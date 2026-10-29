package com.user.lockvideo;

import android.app.*;
import android.content.*;
import android.os.IBinder;

public class WatchService extends Service {
    private BroadcastReceiver rcv;

    @Override public int onStartCommand(Intent i, int f, int id) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel("w", "Фоновая работа", NotificationManager.IMPORTANCE_MIN));
        Notification n = new Notification.Builder(this, "w")
                .setContentTitle("Видео при включении экрана включено")
                .setSmallIcon(android.R.drawable.ic_media_play).build();
        startForeground(1, n);
        if (rcv == null) {
            rcv = new BroadcastReceiver() {
                @Override public void onReceive(Context c, Intent in) {
                    Intent p = new Intent(c, PlayerActivity.class)
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
                    c.startActivity(p);
                }
            };
            registerReceiver(rcv, new IntentFilter(Intent.ACTION_SCREEN_ON));
        }
        return START_STICKY;
    }

    @Override public void onDestroy() {
        if (rcv != null) { unregisterReceiver(rcv); rcv = null; }
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent i) { return null; }
}
