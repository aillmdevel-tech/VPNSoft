package net.pulseroute.client;

import org.json.JSONObject;
import java.net.URL;
import javax.net.ssl.HttpsURLConnection;

final class Provisioning {
    static final boolean ENABLED = true;
    private static JSONObject activationBody(MainActivity activity, String code) throws Exception {
        android.content.SharedPreferences identity = activity.getSharedPreferences("route-installation", android.content.Context.MODE_PRIVATE);
        String identifier = identity.getString("id", "");
        if (identifier.isEmpty()) {
            identifier = java.util.UUID.randomUUID().toString();
            identity.edit().putString("id", identifier).commit();
        }
        String model = android.os.Build.MANUFACTURER + " " + android.os.Build.MODEL;
        String version = activity.getPackageManager().getPackageInfo(activity.getPackageName(), 0).versionName;
        JSONObject device = new JSONObject().put("id", identifier).put("version", version)
            .put("model", model.substring(0, Math.min(72, model.length())));
        return new JSONObject().put("code", code).put("platform", "android").put("device", device);
    }

    static HttpsURLConnection request(MainActivity activity,String code) throws Exception {
        URL endpoint = new URL("https://route.centv.ru/v1/profiles");
        HttpsURLConnection connection = (HttpsURLConnection)endpoint.openConnection();
        connection.setRequestMethod("POST");
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(8000);
        connection.setReadTimeout(10000);
        connection.setUseCaches(false);
        connection.setRequestProperty("Content-Type", "application/json");
        byte[] body = activationBody(activity, code).toString().getBytes(java.nio.charset.StandardCharsets.UTF_8);
        connection.setDoOutput(true);
        connection.setFixedLengthStreamingMode(body.length);
        try (java.io.OutputStream out = connection.getOutputStream()) { out.write(body); }
        return connection;
    }
}
