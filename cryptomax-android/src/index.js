/**
 * CryptoMAX — Main controller (plain JavaScript, no TypeScript)
 *
 * Opens web.max.ru in InAppBrowser (isolated from Capacitor plugins).
 * Injects crypto scripts. Bridges messages between InAppBrowser and native.
 *
 * SECURITY: web.max.ru CANNOT access window.Capacitor or plugins.
 * Only window.mobileApp.postMessage is available for communication.
 */

(function () {
    'use strict';

    // ─── Capacitor Plugins (via global, no ES imports) ────────────
    // In Capacitor 8, plugins are accessible via window.Capacitor.Plugins
    var InAppBrowser = window.Capacitor && window.Capacitor.Plugins
        ? window.Capacitor.Plugins.CapgoInAppBrowser || window.Capacitor.Plugins.InAppBrowser
        : null;
    var Preferences = window.Capacitor && window.Capacitor.Plugins
        ? window.Capacitor.Plugins.Preferences
        : null;
    var LocalNotifications = window.Capacitor && window.Capacitor.Plugins
        ? window.Capacitor.Plugins.LocalNotifications
        : null;
    var App = window.Capacitor && window.Capacitor.Plugins
        ? window.Capacitor.Plugins.App
        : null;
    var CryptoBridge = window.Capacitor && window.Capacitor.Plugins
        ? window.Capacitor.Plugins.CryptoBridge
        : null;

    // ─── State ────────────────────────────────────────────────────
    var webviewId = null;
    var scriptsInjected = false;
    var currentChatId = '';

    var ALLOWED_METHODS = {
        savePassword: true,
        getPassword: true,
        getAllPasswords: true,
        removePassword: true,
        getChatId: true,
        downloadFile: true,
        decryptTextFile: true,
        showNotification: true,
        requestMicPermission: true,
        setOverlayVisibility: true,
    };

    // ─── Script Loading ───────────────────────────────────────────

    function loadScript(filename) {
        return fetch('cap-scripts/' + filename)
            .then(function (resp) {
                if (!resp.ok) throw new Error('HTTP ' + resp.status);
                return resp.text();
            })
            .catch(function (e) {
                console.error('[CryptoMAX] Failed to load ' + filename + ':', e);
                return '';
            });
    }

    function injectScript(filename) {
        return loadScript(filename).then(function (code) {
            if (!code || !webviewId) return false;
            return InAppBrowser.executeScript({ code: code, id: webviewId })
                .then(function () {
                    console.log('[CryptoMAX] Injected: ' + filename);
                    return true;
                })
                .catch(function (e) {
                    console.error('[CryptoMAX] Injection failed for ' + filename + ':', e);
                    return false;
                });
        });
    }

    function injectAllScripts() {
        if (scriptsInjected || !webviewId) return Promise.resolve();
        scriptsInjected = true;

        return injectScript('engine-bundle.js')
            .then(function () { return new Promise(function (r) { setTimeout(r, 500); }); })
            .then(function () { return injectScript('preload-main.js'); })
            .then(function () { return new Promise(function (r) { setTimeout(r, 500); }); })
            .then(function () { return injectScript('ui-panel.js'); })
            .then(function () {
                console.log('[CryptoMAX] All scripts injected');
            });
    }

    // ─── Bridge Handler ───────────────────────────────────────────

    function handleBridgeMessage(event) {
        var data = event.detail || event;
        if (!data || !data.method || !data.id) {
            console.warn('[CryptoMAX] Invalid bridge message:', data);
            return Promise.resolve();
        }

        var method = data.method;
        var args = data.args || [];
        var id = data.id;

        if (!ALLOWED_METHODS[method]) {
            console.warn('[CryptoMAX] Blocked unauthorized method: ' + method);
            return respondToBridge(id, { error: 'Method not allowed' });
        }

        console.log('[CryptoMAX] Bridge: ' + method);
        var result;

        try {
            switch (method) {
                case 'savePassword':
                    if (!args[0] || !args[1]) {
                        result = { error: 'Missing chatId or password' };
                    } else {
                        result = Preferences.set({ key: 'cm_pw_' + args[0], value: args[1] })
                            .then(function () { return { success: true }; });
                    }
                    break;

                case 'getPassword':
                    if (!args[0]) {
                        result = { error: 'Missing chatId' };
                    } else {
                        result = Preferences.get({ key: 'cm_pw_' + args[0] })
                            .then(function (r) { return { password: r.value }; });
                    }
                    break;

                case 'getAllPasswords':
                    result = Preferences.keys().then(function (r) {
                        var passwords = {};
                        var promises = [];
                        for (var i = 0; i < r.keys.length; i++) {
                            (function (key) {
                                if (key.indexOf('cm_pw_') === 0) {
                                    promises.push(Preferences.get({ key: key }).then(function (pr) {
                                        if (pr.value) passwords[key.substring(6)] = pr.value;
                                    }));
                                }
                            })(r.keys[i]);
                        }
                        return Promise.all(promises).then(function () {
                            return { passwords: passwords, count: Object.keys(passwords).length };
                        });
                    });
                    break;

                case 'removePassword':
                    if (args[0]) {
                        result = Preferences.remove({ key: 'cm_pw_' + args[0] })
                            .then(function () { return { success: true }; });
                    } else {
                        result = { success: true };
                    }
                    break;

                case 'getChatId':
                    result = { chatId: currentChatId };
                    break;

                case 'setOverlayVisibility':
                    result = Preferences.set({
                        key: 'cm_overlays_visible',
                        value: args[0] ? 'true' : 'false'
                    }).then(function () { return { success: true }; });
                    break;

                case 'showNotification':
                    var notifId = Math.floor(Math.random() * 100000) + 1;
                    result = LocalNotifications.requestPermissions().then(function (perm) {
                        if (perm.display !== 'granted') return { error: 'Permission denied' };
                        return LocalNotifications.schedule({
                            notifications: [{
                                id: notifId,
                                title: args[0] || 'CryptoMAX',
                                body: args[1] || '',
                            }]
                        }).then(function () { return { success: true, notifId: notifId }; });
                    });
                    break;

                case 'downloadFile':
                    result = CryptoBridge.downloadFile({ url: args[0], filename: args[1] });
                    break;

                case 'decryptTextFile':
                    result = CryptoBridge.decryptTextFile({ url: args[0], chatId: args[1] });
                    break;

                case 'requestMicPermission':
                    result = CryptoBridge.requestMicPermission({});
                    break;

                default:
                    result = { error: 'Unknown method: ' + method };
            }
        } catch (e) {
            console.error('[CryptoMAX] Bridge error in ' + method + ':', e);
            result = { error: String(e) };
        }

        // Handle both promises and plain objects
        return Promise.resolve(result).then(
            function (r) { return respondToBridge(id, r); },
            function (e) { return respondToBridge(id, { error: String(e) }); }
        );
    }

    function respondToBridge(id, result) {
        if (!webviewId) return Promise.resolve();
        return InAppBrowser.postMessage({ detail: { id: id, result: result }, id: webviewId })
            .catch(function (e) {
                console.error('[CryptoMAX] Failed to respond to bridge:', e);
            });
    }

    // ─── URL / Chat ID Tracking ───────────────────────────────────

    function parseChatIdFromUrl(url) {
        try {
            var u = new URL(url);
            var parts = u.pathname.split('/').filter(function (p) { return p && p !== ''; });
            return parts.length > 0 ? parts[parts.length - 1] : '';
        } catch (e) {
            return '';
        }
    }

    // ─── Main Init ────────────────────────────────────────────────

    function initApp() {
        console.log('[CryptoMAX] Initializing...');

        if (!InAppBrowser) {
            console.error('[CryptoMAX] InAppBrowser plugin not available!');
            updateLoader('Ошибка: InAppBrowser plugin не найден');
            return;
        }

        if (!Preferences) {
            console.error('[CryptoMAX] Preferences plugin not available!');
        }

        if (!CryptoBridge) {
            console.error('[CryptoMAX] CryptoBridge plugin not available!');
        }

        console.log('[CryptoMAX] Available plugins:', Object.keys(window.Capacitor.Plugins || {}));

        // Request notification permission
        if (LocalNotifications) {
            LocalNotifications.requestPermissions().catch(function () {});
        }

        // Open web.max.ru in InAppBrowser
        InAppBrowser.openWebView({
            url: 'https://web.max.ru',
            toolbarType: 'blank',
            backgroundColor: '#0b0d13',
            isPresentAfterPageLoad: true,
        }).then(function (result) {
            webviewId = result.id;
            console.log('[CryptoMAX] InAppBrowser opened, id:', webviewId);

            // Page loaded → inject scripts
            InAppBrowser.addListener('browserPageLoaded', function (event) {
                console.log('[CryptoMAX] Page loaded:', event && event.url ? event.url : '');
                currentChatId = parseChatIdFromUrl(event && event.url ? event.url : '');
                scriptsInjected = false;
                injectAllScripts();
            });

            // URL changed
            InAppBrowser.addListener('urlChangeEvent', function (event) {
                console.log('[CryptoMAX] URL changed:', event && event.url ? event.url : '');
                currentChatId = parseChatIdFromUrl(event && event.url ? event.url : '');
            });

            // Bridge messages from InAppBrowser
            InAppBrowser.addListener('messageFromWebview', function (event) {
                handleBridgeMessage(event);
            });

            // Browser closed
            InAppBrowser.addListener('closeEvent', function () {
                console.log('[CryptoMAX] InAppBrowser closed');
                webviewId = null;
                scriptsInjected = false;
                setTimeout(function () {
                    if (!webviewId) initApp();
                }, 1000);
            });

            // Page load error
            InAppBrowser.addListener('pageLoadError', function (event) {
                console.error('[CryptoMAX] Page load error:', event);
            });

        }).catch(function (e) {
            console.error('[CryptoMAX] Failed to open InAppBrowser:', e);
            updateLoader('Ошибка: ' + (e.message || String(e)));
            setTimeout(initApp, 3000);
        });
    }

    function updateLoader(msg) {
        var p = document.querySelector('.loader p');
        if (p) p.textContent = msg;
    }

    // ─── App Lifecycle ────────────────────────────────────────────

    if (App) {
        App.addListener('appReady', function () {
            console.log('[CryptoMAX] App ready');
            setTimeout(initApp, 300);
        });
        App.addListener('resume', function () {
            if (webviewId && !scriptsInjected) {
                setTimeout(injectAllScripts, 1000);
            }
        });
    }

    // Start
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { setTimeout(initApp, 300); });
    } else {
        setTimeout(initApp, 300);
    }

    // Fallback: if appReady doesn't fire, start after 2 seconds
    setTimeout(function () {
        if (!webviewId) {
            console.log('[CryptoMAX] Fallback init after 2s timeout');
            initApp();
        }
    }, 2000);

})();
