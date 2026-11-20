package hev.htproxy;

import android.net.ConnectivityManager;
import android.os.Build;
import android.system.OsConstants;
import java.net.InetAddress;
import java.net.InetSocketAddress;

public final class TProxyService {
    private static volatile ConnectivityManager manager;
    static { System.loadLibrary("hev-socks5-tunnel"); }
    public static native boolean TProxyStartService(String configPath, int fd);
    public static native boolean TProxyStopService();
    public static native boolean TProxyIsRunning();
    public static native long[] TProxyGetStats();
    public static void setManager(ConnectivityManager value) { manager = value; }

    public static int routeOwnerUid(String source, int sourcePort, String target, int targetPort) {
        ConnectivityManager current = manager;
        if (current == null || Build.VERSION.SDK_INT < 29) return -1;
        try {
            return current.getConnectionOwnerUid(OsConstants.IPPROTO_TCP,
                new InetSocketAddress(InetAddress.getByName(source), sourcePort),
                new InetSocketAddress(InetAddress.getByName(target), targetPort));
        } catch (Exception ignored) {
            return -1;
        }
    }
    private TProxyService() {}
}
