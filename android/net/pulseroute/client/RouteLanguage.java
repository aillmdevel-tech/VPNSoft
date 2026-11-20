package net.pulseroute.client;

import android.app.Application;
import android.content.res.Configuration;
import android.os.LocaleList;
import java.io.InputStream;
import java.util.Scanner;
import org.json.JSONObject;

public final class RouteLanguage extends Application {
    private static String language = "ru";
    private static JSONObject strings = new JSONObject();

    @Override public void onCreate() {
        super.onCreate();
        load(getResources().getConfiguration());
    }

    @Override public void onConfigurationChanged(Configuration config) {
        super.onConfigurationChanged(config);
        load(config);
    }

    private void load(Configuration config) {
        LocaleList locales = config.getLocales();
        String selected = "en";
        for (int i=0; i<locales.size(); i++) {
            String candidate = locales.get(i).getLanguage();
            if (candidate.equals("ru") || candidate.equals("en") || candidate.equals("es")) {
                selected = candidate;
                break;
            }
        }
        JSONObject table = new JSONObject();
        if (!selected.equals("ru")) {
            try (InputStream input = getAssets().open("journey/strings-" + selected + ".json");
                 Scanner scanner = new Scanner(input, "UTF-8").useDelimiter("\\A")) {
                table = new JSONObject(scanner.next());
            } catch (Exception unavailable) { selected = "ru"; }
        }
        language = selected;
        strings = table;
    }

    static String page() { return language.equals("ru") ? "index.html" : "index-" + language + ".html"; }
    static String text(String source) { return source == null ? null : strings.optString(source, source); }
}
