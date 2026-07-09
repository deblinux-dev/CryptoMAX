/**
 * preload-main.js — injected into web.max.ru InAppBrowser on Android (Capacitor).
 *
 * MUST be loaded AFTER engine-bundle.js (which exposes window.CryptoEngineAPI).
 *
 * Responsibilities:
 *   1. Message observer  — detect encrypted messages, decrypt IN-PAGE via
 *      CryptoEngineAPI.autoDecode (no bridge call needed for crypto ops),
 *      render Shadow DOM overlays over each bubble.
 *   2. Text file (.txt)  — detect CT1 files in chat, ask native to download
 *      + decrypt (the network request runs in Java, bypassing WebView CORS),
 *      render overlay.
 *   3. Send encrypted text to web.max.ru input field via document.execCommand
 *      and click the Russian-labelled send button.
 *   4. Bridge to parent app via window.mobileApp.postMessage — IPC for password
 *      storage, file download, notifications, mic permission, overlay visibility.
 *
 * NOT in this file (handled separately):
 *   - Floating UI bar  → ui-panel.js (calls window.__cm_* hooks below)
 *   - Engine logic     → engine-bundle.js (exposes window.CryptoEngineAPI)
 *
 * Security model:
 *   - _password stored in closure (NEVER on window)
 *   - Overlays use Shadow DOM (closed) — web.max.ru Svelte cannot read content
 *   - Bridge via window.mobileApp.postMessage (InAppBrowser JS interface)
 *   - web.max.ru CANNOT access window.Capacitor (isolated by InAppBrowser)
 *
 * Bridge protocol (InAppBrowser postMessage IPC):
 *   JS → Parent:  window.mobileApp.postMessage({ detail: { method, args, id } })
 *   Parent → JS:  window.addEventListener('messageFromNative', handler)
 *                 event.detail = { id, result }
 */

(function () {
    'use strict';
    if (window.__cm_injected) return;

    // ════════════════════════════════════════════════════════════
    //  Bridge: InAppBrowser postMessage IPC with parent app
    // ════════════════════════════════════════════════════════════
    //
    //  window.mobileApp is injected by @capgo/capacitor-inappbrowser.
    //  It provides postMessage() for sending messages to the parent app.
    //  The parent responds via window.postMessage → 'messageFromNative' event.
    //
    //  This is SECURE: web.max.ru cannot access window.Capacitor or plugins.
    //  Only window.mobileApp.postMessage is available for communication.

    var _bridgeId = 0;
    var _bridgeCallbacks = {};

    function bridgeCall(method, args) {
        return new Promise(function (resolve, reject) {
            var id = 'b_' + (++_bridgeId);
            _bridgeCallbacks[id] = { resolve: resolve, reject: reject };
            try {
                // Send message to parent app via InAppBrowser bridge
                window.mobileApp.postMessage({
                    detail: {
                        method: method,
                        args: args || [],
                        id: id,
                    },
                });
            } catch (e) {
                delete _bridgeCallbacks[id];
                reject(e);
            }
        });
    }

    // Parent app responds via 'messageFromNative' event
    // event.detail = { id, result }
    window.addEventListener('messageFromNative', function (event) {
        var data = event.detail || event;
        if (!data || !data.id) return;
        var cb = _bridgeCallbacks[data.id];
        if (cb) {
            if (data.result && data.result.error) {
                cb.reject(data.result.error);
            } else {
                cb.resolve(data.result);
            }
            delete _bridgeCallbacks[data.id];
        }
    });

    // Expose for ui-panel.js (so it can call savePassword, getAllPasswords,
    // downloadFile, showNotification, requestMicPermission, etc.)
    window.__cm_bridgeCall = bridgeCall;

    // ════════════════════════════════════════════════════════════
    //  State (closure — _password NEVER on window)
    // ════════════════════════════════════════════════════════════

    var _cmMode = 'aes256';
    var _cmChatId = '';
    var _password = '';            // CLOSURE — never exposed on window
    var _encryptionEnabled = true;
    var _overlaysVisible = true;

    window.__cm_encryptionEnabled = true;
    window.__cm_overlaysVisible = true;

    window.__cm_setMode = function (m) {
        _cmMode = m || 'aes256';
        _encryptionEnabled = (_cmMode !== 'plain');
        window.__cm_encryptionEnabled = _encryptionEnabled;
    };
    window.__cm_setChatId = function (c) {
        _cmChatId = c || '';
    };

    // Password setter — debounced rescan so the user can type without
    // triggering a rescan on every keystroke.
    var _pwdRescanTimer = null;
    window.__cm_setPwd = function (p) {
        p = p || '';
        if (p === _password) return;
        _password = p;
        if (_pwdRescanTimer) clearTimeout(_pwdRescanTimer);
        if (_password) {
            _pwdRescanTimer = setTimeout(function () {
                _processedTexts.clear();
                rescanMessages();
            }, 500);
        }
    };

    // ════════════════════════════════════════════════════════════
    //  Helpers
    // ════════════════════════════════════════════════════════════

    /**
     * Regex trim — strips only \t \n \r and regular space (U+0020).
     * CRITICAL: must NOT use String.prototype.trim(), which also strips
     * Unicode whitespace (U+00A0, U+2002-2005, U+202F, U+205F) used by
     * the invisible-spaces encoder. Stripping them corrupts the encoding.
     */
    function regexTrim(s) {
        if (!s) return '';
        return String(s).replace(/^[\t\n\r ]+/, '').replace(/[\t\n\r ]+$/, '');
    }

    function extractChatIdFromUrl() {
        var parts = window.location.pathname.split('/').filter(function (p) { return p && p !== ''; });
        return parts.length > 0 ? parts[parts.length - 1] : '';
    }

    function escapeHtml(text) {
        var div = document.createElement('div');
        div.textContent = text == null ? '' : String(text);
        return div.innerHTML;
    }

    // ════════════════════════════════════════════════════════════
    //  DOM selectors for web.max.ru
    // ════════════════════════════════════════════════════════════

    var SELECTORS = {
        // Текст сообщения внутри bubble — БЕЗ таймстампа (span.meta — сосед)
        bubbleText: '.bubble .bubbleContent > span.text',
        // Обёртка сообщения в чате
        messageWrapper: '.messageWrapper',
        // Поле ввода (contenteditable div)
        textbox: 'div[role="textbox"]',
        // Кнопка отправки (русский aria-label)
        sendButton: 'button[aria-label*="Отправить сообщение"]',
        // Кнопка скачивания файла (русский aria-label)
        downloadButton: 'button[aria-label="Скачать"]',
        // Контейнер скролла
        chatScrollContent: '.scrollListContent',
        chatScrollable: '.scrollable.scrollListScrollable',
    };

    // ════════════════════════════════════════════════════════════
    //  Message text extraction (preserves emoji spans)
    //
    //  web.max.ru wraps every supported emoji in
    //    <span class="emoji" data-lexical-emoji="EMOJI"><img/></span>
    //  with NO text child, so element.textContent drops the emoji entirely.
    //  This breaks detection of emoji-encoded messages (magic prefix
    //  "😀🔤" of EmojiEncoder). extractRichText restores the original text.
    // ════════════════════════════════════════════════════════════

    function extractRichText(node) {
        if (!node) return '';
        var parts = [];
        var children = node.childNodes;
        for (var i = 0; i < children.length; i++) {
            var cn = children[i];
            if (!cn) continue;
            if (cn.nodeType === Node.TEXT_NODE) {
                if (cn.nodeValue) parts.push(cn.nodeValue);
            } else if (cn.nodeType === Node.ELEMENT_NODE) {
                var cls = cn.className || '';
                if (typeof cls !== 'string') cls = '';
                if (cls.indexOf('emoji') !== -1 && cn.getAttribute) {
                    var emoji = cn.getAttribute('data-lexical-emoji');
                    if (emoji) { parts.push(emoji); continue; }
                }
                parts.push(extractRichText(cn));
            }
        }
        return parts.join('');
    }

    function extractTextFromNode(node) {
        // Основной путь: точный селектор текста bubble
        var bubbleText = node.querySelector(SELECTORS.bubbleText);
        if (bubbleText) {
            var text = regexTrim(extractRichText(bubbleText));
            if (text) return text;
        }

        // Fallback: span.text внутри bubbleContent
        var bubbleContent = node.querySelector('.bubbleContent');
        if (bubbleContent) {
            var spans = bubbleContent.children;
            for (var i = 0; i < spans.length; i++) {
                if (spans[i].classList && spans[i].classList.contains('text')) {
                    var t = regexTrim(extractRichText(spans[i]));
                    if (t) return t;
                }
            }
        }

        // Last resort: сам узел — span.text
        if (node.classList && node.classList.contains('text')) {
            var self = regexTrim(extractRichText(node));
            if (self) return self;
        }
        return '';
    }

    function hasFileAttachment(wrapperNode) {
        if (!wrapperNode) return false;
        return !!wrapperNode.querySelector(
            '.attaches, .photo, .video, .document, .sticker, .gif'
        );
    }

    // ════════════════════════════════════════════════════════════
    //  Processed text dedup
    // ════════════════════════════════════════════════════════════

    var _processedTexts = new Set();
    var _maxProcessedSize = 500;
    var _pendingDecryptNodes = new Map(); // text → .bubble node

    function getUniqueKey(text, node) {
        var idx = '';
        if (node && node.parentNode) {
            var siblings = node.parentNode.children;
            for (var i = 0; i < siblings.length; i++) {
                if (siblings[i] === node) { idx = String(i); break; }
            }
        }
        return text + '\x00' + idx;
    }

    function addToProcessed(key) {
        _processedTexts.add(key);
        if (_processedTexts.size > _maxProcessedSize) {
            var arr = Array.from(_processedTexts);
            _processedTexts = new Set(arr.slice(-300));
        }
    }

    function hasProcessed(key) { return _processedTexts.has(key); }

    // ════════════════════════════════════════════════════════════
    //  Decryption overlay (Shadow DOM closed)
    //  Styles ported from Electron preload-max.js — overflow: visible on
    //  bubble + bordersWrapper, min-height stretch via requestAnimationFrame.
    // ════════════════════════════════════════════════════════════

    var OVERLAY_HOST_STYLE = [
        'position: absolute;',
        'top: 0; left: 0;',
        'width: 100%;',
        'min-height: 100%;',
        'z-index: 99999;',
        'pointer-events: none;',
        'overflow: visible;',
        'background: rgba(11, 13, 19, 0.92);',
        'border-radius: inherit;',
        'box-sizing: border-box;',
    ].join('');

    var OVERLAY_CONTENT_STYLE = [
        'position: relative;',
        'color: #e0e0e0;',
        'font-size: 14px;',
        'line-height: 1.5;',
        'padding: 8px 32px 8px 12px;',
        'white-space: pre-wrap;',
        'word-break: break-word;',
        'overflow-wrap: anywhere;',
        'border-radius: inherit;',
        'box-sizing: border-box;',
        'pointer-events: auto;',
        'user-select: text;',
        'cursor: text;',
        'max-height: 90vh;',
        'overflow-y: auto;',
    ].join('');

    var OVERLAY_LOCK_ICON_STYLE = [
        'display: inline-block;',
        'font-size: 11px;',
        'margin-right: 4px;',
        'opacity: 0.6;',
    ].join('');

    var OVERLAY_COPY_BTN_STYLE = [
        'position: absolute;',
        'top: 4px; right: 4px;',
        'width: 22px; height: 22px;',
        'border: 1px solid rgba(255,255,255,0.15);',
        'border-radius: 4px;',
        'background: rgba(255,255,255,0.08);',
        'color: #aaa;',
        'font-size: 12px;',
        'line-height: 1;',
        'display: flex;',
        'align-items: center;',
        'justify-content: center;',
        'cursor: pointer;',
        'pointer-events: auto;',
        'transition: all 0.15s ease;',
    ].join('');

    var LOCK_SVG = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>';
    var COPY_SVG = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>';
    var CHECK_SVG = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

    function findBubbleForText(text) {
        var main = document.querySelector('main');
        if (!main) return null;
        var bubbles = main.querySelectorAll('.bubble');
        for (var i = 0; i < bubbles.length; i++) {
            var bubbleText = bubbles[i].querySelector('.bubbleContent > span.text');
            if (bubbleText && regexTrim(extractRichText(bubbleText)) === text) {
                return bubbles[i];
            }
        }
        return null;
    }

    function findBordersWrapper(bubbleNode) {
        var walker = bubbleNode.parentElement;
        while (walker && walker !== document.body) {
            var wcn = (walker.className || '').toString();
            if (wcn.indexOf('bordersWrapper') !== -1) return walker;
            walker = walker.parentElement;
        }
        return null;
    }

    function showDecryptedOverlay(originalText, decryptedText) {
        var node = _pendingDecryptNodes.get(originalText);
        _pendingDecryptNodes.delete(originalText);

        // Fallback: если узел пропал из DOM — ищем заново по тексту
        if (!node || !node.parentNode) {
            node = findBubbleForText(originalText);
        }
        if (!node || !node.parentNode) return;

        // Не дублируем overlay
        if (node.querySelector('[data-cm-overlay]')) return;

        // Гарантируем, что bubble позиционирован (для absolute overlay)
        var computed = window.getComputedStyle(node);
        if (computed.position === 'static') {
            node.style.position = 'relative';
        }

        var bordersWrapper = findBordersWrapper(node);

        // Создаём Shadow DOM host
        var host = document.createElement('div');
        host.setAttribute('data-cm-overlay', '1');
        host.style.cssText = OVERLAY_HOST_STYLE;
        if (!_overlaysVisible) host.style.display = 'none';

        var shadow = host.attachShadow({ mode: 'closed' });

        var content = document.createElement('div');
        content.style.cssText = OVERLAY_CONTENT_STYLE;

        var lock = document.createElement('span');
        lock.style.cssText = OVERLAY_LOCK_ICON_STYLE;
        lock.innerHTML = LOCK_SVG;

        var textNode = document.createElement('span');
        textNode.textContent = decryptedText;

        var copyBtn = document.createElement('button');
        copyBtn.style.cssText = OVERLAY_COPY_BTN_STYLE;
        copyBtn.title = 'Копировать';
        copyBtn.innerHTML = COPY_SVG;
        copyBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            try {
                navigator.clipboard.writeText(decryptedText);
                copyBtn.innerHTML = CHECK_SVG;
                copyBtn.style.color = '#00d26a';
                setTimeout(function () {
                    copyBtn.innerHTML = COPY_SVG;
                    copyBtn.style.color = '';
                }, 1500);
            } catch (err) { /* clipboard API may be restricted */ }
        });

        content.appendChild(lock);
        content.appendChild(textNode);
        shadow.appendChild(content);
        shadow.appendChild(copyBtn);

        node.appendChild(host);

        // Снять overflow:hidden — overlay не должен обрезаться
        node.style.setProperty('overflow', 'visible', 'important');
        if (bordersWrapper) {
            bordersWrapper.style.setProperty('overflow', 'visible', 'important');
        }

        // Растянуть bubble под overlay (min-height) — несколько проходов
        // через requestAnimationFrame + таймеры (шрифты, изображения).
        function stretchBubbleToOverlay() {
            try {
                var overlayH = host.offsetHeight;
                var bubbleH = node.offsetHeight;
                if (overlayH > 0 && overlayH > bubbleH) {
                    node.style.setProperty('min-height', (overlayH + 2) + 'px', 'important');
                    if (bordersWrapper) {
                        bordersWrapper.style.setProperty('min-height', (overlayH + 2) + 'px', 'important');
                        bordersWrapper.style.setProperty('height', 'auto', 'important');
                    }
                }
            } catch (e) { /* swallow */ }
        }

        if (window.requestAnimationFrame) {
            window.requestAnimationFrame(function () {
                stretchBubbleToOverlay();
                setTimeout(stretchBubbleToOverlay, 50);
                setTimeout(stretchBubbleToOverlay, 300);
            });
        } else {
            setTimeout(stretchBubbleToOverlay, 50);
        }
    }

    // ════════════════════════════════════════════════════════════
    //  Message processing — decrypt IN-PAGE via CryptoEngineAPI
    //  (no bridge call needed — crypto runs in the WebView)
    // ════════════════════════════════════════════════════════════

    function tryDecrypt(text) {
        if (!_password) return; // wait for password (will retry via rescan)
        if (!window.CryptoEngineAPI || !window.CryptoEngineAPI.isReady()) {
            setTimeout(function () { tryDecrypt(text); }, 500);
            return;
        }

        try {
            // detect() — дешёвая проверка, не запускаем autoDecode на plain-текстах
            var info = window.CryptoEngineAPI.detect(text);
            if (!info || !info.isEncrypted) return;

            window.CryptoEngineAPI.autoDecode(text, _password, _cmChatId)
                .then(function (result) {
                    if (result && result.text && result.text !== text) {
                        showDecryptedOverlay(text, result.text);
                    }
                })
                .catch(function (e) {
                    console.warn('[CryptoMAX] autoDecode failed:', e && e.message);
                });
        } catch (e) {
            console.warn('[CryptoMAX] tryDecrypt error:', e && e.message);
        }
    }

    function processMessageWrapper(wrapperNode) {
        // Пропускаем сообщения с вложениями (текстовые файлы — отдельный обработчик)
        if (hasFileAttachment(wrapperNode)) return;

        var bubble = wrapperNode.querySelector('.bubble') || wrapperNode;
        // Уже расшифровано — не трогаем
        if (bubble.querySelector('[data-cm-overlay]')) return;

        var text = extractTextFromNode(wrapperNode);
        if (!text || text.length < 4 || text.length > 50000) return;

        var key = getUniqueKey(text, wrapperNode);
        if (hasProcessed(key)) return;
        addToProcessed(key);

        _pendingDecryptNodes.set(text, bubble);
        // Держим map ограниченным
        if (_pendingDecryptNodes.size > 200) {
            var keys = Array.from(_pendingDecryptNodes.keys());
            for (var k = 0; k < 50; k++) _pendingDecryptNodes.delete(keys[k]);
        }

        tryDecrypt(text);
    }

    function processExistingMessages(container) {
        if (!container) return;
        var main = container.closest ? container.closest('main') : container;
        var wrappers = main.querySelectorAll('.messageWrapper');
        for (var i = 0; i < wrappers.length; i++) {
            processMessageWrapper(wrappers[i]);
        }
    }

    function findMessageContainer() {
        var main = document.querySelector('main');
        if (!main) return null;
        return main.querySelector(SELECTORS.chatScrollContent)
            || main.querySelector(SELECTORS.chatScrollable)
            || main.querySelector('.openedChat')
            || main;
    }

    function isMessageNode(node) {
        if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
        var cls = node.className || '';
        if (typeof cls !== 'string') cls = '';
        var main = node.closest ? node.closest('main') : null;
        if (!main) return false;
        if (cls.indexOf('messageWrapper') !== -1) return true;
        if (cls.indexOf('block ') !== -1 && node.querySelector('.messageWrapper')) return true;
        if (cls.indexOf('item ') !== -1 && node.querySelector('.messageWrapper')) return true;
        return false;
    }

    var _messageObserver = null;
    var _observedContainer = null;

    function startMessageObserver() {
        var container = findMessageContainer();
        if (!container) { setTimeout(startMessageObserver, 2000); return; }
        if (container === _observedContainer) return;
        _observedContainer = container;

        processExistingMessages(container);

        if (_messageObserver) _messageObserver.disconnect();
        _messageObserver = new MutationObserver(function (mutations) {
            for (var m = 0; m < mutations.length; m++) {
                var added = mutations[m].addedNodes;
                for (var n = 0; n < added.length; n++) {
                    var node = added[n];
                    if (node.nodeType !== Node.ELEMENT_NODE) continue;
                    if (hasFileAttachment(node)) continue;
                    if (isMessageNode(node)) {
                        var wrappers = node.querySelectorAll('.messageWrapper');
                        if (wrappers.length > 0) {
                            for (var w = 0; w < wrappers.length; w++) {
                                processMessageWrapper(wrappers[w]);
                            }
                        } else if (node.classList && node.classList.contains('messageWrapper')) {
                            processMessageWrapper(node);
                        }
                    }
                }
            }
        });
        _messageObserver.observe(container, { childList: true, subtree: true });
    }

    // Rescan all visible messages — used after password becomes available
    function rescanMessages() {
        try {
            var main = document.querySelector('main');
            if (!main) return;
            var wrappers = main.querySelectorAll('.messageWrapper');
            for (var i = 0; i < wrappers.length; i++) {
                processMessageWrapper(wrappers[i]);
            }
        } catch (e) { /* swallow */ }
    }

    // ════════════════════════════════════════════════════════════
    //  Text file (.txt) interception
    //  Ported from text-file-extension.js — queue-based, capture-phase
    //  listener for URL interception (NOT HTMLAnchorElement.prototype.click),
    //  MAX_FILE_SIZE = 2MB, DECRYPT_INTERVAL = 1500ms, reverse order
    //  (newest first), overlay with position:absolute + min-width
    //  preservation + adjustHeight via requestAnimationFrame.
    //  NO expandParents function.
    //
    //  Format CT1: MAGIC(3) "CT1" + IV(12) + AES-256-GCM(text) + tag(16)
    // ════════════════════════════════════════════════════════════

    var TXT_EXTENSION = /\.txt$/i;
    var CT1_MAGIC = [0x43, 0x54, 0x31]; // "CT1"

    var MAX_FILE_SIZE = 2 * 1024 * 1024;       // 2 МБ — лимит размера файла
    var DECRYPT_INTERVAL = 1500;                 // 1.5 сек между декодированиями
    var URL_CAPTURE_TIMEOUT = 3000;              // 3 сек на получение URL
    var POLL_INTERVAL = 3000;                    // 3 сек между проверками DOM

    var _queue = [];                             // очередь кнопок для обработки
    var _isProcessing = false;                   // флаг активной обработки
    var _lastDecryptTime = 0;                    // время последней расшифровки
    var _processedButtons = new WeakSet();       // уже обработанные кнопки
    var _encryptedUrlCache = new Map();          // кэш: URL → isEncrypted|null
    var _sizeCache = new Map();                  // кэш: URL → size

    // ─── Перехват URL через capture-phase event listener ────────────
    //
    // НЕ модифицируем HTMLAnchorElement.prototype.click — это конфликтует
    // с другими расширениями. Вместо этого capture-phase listener на
    // document срабатывает ДО обработчиков Svelte и перехватывает клик
    // по <a download>. Кооперативен — не мешает другим расширениям.

    var _activeCapture = null;  // { resolve, timer }

    function installClickListener() {
        document.addEventListener('click', function (e) {
            if (!_activeCapture) return;

            var target = e.target;
            var anchor = null;
            if (target && target.tagName === 'A' && target.hasAttribute('download')) {
                anchor = target;
            } else if (target && target.closest) {
                anchor = target.closest('a[download]');
            }

            if (anchor && anchor.href) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();

                var cap = _activeCapture;
                _activeCapture = null;
                clearTimeout(cap.timer);
                cap.resolve({ url: anchor.href, filename: anchor.download || '' });
            }
        }, true);  // capture phase — срабатывает раньше обычных обработчиков
    }

    function getDownloadUrl(downloadBtn) {
        return new Promise(function (resolve) {
            var timer = setTimeout(function () {
                if (_activeCapture) _activeCapture = null;
                resolve(null);
            }, URL_CAPTURE_TIMEOUT);

            _activeCapture = {
                resolve: function (info) { resolve(info ? info.url : null); },
                timer: timer,
            };

            try {
                downloadBtn.click();
            } catch (e) {
                clearTimeout(timer);
                _activeCapture = null;
                resolve(null);
            }
        });
    }

    // ─── Best-effort size + magic check (may fail due to CORS) ────

    function getFileSize(url) {
        if (_sizeCache.has(url)) return Promise.resolve(_sizeCache.get(url));
        return fetch(url, { method: 'HEAD' }).then(function (response) {
            var len = parseInt(response.headers.get('Content-Length') || '0', 10);
            if (len > 0) { _sizeCache.set(url, len); return len; }
            return -1; // неизвестный размер
        }).catch(function () { return -1; });
    }

    // Returns: true (encrypted), false (definitely not encrypted), null (couldn't check)
    function checkIfEncrypted(url) {
        if (_encryptedUrlCache.has(url)) return Promise.resolve(_encryptedUrlCache.get(url));
        return fetch(url).then(function (response) {
            var reader = response.body.getReader();
            return reader.read().then(function (chunk) {
                reader.cancel();
                if (chunk.value && chunk.value.length >= 3) {
                    var isEnc = chunk.value[0] === CT1_MAGIC[0] &&
                                chunk.value[1] === CT1_MAGIC[1] &&
                                chunk.value[2] === CT1_MAGIC[2];
                    _encryptedUrlCache.set(url, isEnc);
                    return isEnc;
                }
                return null; // couldn't determine
            });
        }).catch(function () { return null; });
    }

    // ─── Overlay for .txt files (position: absolute, min-width preserved) ────

    var TXT_OVERLAY_HOST_STYLE = [
        'position: absolute;',
        'top: 0; left: 0;',
        'width: 100%;',
        'z-index: 99;',
        'background: rgba(11, 13, 19, 0.98);',
        'border-radius: inherit;',
        'box-sizing: border-box;',
        'pointer-events: auto;',
    ].join('');

    var TXT_OVERLAY_CONTENT_STYLE = [
        'position: relative;',
        'color: #e0e0e0;',
        'font-size: 14px;',
        'line-height: 1.5;',
        'padding: 10px 14px;',
        'white-space: pre-wrap;',
        'word-break: break-word;',
        'overflow-wrap: anywhere;',
        'box-sizing: border-box;',
        'user-select: text;',
        'cursor: text;',
        'max-width: 100%;',
        'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;',
    ].join('');

    var TXT_OVERLAY_HEADER_STYLE = [
        'font-size: 11px;',
        'opacity: 0.55;',
        'margin-bottom: 8px;',
        'display: flex;',
        'align-items: center;',
        'gap: 5px;',
        'user-select: none;',
    ].join('');

    var TXT_OVERLAY_COPY_BTN_STYLE = [
        'position: absolute;',
        'top: 6px; right: 6px;',
        'width: 24px; height: 24px;',
        'border: 1px solid rgba(255,255,255,0.15);',
        'border-radius: 4px;',
        'background: rgba(255,255,255,0.08);',
        'color: #aaa;',
        'display: flex;',
        'align-items: center;',
        'justify-content: center;',
        'cursor: pointer;',
        'transition: all 0.15s ease;',
    ].join('');

    function findMainBubble(btn) {
        var bubble = btn.closest('.bubble');
        if (bubble) return bubble;
        // Fallback: подняться на несколько уровней
        var node = btn;
        for (var i = 0; i < 6 && node; i++) node = node.parentElement;
        return node;
    }

    function showDecryptedTextOverlay(bubbleNode, decryptedText, filename, fileCard) {
        // Не добавляем дубликаты
        if (bubbleNode.querySelector('[data-cm-txt-overlay]')) return;

        // 0. Сохранить исходную ширину bubble ДО скрытия файл-карточки.
        //    .bubble имеет display: flex — при скрытии единственного ребёнка
        //    ширина схлопывается в 0, и текст в overlay переносится по 1
        //    символу на строку.
        var bubbleWidth = bubbleNode.offsetWidth;
        if (bubbleWidth > 0) {
            bubbleNode.style.setProperty('min-width', bubbleWidth + 'px', 'important');
        }

        // 1. Скрыть файл-карточку
        if (fileCard) {
            fileCard.style.setProperty('display', 'none', 'important');
        }

        // 2. Найти bordersWrapper (родитель bubble с overflow:hidden)
        var bordersWrapper = findBordersWrapper(bubbleNode);

        // 3. Создать overlay host (absolute — не участвует в flex layout)
        var host = document.createElement('div');
        host.setAttribute('data-cm-txt-overlay', '1');
        host.style.cssText = TXT_OVERLAY_HOST_STYLE;
        if (!_overlaysVisible) host.style.display = 'none';

        var shadow = host.attachShadow({ mode: 'closed' });

        // 4. Контент overlay
        var content = document.createElement('div');
        content.style.cssText = TXT_OVERLAY_CONTENT_STYLE;

        // Заголовок с именем файла
        var header = document.createElement('div');
        header.style.cssText = TXT_OVERLAY_HEADER_STYLE;
        header.innerHTML = LOCK_SVG + '<span>' + escapeHtml(filename) + '</span>';
        content.appendChild(header);

        // Текст
        var textNode = document.createElement('span');
        textNode.textContent = decryptedText;
        content.appendChild(textNode);

        // Кнопка копирования
        var copyBtn = document.createElement('button');
        copyBtn.style.cssText = TXT_OVERLAY_COPY_BTN_STYLE;
        copyBtn.title = 'Копировать';
        copyBtn.innerHTML = COPY_SVG;
        copyBtn.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            try {
                navigator.clipboard.writeText(decryptedText);
                copyBtn.style.background = 'rgba(76, 175, 80, 0.3)';
                copyBtn.style.color = '#4ade80';
                setTimeout(function () {
                    copyBtn.style.background = '';
                    copyBtn.style.color = '';
                }, 1000);
            } catch (err) { /* swallow */ }
        });
        content.appendChild(copyBtn);

        shadow.appendChild(content);

        // 5. Вставить overlay в bubble
        bubbleNode.appendChild(host);

        // 6. Снять overflow:hidden на bubble и bordersWrapper
        bubbleNode.style.setProperty('overflow', 'visible', 'important');
        if (bordersWrapper) {
            bordersWrapper.style.setProperty('overflow', 'visible', 'important');
        }

        // 7. Измерить высоту overlay и установить min-height на bubble.
        //    requestAnimationFrame + таймеры — на случай, если layout ещё не готов.
        function adjustHeight() {
            var h = host.offsetHeight;
            if (h > 0 && h < 100000) {
                bubbleNode.style.setProperty('min-height', h + 'px', 'important');
                bubbleNode.style.setProperty('height', 'auto', 'important');
                if (bordersWrapper) {
                    bordersWrapper.style.setProperty('min-height', h + 'px', 'important');
                    bordersWrapper.style.setProperty('height', 'auto', 'important');
                }
            }
        }
        if (window.requestAnimationFrame) {
            window.requestAnimationFrame(adjustHeight);
        }
        setTimeout(adjustHeight, 100);
        setTimeout(adjustHeight, 500);
    }

    // ─── Обработка одного файла ─────────────────────────────────────

    function processOneFile(btn) {
        var titleEl = btn.querySelector('.title');
        var svgTextEl = btn.querySelector('text');
        var fileType = svgTextEl ? svgTextEl.textContent.trim().toUpperCase() : '';
        var filename = titleEl ? titleEl.textContent.trim() : '';

        var isTxt = TXT_EXTENSION.test(filename) || fileType === 'TXT';
        if (!isTxt) return Promise.resolve(false); // не .txt — пропустить

        // 1. Получить URL (через перехват anchor.click)
        return getDownloadUrl(btn).then(function (url) {
            if (!url) return false;

            // 2. Best-effort проверка размера (< 2 МБ). Если не удалось
            //    проверить (CORS) — proceed to native, который сделает
            //    свою проверку.
            return getFileSize(url).then(function (size) {
                if (size > MAX_FILE_SIZE) return true; // слишком большой — пометить как обработанный

                // 3. Best-effort проверка CT1 magic
                return checkIfEncrypted(url).then(function (isEncrypted) {
                    if (isEncrypted === false) return true; // точно не зашифрован — не трогаем
                    // isEncrypted === true OR null (couldn't check) — proceed to native
                    return decryptTextFileViaNative(btn, url, filename);
                });
            });
        });
    }

    function decryptTextFileViaNative(btn, url, filename) {
        var bubble = findMainBubble(btn);
        if (!bubble) return Promise.resolve(true);
        var fileCard = btn.closest('.attaches') || btn.parentElement;

        // 4. Скачать файл через native (network request runs in Java —
        //    bypasses WebView CORS, has access to auth cookies).
        //    Java возвращает base64 файла. JS проверяет CT1 magic и расшифровывает.
        return bridgeCall('decryptTextFile', [url, _cmChatId]).then(function (result) {
            if (result && result.success && result.base64) {
                // Декодировать base64 в байты
                var binaryString = atob(result.base64);
                var bytes = new Uint8Array(binaryString.length);
                for (var i = 0; i < binaryString.length; i++) {
                    bytes[i] = binaryString.charCodeAt(i);
                }

                // Проверить CT1 magic (0x43, 0x54, 0x31 = "CT1")
                if (bytes.length < 3 || bytes[0] !== 0x43 || bytes[1] !== 0x54 || bytes[2] !== 0x31) {
                    console.log('[CryptoMAX TextFile] Не CT1:', filename);
                    return true; // не зашифрованный .txt
                }

                // Расшифровать через CryptoEngineAPI (Web Crypto, in-page)
                var base64Ct = result.base64;
                if (window.CryptoEngineAPI) {
                    window.CryptoEngineAPI.decrypt(base64Ct, _password, 'textfile', _cmChatId)
                        .then(function (decryptedText) {
                            btn.style.setProperty('display', 'none', 'important');
                            showDecryptedTextOverlay(bubble, decryptedText, filename, fileCard);
                            console.log('[CryptoMAX TextFile] Расшифрован:', filename,
                                '(' + decryptedText.length + ' символов)');
                        })
                        .catch(function (e) {
                            console.log('[CryptoMAX TextFile] Ошибка расшифровки:', filename, e.message);
                        });
                }
            } else {
                console.log('[CryptoMAX TextFile] Не скачан:', filename,
                    result ? result.error : 'unknown');
            }
            return true; // пометить как обработанный
        }).catch(function (e) {
            console.error('[CryptoMAX TextFile] Ошибка:', filename, e);
            return true; // пометить как обработанный (не пытаться снова)
        });
    }

    // ─── Очередь: обрабатывать по одному файлу за раз ───────────────

    function processQueue() {
        if (_isProcessing) return;
        _isProcessing = true;

        function next() {
            if (_queue.length === 0) { _isProcessing = false; return; }
            var btn = _queue.shift();

            if (_processedButtons.has(btn) || !document.body.contains(btn)) {
                setTimeout(next, 0);
                return;
            }

            // Соблюдать интервал между декодированиями
            var now = Date.now();
            var wait = DECRYPT_INTERVAL - (now - _lastDecryptTime);

            function runOne() {
                processOneFile(btn).then(function (done) {
                    if (done) _processedButtons.add(btn);
                    _lastDecryptTime = Date.now();
                    setTimeout(next, 0);
                }).catch(function (e) {
                    console.error('[CryptoMAX TextFile] processQueue error:', e);
                    setTimeout(next, 0);
                });
            }

            if (wait > 0) setTimeout(runOne, wait);
            else runOne();
        }

        next();
    }

    // ─── Сканирование DOM на наличие .txt файлов ────────────────────
    //
    // Идём с КОНЦА (от самых новых сообщений к старым).
    // В чате web.max.ru новые сообщения внизу (последние в DOM),
    // поэтому обратный обход добавляет их в очередь первыми,
    // и они расшифровываются первыми (очередь FIFO через shift()).

    function scanForTxtFiles() {
        var dlBtns = document.querySelectorAll(SELECTORS.downloadButton);
        var added = 0;

        for (var i = dlBtns.length - 1; i >= 0; i--) {
            var btn = dlBtns[i];
            if (_processedButtons.has(btn)) continue;
            if (_queue.indexOf(btn) !== -1) continue; // уже в очереди
            if (btn.closest('[data-cm-txt-done]')) continue;

            // Быстрая проверка: .txt ли это?
            var titleEl = btn.querySelector('.title');
            var svgTextEl = btn.querySelector('text');
            var fileType = svgTextEl ? svgTextEl.textContent.trim().toUpperCase() : '';
            var filename = titleEl ? titleEl.textContent.trim() : '';

            var isTxt = TXT_EXTENSION.test(filename) || fileType === 'TXT';
            if (!isTxt) {
                _processedButtons.add(btn); // не .txt — больше не проверяем
                continue;
            }

            _queue.push(btn);
            added++;
        }

        if (added > 0) {
            processQueue(); // запустить очередь (неблокирующе)
        }
    }

    function startTextFileScanner() {
        // Установить capture-phase listener для перехвата URL
        installClickListener();

        // Периодический опрос DOM
        setInterval(scanForTxtFiles, POLL_INTERVAL);

        // Также запускать при изменениях DOM
        var observer = new MutationObserver(function () {
            setTimeout(scanForTxtFiles, 200);
        });
        observer.observe(document.body, { childList: true, subtree: true });

        // Первый запуск
        setTimeout(scanForTxtFiles, 1500);

        console.log('[CryptoMAX TextFile] Extension started (queue-based, max ' +
            (MAX_FILE_SIZE / 1024 / 1024) + 'MB, interval ' + DECRYPT_INTERVAL + 'ms)');
    }

    // ════════════════════════════════════════════════════════════
    //  Send encrypted text to web.max.ru input field
    //  Port from preload-max.js — execCommand + Russian aria-labels.
    //  The textbox we target is NOT inside messageWrapper (otherwise
    //  we'd be typing into a quoted message preview).
    // ════════════════════════════════════════════════════════════

    function findInputTextbox() {
        var all = document.querySelectorAll(SELECTORS.textbox);
        for (var i = 0; i < all.length; i++) {
            var tb = all[i];
            // НЕ внутри messageWrapper (текст чужого сообщения)
            // НЕ внутри нашего overlay
            if (!tb.closest('.messageWrapper') &&
                !tb.closest('[data-cm-overlay]') &&
                !tb.closest('[data-cm-txt-overlay]')) {
                return tb;
            }
        }
        return null;
    }

    function findSendButton() {
        var btn = document.querySelector(SELECTORS.sendButton);
        if (btn && !btn.disabled) return btn;

        // Fallback: ищем кнопку с SVG (не disabled)
        var btns = document.querySelectorAll('button');
        for (var i = 0; i < btns.length; i++) {
            var b = btns[i];
            if (b.disabled) continue;
            var svg = b.querySelector('svg');
            if (svg && svg.innerHTML.length > 10) return b;
        }
        return null;
    }

    function sendEncryptedText(encodedText) {
        try {
            window.__cm_sending = true;
            var tb = findInputTextbox();
            if (!tb) { window.__cm_sending = false; return false; }

            tb.focus();
            try {
                document.execCommand('selectAll', false, null);
                document.execCommand('delete', false, null);
                document.execCommand('insertText', false, encodedText);
            } catch (e) {
                tb.textContent = encodedText;
            }
            tb.dispatchEvent(new Event('input', { bubbles: true }));
            tb.dispatchEvent(new Event('change', { bubbles: true }));

            setTimeout(function () {
                var btn = findSendButton();
                if (btn && !btn.disabled) {
                    btn.click();
                } else {
                    // Fallback: Enter
                    tb.dispatchEvent(new KeyboardEvent('keydown', {
                        key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true,
                    }));
                }
                window.__cm_sending = false;
            }, 200);
            return true;
        } catch (e) {
            window.__cm_sending = false;
            console.error('[CryptoMAX] sendEncryptedText error:', e && e.message);
            return false;
        }
    }

    // Expose for ui-panel.js — ui-panel encrypts (via CryptoEngineAPI) and
    // calls this to inject the encoded text into web.max.ru's input.
    window.__cm_send_encrypted = sendEncryptedText;

    // ════════════════════════════════════════════════════════════
    //  Overlay visibility toggle (for ui-panel.js)
    // ════════════════════════════════════════════════════════════

    function setOverlaysVisible(visible) {
        _overlaysVisible = !!visible;
        window.__cm_overlaysVisible = _overlaysVisible;

        var overlays = document.querySelectorAll('[data-cm-overlay], [data-cm-txt-overlay]');
        for (var i = 0; i < overlays.length; i++) {
            overlays[i].style.display = _overlaysVisible ? '' : 'none';
        }

        // Notify native (for toggle button state)
        bridgeCall('setOverlayVisibility', [_overlaysVisible]).catch(function () {});
    }

    // Expose for ui-panel.js to toggle overlays
    window.__cm_setOverlaysVisible = setOverlaysVisible;

    // ════════════════════════════════════════════════════════════
    //  URL observer — SPA navigation, chatId updates
    //  web.max.ru is a SPA: navigating between chats changes the URL
    //  without a page reload. We watch for URL changes and:
    //    1. Update _cmChatId from the new URL
    //    2. Request the saved password for the new chat
    //    3. Clear processed messages and rescan
    // ════════════════════════════════════════════════════════════

    var _lastUrl = '';

    function loadSavedPasswordForCurrentChat() {
        if (!_cmChatId) return;
        bridgeCall('getPassword', [_cmChatId]).then(function (pwd) {
            if (pwd) {
                _password = pwd;
                // Clear processed texts so messages are re-decrypted with new pwd
                _processedTexts.clear();
                _pendingDecryptNodes.clear();
                setTimeout(rescanMessages, 500);
                console.log('[CryptoMAX] Loaded saved password for chat:', _cmChatId);
            }
        }).catch(function (e) {
            console.warn('[CryptoMAX] getPassword failed:', e);
        });
    }

    function onUrlChange() {
        var newId = extractChatIdFromUrl();
        if (newId !== _cmChatId) {
            _cmChatId = newId;
            // Reset state for the new chat
            _processedTexts.clear();
            _pendingDecryptNodes.clear();
            _observedContainer = null;
            _password = ''; // clear until saved password loads
            // Reload saved password for the new chat
            loadSavedPasswordForCurrentChat();
            // Restart message observer on the new chat container
            setTimeout(startMessageObserver, 1500);
        }
    }

    function startUrlObserver() {
        _lastUrl = location.href;
        var observer = new MutationObserver(function () {
            if (location.href !== _lastUrl) {
                _lastUrl = location.href;
                console.log('[CryptoMAX] URL changed:', location.href);
                onUrlChange();
            }
        });
        observer.observe(document, { subtree: true, childList: true });

        // Also poll every 1s — MutationObserver may miss pushState changes
        setInterval(function () {
            if (location.href !== _lastUrl) {
                _lastUrl = location.href;
                onUrlChange();
            }
        }, 1000);
    }

    // ════════════════════════════════════════════════════════════
    //  Init sequence
    // ════════════════════════════════════════════════════════════

    function init() {
        console.log('[CryptoMAX] preload-main.js initializing');

        // 1. Start URL observer (catches SPA navigation immediately)
        startUrlObserver();

        // 2. Get chatId from URL + request saved password from native
        _cmChatId = extractChatIdFromUrl();
        loadSavedPasswordForCurrentChat();

        // 3. Start message observer (will retry until container found)
        setTimeout(startMessageObserver, 1500);

        // 4. Periodic re-check of message container (handles chat switches
        //    where the URL observer might miss)
        setInterval(function () {
            var container = findMessageContainer();
            if (container && container !== _observedContainer) {
                _observedContainer = null;
                startMessageObserver();
            }
        }, 5000);

        // 5. Start text file scanner
        setTimeout(startTextFileScanner, 2000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // ════════════════════════════════════════════════════════════
    //  Public debug / integration API
    // ════════════════════════════════════════════════════════════

    window.CryptoMAX = {
        rescanMessages: rescanMessages,
        setOverlaysVisible: setOverlaysVisible,
        bridgeCall: bridgeCall,
        getMode: function () { return _cmMode; },
        getChatId: function () { return _cmChatId; },
        hasPassword: function () { return !!_password; },
    };

    window.__cm_injected = true;

    console.log('[CryptoMAX] preload-main.js loaded (bridge ready, engine ' +
        (window.CryptoEngineAPI ? 'available' : 'PENDING — load engine-bundle.js first') + ')');
})();
