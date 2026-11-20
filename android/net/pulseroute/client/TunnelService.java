package net.pulseroute.client;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.ConnectivityManager;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.VpnService;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelFileDescriptor;
import android.os.SystemClock;
import hev.htproxy.TProxyService;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.TimeUnit;

public final class TunnelService extends VpnService {
    static volatile String summary = "Отключено";
    static final String APPLY_PROTECTION = "net.pulseroute.client.APPLY_PROTECTION";
    static final String RELOAD_ROUTE = "net.pulseroute.client.RELOAD_ROUTE";
    private static final String CHANNEL = "route_connection";
    private static TunnelService instance;
    private Process router;
    private ParcelFileDescriptor tunnel;
    private boolean nativeRunning;
    private boolean guarding;
    private boolean scoped;
    private boolean proxyOnly;
    private TunnelOptions options;
    private final Handler serviceHandler = new Handler(Looper.getMainLooper());
    private Underlay lastPath;
    private long lastStart;
    private long retryAt;
    private long retryDelay = 1500;
    private final Runnable monitorConnection = new Runnable() {
        @Override public void run() {
            if (!hasSession() || guarding) return;
            reconcileConnection(false);
            serviceHandler.postDelayed(this, 1800);
        }
    };

    private static final class Underlay {
        final Network network;
        final String dns;
        final String wifi;

        Underlay(Network network, String dns,String wifi) {
            this.wifi=wifi;
            this.network = network;
            this.dns = dns;
        }

        boolean matches(Underlay previous) {
            return previous != null && network.equals(previous.network) && dns.equals(previous.dns) && wifi.equals(previous.wifi);
        }
    }

    private final BroadcastReceiver packageChanges = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            if (tunnel == null || intent.getData() == null) return;
            String pkg = intent.getData().getSchemeSpecificPart();
            if (AppProtection.packages(context).contains(pkg)) {
                startForegroundService(new Intent(context, TunnelService.class)
                    .setAction(APPLY_PROTECTION));
            }
        }
    };

    @Override public void onCreate() {
        super.onCreate();
        IntentFilter filter = new IntentFilter();
        filter.addAction(Intent.ACTION_PACKAGE_ADDED);
        filter.addAction(Intent.ACTION_PACKAGE_REMOVED);
        filter.addDataScheme("package");
        if (android.os.Build.VERSION.SDK_INT >= 33) {
            registerReceiver(packageChanges, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(packageChanges, filter);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        instance = this;
        String action=intent==null?null:intent.getAction();
        boolean apply=APPLY_PROTECTION.equals(action);
        boolean resumeGuard=intent==null && getSharedPreferences("vpn-state",MODE_PRIVATE).getBoolean("guard",false);
        boolean guard=apply ? !hasSession() || guarding : resumeGuard;
        if(!hasSession())startForeground(1,notification());
        if(guard && !AppProtection.configured(this)){
            releaseConnection();stopSelf();return START_NOT_STICKY;
        }
        if(!hasSession() || apply || guarding && !guard){
            try {
                options=TunnelOptions.load(this);
                java.util.Set<String> selected=AppProtection.packages(this);
                if(options.proxyOnly && selected.isEmpty() && !guard && !isAlwaysOn()){
                    stopForwarder();
                    if(tunnel!=null){tunnel.close();tunnel=null;}
                    proxyOnly=true;
                    scoped=false;
                }else{
                    Builder builder=new Builder().setSession(RouteLanguage.text("Маршрут")).setMtu(options.mtu)
                        .addAddress("198.18.0.1",30).addAddress("fd42:1::1",64)
                        .addRoute("0.0.0.0",0).addRoute("::",0).addDnsServer("198.18.0.2");
                    if(selected.isEmpty()) {
                        builder.addDisallowedApplication(getPackageName());
                        if(options.excludeLan && android.os.Build.VERSION.SDK_INT>=33)
                            for(String prefix:new String[]{"10.0.0.0/8","172.16.0.0/12","192.168.0.0/16","fc00::/7"})
                                builder.excludeRoute(TunnelOptions.prefix(prefix));
                        if(android.os.Build.VERSION.SDK_INT>=33 && !options.routes.isEmpty()){
                            for(String prefix:options.routes.split("[,\\s]+"))builder.excludeRoute(TunnelOptions.prefix(prefix));
                        }
                    }
                    else {
                        int count=0;
                        for(String pkg:selected){
                            try {builder.addAllowedApplication(pkg);count++;}
                            catch(android.content.pm.PackageManager.NameNotFoundException ignored){}
                        }
                        // Never establish an unrestricted interface when all chosen apps are absent.
                        if(count==0){releaseConnection();stopSelf();return START_NOT_STICKY;}
                    }
                    ParcelFileDescriptor next=builder.establish();
                    if(next==null)throw new IOException("VPN consent unavailable");
                    ParcelFileDescriptor previous=tunnel;
                    stopForwarder();tunnel=next;scoped=!selected.isEmpty();
                    if(previous!=null)previous.close();
                    proxyOnly=false;
                }
                lastPath=null;resetBackoff();
            }catch(Exception error){
                stopForwarder();serviceHandler.removeCallbacks(monitorConnection);
                guarding=true;summary="Не удалось применить правила VPN";
                if(tunnel==null)stopSelf();
                return START_NOT_STICKY;
            }
        }
        setGuard(guard);
        serviceHandler.removeCallbacks(monitorConnection);
        if(!guarding){
            reconcileConnection(apply || RELOAD_ROUTE.equals(action));
            serviceHandler.postDelayed(monitorConnection,1800);
        }
        return START_STICKY;
    }

    private void setGuard(boolean enabled){
        guarding=enabled;
        getSharedPreferences("vpn-state",MODE_PRIVATE).edit().putBoolean("guard",enabled).apply();
        if(enabled){
            serviceHandler.removeCallbacks(monitorConnection);
            stopForwarder();lastPath=null;resetBackoff();
            summary="Доступ приложений заблокирован";
        }
        getSystemService(NotificationManager.class).notify(1,notification());
    }

    private void resetBackoff() {
        retryAt = 0;
        retryDelay = 1500;
    }

    private void reconcileConnection(boolean force) {
        Underlay path = activeUnderlay();
        if (path == null) {
            if (router != null || nativeRunning) stopForwarder();
            lastPath = null;
            resetBackoff();
            summary = "Ожидание сети";
            return;
        }

        long now = SystemClock.elapsedRealtime();
        boolean changed = !path.matches(lastPath);
        boolean healthy = router != null && router.isAlive() && (proxyOnly || nativeRunning && TProxyService.TProxyIsRunning());
        if (!force && !changed && healthy) {
            if (now - lastStart >= 10000) resetBackoff();
            return;
        }
        if (force || changed) resetBackoff();
        if (now < retryAt) {
            summary = "Восстанавливаем VPN";
            return;
        }

        lastPath = path;
        stopForwarder();
        File status = new File(getFilesDir(), "health.json");
        status.delete();
        retryAt = now + retryDelay;
        retryDelay = Math.min(15000, retryDelay * 2);
        try {
            startForwarder(path.dns, status);
            lastStart = SystemClock.elapsedRealtime();
            summary = "Подключено · проверка серверов";
        } catch (Exception | UnsatisfiedLinkError error) {
            stopForwarder();
            summary = "Восстанавливаем VPN";
            android.util.Log.w("RouteConnection", "Forwarder restart failed: " + error.getClass().getSimpleName());
        }
    }

    private void startForwarder(String dns, File status) throws Exception {
        File dir = new File(getFilesDir(), "profiles");
        String nativeDir = getApplicationInfo().nativeLibraryDir;
        org.json.JSONObject effective=new org.json.JSONObject(options.advanced.toString());
        if(options.shareLan && !scoped && lastPath!=null)effective.put("wifi",lastPath.wifi);
        List<String> command = new ArrayList<>(Arrays.asList(
            nativeDir + "/librouter.so", "-engines", nativeDir, "-listen", "127.0.0.1:"+options.socks,"-advanced",effective.toString(),
            "-config", new File(dir, "profiles.json").getPath(), "-dns", dns, "-status", status.getPath()
        ));
        String selected = MainActivity.selectedProfile(this);
        String host=MainActivity.selectedServer(this);
        if (!host.isEmpty()){
            command.add("-server");command.add(host);
            org.json.JSONArray order=new org.json.JSONArray(getSharedPreferences("route-selection",MODE_PRIVATE).getString("priority","[]"));
            java.util.List<String> ids=new ArrayList<>();
            for(int i=0;i<order.length();i++)ids.add(order.getString(i));
            command.add("-order");command.add(android.text.TextUtils.join(",",ids));
        } else if (!selected.isEmpty()) {
            command.add("-profile");
            command.add(selected);
        }
        if(scoped) command.add("-vpn-only");
        router = new ProcessBuilder(command)
            .directory(dir)
            .redirectErrorStream(true)
            .redirectOutput(new File(getFilesDir(), "router.log"))
            .start();
        if(proxyOnly)return;
        String config = "tunnel:\n  mtu: " + options.mtu + "\n  ipv4: 198.18.0.1\n  ipv6: 'fd42:1::1'\n"
            + "socks5:\n  address: 127.0.0.1\n  port: "+options.socks+"\n  udp: 'udp'\n"
            + "mapdns:\n  address: 198.18.0.2\n  port: 53\n  network: 198.19.0.0\n"
            + "  netmask: 255.255.0.0\n  cache-size: " + options.cache + "\n";
        if (options.tcp != 0 || options.udp != 0) {
            config += "misc:\n";
            if (options.tcp != 0) config += "  tcp-read-write-timeout: " + options.tcp * 1000 + "\n";
            if (options.udp != 0) config += "  udp-read-write-timeout: " + options.udp * 1000 + "\n";
        }
        File tunConfig = new File(getFilesDir(), "tun.yml");
        try (FileOutputStream out = new FileOutputStream(tunConfig)) {
            out.write(config.getBytes(StandardCharsets.UTF_8));
        }
        nativeRunning = TProxyService.TProxyStartService(tunConfig.getPath(), tunnel.getFd());
        if (!nativeRunning) throw new IOException("TUN-адаптер не запустился");
    }

    static String sharedAddress(){
        TunnelService s=instance;
        if(s==null||s.guarding||s.scoped||s.options==null||!s.options.shareLan||s.lastPath==null||s.lastPath.wifi.isEmpty())return "";
        return s.lastPath.wifi.split("/")[0]+":"+s.options.socks;
    }
    static boolean hasInterface() {return instance!=null && instance.tunnel!=null;}
    private boolean hasSession(){return proxyOnly || tunnel!=null;}
    static boolean running(){return instance!=null && instance.hasSession() && !instance.guarding;}
    static boolean inProxyMode(){return running() && instance.proxyOnly;}

    static boolean systemAlwaysOn() {
        TunnelService current = instance;
        return current != null && android.os.Build.VERSION.SDK_INT >= 29 && current.isAlwaysOn();
    }

    static boolean systemLockdown() {
        return systemAlwaysOn() && instance.isLockdownEnabled();
    }

    static boolean disconnect() {
        TunnelService current = instance;
        if (current == null) return false;
        // Android binds to the service for as long as its VPN interface exists.
        // Release the interface explicitly before waiting for service destruction.
        if(AppProtection.configured(current)){current.setGuard(true);return true;}
        if(current.isAlwaysOn())return false;
        current.releaseConnection();
        current.stopSelf();
        return true;
    }

    static Network originNetwork() {
        TunnelService service=instance;
        return service!=null && service.lastPath!=null && service.tunnel!=null ? service.lastPath.network : null;
    }

    private Underlay activeUnderlay() {
        ConnectivityManager manager = getSystemService(ConnectivityManager.class);
        Network preferred = manager.getActiveNetwork();
        if (preferred != null) {
            NetworkCapabilities caps = manager.getNetworkCapabilities(preferred);
            if (caps != null && !caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) {
                return usableUnderlay(manager, preferred, caps);
            }
        }
        for (Network network : manager.getAllNetworks()) {
            Underlay path = usableUnderlay(manager, network, manager.getNetworkCapabilities(network));
            if (path != null) return path;
        }
        return null;
    }

    private Underlay usableUnderlay(ConnectivityManager manager, Network network, NetworkCapabilities caps) {
        if (caps == null || caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)
            || !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) return null;
        LinkProperties properties = manager.getLinkProperties(network);
        if (properties == null) return null;
        String wifi="";
        if(caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)){
            for(android.net.LinkAddress a:properties.getLinkAddresses()){
                if(a.getAddress() instanceof java.net.Inet4Address && a.getAddress().isSiteLocalAddress() && a.getPrefixLength()>=8){
                    wifi=a.getAddress().getHostAddress()+"/"+a.getPrefixLength();break;
                }
            }
        }
        if (options != null && !"auto".equals(options.dns)) return new Underlay(network, options.dns,wifi);
        for (InetAddress address : properties.getDnsServers()) {
            if (!address.isLinkLocalAddress()) return new Underlay(network, address.getHostAddress(),wifi);
        }
        return null;
    }

    private Notification notification() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(CHANNEL, "VPN", NotificationManager.IMPORTANCE_LOW));
        Intent intent = new Intent(this, MainActivity.class);
        PendingIntent pending = PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, CHANNEL)
            .setContentTitle(RouteLanguage.text("Маршрут"))
            .setContentText(proxyOnly?RouteLanguage.text("Локальный прокси"):guarding?RouteLanguage.text("Доступ выбранных приложений заблокирован"):RouteLanguage.text("VPN-подключение"))
            .setContentIntent(pending)
            .setSmallIcon(android.R.drawable.stat_sys_warning)
            .setOngoing(true)
            .build();
    }

    @Override
    public void onRevoke() {
        serviceHandler.post(() -> {
            releaseConnection();
            stopSelf();
        });
    }

    @Override
    public void onDestroy() {
        unregisterReceiver(packageChanges);
        releaseConnection();
        if (instance == this) instance = null;
        super.onDestroy();
    }

    private void releaseConnection() {
        serviceHandler.removeCallbacks(monitorConnection);
        lastPath = null;
        resetBackoff();
        stopForwarder();
        if (tunnel != null) {
            try { tunnel.close(); } catch (IOException ignored) {}
            tunnel = null;
        }
        TProxyService.setManager(null);
        if (!summary.startsWith("Ошибка")) summary = "Отключено";
        proxyOnly=false;
        stopForeground(STOP_FOREGROUND_REMOVE);
    }

    private void stopForwarder() {
        if (nativeRunning) TProxyService.TProxyStopService();
        nativeRunning = false;
        if (router != null) {
            router.destroy();
            try {
                if (!router.waitFor(1800, TimeUnit.MILLISECONDS)) {
                    router.destroyForcibly();
                    router.waitFor(600, TimeUnit.MILLISECONDS);
                }
            } catch (InterruptedException error) {
                router.destroyForcibly();
                Thread.currentThread().interrupt();
            }
            router = null;
        }
    }
}
