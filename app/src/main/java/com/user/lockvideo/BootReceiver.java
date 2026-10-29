package com.user.lockvideo;

import android.content.*;

public class BootReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context c, Intent i) {
        if (c.getSharedPreferences("p", 0).getBoolean("on", false)) {
            try { c.startForegroundService(new Intent(c, WatchService.class)); } catch (Exception ignored) {}
        }
    }
}
