package com.cryptomax.app;

import android.content.Intent;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

/**
 * MainActivity — Capacitor's BridgeActivity that hosts the web.max.ru WebView.
 *
 * Registers CryptoBridgePlugin so the prompt()-based bridge is wired up before
 * the WebView loads any URL.
 */
public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Plugins must be registered BEFORE super.onCreate() so the bridge
        // has them available when the WebView is initialised.
        registerPlugin(CryptoBridgePlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        // Forward to bridge (Capacitor plugins) — needed for camera/file pickers
        if (getBridge() != null) {
            getBridge().onActivityResult(requestCode, resultCode, data);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (getBridge() != null) {
            getBridge().onRequestPermissionsResult(requestCode, permissions, grantResults);
        }
    }
}
