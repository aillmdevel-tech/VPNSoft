package net.pulseroute.client;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Build;
import android.widget.Toast;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import javax.net.ssl.HttpsURLConnection;
import org.json.JSONObject;

final class ReleaseUpdate {
    private static final String ORIGIN = "https://route.centv.ru";
    static void start(Activity activity,Runnable done) {
        new Thread(()->check(activity,done),"release-update").start();
    }

    private static void check(Activity activity,Runnable done) {
        try {
            PackageInfo installed = activity.getPackageManager().getPackageInfo(activity.getPackageName(), 0);
            long installedBuild = Build.VERSION.SDK_INT >= 28 ? installed.getLongVersionCode() : installed.versionCode;
            JSONObject release = fetch().getJSONObject("android");
            long build = release.getLong("build");
            String version = release.getString("version");
            if (build < 1 || !version.matches("[0-9]+(?:\\.[0-9]+){1,2}")) {
                throw new IOException("Invalid release");
            }
            activity.runOnUiThread(() -> {
                if(activity.isDestroyed() || activity.isFinishing())return;
                done.run();
                AlertDialog.Builder dialog = new AlertDialog.Builder(activity);
                if (build > installedBuild) {
                    dialog.setTitle(RouteLanguage.text("Доступен «Маршрут» ") + version)
                        .setMessage(RouteLanguage.text("После скачивания откройте APK и подтвердите обновление в Android."))
                        .setNegativeButton(RouteLanguage.text("Позже"), null)
                        .setPositiveButton(RouteLanguage.text("Скачать APK"), (choice, selected) -> openDownload(activity));
                } else {
                    dialog.setTitle(RouteLanguage.text("Установлена актуальная версия"))
                        .setMessage(RouteLanguage.text("Маршрут ") + installed.versionName)
                        .setPositiveButton("OK", null);
                }
                dialog.show();
            });
        } catch (Exception error) {
            activity.runOnUiThread(() -> {
                if (!activity.isDestroyed() && !activity.isFinishing()) {
                    done.run();
                    new AlertDialog.Builder(activity).setTitle(RouteLanguage.text("Проверка обновлений недоступна"))
                        .setMessage(RouteLanguage.text("Повторите проверку, когда появится связь с сервером."))
                        .setPositiveButton("OK", null).show();
                }
            });
        }
    }

    private static JSONObject fetch() throws Exception {
        HttpsURLConnection connection = (HttpsURLConnection) new URL(ORIGIN + "/version.json").openConnection();
        connection.setInstanceFollowRedirects(false);
        connection.setUseCaches(false);
        connection.setConnectTimeout(6000);
        connection.setReadTimeout(6000);
        connection.setRequestProperty("Accept", "application/json");
        try {
            if (connection.getResponseCode() != 200 || connection.getContentLength() > 4096) {
                throw new IOException("Release unavailable");
            }
            try (InputStream input = connection.getInputStream()) {
                ByteArrayOutputStream output = new ByteArrayOutputStream();
                byte[] buffer = new byte[1024];
                for (int length; (length = input.read(buffer)) != -1;) {
                    if (output.size() + length > 4096) throw new IOException("Release metadata too large");
                    output.write(buffer, 0, length);
                }
                return new JSONObject(new String(output.toByteArray(), StandardCharsets.UTF_8));
            }
        } finally {
            connection.disconnect();
        }
    }

    private static void openDownload(Activity activity) {
        try {
            activity.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(ORIGIN + "/route.apk")));
        } catch (ActivityNotFoundException error) {
            Toast.makeText(activity, RouteLanguage.text("Откройте route.centv.ru в браузере"), Toast.LENGTH_LONG).show();
        }
    }
}
