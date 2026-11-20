package net.pulseroute.client;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;

final class ReleaseUpdate {
    static void start(Activity activity, Runnable done) {
        done.run();
        Uri listing = Uri.parse("https://play.google.com/store/apps/details?id=" + activity.getPackageName());
        Intent intent = new Intent(Intent.ACTION_VIEW, listing);
        try { activity.startActivity(intent); }
        catch (android.content.ActivityNotFoundException ignored) {
            android.widget.Toast.makeText(activity, listing.toString(), android.widget.Toast.LENGTH_LONG).show();
        }
    }
}
