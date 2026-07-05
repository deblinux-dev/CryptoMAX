// Text-file extension для CryptoMAX Electron.
//
// Перехватывает .txt файлы в чате web.max.ru, тихо скачивает их
// и пытается расшифровать паролем чата (формат CT1).
// При успехе — заменяет файл-сообщение на Shadow DOM overlay с текстом.
//
// Архитектура:
//   - Очередь обработки (один файл за раз, без гонки состояний)
//   - Проверка размера файла (< 2 МБ, защита от переполнения)
//   - Интервал между декодированиями (1.5 сек, защита от rate-limit)
//   - Overlay растягивает родительские контейнеры под контент
//
// Формат CT1: MAGIC(3) "CT1" + IV(12) + AES-256-GCM(text) + tag(16)

(function () {
    'use strict';

    var ipcRenderer = window.__cm_ipc;
    if (!ipcRenderer) {
        console.error('[CryptoMAX TextFile] IPC bridge not available');
        return;
    }

    var TXT_EXTENSION = /\.txt$/i;
    var CT1_MAGIC = [0x43, 0x54, 0x31]; // "CT1"

    // ─── Конфигурация ───────────────────────────────────────────────

    var MAX_FILE_SIZE = 2 * 1024 * 1024;      // 2 МБ — лимит размера файла
    var DECRYPT_INTERVAL = 1500;                // 1.5 сек между декодированиями
    var URL_CAPTURE_TIMEOUT = 3000;             // 3 сек на получение URL
    var POLL_INTERVAL = 3000;                   // 3 сек между проверками DOM

    // ─── Очередь обработки (один файл за раз) ───────────────────────

    var _queue = [];                             // очередь кнопок для обработки
    var _isProcessing = false;                   // флаг активной обработки
    var _lastDecryptTime = 0;                    // время последней расшифровки
    var _processedButtons = new WeakSet();       // уже обработанные кнопки
    var _encryptedUrlCache = new Map();          // кэш: URL → isEncrypted
    var _sizeCache = new Map();                  // кэш: URL → size

    // ─── Перехват URL через capture-phase event listener ────────────
    //
    // НЕ модифицируем HTMLAnchorElement.prototype.click — это конфликтует
    // с audio-extension.js, который тоже перехватывает этот метод.
    // Вместо этого используем capture-phase listener на document:
    // он срабатывает ДО обработчиков Svelte и перехватывает клик по <a download>.
    // Кооперативен — не мешает audio-extension.

    var _activeCapture = null;  // { resolve, timer }

    function installClickListener() {
        document.addEventListener('click', function (e) {
            if (!_activeCapture) return;

            // Найти <a> с атрибутом download (целевой элемент клика)
            var target = e.target;
            var anchor = null;
            if (target && target.tagName === 'A' && target.hasAttribute('download')) {
                anchor = target;
            } else if (target && target.closest) {
                anchor = target.closest('a[download]');
            }

            if (anchor && anchor.href) {
                // Перехватить клик — предотвратить скачивание
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
                if (_activeCapture) {
                    _activeCapture = null;
                }
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

    // ─── Утилиты ────────────────────────────────────────────────────

    function getCurrentChatId() {
        var pathname = window.location.pathname;
        var parts = pathname.split('/').filter(function (p) { return p && p !== ''; });
        return parts.length > 0 ? parts[parts.length - 1] : null;
    }

    // Получить размер файла из Content-Length (без полного скачивания)
    async function getFileSize(url) {
        if (_sizeCache.has(url)) return _sizeCache.get(url);
        try {
            var response = await fetch(url, { method: 'HEAD' });
            var len = parseInt(response.headers.get('Content-Length') || '0', 10);
            if (len > 0) {
                _sizeCache.set(url, len);
                return len;
            }
        } catch (e) {}
        return -1; // неизвестный размер
    }

    // Проверить CT1 magic (скачивает только первые байты)
    async function checkIfEncrypted(url) {
        if (_encryptedUrlCache.has(url)) return _encryptedUrlCache.get(url);
        try {
            var response = await fetch(url);
            var reader = response.body.getReader();
            var chunk = await reader.read();
            reader.cancel();
            if (chunk.value && chunk.value.length >= 3) {
                var isEnc = chunk.value[0] === CT1_MAGIC[0] &&
                            chunk.value[1] === CT1_MAGIC[1] &&
                            chunk.value[2] === CT1_MAGIC[2];
                _encryptedUrlCache.set(url, isEnc);
                return isEnc;
            }
        } catch (e) {}
        return false;
    }

    // ─── Overlay: растягивает родительские контейнеры ───────────────
    //
    // Подход:
    //   1. Скрыть файл-карточку (.attaches)
    //   2. Вставить overlay как relative-элемент (пузырь растёт естественно)
    //   3. Установить overflow: visible на обрезающих контейнерах
    //      (.bubble, .bordersWrapper и др.)

    var OVERLAY_STYLE = [
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

    var HEADER_STYLE = [
        'font-size: 11px;',
        'opacity: 0.55;',
        'margin-bottom: 8px;',
        'display: flex;',
        'align-items: center;',
        'gap: 5px;',
        'user-select: none;',
    ].join('');

    var COPY_BTN_STYLE = [
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

    function escapeHtml(text) {
        var div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // Найти главный bubble-контейнер (с .bubble классом)
    function findMainBubble(btn) {
        var bubble = btn.closest('.bubble');
        if (bubble) return bubble;
        // Fallback: подняться на несколько уровней
        var node = btn;
        for (var i = 0; i < 6 && node; i++) {
            node = node.parentElement;
        }
        return node;
    }

    // Показать расшифрованный текст в overlay
    function showDecryptedTextOverlay(bubbleNode, decryptedText, filename, fileCard) {
        // Не добавляем дубликаты
        if (bubbleNode.querySelector('[data-cm-txt-overlay]')) return;

        // 0. Сохранить исходную ширину bubble ДО скрытия файл-карточки.
        //    .bubble имеет display: flex — при скрытии единственного ребёнка
        //    (файл-карточки) ширина схлопывается в 0, и текст в overlay
        //    переносится по 1 символу на строку.
        var bubbleWidth = bubbleNode.offsetWidth;
        if (bubbleWidth > 0) {
            bubbleNode.style.setProperty('min-width', bubbleWidth + 'px', 'important');
        }

        // 1. Скрыть файл-карточку
        if (fileCard) {
            fileCard.style.setProperty('display', 'none', 'important');
        }

        // 2. Найти bordersWrapper (родитель bubble с overflow:hidden)
        var bordersWrapper = null;
        var walker = bubbleNode.parentElement;
        while (walker && walker !== document.body) {
            var wcn = (walker.className || '').toString();
            if (wcn.indexOf('bordersWrapper') !== -1) { bordersWrapper = walker; break; }
            walker = walker.parentElement;
        }

        // 3. Создать overlay host (absolute — не участвует в flex layout,
        //    не растягивается flex-контейнером)
        var host = document.createElement('div');
        host.setAttribute('data-cm-txt-overlay', '1');
        host.style.cssText = 'position: absolute; top: 0; left: 0; width: 100%; z-index: 99; background: rgba(11, 13, 19, 0.98); border-radius: inherit; box-sizing: border-box; pointer-events: auto;';

        var shadow = host.attachShadow({ mode: 'closed' });

        // 4. Контент overlay
        var content = document.createElement('div');
        content.style.cssText = OVERLAY_STYLE;

        // Заголовок с именем файла
        var header = document.createElement('div');
        header.style.cssText = HEADER_STYLE;
        header.innerHTML = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg><span>' + escapeHtml(filename) + '</span>';
        content.appendChild(header);

        // Текст
        var textNode = document.createElement('span');
        textNode.textContent = decryptedText;
        content.appendChild(textNode);

        // Кнопка копирования
        var copyBtn = document.createElement('button');
        copyBtn.style.cssText = COPY_BTN_STYLE;
        copyBtn.title = 'Копировать';
        copyBtn.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>';
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
            } catch (e) {}
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
        //    Это заставит bubble (и его предков) вырасти под контент overlay.
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
        requestAnimationFrame(adjustHeight);
        setTimeout(adjustHeight, 100);
        setTimeout(adjustHeight, 500);
    }

    // ─── Обработка одного файла ─────────────────────────────────────

    async function processOneFile(btn) {
        var titleEl = btn.querySelector('.title');
        var svgTextEl = btn.querySelector('text');
        var fileType = svgTextEl ? svgTextEl.textContent.trim().toUpperCase() : '';
        var filename = titleEl ? titleEl.textContent.trim() : '';

        var isTxt = TXT_EXTENSION.test(filename) || fileType === 'TXT';
        if (!isTxt) return false; // не .txt — пропустить

        // 1. Получить URL (через перехват anchor.click)
        var url = await getDownloadUrl(btn);
        if (!url) {
            console.log('[CryptoMAX TextFile] URL не получен для:', filename);
            return false;
        }

        // 2. Проверить размер файла (< 2 МБ)
        var size = await getFileSize(url);
        if (size > MAX_FILE_SIZE) {
            console.log('[CryptoMAX TextFile] Файл слишком большой:', filename, size, 'байт');
            return true; // пометить как обработанный (больше не пытаться)
        }

        // 3. Проверить CT1 magic
        var isEncrypted = await checkIfEncrypted(url);
        if (!isEncrypted) {
            return true; // обычный .txt — не трогаем
        }

        // 4. Найти bubble и файл-карточку
        var bubble = findMainBubble(btn);
        if (!bubble) return true;
        var fileCard = btn.closest('.attaches') || btn.parentElement;

        // 5. Расшифровать через main process
        var chatId = getCurrentChatId();
        console.log('[CryptoMAX TextFile] Расшифровка:', filename, 'chatId:', chatId);

        try {
            var result = await ipcRenderer.invoke('decrypt-text-file', {
                url: url,
                chatId: chatId,
            });

            if (result && result.success && result.text) {
                // Скрыть кнопку скачивания
                btn.style.setProperty('display', 'none', 'important');
                // Показать overlay
                showDecryptedTextOverlay(bubble, result.text, filename, fileCard);
                console.log('[CryptoMAX TextFile] Расшифрован:', filename, '(' + result.text.length + ' символов)');
                return true;
            } else {
                console.log('[CryptoMAX TextFile] Не расшифрован:', filename, result ? result.error : 'unknown');
                return true; // пометить как обработанный (не пытаться снова)
            }
        } catch (e) {
            console.error('[CryptoMAX TextFile] Ошибка:', filename, e);
            return true; // пометить как обработанный
        }
    }

    // ─── Очередь: обрабатывать по одному файлу за раз ───────────────

    async function processQueue() {
        if (_isProcessing) return;
        _isProcessing = true;

        try {
            while (_queue.length > 0) {
                var btn = _queue.shift();

                // Пропустить уже обработанные
                if (_processedButtons.has(btn)) continue;
                if (!document.body.contains(btn)) continue;

                // Соблюдать интервал между декодированиями
                var now = Date.now();
                var wait = DECRYPT_INTERVAL - (now - _lastDecryptTime);
                if (wait > 0) {
                    await new Promise(function (r) { setTimeout(r, wait); });
                }

                // Обработать файл
                var done = await processOneFile(btn);
                if (done) {
                    _processedButtons.add(btn);
                }
                _lastDecryptTime = Date.now();
            }
        } catch (e) {
            console.error('[CryptoMAX TextFile] processQueue error:', e);
        } finally {
            _isProcessing = false;
        }
    }

    // ─── Сканирование DOM на наличие .txt файлов ────────────────────
    //
    // Идём с КОНЦА (от самых новых сообщений к старым).
    // В чате web.max.ru новые сообщения внизу (последние в DOM),
    // поэтому обратный обход добавляет их в очередь первыми,
    // и они расшифровываются первыми (очередь FIFO через shift()).

    function scanForTxtFiles() {
        var dlBtns = document.querySelectorAll('button[aria-label="Скачать"]');
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

    // ─── Запуск наблюдателя ─────────────────────────────────────────

    function startObserver() {
        // Установить capture-phase listener для перехвата URL (до любых обработчиков)
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

        console.log('[CryptoMAX TextFile] Extension started (queue-based, max ' + (MAX_FILE_SIZE / 1024 / 1024) + 'MB, interval ' + DECRYPT_INTERVAL + 'ms)');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            setTimeout(startObserver, 2000);
        });
    } else {
        setTimeout(startObserver, 2000);
    }

})();
