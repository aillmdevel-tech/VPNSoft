package net.pulseroute.client;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.Proxy;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Objects;
import javax.net.ssl.HttpsURLConnection;
import org.json.JSONObject;

/** Approximate origin on the Wi-Fi or cellular network. Never persist an IP address. */
final class OriginLocation {
    private final ConnectivityManager manager;
    private final Handler main=new Handler(Looper.getMainLooper());
    private Network last;
    private JSONObject location;
    private long nextCheck;
    private int generation;
    private boolean pending;
    String status="";

    OriginLocation(Context context){manager=context.getSystemService(ConnectivityManager.class);}

    void clear(){
        generation++;last=null;location=null;pending=false;nextCheck=0;
    }
    JSONObject current(){
        Network path=TunnelService.originNetwork();
        if(path==null)path=manager.getActiveNetwork();
        NetworkCapabilities caps=path==null?null:manager.getNetworkCapabilities(path);
        if(caps==null || !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN) ||
            !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED))path=null;
        if(!Objects.equals(last,path)){
            generation++;last=path;location=null;nextCheck=0;pending=false;
        }
        if(path==null)status=RouteLanguage.text("Локация сети · исходная сеть недоступна");
        if(path!=null && !pending && SystemClock.elapsedRealtime()>=nextCheck){
            final Network network=path;final int ticket=generation;
            pending=true;status=RouteLanguage.text("Локация сети · определяем место по IP");
            new Thread(()->{
                JSONObject point=null;
                String label=RouteLanguage.text("Локация сети · сервисы геолокации недоступны");
                boolean received=false;
                for(boolean reserve:new boolean[]{false,true}){
                    HttpsURLConnection c=null;
                    try{
                        URL url=new URL(reserve?"https://ipwho.is/?fields=success,country_code,city,latitude,longitude":"https://ipinfo.io/json");
                        c=(HttpsURLConnection)network.openConnection(url,Proxy.NO_PROXY);
                        c.setConnectTimeout(5500);c.setReadTimeout(5500);
                        c.setUseCaches(false);c.setInstanceFollowRedirects(false);
                        if(c.getResponseCode()!=200)continue;
                        try(InputStream in=c.getInputStream()){
                            ByteArrayOutputStream out=new ByteArrayOutputStream();byte[] buf=new byte[512];
                            for(int n;(n=in.read(buf))!=-1;){if(out.size()+n>8192)throw new java.io.IOException();out.write(buf,0,n);}
                            JSONObject data=new JSONObject(new String(out.toByteArray(),StandardCharsets.UTF_8));
                            if(reserve && !data.optBoolean("success"))continue;
                            String country=data.getString(reserve?"country_code":"country");
                            if(!country.matches("[A-Z]{2}"))continue;
                            if(country.equals("RU") || country.equals("GE")){
                                double lat,lon;
                                if(reserve){lat=data.getDouble("latitude");lon=data.getDouble("longitude");}
                                else{String[] pair=data.getString("loc").split(",");lat=Double.parseDouble(pair[0]);lon=Double.parseDouble(pair[1]);}
                                if(!(Math.abs(lat)<90 && Math.abs(lon)<=180))continue;
                                point=new JSONObject().put("country",country).put("lat",lat).put("lon",lon);
                                label=RouteLanguage.text("Локация сети · ")+(country.equals("RU")?RouteLanguage.text("Россия"):RouteLanguage.text("Грузия"))+" · "+data.optString("city","");
                            }else label=RouteLanguage.text("Локация сети · ")+new java.util.Locale("",country).getDisplayCountry(java.util.Locale.getDefault());
                            label+=" ("+(reserve?"ipwho.is":"IPinfo")+")";
                            received=true;break;
                        }
                    }catch(Exception ignored){}finally{if(c!=null)c.disconnect();}
                }
                final JSONObject result=point;final boolean success=received;final String message=label;
                main.post(()->{if(ticket==generation){location=result;status=message;pending=false;
                    nextCheck=SystemClock.elapsedRealtime()+(success?3600000:300000);}});
            },"origin-location").start();
        }
        return location;
    }
}
