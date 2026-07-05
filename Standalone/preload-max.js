/**
 * CryptoMAX — preload для BrowserView web.max.ru.
 *
 * КРИТИЧНО ДЛЯ БЕЗОПАСНОСТИ:
 * - Работает в ИЗОЛИРОВАННОМ preload-контексте (contextIsolation=true)
 * - БЕЗ инъекции content-скриптов — web.max.ru НЕ может обнаружить наш код
 * - БЕЗ contextBridge — web.max.ru НЕ может вызывать наши функции
 * - Только наблюдение за DOM (чтение) и манипуляции (ввод, клик)
 * - Вся криптография — в панели, здесь её нет
 *
 * Коммуникация:
 * - preload --> main:  ipcRenderer.send('incoming-message', data)
 * - main --> preload:  ipcRenderer.on('do-send-message', handler)
 * - main --> preload:  ipcRenderer.on('show-decrypted-overlay', handler) — Shadow DOM дешифровка
 *
 * Структура DOM web.max.ru (проверено 2026-06-29):
 *   main > .openedChat > .history > .history > .scrollable > .scrollListContent
 *     > .item > .block > .messageWrapper
 *       > .message > .message--isOut > [data-bubbles-variant] > .bordersWrapper
 *         > .bubble > .bubbleContent
 *           > span.text   <-- текст сообщения (чистый, без таймстампа)
 *           > span.meta   <-- таймстамп (нужно исключать)
 */

const { ipcRenderer, contextBridge } = require('electron');

// Состояние

let _messageObserver = null;
let _urlObserver = null;
let _lastUrl = '';
let _processedTexts = new Set();
let _maxProcessedSize = 500;
let _observedContainer = null;
let _pendingDecryptNodes = new Map(); // текст --> DOM-узел (.bubble), для Shadow DOM overlay

// DOM-селекторы для web.max.ru

const SELECTORS = {
    // Страница входа
    phoneInput: 'input.field',
    countryButton: 'button.country',
    signInButton: 'button.button--primary.button--stretched',

    // Поле ввода в чате
    textbox: 'div[role="textbox"]',
    sendButton: 'button[aria-label*="Отправить сообщение"]',

    // Текст сообщения внутри bubble — БЕЗ таймстампа (span.meta — соседний элемент)
    bubbleText: '.bubble .bubbleContent > span.text',

    // Обёртка сообщения в области чата
    messageWrapper: '.messageWrapper',

    // Блок с одной или несколькими обёртками сообщений
    messageBlock: '.block',

    // Скроллируемый контейнер сообщений (внутри <main>)
    chatScrollContent: '.scrollListContent',
    chatScrollable: '.scrollable.scrollListScrollable',
};

// Утилиты

function extractChatId() {
    var parts = window.location.pathname.split('/').filter(function (p) { return p && p !== ''; });
    return parts.length > 0 ? parts[parts.length - 1] : '';
}

/**
 * Извлекает текст из узла, восстанавливая эмодзи, которые web.max.ru
 * оборачивает в <span class="emoji" data-lexical-emoji="EMOJI"><img/></span>.
 *
 * web.max.ru рендерит каждый «поддерживаемый» эмодзи как такой span с <img>
 * внутри и БЕЗ текстового дочернего узла. Поэтому element.textContent
 * возвращает пустую строку для таких span'ов, что незаметно вырезает эмодзи
 * (включая MAGIC-префикс "😀🔤" кодера EmojiEncoder) из извлечённого текста
 * сообщения и ломает детект/декодирование эмодзи-сообщений.
 *
 * Этот обходчик восстанавливает исходный текст:
 *   - добавляет сырой текст текстовых узлов,
 *   - берёт атрибут `data-lexical-emoji` для emoji-span'ов,
 *   - рекурсивно обходит остальные элементы.
 *
 * Для plain-text сообщений результат идентичен textContent, так что это
 * безопасная универсальная замена.
 */
function extractRichText(node) {
    if (!node) return '';
    var parts = [];
    var children = node.childNodes;
    for (var i = 0; i < children.length; i++) {
        var cn = children[i];
        if (!cn) continue;
        if (cn.nodeType === Node.TEXT_NODE) {
            // 3 — текстовый узел
            if (cn.nodeValue) parts.push(cn.nodeValue);
        } else if (cn.nodeType === Node.ELEMENT_NODE) {
            // 1 — элемент
            var cls = cn.className || '';
            if (typeof cls !== 'string') cls = '';
            // Emoji-span: берём исходный эмодзи из атрибута
            if (cls.indexOf('emoji') !== -1 && cn.getAttribute) {
                var emoji = cn.getAttribute('data-lexical-emoji');
                if (emoji) {
                    parts.push(emoji);
                    continue;
                }
            }
            // Любой другой элемент: рекурсивно
            var inner = extractRichText(cn);
            if (inner) parts.push(inner);
        }
        // Node.COMMENT_NODE (8) и прочие пропускаем
    }
    return parts.join('');
}

/**
 * Извлекает чистый текст сообщения из узла.
 * Использует точный DOM-путь web.max.ru: .bubble > .bubbleContent > span.text
 * Исключает таймстамп (span.meta), который является соседним элементом.
 *
 * Важно: использует extractRichText (не textContent), чтобы эмодзи,
 * обёрнутые в <span class="emoji" data-lexical-emoji="..."><img/></span>
 * сайтом web.max.ru, сохранялись — включая MAGIC-префикс "😀🔤" кодера EmojiEncoder.
 */
function extractTextFromNode(node) {
    // Основной путь: точный селектор текста bubble в web.max.ru
    var bubbleText = node.querySelector(SELECTORS.bubbleText);
    if (bubbleText) {
        // ВНИМАНИЕ: НЕ используем .trim() — он вырезает Unicode whitespace
        // (U+00A0, U+2002-2005, U+202F, U+205F), которые invisible-spaces encoder
        // использует для кодирования. Используем regex trim (только \t\n\r space).
        var text = extractRichText(bubbleText).replace(/^[\t\n\r ]+/, '').replace(/[\t\n\r ]+$/, '');
        if (text) return text;
    }

    // Fallback: ищем любой прямой дочерний span.text внутри bubbleContent
    var bubbleContent = node.querySelector('.bubbleContent');
    if (bubbleContent) {
        var spans = bubbleContent.children;
        for (var i = 0; i < spans.length; i++) {
            if (spans[i].classList && spans[i].classList.contains('text')) {
                var t = extractRichText(spans[i]).replace(/^[\t\n\r ]+/, '').replace(/[\t\n\r ]+$/, '');
                if (t) return t;
            }
        }
    }

    // Последний вариант: если сам узел — span.text
    if (node.classList && node.classList.contains('text')) {
        var self = extractRichText(node).replace(/^[\t\n\r ]+/, '').replace(/[\t\n\r ]+$/, '');
        if (self) return self;
    }

    return '';
}

/**
 * Проверяет, является ли узел обёрткой сообщения в области чата (внутри <main>).
 * Исключает совпадения с элементами сайдбара.
 */
function isMessageNode(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;

    var cls = node.className || '';
    if (typeof cls !== 'string') cls = '';

    // Должен быть внутри <main>, чтобы не матчить сайдбар
    var main = node.closest ? node.closest('main') : null;
    if (!main) {
        // Fallback: проверяем предков вручную
        var p = node.parentNode;
        while (p && p !== document) {
            if (p.tagName === 'MAIN') { main = p; break; }
            p = p.parentNode;
        }
    }
    if (!main) return false;

    // Распознаём messageWrapper (основной контейнер сообщения)
    if (cls.indexOf('messageWrapper') !== -1) return true;

    // Распознаём .block (содержит messageWrapper'ы, добавляется группой)
    if (cls.indexOf('block ') !== -1 && node.querySelector('.messageWrapper')) return true;

    // Распознаём .item (элемент scroll list, содержит .block)
    if (cls.indexOf('item ') !== -1 && node.querySelector('.messageWrapper')) return true;

    return false;
}

function getUniqueKey(text, node) {
    // Комбинация текста + индекса позиции внутри родителя для уникальности
    var idx = '';
    if (node.parentNode) {
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

function hasProcessed(key) {
    return _processedTexts.has(key);
}

// Обработка сообщений

/**
 * Обрабатывает один узел-сообщение: извлекает чистый текст и отправляет в main process.
 */
function processMessageWrapper(wrapperNode) {
    var text = extractTextFromNode(wrapperNode);
    if (!text || text.length === 0 || text.length > 50000) return;

    var key = getUniqueKey(text, wrapperNode);
    if (hasProcessed(key)) return;
    addToProcessed(key);

    // Сохраняем ссылку на .bubble для Shadow DOM overlay
    var bubble = wrapperNode.querySelector('.bubble') || wrapperNode;
    _pendingDecryptNodes.set(text, bubble);

    // Держим map ограниченным по размеру
    if (_pendingDecryptNodes.size > 200) {
        var keys = Array.from(_pendingDecryptNodes.keys());
        for (var k = 0; k < 50; k++) {
            _pendingDecryptNodes.delete(keys[k]);
        }
    }

    var chatId = extractChatId();

    console.log('CryptoMAX: Found message, sending for decrypt check:', text.substring(0, 60) + (text.length > 60 ? '...' : ''));

    ipcRenderer.send('incoming-message', {
        text: text,
        chatId: chatId || '',
    });
}

/**
 * Обрабатывает все существующие сообщения в контейнере.
 */
function processExistingMessages(container) {
    if (!container) return;

    // Ищем messageWrapper только внутри <main>
    var main = container.closest ? container.closest('main') : container;
    var wrappers = main.querySelectorAll('.messageWrapper');

    console.log('CryptoMAX: Processing', wrappers.length, 'existing messages');

    for (var i = 0; i < wrappers.length; i++) {
        processMessageWrapper(wrappers[i]);
    }
}

// Наблюдатель за сообщениями

/**
 * Находит скроллируемый контейнер сообщений внутри <main>.
 * Структура web.max.ru: main > .openedChat > .history > .history > .scrollable > .scrollListContent
 */
function findMessageContainer() {
    var main = document.querySelector('main');
    if (!main) return null;

    // Основной путь: скроллируемый контейнер контента
    var container = main.querySelector(SELECTORS.chatScrollContent);
    if (container) return container;

    // Fallback: скроллируемая обёртка
    container = main.querySelector(SELECTORS.chatScrollable);
    if (container) return container;

    // Fallback: элемент .openedChat
    container = main.querySelector('.openedChat');
    if (container) return container;

    // Fallback: сам main
    return main;
}

function startMessageObserver() {
    var container = findMessageContainer();

    if (!container) {
        setTimeout(startMessageObserver, 2000);
        return;
    }

    if (container === _observedContainer) return;
    _observedContainer = container;

    console.log('CryptoMAX: Observer attached to', container.className);

    // Обрабатываем существующие сообщения в чате
    processExistingMessages(container);

    // Следим за новыми сообщениями
    if (_messageObserver) {
        _messageObserver.disconnect();
    }

    _messageObserver = new MutationObserver(function (mutations) {
        for (var m = 0; m < mutations.length; m++) {
            var mutation = mutations[m];
            for (var n = 0; n < mutation.addedNodes.length; n++) {
                var node = mutation.addedNodes[n];
                if (node.nodeType !== Node.ELEMENT_NODE) continue;

                if (isMessageNode(node)) {
                    // Добавленный узел — это messageWrapper или .block/.item с обёртками
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

    _messageObserver.observe(container, {
        childList: true,
        subtree: true,
    });
}

// Детект SPA-навигации

function startUrlObserver() {
    _lastUrl = location.href;

    _urlObserver = new MutationObserver(function () {
        if (location.href !== _lastUrl) {
            _lastUrl = location.href;

            ipcRenderer.send('incoming-message', {
                text: '__url_change__',
                chatId: extractChatId(),
            });

            // Перенаблюдаем за сообщениями нового чата
            _observedContainer = null;
            _processedTexts.clear();
            setTimeout(startMessageObserver, 1500);
        }
    });

    _urlObserver.observe(document, {
        subtree: true,
        childList: true,
    });
}

// Отправка сообщения (вызывается по IPC из main process)

function sendMessage(text) {
    return new Promise(function (resolve, reject) {
        try {
            var textbox = document.querySelector(SELECTORS.textbox);
            if (!textbox) {
                reject('Textbox not found (div[role="textbox"])');
                return;
            }

            textbox.focus();

            try {
                document.execCommand('selectAll', false, null);
                document.execCommand('delete', false, null);
                document.execCommand('insertText', false, text);
            } catch (e) {
                textbox.textContent = text;
            }

            textbox.dispatchEvent(new Event('input', { bubbles: true }));
            textbox.dispatchEvent(new Event('change', { bubbles: true }));

            setTimeout(function () {
                var sendBtn = document.querySelector(SELECTORS.sendButton);

                if (!sendBtn) {
                    var buttons = document.querySelectorAll('button');
                    for (var b = 0; b < buttons.length; b++) {
                        var svg = buttons[b].querySelector('svg');
                        if (svg && !buttons[b].disabled && svg.innerHTML.length > 10) {
                            sendBtn = buttons[b];
                            break;
                        }
                    }
                }

                if (sendBtn && !sendBtn.disabled) {
                    sendBtn.click();
                    resolve(true);
                } else {
                    textbox.dispatchEvent(new KeyboardEvent('keydown', {
                        key: 'Enter',
                        code: 'Enter',
                        keyCode: 13,
                        bubbles: true,
                    }));
                    resolve(true);
                }
            }, 200);

        } catch (e) {
            reject(e.message || String(e));
        }
    });
}

// Shadow DOM overlay с расшифрованным текстом
// При успешной дешифровке создаёт Shadow DOM overlay поверх bubble,
// чтобы расшифрованный текст был виден ТОЛЬКО клиенту.
// JS web.max.ru (Svelte) не может читать содержимое Shadow DOM.

// Хост-контейнер overlay: абсолютное позиционирование поверх bubble,
// НО высота НЕ фиксирована — overlay растёт под содержимое, чтобы длинный
// расшифрованный текст (кириллица шире латиницы, переносы строк) не обрезался.
// min-height: 100% гарантирует, что короткий текст всё равно перекроет bubble.
var _overlayHostStyle = [
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

// Контент overlay: обычный блочный поток (position: relative), растёт с текстом.
// max-height + overflow-y — страховка для экстремально длинных текстов (>90vh):
// такой текст не обрезается навсегда, а прокручивается внутри overlay.
var _overlayContentStyle = [
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

var _overlayLockIcon = [
    'display: inline-block;',
    'font-size: 11px;',
    'margin-right: 4px;',
    'opacity: 0.6;',
].join('');

var _copyBtnStyle = [
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

var _copyBtnHoverStyle = [
    'background: rgba(255,255,255,0.18);',
    'color: #fff;',
    'border-color: rgba(255,255,255,0.3);',
].join('');

function showDecryptedOverlay(originalText, decryptedText) {
    var node = _pendingDecryptNodes.get(originalText);
    _pendingDecryptNodes.delete(originalText);

    if (!node || !node.parentNode) {
        // Узел пропал из DOM — ищем внутри <main> по тексту bubble
        var main = document.querySelector('main');
        if (main) {
            var bubbles = main.querySelectorAll('.bubble');
            for (var i = 0; i < bubbles.length; i++) {
                var bubbleText = bubbles[i].querySelector('.bubbleContent > span.text');
                if (bubbleText && extractRichText(bubbleText).replace(/^[\t\n\r ]+/, '').replace(/[\t\n\r ]+$/, '') === originalText) {
                    node = bubbles[i];
                    break;
                }
            }
        }
    }

    if (!node || !node.parentNode) return;

    // Не добавляем дубликаты overlay
    if (node.querySelector('[data-cm-overlay]')) return;

    // Гарантируем, что bubble позиционирован
    var computed = window.getComputedStyle(node);
    if (computed.position === 'static') {
        node.style.position = 'relative';
    }

    // Создаём Shadow DOM host — заполняет bubble целиком через absolute
    var host = document.createElement('div');
    host.setAttribute('data-cm-overlay', '1');
    host.style.cssText = _overlayHostStyle;

    // Прикрепляем shadow root — контент изолирован от web.max.ru
    var shadow = host.attachShadow({ mode: 'closed' });

    // Строим контент overlay
    var content = document.createElement('div');
    content.style.cssText = _overlayContentStyle;

    var lock = document.createElement('span');
    lock.style.cssText = _overlayLockIcon;
    // SVG замок-открыт из Lucide (офлайн, встроенный)
    lock.innerHTML = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>';

    var textNode = document.createElement('span');
    textNode.textContent = decryptedText;

    // Кнопка копирования (правый верхний угол overlay) — SVG clipboard из Lucide
    var copyBtn = document.createElement('button');
    copyBtn.style.cssText = _copyBtnStyle;
    copyBtn.title = 'Копировать (очищается через 30 сек)';
    copyBtn.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>';
    copyBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        ipcRenderer.send('secure-copy', { text: decryptedText });
        // Визуальный фидбек — SVG галочки из Lucide
        copyBtn.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
        copyBtn.style.color = '#00d26a';
        setTimeout(function () {
            copyBtn.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>';
            copyBtn.style.color = '';
        }, 1500);
    });
    copyBtn.addEventListener('mouseenter', function () {
        copyBtn.style.cssText = _copyBtnStyle + _copyBtnHoverStyle;
    });
    copyBtn.addEventListener('mouseleave', function () {
        copyBtn.style.cssText = _copyBtnStyle;
    });

    content.appendChild(lock);
    content.appendChild(textNode);
    shadow.appendChild(content);
    // Кнопку копирования крепим к host (а не content), чтобы она оставалась
    // в правом верхнем углу даже при прокрутке длинного текста внутри content.
    shadow.appendChild(copyBtn);

    // Перехватываем copy на shadow root для безопасного буфера
    // (пользователь выделяет текст + Ctrl+C)
    shadow.addEventListener('copy', function (e) {
        e.preventDefault();
        var sel = window.getSelection();
        var selectedText = sel ? sel.toString() : '';
        if (selectedText) {
            ipcRenderer.send('secure-copy', { text: selectedText });
        }
    });

    // Добавляем host как последний дочерний элемент bubble
    node.appendChild(host);

    // Принудительно растягиваем bubble (и его родителей) под overlay
    // Проблема: overlay с position: absolute расширяется под содержимое, но
    // родительский .bubble остаётся исходной высоты --> если bubble или его
    // предки имеют ограниченную высоту / overflow: hidden, overlay визуально
    // обрезается. Решение: измерить реальную высоту overlay после рендера и
    // установить min-height на bubble, чтобы контейнер рос под overlay.
    function stretchBubbleToOverlay() {
        try {
            var overlayH = host.offsetHeight; // реальная высота overlay
            var bubbleH = node.offsetHeight;   // текущая высота bubble
            if (overlayH > bubbleH) {
                // Растягиваем bubble до высоты overlay (+ запас 2px на border-radius)
                node.style.minHeight = (overlayH + 2) + 'px';
            }
        } catch (e) {
            console.warn('CryptoMAX: stretchBubbleToOverlay error:', e);
        }
    }
    // Измерение после вставки в DOM + после рендера шрифтов.
    // requestAnimationFrame даёт браузеру возможность отрисовать содержимое
    // shadow root, чтобы offsetHeight был корректным.
    if (window.requestAnimationFrame) {
        window.requestAnimationFrame(function () {
            stretchBubbleToOverlay();
            // Повторное измерение после загрузки шрифтов/изображений (через 50мс)
            setTimeout(stretchBubbleToOverlay, 50);
            // И финальное — через 300мс (на случай медленного рендера)
            setTimeout(stretchBubbleToOverlay, 300);
        });
    } else {
        setTimeout(stretchBubbleToOverlay, 50);
    }

    console.log('CryptoMAX: Shadow DOM overlay applied for message:', originalText.substring(0, 40) + '...');
}

// IPC-слушатели (из main process)

ipcRenderer.on('do-send-message', function (event, text) {
    sendMessage(text).then(function () {
        // Сообщение успешно отправлено
    }).catch(function (err) {
        console.error('CryptoMAX: Send failed:', err);
    });
});

ipcRenderer.on('show-decrypted-overlay', function (event, data) {
    if (data && data.originalText && data.decryptedText) {
        showDecryptedOverlay(data.originalText, data.decryptedText);
    }
});

// send-encrypted-file: прикрепить зашифрованный ZIP/TXT и отправить в чат
// Метод: paste с ClipboardEvent на input textbox (не внутри messageWrapper).
// web.max.ru принимает paste с файлом и автоматически отправляет сообщение
// с вложением. Проверено на файлах до 100KB+.
// data: { buffer: ArrayBuffer, filename: string, mimeType?: string }
ipcRenderer.on('send-encrypted-file', function (event, data) {
    console.log('CryptoMAX: send-encrypted-file received:', data ? {
        hasBuffer: !!data.buffer,
        bufferByteLength: data.buffer ? data.buffer.byteLength : 0,
        filename: data.filename,
        mimeType: data.mimeType || '(default: application/zip)',
    } : 'no data');

    if (!data || !data.buffer || !data.filename) {
        console.error('CryptoMAX: send-encrypted-file — нет данных');
        return;
    }
    try {
        // 1. Найти INPUT textbox (НЕ внутри messageWrapper/message--isOut/In).
        //    Используем надёжный селектор без svelte-хэшей.
        var allTextboxes = document.querySelectorAll('div[role="textbox"]');
        var inputTextbox = null;
        for (var i = 0; i < allTextboxes.length; i++) {
            var tb = allTextboxes[i];
            if (!tb.closest('.messageWrapper') &&
                !tb.closest('.message--isOut') &&
                !tb.closest('.message--isIn')) {
                inputTextbox = tb;
                break;
            }
        }
        if (!inputTextbox) {
            console.error('CryptoMAX: input textbox не найден (нет открытого чата?)');
            return;
        }

        // 2. Focus
        inputTextbox.focus();

        // 3. Создать File из буфера
        var bytes = new Uint8Array(data.buffer);
        var mimeType = data.mimeType || 'application/zip';
        var blob = new Blob([bytes], { type: mimeType });
        var file = new File([blob], data.filename, { type: mimeType });

        console.log('CryptoMAX: File created:', file.name, file.size, 'bytes, type:', file.type,
            '| first 3 bytes:', bytes.length >= 3 ? [bytes[0], bytes[1], bytes[2]] : 'too short');

        // 4. DataTransfer + ClipboardEvent('paste')
        var dt = new DataTransfer();
        dt.items.add(file);
        var pasteEv = new ClipboardEvent('paste', {
            clipboardData: dt,
            bubbles: true,
            cancelable: true,
        });
        inputTextbox.dispatchEvent(pasteEv);

        console.log('CryptoMAX: paste dispatched for', data.filename,
            '(' + bytes.length + ' bytes)',
            'defaultPrevented:', pasteEv.defaultPrevented);
    } catch (e) {
        console.error('CryptoMAX: send-encrypted-file error:', e);
    }
});

// Переключение видимости overlay (из тулбара)
ipcRenderer.on('set-overlays-visible', function (event, data) {
    var visible = data && data.visible !== false;
    var overlays = document.querySelectorAll('[data-cm-overlay]');
    for (var i = 0; i < overlays.length; i++) {
        overlays[i].style.display = visible ? '' : 'none';
    }
    console.log('CryptoMAX: Overlays', visible ? 'shown' : 'hidden', '(' + overlays.length + ' elements)');
});

//

// Аудио-расширение: плееры, запись, зашифрованные голосовые.
// Bridge __cm_ipc выставляется в main world через contextBridge,
// сам скрипт audio-extension.js внедряет main process через executeJavaScript
// (после загрузки страницы), чтобы он выполнялся в main world и мог
// перехватывать прототипы (HTMLAnchorElement.click и т.п.).

var _bridgeExposed = false;
function exposeAudioBridge() {
    if (_bridgeExposed) return;
    _bridgeExposed = true;
    try {
        contextBridge.exposeInMainWorld('__cm_ipc', {
            send: function(channel, data) { ipcRenderer.send(channel, data); },
            sendSync: function(channel, data) { return ipcRenderer.sendSync(channel, data); },
            invoke: function(channel, data) { return ipcRenderer.invoke(channel, data); },
            on: function(channel, handler) {
                ipcRenderer.on(channel, function(event) {
                    var args = Array.prototype.slice.call(arguments, 1);
                    handler.apply(null, args);
                });
            },
        });
        console.log('CryptoMAX: __cm_ipc bridge выставлен в main world');
    } catch (e) {
        // contextBridge может выдать ошибку при повторном вызове на той же странице
        console.log('CryptoMAX: bridge уже существует или ошибка:', e.message);
    }
}



// Инициализация

function init() {
    console.log('CryptoMAX: preload-max.js initializing');

    // Запускаем URL-наблюдатель для детекта SPA-навигации
    startUrlObserver();

    // Выставляем bridge для audio-extension.js в main world
    exposeAudioBridge();

    // Запускаем наблюдатель за сообщениями (повторяет попытки, пока не найдёт контейнер)
    if (document.readyState === 'complete') {
        setTimeout(startMessageObserver, 1000);
    } else {
        window.addEventListener('load', function () {
            setTimeout(startMessageObserver, 1000);
        });
    }

    // Периодическая перепроверка контейнера сообщений (на случай поздних изменений DOM, переключений чата)
    setInterval(function () {
        var container = findMessageContainer();
        if (container && container !== _observedContainer) {
            console.log('CryptoMAX: Message container changed, re-attaching observer');
            _observedContainer = null;
            startMessageObserver();
        }
    }, 5000);
}

// Стартуем, когда DOM готов
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
