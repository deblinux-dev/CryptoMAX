package com.cryptomax.app;

import android.app.Application;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.os.Build;
import android.util.Log;

/**
 * CryptoMAXApplication — creates the notification channel used by
 * CryptoBridgePlugin.showNotification.  Registered in AndroidManifest via
 * android:name="com.cryptomax.app.CryptoMAXApplication".
 */
public class CryptoMAXApplication extends Application {

    public static final String CHANNEL_ID = "cryptomax_main";
    public static final String CHANNEL_NAME = "CryptoMAX";
    private static final String TAG = "CryptoMAXApp";

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannels();
        Log.d(TAG, "CryptoMAXApplication initialised");
    }

    private void createNotificationChannels() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel main = new NotificationChannel(
                    CHANNEL_ID,
                    CHANNEL_NAME,
                    NotificationManager.IMPORTANCE_DEFAULT
            );
            main.setDescription("CryptoMAX notifications");
            main.enableVibration(true);
            main.enableLights(true);
            main.setLightColor(0x0FE2C2);

            NotificationChannel high = new NotificationChannel(
                    "cryptomax_high",
                    "CryptoMAX — Alerts",
                    NotificationManager.IMPORTANCE_HIGH
            );
            high.setDescription("High-priority CryptoMAX alerts");
            high.enableVibration(true);

            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(main);
                manager.createNotificationChannel(high);
            }
        }
    }
}
