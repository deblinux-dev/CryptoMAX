/**
 * cm-voice-crypto.js — шифрование/дешифрование голосовых сообщений для CryptoMAX.
 *
 * Модуль Electron-прослойки (main process, Node.js).
 *
 * Формат: EV1 magic (3 байта) + IV(12) + AES-256-GCM(audio_bytes) + authTag(16).
 * KDF совместим с CleanCrypto (engine/js/core/clean-crypto.js):
 *   PBKDF2(password + ':' + chatId, SALT, 100000, SHA-256) --> 256 бит.
 * Голосовое шифруется тем же паролем чата, что и сообщения.
 *
 * EV1 magic (0x45 0x56 0x31 = "EV1") — маркер зашифрованного голосового,
 * по которому userscript web.max.ru отличает .ogg с шифрованием от обычных.
 *
 * Экспорт:
 *   encryptVoice(audioBuffer, password, chatId) --> Buffer (EV1+IV+ct+tag)
 *   decryptVoice(encBuffer, password, chatId)   --> Buffer (audio bytes)
 */

'use strict';

const crypto = require('crypto');

const SALT = Buffer.from('clean-crypto-v1-aes256gcm', 'utf8');
const ITERATIONS = 100000;
const KEY_BYTES = 32;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const MAGIC = Buffer.from([0x45, 0x56, 0x31]); // "EV1"

function deriveKey(password, chatId) {
    const material = password + (chatId ? ':' + chatId : '');
    return crypto.pbkdf2Sync(material, SALT, ITERATIONS, KEY_BYTES, 'sha256');
}

function encryptVoice(audioBuffer, password, chatId) {
    const key = deriveKey(password, chatId);
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(audioBuffer), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([MAGIC, iv, ct, tag]);
}

function decryptVoice(encBuffer, password, chatId) {
    if (encBuffer.length < MAGIC.length + IV_LENGTH + TAG_LENGTH) {
        throw new Error('Зашифрованные данные голосового слишком короткие.');
    }
    // Проверка magic (необязательно, но для надёжности)
    if (encBuffer.slice(0, MAGIC.length).toString('latin1') !== MAGIC.toString('latin1')) {
        throw new Error('Неверный magic-маркер голосового (ожидался EV1).');
    }
    const key = deriveKey(password, chatId);
    const iv = encBuffer.slice(MAGIC.length, MAGIC.length + IV_LENGTH);
    const tag = encBuffer.slice(encBuffer.length - TAG_LENGTH);
    const ct = encBuffer.slice(MAGIC.length + IV_LENGTH, encBuffer.length - TAG_LENGTH);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    try {
        return Buffer.concat([decipher.update(ct), decipher.final()]);
    } catch (e) {
        throw new Error('Неверный пароль или повреждённое голосовое.');
    }
}

function isEncryptedVoice(buffer) {
    if (!buffer || buffer.length < MAGIC.length) return false;
    return buffer.slice(0, MAGIC.length).toString('latin1') === MAGIC.toString('latin1');
}

module.exports = {
    encryptVoice,
    decryptVoice,
    isEncryptedVoice,
    MAGIC,
};
