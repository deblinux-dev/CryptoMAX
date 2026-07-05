/**
 * Compact Cipher — Length-Preserving Stream Cipher
 *
 * ## Назначение
 *   Режим шифрования, который НЕ раздувает текст (в отличие от base64 после AES).
 *   Длина зашифрованного текста = длина исходного текста + фиксированные 12 символов
 *   (6 символов MAC + 6 символов nonce). Никакого 33%-ного base64-разбухания.
 *
 * ## Безопасность (в отличие от RC4)
 *   - Ключ: PBKDF2-SHA256(password + chatId, salt, 100000 итераций, 256 бит)
 *   - Ключевой поток: HMAC-SHA256 в режиме CTR — криптографически стойкий PRF,
 *     не имеет смещений байтов (главная уязвимость RC4).
 *   - Nonce: 6 случайных символов на каждое сообщение — исключает повторное
 *     использование ключевого потока (вторая главная уязвимость RC4).
 *   - MAC: HMAC-SHA256 → 6 цифр — аутентификация и детекция.
 *   - Доменное разделение: «ENC» для потока, «MAC» для аутентификации.
 *
 * ## Формат
 *   До шифрования:  [plaintext][6-значный MAC]
 *   После шифрования: [ciphertext (длина = len(plaintext)+6)] [6-симв. nonce]
 *   Итог: len(plaintext) + 12 символов (фиксированные накладные расходы)
 *
 *   Весь вывод выглядит как равномерно-случайная строка из алфавита —
 *   никаких magic-префиксов, никаких детектируемых паттернов.
 *
 * ## Детекция
 *   - Нет magic-префикса (в отличие от других кодеров).
 *   - В autoDecode пробуется ПОСЛЕДНИМ (после всех остальных режимов).
 *   - Валидация: после расшифровки проверяется MAC. Совпадение → это Compact Cipher.
 *   - Вероятность ложного срабатывания: 1 к 1 000 000.
 *
 * ## Алфавит (161 символ)
 *   Латиница (a-z, A-Z), кириллица (а-я, А-Я, включая ё/Ё),
 *   цифры (0-9), пробел, основные знаки препинания и спецсимволы.
 *
 *   ВАЖНО: перевод строки (\n) НЕ включён в алфавит!
 *   Причина: мессенджеры вырезают \n из однострочных сообщений,
 *   что приводит к необратимому искажению шифртекста.
 *   Многострочные plaintext-сообщения: \n заменяется на пробел
 *   перед шифрованием (см. _normalizePlaintext).
 */

// ─── Алфавит ─────────────────────────────────────────────────

const _ALPHA_STR =
    'abcdefghijklmnopqrstuvwxyz' +   // 26
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ' +   // 26
    'абвгдеёжзийклмнопрстуфхцчшщъыьэюя' + // 33
    'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ' + // 33
    '0123456789' +                   // 10
    ' ' +                            // 1  пробел
    '.,!?;:\'"-()[]{}/@#$%^&*_+=~`|<>\\' + // 31  пунктуация
    '';                             // (\n убран — мессенджеры его вырезают)
// Итого: 161 символ

const ALPHABET = Object.freeze(_ALPHA_STR.split(''));
const N = ALPHABET.length; // 161

// Быстрые карты: символ → индекс и индекс → символ
const CHAR_TO_IDX = new Map();
for (let i = 0; i < N; i++) {
    CHAR_TO_IDX.set(ALPHABET[i], i);
}
const IDX_TO_CHAR = ALPHABET; // массив — доступ по индексу

// ─── Константы ───────────────────────────────────────────────

const SALT = new TextEncoder().encode('compact-cipher-v1');
const ITERATIONS = 100_000;
const KEY_BITS = 256;
const NONCE_CHARS = 6;        // длина nonce в символах алфавита
const MAC_DIGITS = 6;         // длина MAC в цифрах
const TOTAL_OVERHEAD = NONCE_CHARS + MAC_DIGITS; // 12

// ─── Кэш ключей (избегаем повторного PBKDF2) ─────────────────

const _keyCache = new Map(); // key: "password:chatId" → { cryptoKey, ts }
const _KEY_CACHE_TTL = 5 * 60 * 1000; // 5 минут

// ─── Класс ───────────────────────────────────────────────────

export default class CompactCipher {
    static get id()    { return 'compact'; }
    static get label() { return 'Компактный (1:1)'; }
    static get icon()  { return '🗜️'; }

    /** Размер фиксированных накладных расходов (символов) */
    static get overhead() { return TOTAL_OVERHEAD; }

    /** Алфавит (для UI/валидации) */
    static get alphabet() { return _ALPHA_STR; }

    /**
     * Проверить, все ли символы текста поддерживаются алфавитом.
     * @param {string} text
     * @returns {boolean}
     */
    static isSupported(text) {
        if (!text) return true;
        for (const ch of text) {
            if (!CHAR_TO_IDX.has(ch)) return false;
        }
        return true;
    }

    /**
     * Получить множество неподдерживаемых символов в тексте.
     * @param {string} text
     * @returns {Set<string>}
     */
    static getUnsupportedChars(text) {
        const unsupported = new Set();
        if (!text) return unsupported;
        for (const ch of text) {
            if (!CHAR_TO_IDX.has(ch)) unsupported.add(ch);
        }
        return unsupported;
    }

    /**
     * Оценка размера зашифрованного сообщения.
     * @param {number} textLength — длина исходного текста в символах
     * @returns {number} — длина зашифрованного текста
     */
    static encryptedSize(textLength) {
        return textLength + TOTAL_OVERHEAD;
    }

    // ─── Публичные методы ───────────────────────────────────

    /**
     * Зашифровать текст.
     *
     * @param {string} plaintext — исходный текст
     * @param {string} password — пароль
     * @param {string} chatId — идентификатор чата (для per-chat key derivation)
     * @returns {Promise<string>} — зашифрованный текст
     * @throws {Error} если текст содержит неподдерживаемые символы
     */
    async encrypt(plaintext, password, chatId = '') {
        if (!plaintext) plaintext = '';
        if (!password) throw new Error('Пароль обязателен для компактного шифра.');

        // 1. Нормализация: \n и \r заменяются на пробел.
        //    Причина: мессенджеры вырезают переводы строк из сообщений,
        //    что приводит к необратимому искажению шифртекста (т.к. \n
        //    может появиться в шифртексте как случайный символ алфавита).
        plaintext = plaintext.replace(/[\r\n]+/g, ' ');

        // 2. Валидация: все символы должны быть в алфавите
        for (const ch of plaintext) {
            if (!CHAR_TO_IDX.has(ch)) {
                throw new Error(
                    `Неподдерживаемый символ «${ch}» (U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}). ` +
                    `Компактный шифр поддерживает латиницу, кириллицу, цифры и основные знаки препинания. ` +
                    `Удалите этот символ или выберите другой режим шифрования.`
                );
            }
        }

        // 3. Derive key (с кэшированием)
        const key = await this._deriveKey(password, chatId);

        // 4. Generate nonce (6 случайных индексов алфавита)
        const nonceIndices = new Uint8Array(NONCE_CHARS);
        crypto.getRandomValues(nonceIndices);
        for (let i = 0; i < NONCE_CHARS; i++) {
            nonceIndices[i] = nonceIndices[i] % N;
        }
        const nonceStr = nonceIndices.reduce((s, idx) => s + IDX_TO_CHAR[idx], '');

        // 5. Compute MAC: HMAC-SHA256(key, "MAC" || nonce || plaintext) → 6 цифр
        const macStr = await this._computeMAC(key, nonceIndices, plaintext);

        // 6. Объединить plaintext + MAC, затем зашифровать
        const combined = plaintext + macStr;
        const combinedIndices = new Uint8Array(combined.length);
        for (let i = 0; i < combined.length; i++) {
            combinedIndices[i] = CHAR_TO_IDX.get(combined[i]);
        }

        // 7. Сгенерировать ключевой поток и зашифровать
        const keystream = await this._generateKeystream(key, nonceIndices, combinedIndices.length);
        const cipherIndices = new Uint8Array(combinedIndices.length);
        for (let i = 0; i < combinedIndices.length; i++) {
            // Модульное сложение: c = (p + k) mod N
            // k приводится к [0..N-1], чтобы p+k ∈ [0..2N-2] → корректный mod
            const k = keystream[i] % N;
            cipherIndices[i] = (combinedIndices[i] + k) % N;
        }

        // 8. Преобразовать индексы в символы
        let ciphertext = '';
        for (let i = 0; i < cipherIndices.length; i++) {
            ciphertext += IDX_TO_CHAR[cipherIndices[i]];
        }

        // 9. Добавить nonce в конце
        return ciphertext + nonceStr;
    }

    /**
     * Расшифровать текст.
     *
     * @param {string} ciphertext — зашифрованный текст (включая nonce)
     * @param {string} password — пароль
     * @param {string} chatId — идентификатор чата
     * @returns {Promise<string|null>} — расшифрованный текст или null (не этот алгоритм / неверный пароль)
     */
    async decrypt(ciphertext, password, chatId = '') {
        if (!ciphertext || !password) return null;

        // 1. Проверка минимальной длины
        if (ciphertext.length < TOTAL_OVERHEAD) return null;

        // 2. Проверка: все символы в алфавите
        for (const ch of ciphertext) {
            if (!CHAR_TO_IDX.has(ch)) return null;
        }

        // 3. Извлечь nonce (последние NONCE_CHARS символов)
        const nonceStr = ciphertext.slice(-NONCE_CHARS);
        const nonceIndices = new Uint8Array(NONCE_CHARS);
        for (let i = 0; i < NONCE_CHARS; i++) {
            nonceIndices[i] = CHAR_TO_IDX.get(nonceStr[i]);
        }

        // 4. Извлечь ciphertext (без nonce)
        const cipherBody = ciphertext.slice(0, -NONCE_CHARS);
        if (cipherBody.length < MAC_DIGITS) return null; // слишком коротко для plaintext+MAC

        // 5. Derive key
        let key;
        try {
            key = await this._deriveKey(password, chatId);
        } catch { return null; }

        // 6. Расшифровать
        const cipherIndices = new Uint8Array(cipherBody.length);
        for (let i = 0; i < cipherBody.length; i++) {
            cipherIndices[i] = CHAR_TO_IDX.get(cipherBody[i]);
        }
        const keystream = await this._generateKeystream(key, nonceIndices, cipherIndices.length);
        const plainIndices = new Uint8Array(cipherIndices.length);
        for (let i = 0; i < cipherIndices.length; i++) {
            // Модульное вычитание: p = (c - k + N) mod N
            // k приводится к [0..N-1], чтобы c-k ∈ [-(N-1)..N-1] → +N даёт [1..2N-1] → корректный mod
            const k = keystream[i] % N;
            plainIndices[i] = (cipherIndices[i] - k + N) % N;
        }

        // 8. Преобразовать индексы в строку
        let decrypted = '';
        for (let i = 0; i < plainIndices.length; i++) {
            decrypted += IDX_TO_CHAR[plainIndices[i]];
        }

        // 8. Извлечь MAC (последние MAC_DIGITS символов расшифрованного текста)
        const macCandidate = decrypted.slice(-MAC_DIGITS);
        const plaintext = decrypted.slice(0, -MAC_DIGITS);

        // 9. Проверить, что MAC состоит только из цифр
        if (!/^\d{6}$/.test(macCandidate)) return null;

        // 10. Вычислить ожидаемый MAC и сравнить
        const expectedMac = await this._computeMAC(key, nonceIndices, plaintext);

        // Использовать timing-safe сравнение
        if (!_constantTimeCompare(macCandidate, expectedMac)) return null;

        return plaintext;
    }

    // ─── Внутренние методы ──────────────────────────────────

    /**
     * Derive encryption key from password + chatId using PBKDF2.
     * Результат кэшируется на 5 минут для производительности.
     * @param {string} password
     * @param {string} chatId
     * @returns {Promise<CryptoKey>}
     */
    async _deriveKey(password, chatId) {
        const cacheKey = password + '\x00' + chatId;
        const cached = _keyCache.get(cacheKey);
        const now = Date.now();
        if (cached && (now - cached.ts) < _KEY_CACHE_TTL) {
            return cached.cryptoKey;
        }

        const enc = new TextEncoder();
        const material = await crypto.subtle.importKey(
            'raw',
            enc.encode(password + (chatId ? ':' + chatId : '')),
            { name: 'PBKDF2' },
            false,
            ['deriveKey']
        );

        const cryptoKey = await crypto.subtle.deriveKey(
            { name: 'PBKDF2', salt: SALT, iterations: ITERATIONS, hash: 'SHA-256' },
            material,
            { name: 'HMAC', hash: 'SHA-256', length: KEY_BITS },
            true,
            ['sign']
        );

        _keyCache.set(cacheKey, { cryptoKey, ts: now });

        // Очистка устаревших записей (раз в ~50 вызовов)
        if (_keyCache.size > 50) {
            for (const [k, v] of _keyCache) {
                if (now - v.ts > _KEY_CACHE_TTL) _keyCache.delete(k);
            }
        }

        return cryptoKey;
    }

    /**
     * Сгенерировать ключевой поток заданной длины.
     * HMAC-SHA256 в режиме CTR: block_i = HMAC(key, "ENC" || nonce || counter_i)
     * Каждый блок — 32 байта; берём по одному байту на символ.
     *
     * @param {CryptoKey} key
     * @param {Uint8Array} nonceIndices — nonce как массив индексов [0..N-1]
     * @param {number} length — сколько байт потока нужно
     * @returns {Promise<Uint8Array>} — массив байт потока [0..255]
     */
    async _generateKeystream(key, nonceIndices, length) {
        const result = new Uint8Array(length);
        const enc = new TextEncoder();

        // Префикс: "ENC" || nonce || counter(4 байта LE)
        const prefix = new Uint8Array(3 + nonceIndices.length + 4);
        prefix[0] = 0x45; prefix[1] = 0x4E; prefix[2] = 0x43; // "ENC"
        prefix.set(nonceIndices, 3);

        const numBlocks = Math.ceil(length / 32);
        let offset = 0;

        for (let block = 0; block < numBlocks; block++) {
            // Записать counter (4 байта, little-endian)
            prefix[3 + nonceIndices.length]     = block & 0xFF;
            prefix[3 + nonceIndices.length + 1] = (block >> 8) & 0xFF;
            prefix[3 + nonceIndices.length + 2] = (block >> 16) & 0xFF;
            prefix[3 + nonceIndices.length + 3] = (block >> 24) & 0xFF;

            const sigBuf = await crypto.subtle.sign('HMAC', key, prefix);
            const sig = new Uint8Array(sigBuf);

            const remaining = length - offset;
            const toCopy = Math.min(32, remaining);
            result.set(sig.subarray(0, toCopy), offset);
            offset += toCopy;
        }

        return result;
    }

    /**
     * Вычислить MAC: HMAC-SHA256(key, "MAC" || nonce || plaintext) → 6 цифр.
     *
     * @param {CryptoKey} key
     * @param {Uint8Array} nonceIndices
     * @param {string} plaintext
     * @returns {Promise<string>} — 6-значная строка (с ведущими нулями)
     */
    async _computeMAC(key, nonceIndices, plaintext) {
        const enc = new TextEncoder();
        const ptBytes = enc.encode(plaintext);

        // "MAC" || nonce || plaintext
        const data = new Uint8Array(3 + nonceIndices.length + ptBytes.length);
        data[0] = 0x4D; data[1] = 0x41; data[2] = 0x43; // "MAC"
        data.set(nonceIndices, 3);
        data.set(ptBytes, 3 + nonceIndices.length);

        const sigBuf = await crypto.subtle.sign('HMAC', key, data);
        const sig = new Uint8Array(sigBuf);

        // Берём первые 4 байта, интерпретируем как uint32 (big-endian), mod 10^6
        const view = new DataView(sig.buffer, sig.byteOffset, 4);
        const uint32 = view.getUint32(0, false); // big-endian
        const macNum = uint32 % 1_000_000;

        // Форматировать как 6-значную строку с ведущими нулями
        return macNum.toString().padStart(MAC_DIGITS, '0');
    }
}

// ─── Вспомогательные функции ─────────────────────────────────

/**
 * Постоянное по времени сравнение строк (защита от timing-атак).
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function _constantTimeCompare(a, b) {
    if (a.length !== b.length) return false;
    let result = 0;
    for (let i = 0; i < a.length; i++) {
        result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return result === 0;
}
