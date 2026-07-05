/**
 * cm-text-file-crypto.js — шифрование/дешифрование текстовых файлов для CryptoMAX.
 *
 * Модуль Electron-прослойки (main process, Node.js).
 *
 * Назначение:
 *   Режим шифрования для длинных многострочных текстовых сообщений.
 *   Текст шифруется AES-256-GCM и отправляется как .txt файл в чат.
 *   Получатель: анализатор видит .txt файл, тихо подкачивает его,
 *   расшифровывает паролем чата и показывает как обычное текстовое сообщение
 *   в Shadow DOM overlay.
 *
 * Формат файла (CT1):
 *   MAGIC (3 байта: "CT1") + IV(12) + AES-256-GCM(text_bytes) + authTag(16)
 *
 * KDF совместим с CleanCrypto (engine/js/core/clean-crypto.js):
 *   PBKDF2(password + ':' + chatId, SALT, 100000, SHA-256) --> 256 бит.
 *
 * Имя файла:
 *   Случайная строка из [a-z0-9] (8-12 символов) + .txt
 *   Без паттернов, без "cryptomax", без даты — чтобы избежать
 *   автоудаления сервером или детекции по шаблону.
 *
 * Экспорт:
 *   encryptText(text, password, chatId) --> Buffer (CT1+IV+ct+tag)
 *   decryptText(encBuffer, password, chatId) --> string (исходный текст)
 *   isEncryptedText(buffer) --> boolean
 *   generateRandomFilename() --> string (например, "k7xm2p.txt")
 */

'use strict';

const crypto = require('crypto');

const SALT = Buffer.from('clean-crypto-v1-aes256gcm', 'utf8');
const ITERATIONS = 100000;
const KEY_BYTES = 32;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const MAGIC = Buffer.from([0x43, 0x54, 0x31]); // "CT1" (Compact Text v1)

/**
 * Derive encryption key from password + chatId (PBKDF2-SHA256).
 * Совместим с CleanCrypto (engine/js/core/clean-crypto.js).
 */
function deriveKey(password, chatId) {
    const material = password + (chatId ? ':' + chatId : '');
    return crypto.pbkdf2Sync(material, SALT, ITERATIONS, KEY_BYTES, 'sha256');
}

/**
 * Зашифровать текст в формат CT1.
 * @param {string} text — исходный текст (любой длины, с переносами строк)
 * @param {string} password — пароль чата
 * @param {string} chatId — идентификатор чата
 * @returns {Buffer} MAGIC + IV + ciphertext + authTag
 */
function encryptText(text, password, chatId) {
    if (typeof text !== 'string') text = String(text);
    const key = deriveKey(password, chatId);
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const textBytes = Buffer.from(text, 'utf8');
    const ct = Buffer.concat([cipher.update(textBytes), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([MAGIC, iv, ct, tag]);
}

/**
 * Расшифровать CT1 в исходный текст.
 * @param {Buffer} encBuffer — MAGIC + IV + ciphertext + authTag
 * @param {string} password — пароль чата
 * @param {string} chatId — идентификатор чата
 * @returns {string} исходный текст
 * @throws {Error} если неверный пароль, повреждены данные или неверный magic
 */
function decryptText(encBuffer, password, chatId) {
    if (!Buffer.isBuffer(encBuffer)) encBuffer = Buffer.from(encBuffer);
    if (encBuffer.length < MAGIC.length + IV_LENGTH + TAG_LENGTH) {
        throw new Error('Зашифрованные данные слишком короткие.');
    }
    // Проверка magic
    if (encBuffer.slice(0, MAGIC.length).toString('latin1') !== MAGIC.toString('latin1')) {
        throw new Error('Неверный magic-маркер (ожидался CT1).');
    }
    const key = deriveKey(password, chatId);
    const iv = encBuffer.slice(MAGIC.length, MAGIC.length + IV_LENGTH);
    const tag = encBuffer.slice(encBuffer.length - TAG_LENGTH);
    const ct = encBuffer.slice(MAGIC.length + IV_LENGTH, encBuffer.length - TAG_LENGTH);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    try {
        const plainBuf = Buffer.concat([decipher.update(ct), decipher.final()]);
        return plainBuf.toString('utf8');
    } catch (e) {
        throw new Error('Неверный пароль или повреждённые данные.');
    }
}

/**
 * Проверить, что буфер содержит зашифрованный CT1 текст.
 * @param {Buffer} buffer
 * @returns {boolean}
 */
function isEncryptedText(buffer) {
    if (!buffer || buffer.length < MAGIC.length) return false;
    if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
    return buffer.slice(0, MAGIC.length).toString('latin1') === MAGIC.toString('latin1');
}

/**
 * Сгенерировать случайное имя файла для зашифрованного .txt.
 * Формат: 8-10 случайных символов [a-z0-9] + ".txt"
 * Без паттернов, без даты, без "cryptomax" — для скрытности.
 * @returns {string} например, "k7xm2p9a.txt"
 */
function generateRandomFilename() {
    const CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const length = 8 + Math.floor(Math.random() * 3); // 8-10 символов
    const bytes = crypto.randomBytes(length);
    let name = '';
    for (let i = 0; i < length; i++) {
        name += CHARS[bytes[i] % CHARS.length];
    }
    return name + '.txt';
}

module.exports = {
    encryptText,
    decryptText,
    isEncryptedText,
    generateRandomFilename,
    MAGIC,
};
