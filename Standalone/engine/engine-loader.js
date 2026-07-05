/**
 * Загрузчик движка CryptoMAX.
 *
 * Динамически подгружает все скрипты движка Stegonator в правильном порядке
 * и выставляет наружу чистый CryptoEngineAPI на window.
 *
 * Конвейер кодирования — повторяет оригинальный Stegonator:
 *
 *   layout   --> LayoutSwitchEncoder.encodeString(text, false)
 *              Без шифрования, без magic-префикса. Просто переключение EN<->RU.
 *
 *   aes256   --> CleanCrypto.encrypt(text, pwd, chatId) --> _bytesToBase64url(bytes)
 *              Полное AES-256-GCM шифрование, вывод чистый base64url (начинается с "Q1JZ").
 *              Без текстового magic-префикса.
 *
 *   invisible / base64 / compression / emoji / chinese
 *           --> CleanCrypto.encrypt(text, pwd, chatId) --> encoder.encode(bytes)
 *              Зашифрованные байты оборачиваются в magic-префикс конкретного кодера.
 *
 * Декодирование / авто-декодирование — повторяет _tryAutoDecode из оригинального main.js:
 *   1. detectEncoder(text) --> совпадение по magic-префиксу --> decode --> decrypt
 *   2. _base64urlToBytes(text) --> decrypt (ловит режим aes256)
 *   3. LayoutSwitchEncoder.decodeToString(text) (для layout без magic)
 */

(function () {
    'use strict';

    window.CryptoEngineAPI = null;
    window._cryptoEngineReady = false;
    window._cryptoEngineError = null;

    // Хелперы

    function loadScript(src) {
        return new Promise(function (resolve, reject) {
            var s = document.createElement('script');
            s.src = src;
            s.onload = resolve;
            s.onerror = function () {
                reject(new Error('Failed to load script: ' + src));
            };
            document.head.appendChild(s);
        });
    }

    // Bootstrap модуля (запускается как ES-модуль)

    var MODULE_CODE = [
        'import CleanCrypto from "./engine/js/core/clean-crypto.js";',
        'import CompactCipher from "./engine/js/core/compact-cipher.js";',
        'import LayoutSwitchEncoder from "./engine/js/core/encoders/layout-switch-encoder.js";',
        'import { getEncoderById, detectEncoder, getEncoderList } from "./engine/js/core/encoders/index.js";',
        '// Electron-прослойка (не ядро Стегонатора): умный лингвистический',
        '// анализатор неверной раскладки — заменяет простой regex-фильтр в',
        '// autoDecode (блок 3) на анализ частотности гласных, морфемных маркеров,',
        '// невозможных биграмм и защиту URL/email/base64-токенов.',
        'import LayoutAnalyzer from "./layout-analyzer.js";',
        '',
        '(function() {',
        '    "use strict";',
        '',
        '    var crypto = new CleanCrypto();',
        '    var compactCipher = new CompactCipher();',
        '',
        '    // Хелперы base64url (как в оригинальном main.js)', 
        '',
        '    var B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";',
        '    var B64_DECODE = new Map();',
        '    B64_CHARS.split("").forEach(function(ch, i) { B64_DECODE.set(ch, i); });',
        '',
        '    function _bytesToBase64url(bytes) {',
        '        var result = "";',
        '        for (var i = 0; i < bytes.length; i += 3) {',
        '            var a = bytes[i];',
        '            var b = i + 1 < bytes.length ? bytes[i + 1] : 0;',
        '            var c = i + 2 < bytes.length ? bytes[i + 2] : 0;',
        '            var bits = (a << 16) | (b << 8) | c;',
        '            result += B64_CHARS[(bits >> 18) & 0x3F];',
        '            result += B64_CHARS[(bits >> 12) & 0x3F];',
        '            result += (i + 1 < bytes.length) ? B64_CHARS[(bits >> 6) & 0x3F] : "";',
        '            result += (i + 2 < bytes.length) ? B64_CHARS[bits & 0x3F] : "";',
        '        }',
        '        return result;',
        '    }',
        '',
        '    function _base64urlToBytes(str) {',
        '        if (!str) return null;',
        '        if (str.length === 0) return new Uint8Array(0);',
        '        var len = str.length;',
        '        var remainder = len % 4;',
        '        if (remainder === 1) return null;',
        '        var outputLen;',
        '        if (remainder === 0) outputLen = Math.floor(len / 4) * 3;',
        '        else if (remainder === 2) outputLen = Math.floor(len / 4) * 3 + 1;',
        '        else outputLen = Math.floor(len / 4) * 3 + 2;',
        '        var bytes = new Uint8Array(outputLen);',
        '        var byteIdx = 0;',
        '        var i = 0;',
        '        while (i + 4 <= len) {',
        '            var a = B64_DECODE.get(str[i++]) || 0;',
        '            var b = B64_DECODE.get(str[i++]) || 0;',
        '            var c = B64_DECODE.get(str[i++]) || 0;',
        '            var d = B64_DECODE.get(str[i++]) || 0;',
        '            var bits = (a << 18) | (b << 12) | (c << 6) | d;',
        '            if (byteIdx < outputLen) bytes[byteIdx++] = (bits >> 16) & 0xFF;',
        '            if (byteIdx < outputLen) bytes[byteIdx++] = (bits >> 8) & 0xFF;',
        '            if (byteIdx < outputLen) bytes[byteIdx++] = bits & 0xFF;',
        '        }',
        '        if (remainder === 2) {',
        '            var a2 = B64_DECODE.get(str[i]) || 0;',
        '            var b2 = B64_DECODE.get(str[i + 1]) || 0;',
        '            if (byteIdx < outputLen) bytes[byteIdx++] = ((a2 << 2) | (b2 >> 4)) & 0xFF;',
        '        } else if (remainder === 3) {',
        '            var a3 = B64_DECODE.get(str[i]) || 0;',
        '            var b3 = B64_DECODE.get(str[i + 1]) || 0;',
        '            var c3 = B64_DECODE.get(str[i + 2]) || 0;',
        '            if (byteIdx < outputLen) bytes[byteIdx++] = ((a3 << 2) | (b3 >> 4)) & 0xFF;',
        '            if (byteIdx < outputLen) bytes[byteIdx++] = ((b3 << 4) | (c3 >> 2)) & 0xFF;',
        '        }',
        '        return bytes;',
        '    }',
        '',
        '    // Соответствие subMode --> id кодера', 
        '',
        '    var SUBMODE_ENCODER_MAP = {',
        '        "invisible": "invisible-spaces",',
        '        "base64": "base64",',
        '        "compression": "compression",',
        '        "emoji": "emoji",',
        '        "chinese": "chinese"',
        '    };',
        '',
        '    // CryptoEngineAPI', 
        '',
        '    window.CryptoEngineAPI = {',
        '',
        '        /**',
        '         * КОДИРОВАНИЕ — повторяет путь оригинального Stegonator (main.js ~line 994)',
        '         *',
        '         * mode "layout"      --> LayoutSwitchEncoder.encodeString(text, false)',
        '         *                      Без шифрования, без magic-префикса',
        '         *',
        '         * mode "aes256"      --> CleanCrypto.encrypt --> _bytesToBase64url',
        '         *                      Полное AES-256-GCM, чистый base64url, без текстового magic',
        '         *',
        '         * mode invisible/base64/compression/emoji/chinese',
        '         *                     --> CleanCrypto.encrypt --> encoder.encode(bytes)',
        '         *                      Зашифрованные байты с magic-префиксом кодера',
        '         *',
        '         * mode "compact"   --> CompactCipher.encrypt (length-preserving stream cipher)',
        '         *                      Не раздувает текст: len(out) = len(in) + 12 (фикс. накладные)',
        '         *                      Без magic-префикса, детекция через MAC-проверку',
        '         */',
        '        encrypt: async function(plaintext, password, mode, chatId) {',
        '            mode = mode || "aes256";',
        '            chatId = chatId || "";',
        '',
        '            // 1. Смена раскладки — без шифрования, только обфускация',
        '            if (mode === "layout") {',
        '                return LayoutSwitchEncoder.encodeString(plaintext, false);',
        '            }',
        '',
        '            // 2. AES-256 — чистый base64url, без текстового magic-префикса',
        '            if (mode === "aes256") {',
        '                var encrypted = await crypto.encrypt(plaintext, password, chatId);',
        '                return _bytesToBase64url(encrypted);',
        '            }',
        '',
        '            // 3. Компактный шифр — length-preserving, без magic, +12 символов',
        '            if (mode === "compact") {',
        '                return await compactCipher.encrypt(plaintext, password, chatId);',
        '            }',
        '',
        '            // 4. Остальные режимы — шифруем, затем оборачиваем в кодер',
        '            var encoderId = SUBMODE_ENCODER_MAP[mode];',
        '            if (!encoderId) throw new Error("Unknown mode: " + mode);',
        '',
        '            var encoder = getEncoderById(encoderId);',
        '            if (!encoder) throw new Error("Unknown encoder: " + encoderId);',
        '',
        '            var encrypted = await crypto.encrypt(plaintext, password, chatId);',
        '            var result = encoder.encode(encrypted);',
        '            if (result && typeof result.then === "function") {',
        '                result = await result;',
        '            }',
        '            return result;',
        '        },',
        '',
        '        /**',
        '         * ДЕКОДИРОВАНИЕ — повторяет путь декодирования оригинального Stegonator (main.js ~line 1056)',
        '         *',
        '         * mode "layout" --> LayoutSwitchEncoder.decodeToString(text)',
        '         * mode "aes256" --> _base64urlToBytes --> crypto.decrypt',
        '         * mode "compact" --> CompactCipher.decrypt (length-preserving, MAC-validated)',
        '         * остальные   --> detectEncoder --> decode --> crypto.decrypt',
        '         */',
        '        decrypt: async function(ciphertext, password, mode, chatId) {',
        '            ciphertext = (ciphertext || "").replace(/^[\\t\\n\\r ]+/, "").replace(/[\\t\\n\\r ]+$/, "");',
        '            chatId = chatId || "";',
        '',
        '            // 1. Смена раскладки — автоопределение направления',
        '            if (mode === "layout") {',
        '                return LayoutSwitchEncoder.decodeToString(ciphertext);',
        '            }',
        '',
        '            // 2. AES-256 base64',
        '            if (mode === "aes256") {',
        '                var bytes = _base64urlToBytes(ciphertext);',
        '                if (!bytes) throw new Error("Invalid Base64");',
        '                return await crypto.decrypt(bytes, password, chatId);',
        '            }',
        '',
        '            // 3. Компактный шифр — length-preserving, MAC-валидация',
        '            if (mode === "compact") {',
        '                var compactResult = await compactCipher.decrypt(ciphertext, password, chatId);',
        '                if (compactResult === null) throw new Error("Не удалось расшифровать (неверный пароль или данные).");',
        '                return compactResult;',
        '            }',
        '',
        '            // 4. Остальные режимы — автоопределение по magic-префиксу',
        '            var encoder = detectEncoder(ciphertext);',
        '            if (!encoder) {',
        '                throw new Error("Unable to detect encoding type.");',
        '            }',
        '',
        '            var decoded = encoder.decode(ciphertext);',
        '            if (decoded && typeof decoded.then === "function") {',
        '                decoded = await decoded;',
        '            }',
        '            if (!decoded) {',
        '                throw new Error("Decode error (" + (encoder.label || encoder.id) + ")");',
        '            }',
        '',
        '            return await crypto.decrypt(decoded, password, chatId);',
        '        },',
        '',
        '        /**',
        '         * АВТО-ДЕКОДИРОВАНИЕ — повторяет оригинальный _tryAutoDecode (main.js ~line 355)',
        '         *',
        '         * Пытается по порядку:',
        '         * 1. detectEncoder (magic-префикс) --> decode --> decrypt',
        '         * 2. Чистый base64url --> decrypt (ловит режим aes256)',
        '         * 3. Компактный шифр (MAC-валидация, без magic-префикса)',
        '         * 4. Декодирование раскладки (для layout без magic — ВСЕГДА последняя)',
        '         */',
        '        autoDecode: async function(ciphertext, password, chatId) {',
        '            if (!ciphertext || !password) return null;',
        '            ciphertext = (ciphertext || "").replace(/^[\\t\\n\\r ]+/, "").replace(/[\\t\\n\\r ]+$/, "");',
        '            chatId = chatId || "";',
        '',
        '            // 1. detectEncoder (magic-префикс)',
        '            try {',
        '                var encoder = detectEncoder(ciphertext);',
        '                if (encoder) {',
        '                    var decoded = encoder.decode(ciphertext);',
        '                    if (decoded && typeof decoded.then === "function") decoded = await decoded;',
        '                    if (decoded) {',
        '                        var decrypted = await crypto.decrypt(decoded, password, chatId);',
        '                        return { text: decrypted, method: encoder.label || "auto" };',
        '                    }',
        '                }',
        '            } catch (e) { /* не этот тип */ }',
        '',
        '            // 2. AES-256 base64',
        '            // Пробуем, только если текст похож на валидный base64url (без кириллицы, пробелов и т.п.)',
        '            if (/^[A-Za-z0-9_-]{20,}$/.test(ciphertext)) {',
        '                try {',
        '                    var bytes = _base64urlToBytes(ciphertext);',
        '                    if (bytes && bytes.length >= 31) {',
        '                        var decrypted2 = await crypto.decrypt(bytes, password, chatId);',
        '                        return { text: decrypted2, method: "AES-256" };',
        '                    }',
        '                } catch (e) { /* не AES-256 */ }',
        '            }',
        '',
        '            // 3. Компактный шифр — пробуем ПЕРЕД раскладкой.',
        '            //',
        '            // Это самый «жадный» режим: он может «расшифровать» почти любую',
        '            // строку из алфавита, но MAC-проверка отсекает ложные срабатывания',
        '            // (вероятность ложного срабатывания 1 к 1 000 000).',
        '            // Важно: compact пробуется ДО раскладки, т.к. layout switch может',
        '            // «декодировать» почти любой латинский текст (выдавая мусор для',
        '            // compact-зашифрованных сообщений). MAC-проверка гарантирует, что',
        '            // compact «сработает» только на реально зашифрованных сообщениях.',
        '            // Pre-check: минимальная длина и все символы в алфавите.',
        '            if (ciphertext.length >= 12 && CompactCipher.isSupported(ciphertext)) {',
        '                try {',
        '                    var compactDecoded = await compactCipher.decrypt(ciphertext, password, chatId);',
        '                    if (compactDecoded !== null) {',
        '                        return { text: compactDecoded, method: "Компактный" };',
        '                    }',
        '                } catch (e) { /* не компактный шифр */ }',
        '            }',
        '',
        '            // 4. Декодирование раскладки (без magic) — умный лингвистический анализ.',
        '            //',
        '            // LayoutAnalyzer (Electron-прослойка, не ядро Стегонатора)',
        '            // выполняет пословный скоринг сообщения: частотность гласных в',
        '            // исходной и целевой раскладке, невозможные в EN биграммы и',
        '            // морфемные маркеры (cz=ся, jq=ой, ghb=при, sq=ый, yf=на, gj=по),',
        '            // кластеры согласных, а также защиту URL/email/base64-токенов.',
        '            // Это заменяет прежний наивный regex-фильтр (!hasCyrillic &&',
        '            // !isBase64Like), который не учитывал смешанные сообщения с',
        '            // URL/английскими словами и длинные английские тексты.',
        '            //',
        '            // См. layout-analyzer.js — протестировано на 167 кейсах,',
        '            // 0 ложных срабатываний на нормальных EN/RU текстах и AES.',
        '            //',
        '            // Раскладка ВСЕГДА последняя — это не настоящее шифрование,',
        '            // а просто визуальная маскировка.',
        '            try {',
        '                var layoutAnalysis = LayoutAnalyzer.analyze(ciphertext);',
        '                if (layoutAnalysis.isChanged && layoutAnalysis.resultText &&',
        '                    layoutAnalysis.resultText !== ciphertext) {',
        '                    return { text: layoutAnalysis.resultText, method: "Layout" };',
        '                }',
        '            } catch (e) { /* не раскладка */ }',
        '',
        '            return null;',
        '        },',
        '',
        '        /**',
        '         * ДЕТЕКТ — проверяет, похож ли текст на зашифрованный',
        '         */',
        '        detect: function(text) {',
        '            if (!text) return { isEncrypted: false, algorithm: null, isStego: false };',
        '            // ВНИМАНИЕ: НЕ используем .trim() — он вырезает Unicode whitespace',
        '            // (U+00A0, U+2002-2005, U+202F, U+205F), которые invisible-spaces encoder',
        '            // использует для кодирования. Используем regex trim (только \\t\\n\\r space).',
        '            text = text.replace(/^[\\t\\n\\r ]+/, "").replace(/[\\t\\n\\r ]+$/, "");',
        '            var encoder = detectEncoder(text);',
        '            if (encoder) {',
        '                var stegoIds = ["invisible-spaces", "chinese", "emoji", "layout-switch"];',
        '                return {',
        '                    isEncrypted: true,',
        '                    algorithm: encoder.id,',
        '                    label: encoder.label || encoder.id,',
        '                    isStego: stegoIds.indexOf(encoder.id) !== -1',
        '                };',
        '            }',
        '            // Также детектим чистый AES-256 base64 (начинается с Q1JZ)',
        '            if (text.indexOf("Q1JZ") === 0 && /^[A-Za-z0-9_-]+$/.test(text)) {',
        '                return { isEncrypted: true, algorithm: "aes256", label: "AES-256", isStego: false };',
        '            }',
        '            return { isEncrypted: false, algorithm: null, isStego: false };',
        '        },',
        '',
        '        isReady: function() { return true; },',
        '',
        '        getSupportedModes: function() {',
        '            return [',
        '                { id: "aes256",     label: "AES-256-GCM",             icon: "🔐" },',
        '                { id: "compact",    label: "Компактный (1:1)",        icon: "🗜️" },',
        '                { id: "textfile",   label: "Криптоконтейнер (файл)",  icon: "📄" },',
        '                { id: "layout",     label: "Смена раскладки",          icon: "⌨️" },',
        '                { id: "invisible",  label: "Невидимые символы",       icon: "👻" },',
        '                { id: "base64",     label: "Base64/85",              icon: "🔤" },',
        '                { id: "compression",label: "Deflate+B64",            icon: "📦" },',
        '                { id: "emoji",      label: "Эмодзи",                 icon: "😀" },',
        '                { id: "chinese",    label: "Иероглифы",              icon: "🈳" }',
        '            ];',
        '        }',
        '    };',
        '',
        '    window._cryptoEngineReady = true;',
        '    window.dispatchEvent(new Event("crypto-engine-ready"));',
        '    console.log("CryptoMAX: Engine loaded (Stegonator-compatible)");',
        '})();',
    ].join('\n');

    // Инициализация

    async function init() {
        try {
            // Шаг 1: подгрузить не-модульные зависимости (UMD/IIFE)
            await loadScript('./engine/lib/pako.min.js');
            await loadScript('./engine/lib/morph-compress.js');

            // Шаг 2: создать и подгрузить bootstrap ES-модуля
            var moduleScript = document.createElement('script');
            moduleScript.type = 'module';
            moduleScript.textContent = MODULE_CODE;
            document.head.appendChild(moduleScript);

            console.log('CryptoMAX: Engine loader initiated');
        } catch (e) {
            console.error('CryptoMAX: Engine load failed:', e);
            window.CryptoEngineAPI = null;
            window._cryptoEngineReady = false;
            window._cryptoEngineError = e.message;
            window.dispatchEvent(new Event('crypto-engine-error'));
        }
    }

    // Старт

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();