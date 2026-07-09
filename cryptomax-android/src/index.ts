/**
 * CryptoMAX — Capacitor entry point (SECURE InAppBrowser architecture)
 *
 * ARCHITECTURE:
 * ┌──────────────────────────────────────────────────┐
 * │  Main Capacitor WebView (this file, index.html)  │
 * │  window.Capacitor AVAILABLE                       │
 * │  - @capacitor/preferences (password storage)      │
 * │  - @capacitor/local-notifications                 │
 * │  - CryptoBridgePlugin (download, permissions)     │
 * │  - InAppBrowser plugin                            │
 * │                                                   │
 * │  Responsibilities:                                │
 * │  1. Open web.max.ru in InAppBrowser (isolated)    │
 * │  2. Inject crypto scripts on page load            │
 * │  3. Bridge: receive messages, process, respond    │
 * ├──────────────────────────────────────────────────┤
 * │  InAppBrowser WebView (web.max.ru)                │
 * │  window.Capacitor NOT AVAILABLE (ISOLATED)         │
 * │  Only window.mobileApp.postMessage for bridge     │
 * │                                                   │
 * │  Injected scripts:                                │
 * │  - engine-bundle.js (crypto engine)               │
 * │  - preload-main.js (message observer, overlay)    │
 * │  - ui-panel.js (Material Design UI)               │
 * └──────────────────────────────────────────────────┘
 *
 * SECURITY:
 * - web.max.ru CANNOT access Capacitor plugins (Preferences, Filesystem, etc.)
 * - web.max.ru CANNOT access window.Capacitor
 * - Only window.mobileApp.postMessage is available for communication
 * - All bridge calls validated against whitelist
 * - Passwords stored via @capacitor/preferences (encrypted by Android Keystore)
 */

import { InAppBrowser } from '@capgo/capacitor-inappbrowser';
import { Preferences } from '@capacitor/preferences';
import { LocalNotifications } from '@capacitor/local-notifications';
import { App } from '@capacitor/app';

// ─── State ──────────────────────────────────────────────────────

let _webviewId: string | null = null;
let _scriptsInjected = false;

// Whitelist of allowed bridge methods (security: only these can be called)
const ALLOWED_METHODS = new Set([
    'savePassword',
    'getPassword',
    'getAllPasswords',
    'removePassword',
    'getChatId',
    'downloadFile',
    'decryptTextFile',
    'showNotification',
    'requestMicPermission',
    'setOverlayVisibility',
]);

// ─── Script Loading ─────────────────────────────────────────────

async function loadScript(filename: string): Promise<string> {
    try {
        const response = await fetch(`cap-scripts/${filename}`);
        if (!response.ok) {
            console.error(`[CryptoMAX] Failed to load ${filename}: ${response.status}`);
            return '';
        }
        return await response.text();
    } catch (e) {
        console.error(`[CryptoMAX] Error loading ${filename}:`, e);
        return '';
    }
}

async function injectScript(filename: string): Promise<boolean> {
    const code = await loadScript(filename);
    if (!code || !_webviewId) return false;

    try {
        await InAppBrowser.executeScript({
            code: code,
            id: _webviewId,
        });
        console.log(`[CryptoMAX] Injected: ${filename}`);
        return true;
    } catch (e) {
        console.error(`[CryptoMAX] Injection failed for ${filename}:`, e);
        return false;
    }
}

async function injectAllScripts(): Promise<void> {
    if (_scriptsInjected || !_webviewId) return;
    _scriptsInjected = true;

    // Order matters: engine first (defines CryptoEngineAPI),
    // then preload-main (uses CryptoEngineAPI),
    // then ui-panel (uses both)
    await injectScript('engine-bundle.js');
    await new Promise(r => setTimeout(r, 500));

    await injectScript('preload-main.js');
    await new Promise(r => setTimeout(r, 500));

    await injectScript('ui-panel.js');

    console.log('[CryptoMAX] All scripts injected');
}

// ─── Bridge Handler ─────────────────────────────────────────────

async function handleBridgeMessage(event: any): Promise<void> {
    // Extract data from event (Capacitor wraps in 'detail')
    const data = event.detail || event;
    if (!data || !data.method || !data.id) {
        console.warn('[CryptoMAX] Invalid bridge message:', data);
        return;
    }

    const { method, args = [], id } = data;

    // SECURITY: validate method against whitelist
    if (!ALLOWED_METHODS.has(method)) {
        console.warn(`[CryptoMAX] Blocked unauthorized method: ${method}`);
        await respondToBridge(id, { error: 'Method not allowed' });
        return;
    }

    console.log(`[CryptoMAX] Bridge: ${method}`);

    let result: any;

    try {
        switch (method) {
            // ─── Password Management (via @capacitor/preferences) ───
            case 'savePassword': {
                const chatId = args[0] as string;
                const password = args[1] as string;
                if (!chatId || !password) {
                    result = { error: 'Missing chatId or password' };
                } else {
                    await Preferences.set({
                        key: `cm_pw_${chatId}`,
                        value: password,
                    });
                    result = { success: true };
                }
                break;
            }

            case 'getPassword': {
                const chatId = args[0] as string;
                if (!chatId) {
                    result = { error: 'Missing chatId' };
                } else {
                    const { value } = await Preferences.get({
                        key: `cm_pw_${chatId}`,
                    });
                    result = { password: value };
                }
                break;
            }

            case 'getAllPasswords': {
                const { keys } = await Preferences.keys();
                const passwords: Record<string, string> = {};
                for (const key of keys) {
                    if (key.startsWith('cm_pw_')) {
                        const chatId = key.substring(6);
                        const { value } = await Preferences.get({ key });
                        if (value) passwords[chatId] = value;
                    }
                }
                result = { passwords, count: Object.keys(passwords).length };
                break;
            }

            case 'removePassword': {
                const chatId = args[0] as string;
                if (chatId) {
                    await Preferences.remove({ key: `cm_pw_${chatId}` });
                }
                result = { success: true };
                break;
            }

            // ─── Chat ID (extract from InAppBrowser URL) ───
            case 'getChatId': {
                result = { chatId: _currentChatId || '' };
                break;
            }

            // ─── Overlay Visibility (persist setting) ───
            case 'setOverlayVisibility': {
                const visible = args[0] as boolean;
                await Preferences.set({
                    key: 'cm_overlays_visible',
                    value: visible ? 'true' : 'false',
                });
                result = { success: true };
                break;
            }

            // ─── Notifications (via @capacitor/local-notifications) ───
            case 'showNotification': {
                const title = args[0] as string;
                const body = args[1] as string;
                const notifId = Math.floor(Math.random() * 100000) + 1;

                try {
                    // Request permission first
                    const permResult = await LocalNotifications.requestPermissions();
                    if (permResult.display !== 'granted') {
                        result = { error: 'Notification permission denied' };
                        break;
                    }

                    await LocalNotifications.schedule({
                        notifications: [{
                            id: notifId,
                            title: title || 'CryptoMAX',
                            body: body || '',
                            smallIcon: 'ic_launcher_small',
                            iconColor: '#0fe2c2',
                        }],
                    });
                    result = { success: true, notifId };
                } catch (e) {
                    result = { error: String(e) };
                }
                break;
            }

            // ─── Native operations (via CryptoBridgePlugin) ───
            case 'downloadFile': {
                // Delegate to native plugin (DownloadManager)
                result = await callNativePlugin('downloadFile', args);
                break;
            }

            case 'decryptTextFile': {
                // Delegate to native plugin (OkHttp download → base64)
                result = await callNativePlugin('decryptTextFile', args);
                break;
            }

            case 'requestMicPermission': {
                // Delegate to native plugin (Android permissions)
                result = await callNativePlugin('requestMicPermission', args);
                break;
            }

            default:
                result = { error: `Unknown method: ${method}` };
        }
    } catch (e) {
        console.error(`[CryptoMAX] Bridge error in ${method}:`, e);
        result = { error: String(e) };
    }

    // Send response back to InAppBrowser
    await respondToBridge(id, result);
}

async function respondToBridge(id: string, result: any): Promise<void> {
    if (!_webviewId) return;
    try {
        await InAppBrowser.postMessage({
            detail: { id, result },
            id: _webviewId,
        });
    } catch (e) {
        console.error('[CryptoMAX] Failed to respond to bridge:', e);
    }
}

// ─── Native Plugin Call (for operations that need Java) ─────────

async function callNativePlugin(method: string, args: any[]): Promise<any> {
    // CryptoBridgePlugin is registered as a Capacitor plugin
    // Access via window.Capacitor.Plugins
    const plugin = (window as any).Capacitor?.Plugins?.CryptoBridge;
    if (!plugin) {
        return { error: 'CryptoBridge plugin not available' };
    }

    try {
        // Build options object from args based on method
        let opts: Record<string, any> = {};
        switch (method) {
            case 'downloadFile':
                opts = { url: args[0], filename: args[1] };
                break;
            case 'decryptTextFile':
                opts = { url: args[0], chatId: args[1] };
                break;
            case 'requestMicPermission':
                // No args needed
                break;
            default:
                return { error: `Unknown native method: ${method}` };
        }
        return await plugin[method](opts);
    } catch (e) {
        return { error: String(e) };
    }
}

// ─── URL / Chat ID Tracking ─────────────────────────────────────

let _currentChatId = '';

function parseChatIdFromUrl(url: string): string {
    try {
        const u = new URL(url);
        const parts = u.pathname.split('/').filter(p => p && p !== '');
        return parts.length > 0 ? parts[parts.length - 1] : '';
    } catch {
        return '';
    }
}

// ─── Main Init ──────────────────────────────────────────────────

async function initApp(): Promise<void> {
    console.log('[CryptoMAX] Initializing secure InAppBrowser architecture...');

    try {
        // Request notification permission on first launch
        await LocalNotifications.requestPermissions();

        // Open web.max.ru in InAppBrowser (ISOLATED from Capacitor)
        const result = await InAppBrowser.openWebView({
            url: 'https://web.max.ru',
            toolbarType: 'blank',           // No toolbar — full screen
            backgroundColor: '#0b0d13',     // Dark background
            isPresentAfterPageLoad: true,    // Show after page loads
            // allowScreenshotsFromWebPage: false,  // Security: no screenshots
        });

        _webviewId = result.id;
        console.log('[CryptoMAX] InAppBrowser opened, id:', _webviewId);

        // ─── Event Listeners ───────────────────────────────────

        // Page loaded → inject scripts
        InAppBrowser.addListener('browserPageLoaded', async (event: any) => {
            console.log('[CryptoMAX] Page loaded:', event?.url || '');
            _currentChatId = parseChatIdFromUrl(event?.url || '');
            _scriptsInjected = false; // Reset on navigation
            await injectAllScripts();
        });

        // URL changed → update chatId, re-inject if needed
        InAppBrowser.addListener('urlChangeEvent', async (event: any) => {
            console.log('[CryptoMAX] URL changed:', event?.url || '');
            _currentChatId = parseChatIdFromUrl(event?.url || '');
        });

        // Bridge: message from InAppBrowser
        InAppBrowser.addListener('messageFromWebview', async (event: any) => {
            await handleBridgeMessage(event);
        });

        // Browser closed → app should close or show error
        InAppBrowser.addListener('closeEvent', () => {
            console.log('[CryptoMAX] InAppBrowser closed');
            _webviewId = null;
            _scriptsInjected = false;
            // Reopen after a short delay (user might have accidentally closed)
            setTimeout(() => {
                if (!_webviewId) initApp();
            }, 1000);
        });

        // Page load error
        InAppBrowser.addListener('pageLoadError', (event: any) => {
            console.error('[CryptoMAX] Page load error:', event);
        });

    } catch (e) {
        console.error('[CryptoMAX] Failed to open InAppBrowser:', e);
        // Retry after delay
        setTimeout(initApp, 3000);
    }
}

// ─── App Lifecycle ──────────────────────────────────────────────

App.addListener('appReady', () => {
    console.log('[CryptoMAX] App ready');
    setTimeout(initApp, 500);
});

App.addListener('resume', () => {
    // Scripts may need re-injection if WebView was refreshed
    if (_webviewId && !_scriptsInjected) {
        setTimeout(injectAllScripts, 1000);
    }
});

// Start
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        setTimeout(initApp, 500);
    });
} else {
    setTimeout(initApp, 500);
}
