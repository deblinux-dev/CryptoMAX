package com.cryptomax.app;

import android.Manifest;
import android.app.DownloadManager;
import android.content.Context;
import android.net.Uri;
import android.os.Environment;
import android.util.Base64;
import android.util.Log;
import android.webkit.CookieManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;

/**
 * CryptoBridgePlugin — native operations for CryptoMAX Android.
 *
 * SECURE ARCHITECTURE:
 * This plugin runs in the MAIN Capacitor WebView (index.ts context).
 * web.max.ru runs in a SEPARATE InAppBrowser WebView — it CANNOT access
 * this plugin directly. All bridge calls go through:
 *
 *   web.max.ru JS → window.mobileApp.postMessage → index.ts → this plugin
 *
 * Only 3 methods (everything else handled by Capacitor plugins):
 *   - downloadFile(url, filename)     → DownloadManager (save to Downloads)
 *   - decryptTextFile(url, chatId)    → OkHttp download → base64 (bypass CORS)
 *   - requestMicPermission()          → Android RECORD_AUDIO permission
 */
@CapacitorPlugin(
    name = "CryptoBridge",
    permissions = {
        @Permission(
            alias = "mic",
            strings = { Manifest.permission.RECORD_AUDIO }
        )
    }
)
public class CryptoBridgePlugin extends Plugin {

    private static final String TAG = "CryptoBridge";
    private static final int MAX_FILE_SIZE = 8 * 1024 * 1024; // 8 MB limit
    private OkHttpClient httpClient = null;

    // ─── downloadFile: save file to Downloads folder ───

    @PluginMethod
    public void downloadFile(PluginCall call) {
        String url = call.getString("url");
        String filename = call.getString("filename");

        if (url == null || filename == null) {
            call.reject("Missing url or filename");
            return;
        }

        JSObject ret = new JSObject();
        try {
            DownloadManager dm = (DownloadManager) getContext()
                    .getSystemService(Context.DOWNLOAD_SERVICE);

            String cookies = CookieManager.getInstance().getCookie(url);

            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
            request.setDestinationInExternalPublicDir(
                    Environment.DIRECTORY_DOWNLOADS, filename);
            request.setNotificationVisibility(
                    DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);

            if (cookies != null && !cookies.isEmpty()) {
                request.addRequestHeader("Cookie", cookies);
            }

            long downloadId = dm.enqueue(request);
            ret.put("success", true);
            ret.put("downloadId", downloadId);
            call.resolve(ret);
        } catch (Exception e) {
            Log.e(TAG, "downloadFile error", e);
            ret.put("success", false);
            ret.put("error", e.getMessage());
            call.resolve(ret);
        }
    }

    // ─── decryptTextFile: download via OkHttp, return base64 ───

    @PluginMethod
    public void decryptTextFile(PluginCall call) {
        String url = call.getString("url");
        String chatId = call.getString("chatId");

        if (url == null) {
            call.reject("Missing url");
            return;
        }

        Log.i(TAG, "decryptTextFile: " + url);

        new Thread(() -> {
            try {
                if (httpClient == null) {
                    httpClient = new OkHttpClient.Builder()
                            .connectTimeout(15, TimeUnit.SECONDS)
                            .readTimeout(30, TimeUnit.SECONDS)
                            .followRedirects(true)
                            .build();
                }

                String cookies = CookieManager.getInstance().getCookie(url);
                Request.Builder reqBuilder = new Request.Builder().url(url);
                if (cookies != null && !cookies.isEmpty()) {
                    reqBuilder.addHeader("Cookie", cookies);
                }
                Request request = reqBuilder.build();

                Response response = httpClient.newCall(request).execute();
                if (!response.isSuccessful()) {
                    JSObject err = new JSObject();
                    err.put("success", false);
                    err.put("error", "HTTP " + response.code());
                    resolveOnMain(call, err);
                    return;
                }

                InputStream is = response.body().byteStream();
                ByteArrayOutputStream baos = new ByteArrayOutputStream();
                byte[] buffer = new byte[4096];
                int bytesRead;
                long totalRead = 0;

                while ((bytesRead = is.read(buffer)) != -1) {
                    totalRead += bytesRead;
                    if (totalRead > MAX_FILE_SIZE) {
                        JSObject err = new JSObject();
                        err.put("success", false);
                        err.put("error", "File too large (max 8MB)");
                        resolveOnMain(call, err);
                        return;
                    }
                    baos.write(buffer, 0, bytesRead);
                }

                byte[] fileBytes = baos.toByteArray();
                response.close();

                String base64 = Base64.encodeToString(fileBytes, Base64.NO_WRAP);
                JSObject ret = new JSObject();
                ret.put("success", true);
                ret.put("base64", base64);
                ret.put("size", fileBytes.length);
                resolveOnMain(call, ret);

            } catch (Exception e) {
                Log.e(TAG, "decryptTextFile error", e);
                JSObject err = new JSObject();
                err.put("success", false);
                err.put("error", e.getMessage());
                resolveOnMain(call, err);
            }
        }).start();
    }

    // ─── requestMicPermission ───

    @PluginMethod
    public void requestMicPermission(PluginCall call) {
        if (hasRequiredPermissions(Manifest.permission.RECORD_AUDIO)) {
            JSObject ret = new JSObject();
            ret.put("granted", true);
            call.resolve(ret);
        } else {
            requestPermissionForAlias("mic", call, "micPermissionCallback");
        }
    }

    @PermissionCallback
    private void micPermissionCallback(PluginCall call) {
        JSObject ret = new JSObject();
        boolean granted = hasRequiredPermissions(Manifest.permission.RECORD_AUDIO);
        ret.put("granted", granted);
        call.resolve(ret);
    }

    // ─── Helper: resolve on main thread ───

    private void resolveOnMain(final PluginCall call, final JSObject ret) {
        getActivity().runOnUiThread(() -> call.resolve(ret));
    }
}
