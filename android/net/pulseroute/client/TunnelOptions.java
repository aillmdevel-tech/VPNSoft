package net.pulseroute.client;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONException;
import org.json.JSONObject;

/** Snapshot for one established TUN, including forwarder retries on another network. */
final class TunnelOptions {
    final JSONObject advanced;
    final int socks;
    final boolean excludeLan,shareLan,proxyOnly;
    final String routes;
    final int mtu;
    final int cache;
    final String dns;
    final int tcp, udp;

    private TunnelOptions(int mtu, int cache, String dns, int tcp, int udp, JSONObject advanced, boolean excludeLan,boolean shareLan,String routes,boolean proxyOnly) {
        this.proxyOnly=proxyOnly;
        this.routes=routes;
        this.shareLan=shareLan;
        this.advanced=advanced;this.socks=advanced.optInt("socks",17680);this.excludeLan=excludeLan;
        this.mtu = mtu;
        this.cache = cache;
        this.dns = dns;
        this.tcp = tcp;
        this.udp = udp;
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences("route-tunnel", Context.MODE_PRIVATE);
    }

    static TunnelOptions load(Context context) {
        SharedPreferences p = prefs(context);
        JSONObject advanced;
        try { advanced=new JSONObject(p.getString("advanced","{}")); } catch(JSONException e){advanced=new JSONObject();}
        return new TunnelOptions(p.getInt("mtu", 1500), p.getInt("cache", 4096), p.getString("dns", "auto"), p.getInt("tcp", 0), p.getInt("udp", 0),advanced,p.getBoolean("excludeLan",false),p.getBoolean("shareLan",false),p.getString("routes",""),p.getBoolean("proxyOnly",false));
    }

    JSONObject json() throws JSONException {
        return new JSONObject(advanced.toString()).put("mode",proxyOnly?"proxy":"vpn").put("routes",routes).put("lan",shareLan?"wifi":"off").put("exclude",excludeLan?"lan":"none").put("mtu", mtu).put("dns", dns).put("cache", cache).put("tcp", tcp).put("udp", udp);
    }

    static android.net.IpPrefix prefix(String text){
        String[] fields=text.split("/",-1);
        if(fields.length!=2 || !android.net.InetAddresses.isNumericAddress(fields[0]) || !fields[1].matches("[0-9]{1,3}"))return null;
        try{
            java.net.InetAddress addr=android.net.InetAddresses.parseNumericAddress(fields[0]);
            int bits=Integer.parseInt(fields[1]);
            if(bits<1 || bits>addr.getAddress().length*8)return null;
            return new android.net.IpPrefix(addr,bits);
        }catch(IllegalArgumentException e){return null;}
    }

    static void save(Context context, String payload) {
        try {
            JSONObject values = new JSONObject(payload);
            int mtu = values.getInt("mtu"), cache = values.getInt("cache");
            int tcp = values.optInt("tcp", 0), udp = values.optInt("udp", 0);
            if (tcp != 0 && tcp != 60 && tcp != 300 && tcp != 900) return;
            if (udp != 0 && udp != 30 && udp != 60 && udp != 180) return;
            String dns = values.getString("dns");
            if (mtu != 1280 && mtu != 1400 && mtu != 1420 && mtu != 1500) return;
            if (cache != 1024 && cache != 4096 && cache != 8192) return;
            if (!dns.equals("auto") && !android.net.InetAddresses.isNumericAddress(dns)) return;
            String routes=values.optString("routes","").trim();
            if(routes.length()>2048)return;
            if(!routes.isEmpty()){
                String[] entries=routes.split("[,\\s]+");
                if(entries.length>32)return;
                for(String entry:entries)if(prefix(entry)==null)return;
            }
            JSONObject advanced=new JSONObject();
            for(String key:new String[]{"engineDNS","http","socks","sniff","mux","ip","fragment","method","timeout","interval"})
                if(values.has(key)) advanced.put(key,values.get(key));
            if(!advanced.optString("engineDNS","profile").matches("profile|cloudflare|google|quad9") || !advanced.optString("http","0").matches("0|8080|10809") || !advanced.optString("mux","profile").matches("profile|off|4|8|16") ||
               !advanced.optString("sniff","profile").matches("profile|on|off") ||
               !advanced.optString("ip","profile").matches("profile|UseIPv4|UseIPv6") ||
               !advanced.optString("fragment","profile").matches("profile|tlshello") ||
               !advanced.optString("method","GET").matches("GET|HEAD") ||
               !advanced.optString("timeout","6").matches("5|6|10|15") ||
               !advanced.optString("interval","15").matches("15|30|60") ||
               !advanced.optString("socks","17680").matches("1080|10808|17680"))return;
            prefs(context).edit().putBoolean("proxyOnly",values.optString("mode").equals("proxy")).putString("routes",routes).putBoolean("shareLan",values.optString("lan").equals("wifi")).putString("advanced",advanced.toString()).putBoolean("excludeLan",values.optString("exclude").equals("lan")).putInt("mtu", mtu).putInt("cache", cache).putString("dns", dns).putInt("tcp", tcp).putInt("udp", udp).apply();
        } catch (JSONException ignored) { }
    }
}
