# ProGuard rules for CryptoMAX

# ─── Keep app classes ─────────────────────────────────
-keep class com.cryptomax.app.** { *; }

# ─── Keep Capacitor bridge classes ────────────────────
-keep class com.getcapacitor.** { *; }
-keep @com.getcapacitor.annotation.CapacitorPlugin class * { *; }
-keep @com.getcapacitor.annotation.PluginMethod class * { *; }
-keepclassmembers class * {
    @com.getcapacitor.annotation.PermissionCallback <methods>;
}

# ─── OkHttp (CryptoBridgePlugin network) ──────────────
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
-keep class okhttp3.** { *; }
-keep class okio.** { *; }

# ─── Keep plugin bridge methods (called via reflection from WebView JS bridge) ─
-keepclassmembers class com.cryptomax.app.CryptoBridgePlugin {
    public *;
}

# ─── AndroidX ─────────────────────────────────────────
-keep class androidx.core.** { *; }
-keep class androidx.appcompat.** { *; }
-keep class androidx.webkit.** { *; }
