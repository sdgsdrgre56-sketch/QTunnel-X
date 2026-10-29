package com.user.lockvideo;

import android.Manifest;
import android.app.Activity;
import android.content.*;
import android.net.Uri;
import android.os.*;
import android.provider.Settings;
import android.view.Gravity;
import android.widget.*;
import java.io.*;

public class MainActivity extends Activity {
    private static final int PICK = 1;

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        LinearLayout l = new LinearLayout(this);
        l.setOrientation(LinearLayout.VERTICAL);
        l.setPadding(48, 120, 48, 48);
        l.setGravity(Gravity.TOP);

        TextView t = new TextView(this);
        t.setText("Видео со звуком при включении экрана\n\n1. Дай разрешение «Поверх других окон».\n2. Включи переключатель.\n3. В настройках батареи для этого приложения поставь «Без ограничений».\n4. Включи «Двойное касание для включения экрана» в настройках Samsung.");
        t.setTextSize(16);
        l.addView(t);

        Switch sw = new Switch(this);
        sw.setText("Включено");
        sw.setPadding(0, 40, 0, 40);
        SharedPreferences sp = getSharedPreferences("p", 0);
        sw.setChecked(sp.getBoolean("on", false));
        sw.setOnCheckedChangeListener((v, on) -> {
            sp.edit().putBoolean("on", on).apply();
            Intent s = new Intent(this, WatchService.class);
            if (on) startForegroundService(s); else stopService(s);
        });
        l.addView(sw);

        l.addView(btn("Разрешить «Поверх других окон»", () ->
                startActivity(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + getPackageName())))));
        l.addView(btn("Выбрать своё видео", () -> {
            Intent i = new Intent(Intent.ACTION_GET_CONTENT).setType("video/*");
            startActivityForResult(i, PICK);
        }));
        l.addView(btn("Отключить полностью", () -> {
            sp.edit().putBoolean("on", false).apply();
            sw.setChecked(false);
            stopService(new Intent(this, WatchService.class));
            Toast.makeText(this, "Отключено", Toast.LENGTH_SHORT).show();
        }));
        l.addView(btn("Удалить приложение", () -> {
            sp.edit().putBoolean("on", false).apply();
            stopService(new Intent(this, WatchService.class));
            startActivity(new Intent(Intent.ACTION_DELETE, Uri.parse("package:" + getPackageName())));
        }));
        l.addView(btn("Проверить сейчас", () -> startActivity(new Intent(this, PlayerActivity.class))));
        setContentView(l);

        if (Build.VERSION.SDK_INT >= 33)
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 0);
    }

    private Button btn(String s, Runnable r) {
        Button b = new Button(this);
        b.setText(s);
        b.setAllCaps(false);
        b.setOnClickListener(v -> r.run());
        return b;
    }

    @Override protected void onActivityResult(int rq, int rs, Intent d) {
        if (rq == PICK && rs == RESULT_OK && d != null && d.getData() != null) {
            try (InputStream in = getContentResolver().openInputStream(d.getData());
                 OutputStream out = new FileOutputStream(new File(getFilesDir(), "video.mp4"))) {
                byte[] buf = new byte[65536]; int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                Toast.makeText(this, "Видео сохранено", Toast.LENGTH_SHORT).show();
            } catch (Exception e) {
                Toast.makeText(this, "Ошибка: " + e.getMessage(), Toast.LENGTH_LONG).show();
            }
        }
    }
}
