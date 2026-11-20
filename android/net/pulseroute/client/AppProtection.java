package net.pulseroute.client;

import android.content.Context;
import android.content.SharedPreferences;
import java.util.HashSet;
import java.util.Set;

final class AppProtection {
    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences("app-protection", Context.MODE_PRIVATE);
    }

    // Earlier releases stored a server address or "any" under the package name.
    // Only membership matters now, including before the first edit after an upgrade.
    static Set<String> packages(Context context) {
        return new HashSet<>(prefs(context).getAll().keySet());
    }

    static boolean configured(Context context) {
        return !packages(context).isEmpty();
    }

    static boolean save(Context context, Set<String> packages) {
        SharedPreferences.Editor editor = prefs(context).edit().clear();
        for (String pkg : packages) editor.putBoolean(pkg, true);
        return editor.commit();
    }
}
