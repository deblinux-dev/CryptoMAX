/**
 * Криптографический модуль с компактным алфавитным кодированием
 *
 * ## Схема шифрования
 *   key     = PBKDF2(password, фикс.соль, 100000) → 256 бит
 *   counter = SHA256("stego-ctr:" + password)[0:16]
 *   ciphertext = AES-CTR(key, counter, compressedPlaintext)
 *
 * ## Компактный алфавит (7 бит на символ → экономия ~2x vs UTF-8 для кириллицы)
 *
 * Алфавит из 128 символов (7 бит на символ):
 *   - а-я  (33 буквы: а б в г д е ж з и й к л м н о п р с т у ф х ц ч ш щ ъ ы ь э ю я)
 *   - ё    (1 буква)
 *   - А-Я  (33 буквы) + Ё
 *   - a-z  (26 букв)
 *   - A-Z  (26 букв)
 *   - 0-9  (10 цифр)
 *   - пробел, . , ! ? : ; - ( ) " ' / @ # % + = _ \n и др.
 *
 * Итого: 68 + 52 + 10 + ~20 знаков = ~150 символов
 * Кодируем каждый в 8 бит (256 позиций — достаточно для 150 символов).
 *
 * Реальная экономия: кириллица UTF-8 = 2 байта/символ, наш алфавит = 1 байт/символ.
 * Шифротекст "Привет!" = 7 байт + 1 magic = 8 байт = 64 бита (было 120 бит).
 *
 * ## Формат plaintext (overhead = 1-3 байта)
 *
 * Короткие сообщения (1-15 байт):
 *   Byte 0: 0xA0 | (length - 1)    → 0xA1..0xAF (length 1-15)
 *   Bytes 1..N: data
 *   Overhead = 1 байт (8 бит)
 *
 * Длинные сообщения (16-255 байт):
 *   Byte 0: 0xB0 (маркер длинного формата)
 *   Byte 1: length (16-255)
 *   Bytes 2..N+1: data
 *   Overhead = 2 байта (16 бит)
 *
 * Расширенные сообщения (256-65535 байт):
 *   Byte 0: 0xB1 (маркер расширенного формата)
 *   Byte 1: length >> 8 (старший байт длины)
 *   Byte 2: length & 0xFF (младший байт длины)
 *   Bytes 3..N+2: data
 *   Overhead = 3 байта (24 бит)
 *
 * ## Верификация пароля
 * Старшие 4 бита первого байта = 0xA (короткий) или 0xB (длинный/расширенный).
 * Если после расшифровки они не совпадают → неверный пароль.
 * Вероятность ложного срабатывания: 3/16 (при случайных данных).
 * Дополнительная проверка: длина данных не превышает оставшийся размер plaintext.
 */

export class CryptoEngine {
    constructor() {
        this.ALGO     = 'AES-CTR';
        this.KEY_BITS = 256;
        this.CTR_LEN  = 16;
        this.ITER     = 100_000;
        this.MAGIC_SHORT = 0xA0;  // короткий формат: 0xA0 | (len-1), len 1-15
        this.MAGIC_LONG  = 0xB0;  // длинный формат: 0xB0, next byte = len (16-255)
        this.MAGIC_EXT  = 0xB1;  // расширенный формат: 0xB1, 2 bytes len (256-65535)

        // Кастомный алфавит: индекс → символ
        this._buildAlphabet();
    }

    _buildAlphabet() {
        const chars = [];

        // Строчные кириллица (а-я + ё)
        for (let c = 'а'.codePointAt(0); c <= 'я'.codePointAt(0); c++) chars.push(String.fromCodePoint(c));
        chars.push('ё');

        // Прописные кириллица (А-Я + Ё)
        for (let c = 'А'.codePointAt(0); c <= 'Я'.codePointAt(0); c++) chars.push(String.fromCodePoint(c));
        chars.push('Ё');

        // Латиница строчная a-z
        for (let c = 97; c <= 122; c++) chars.push(String.fromCharCode(c));
        // Латиница прописная A-Z
        for (let c = 65; c <= 90; c++) chars.push(String.fromCharCode(c));

        // Цифры 0-9
        for (let c = 48; c <= 57; c++) chars.push(String.fromCharCode(c));

        // Знаки препинания и спецсимволы
        const specials = ' .,!?:;-()[]{}"\'/\\@#$%^&*+=_~`|<>\n\t\r«»—…№';
        for (const ch of specials) chars.push(ch);

        // Индексы
        this._charToIdx = new Map(chars.map((c, i) => [c, i]));
        this._idxToChar = chars;

        // Если символ не в алфавите — заменяем на '?'
        this._fallback = this._charToIdx.get('?') ?? 0;
    }

    /**
     * Компактное кодирование строки → Uint8Array (1 байт на символ из алфавита)
     * Символы вне алфавита кодируются как '?' (fallback).
     */
    _encodeString(str) {
        const bytes = new Uint8Array(str.length);
        for (let i = 0; i < str.length; i++) {
            bytes[i] = this._charToIdx.has(str[i])
                ? this._charToIdx.get(str[i])
                : this._fallback;
        }
        return bytes;
    }

    /**
     * Декодирование Uint8Array → строка
     */
    _decodeBytes(bytes) {
        let str = '';
        for (const b of bytes) {
            str += b < this._idxToChar.length ? this._idxToChar[b] : '?';
        }
        return str;
    }

    async _deriveKey(password) {
        const enc      = new TextEncoder();
        const salt     = enc.encode('linguistic-stego-v1');
        const material = await crypto.subtle.importKey(
            'raw', enc.encode(password),
            { name: 'PBKDF2' }, false, ['deriveKey']
        );
        return crypto.subtle.deriveKey(
            { name: 'PBKDF2', salt, iterations: this.ITER, hash: 'SHA-256' },
            material,
            { name: this.ALGO, length: this.KEY_BITS },
            false, ['encrypt', 'decrypt']
        );
    }

    async _deriveCtr(password) {
        const enc = new TextEncoder();
        const buf = await crypto.subtle.digest('SHA-256', enc.encode('stego-ctr:' + password));
        return new Uint8Array(buf, 0, this.CTR_LEN);
    }

    /**
     * Зашифровать данные.
     * @param {Uint8Array} data - данные (результат stringToBytes)
     * @param {string} password
     * @returns {Uint8Array} - шифротекст
     *
     * Формат plaintext:
     *   Короткий (data.length 1-15):  [0xA0|len-1] [data...]       → overhead 1 байт
     *   Длинный   (data.length 16-255): [0xB0] [len] [data...]     → overhead 2 байта
     *   Расширенный (data.length 256-65535): [0xB1] [lenHi] [lenLo] [data...] → overhead 3 байта
     */
    async encrypt(data, password) {
        const [key, counter] = await Promise.all([
            this._deriveKey(password),
            this._deriveCtr(password)
        ]);

        let plaintext;
        if (data.length <= 15) {
            // Короткий формат: 1 байт заголовка
            plaintext = new Uint8Array(1 + data.length);
            plaintext[0] = this.MAGIC_SHORT | (data.length - 1);
            plaintext.set(data, 1);
        } else if (data.length <= 255) {
            // Длинный формат: 2 байта заголовка
            plaintext = new Uint8Array(2 + data.length);
            plaintext[0] = this.MAGIC_LONG;
            plaintext[1] = data.length;
            plaintext.set(data, 2);
        } else {
            // Расширенный формат: 3 байта заголовка (len до 65535)
            plaintext = new Uint8Array(3 + data.length);
            plaintext[0] = this.MAGIC_EXT;
            plaintext[1] = (data.length >> 8) & 0xFF;
            plaintext[2] = data.length & 0xFF;
            plaintext.set(data, 3);
        }

        const buf = await crypto.subtle.encrypt(
            { name: this.ALGO, counter, length: 64 },
            key, plaintext
        );
        return new Uint8Array(buf);
    }

    async decrypt(data, password) {
        const [key, counter] = await Promise.all([
            this._deriveKey(password),
            this._deriveCtr(password)
        ]);

        let buf;
        try {
            buf = await crypto.subtle.decrypt(
                { name: this.ALGO, counter, length: 64 },
                key, data
            );
        } catch {
            throw new Error('Неверный пароль или повреждённые данные.');
        }

        const plaintext = new Uint8Array(buf);
        if (plaintext.length < 2) {
            throw new Error('Неверный пароль или повреждённые данные.');
        }

        const headerByte = plaintext[0];
        const headerNibble = headerByte & 0xF0;
        let dataLen, dataStart;

        if (headerNibble === this.MAGIC_SHORT) {
            // Короткий формат: 0xA0 | (len-1)
            dataLen = (headerByte & 0x0F) + 1;
            dataStart = 1;
        } else if (headerByte === this.MAGIC_LONG) {
            // Длинный формат: 0xB0, next byte = len
            dataLen = plaintext[1];
            dataStart = 2;
        } else if (headerByte === this.MAGIC_EXT) {
            // Расширенный формат: 0xB1, 2 bytes = len
            dataLen = (plaintext[1] << 8) | plaintext[2];
            dataStart = 3;
        } else {
            throw new Error('Неверный пароль или повреждённые данные.');
        }

        // Проверка: данные не превышают размер plaintext
        if (dataStart + dataLen > plaintext.length) {
            throw new Error('Неверный пароль или повреждённые данные.');
        }

        return plaintext.slice(dataStart, dataStart + dataLen);
    }

    /**
     * Строка → компактные байты (1 байт/символ для кириллицы/латиницы)
     * Вместо стандартного UTF-8 (2 байта для кириллицы)
     */
    stringToBytes(str) {
        return this._encodeString(str);
    }

    /**
     * Компактные байты → строка
     */
    bytesToString(bytes) {
        return this._decodeBytes(bytes);
    }

    /** Размер шифротекста для строки (в байтах) */
    encryptedSize(str) {
        const dataLen = str.length; // 1 байт/символ в компактном алфавите
        const overhead = dataLen <= 15 ? 1 : dataLen <= 255 ? 2 : 3;
        return dataLen + overhead;
    }

    /** Overhead в байтах для заданной длины данных */
    getOverhead(dataLen) {
        return dataLen <= 15 ? 1 : dataLen <= 255 ? 2 : 3;
    }
}

export default CryptoEngine;
