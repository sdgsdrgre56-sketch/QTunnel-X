package com.user.lockvideo;

import android.app.Activity;
import android.net.Uri;
import android.os.Bundle;
import android.view.*;
import android.widget.*;
import java.io.File;

public class PlayerActivity extends Activity {
    private VideoView vv;

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        setShowWhenLocked(true);
        setTurnScreenOn(true);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(0xFF000000);
        vv = new VideoView(this);
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(-1, -1, Gravity.CENTER);
        root.addView(vv, lp);
        setContentView(root);

        File f = new File(getFilesDir(), "video.mp4");
        Uri u = f.exists() ? Uri.fromFile(f)
                : Uri.parse("android.resource://" + getPackageName() + "/" + R_RAW_DEFAULT());
        vv.setVideoURI(u);
        vv.setOnCompletionListener(m -> finish());
        vv.setOnErrorListener((m, w, e) -> { finish(); return true; });
        vv.setOnTouchListener((v, ev) -> { finish(); return true; });
        vv.start();
    }

    private int R_RAW_DEFAULT() {
        return getResources().getIdentifier("default_video", "raw", getPackageName());
    }

    @Override protected void onStop() { super.onStop(); finish(); }
}
