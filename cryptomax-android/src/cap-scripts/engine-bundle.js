/**
 * engine-bundle.js — CryptoMAX Engine Bundle for Android (Capacitor WebView)
 *
 * Single-file IIFE port of the CryptoMAX Electron engine, adapted to run
 * inside the web.max.ru WebView on Android. Contains ALL encryption /
 * decryption logic, with no ES module imports and no external dependencies
 * except the Web Crypto API (crypto.subtle), which is available in
 * Android System WebView (Chromium-based).
 *
 * Source files ported (from /tmp/CryptoMAX-repo/Standalone/):
 *   1. engine/js/core/clean-crypto.js            — AES-256-GCM (Web Crypto)
 *   2. engine/js/core/compact-cipher.js          — Length-preserving stream cipher
 *                                                  (HMAC-SHA256 CTR over 161-char alphabet)
 *   3. engine/js/core/encoders/invisible-spaces.js — Invisible chars + SENTINEL fix
 *   4. engine/js/core/encoders/base64-encoder.js — Base64 / Base85 (Ascii85)
 *   5. engine/js/core/encoders/compression-encoder.js — Deflate-raw + Base64url
 *                                                  (uses native CompressionStream;
 *                                                    no pako dependency needed)
 *   6. engine/js/core/encoders/emoji-encoder.js  — 256-emoji alphabet
 *   7. engine/js/core/encoders/chinese-encoder.js — CJK base-20992
 *   8. engine/js/core/encoders/layout-switch-encoder.js — Smart word-by-word
 *                                                  layout switch (hybrid text + Cat A/B)
 *   9. layout-analyzer.js                        — Smart linguistic layout detection
 *  10. cm-text-file-crypto.js                    — CT1 format for .txt (Node → Web Crypto)
 *  11. cm-voice-crypto.js                        — EV1 format for voice (Node → Web Crypto)
 *
 * All latest fixes from worklog.md are baked in:
 *   - invisible-spaces: SENTINEL (U+FFA0) at end of encode; regex trim in decode/detect
 *     (web.max.ru Lexical editor strips trailing whitespace via .trim())
 *   - compact-cipher: 161-char alphabet (NO \n); \r\n → space normalization
 *     (messengers strip newlines from single-line messages)
 *   - layout-switch-encoder: word-by-word direction; smart punctuation
 *     (Category A: convert if next char is letter; Category B: convert only if
 *      surrounded by letters on both sides)
 *   - clean-crypto: PBKDF2-SHA256 100000 iterations, AES-256-GCM
 *   - detect(): NO .trim() (uses regex trim — preserves Unicode invisible chars)
 *
 * autoDecode order (matches engine-loader.js):
 *   1. detectEncoder(magic prefix) → decode → decrypt
 *   2. AES-256 base64url (if text matches /^[A-Za-z0-9_-]{20,}$/)
 *   3. Compact cipher (MAC-validated — 1-in-10^6 false positive)
 *   4. Layout analyzer (always LAST — pure obfuscation, not crypto)
 *
 * Exposed API (window.CryptoEngineAPI):
 *   encrypt(plaintext, password, mode, chatId)        → Promise<string>
 *   decrypt(ciphertext, password, mode, chatId)        → Promise<string>
 *   autoDecode(ciphertext, password, chatId)           → Promise<{text, method}|null>
 *   detect(text)                                       → {isEncrypted, algorithm, label, isStego}
 *   isReady()                                          → true
 *   getSupportedModes()                                → [{id, label, icon}]
 *
 * Modes: aes256, compact, layout, invisible, base64, compression, emoji,
 *        chinese, textfile
 *
 * For textfile mode:
 *   encrypt → returns base64url of CT1 binary (MAGIC "CT1" + IV(12) + ct+tag)
 *   decrypt → takes base64url CT1, returns plaintext
 *
 * Compression: uses native CompressionStream / DecompressionStream
 * (deflate-raw). No pako dependency required for Android WebView
 * (Chromium 80+, API 30+). Falls back to no compression if unavailable.
 */

(function () {
    'use strict';

    // ════════════════════════════════════════════════════════════
    //  Utility helpers (shared across all modules)
    // ════════════════════════════════════════════════════════════

    var _textEncoder = new TextEncoder();
    var _textDecoder = new TextDecoder();

    function utf8Encode(str) {
        return _textEncoder.encode(str);
    }

    function utf8Decode(bytes) {
        return _textDecoder.decode(bytes);
    }

    /**
     * Regex trim — strips only \t \n \r and regular space (U+0020).
     * CRITICAL: must NOT use String.prototype.trim(), which also strips
     * Unicode whitespace (U+00A0, U+2002-2005, U+202F, U+205F) used by
     * the invisible-spaces encoder. Stripping them corrupts the encoding.
     */
    function regexTrim(text) {
        if (!text) return '';
        return String(text).replace(/^[\t\n\r ]+/, '').replace(/[\t\n\r ]+$/, '');
    }

    // ─── Base64url helpers (shared by AES-256 mode + textfile mode) ───

    var B64URL_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    var B64URL_DECODE = new Map();
    B64URL_CHARS.split('').forEach(function (ch, i) { B64URL_DECODE.set(ch, i); });

    function bytesToBase64url(bytes) {
        if (!bytes || bytes.length === 0) return '';
        var result = '';
        for (var i = 0; i < bytes.length; i += 3) {
            var a = bytes[i];
            var b = (i + 1 < bytes.length) ? bytes[i + 1] : 0;
            var c = (i + 2 < bytes.length) ? bytes[i + 2] : 0;
            var bits = (a << 16) | (b << 8) | c;
            result += B64URL_CHARS[(bits >> 18) & 0x3F];
            result += B64URL_CHARS[(bits >> 12) & 0x3F];
            result += (i + 1 < bytes.length) ? B64URL_CHARS[(bits >> 6) & 0x3F] : '';
            result += (i + 2 < bytes.length) ? B64URL_CHARS[bits & 0x3F] : '';
        }
        return result;
    }

    function base64urlToBytes(str) {
        if (!str) return null;
        if (str.length === 0) return new Uint8Array(0);
        var len = str.length;
        var remainder = len % 4;
        if (remainder === 1) return null; // invalid

        var outputLen;
        if (remainder === 0) outputLen = Math.floor(len / 4) * 3;
        else if (remainder === 2) outputLen = Math.floor(len / 4) * 3 + 1;
        else outputLen = Math.floor(len / 4) * 3 + 2;

        var bytes = new Uint8Array(outputLen);
        var byteIdx = 0;
        var i = 0;

        while (i + 4 <= len) {
            var a = B64URL_DECODE.get(str[i++]) || 0;
            var b = B64URL_DECODE.get(str[i++]) || 0;
            var c = B64URL_DECODE.get(str[i++]) || 0;
            var d = B64URL_DECODE.get(str[i++]) || 0;
            var bits = (a << 18) | (b << 12) | (c << 6) | d;
            if (byteIdx < outputLen) bytes[byteIdx++] = (bits >> 16) & 0xFF;
            if (byteIdx < outputLen) bytes[byteIdx++] = (bits >> 8) & 0xFF;
            if (byteIdx < outputLen) bytes[byteIdx++] = bits & 0xFF;
        }

        if (remainder === 2) {
            var a2 = B64URL_DECODE.get(str[i]) || 0;
            var b2 = B64URL_DECODE.get(str[i + 1]) || 0;
            if (byteIdx < outputLen) bytes[byteIdx++] = ((a2 << 2) | (b2 >> 4)) & 0xFF;
        } else if (remainder === 3) {
            var a3 = B64URL_DECODE.get(str[i]) || 0;
            var b3 = B64URL_DECODE.get(str[i + 1]) || 0;
            var c3 = B64URL_DECODE.get(str[i + 2]) || 0;
            if (byteIdx < outputLen) bytes[byteIdx++] = ((a3 << 2) | (b3 >> 4)) & 0xFF;
            if (byteIdx < outputLen) bytes[byteIdx++] = ((b3 << 4) | (c3 >> 2)) & 0xFF;
        }

        return bytes;
    }

    /**
     * Timing-safe string comparison (defends against timing attacks on MAC).
     */
    function constantTimeCompare(a, b) {
        if (a.length !== b.length) return false;
        var result = 0;
        for (var i = 0; i < a.length; i++) {
            result |= a.charCodeAt(i) ^ b.charCodeAt(i);
        }
        return result === 0;
    }

    // ════════════════════════════════════════════════════════════
    //  CleanCrypto — AES-256-GCM encryption (Web Crypto API)
    // ════════════════════════════════════════════════════════════
    //
    //  Format: MAGIC "CRY" (3) + IV (12) + ciphertext+tag (variable)
    //  KDF:    PBKDF2-SHA256, 100000 iterations, salt "clean-crypto-v1-aes256gcm"
    //  Per-chat: key = PBKDF2(password + ":" + chatId, salt, ...)

    var CLEAN_SALT = utf8Encode('clean-crypto-v1-aes256gcm');
    var CLEAN_IV_LENGTH = 12;
    var CLEAN_TAG_LENGTH = 16;
    var CLEAN_ITERATIONS = 100000;
    var CLEAN_MAGIC = new Uint8Array([0x43, 0x52, 0x59]); // "CRY"

    var CleanCrypto = {
        ALGO: 'AES-GCM',
        KEY_BITS: 256,

        deriveKey: async function (password, chatId) {
            chatId = chatId || '';
            var material = await crypto.subtle.importKey(
                'raw',
                utf8Encode(password + (chatId ? ':' + chatId : '')),
                { name: 'PBKDF2' },
                false,
                ['deriveKey']
            );
            return crypto.subtle.deriveKey(
                { name: 'PBKDF2', salt: CLEAN_SALT, iterations: CLEAN_ITERATIONS, hash: 'SHA-256' },
                material,
                { name: this.ALGO, length: this.KEY_BITS },
                false,
                ['encrypt', 'decrypt']
            );
        },

        /**
         * Encrypt plaintext → Uint8Array (MAGIC + IV + ct+tag).
         */
        encrypt: async function (plaintext, password, chatId) {
            var key = await this.deriveKey(password, chatId);
            var iv = crypto.getRandomValues(new Uint8Array(CLEAN_IV_LENGTH));
            var encoded = utf8Encode(plaintext);

            var ciphertextBuf = await crypto.subtle.encrypt(
                { name: this.ALGO, iv: iv },
                key,
                encoded
            );
            var ciphertext = new Uint8Array(ciphertextBuf);

            var result = new Uint8Array(CLEAN_MAGIC.length + CLEAN_IV_LENGTH + ciphertext.length);
            result.set(CLEAN_MAGIC, 0);
            result.set(iv, CLEAN_MAGIC.length);
            result.set(ciphertext, CLEAN_MAGIC.length + CLEAN_IV_LENGTH);
            return result;
        },

        /**
         * Decrypt Uint8Array → plaintext string.
         * Throws on bad magic / wrong password / corrupted data.
         */
        decrypt: async function (data, password, chatId) {
            if (data.length < CLEAN_MAGIC.length + CLEAN_IV_LENGTH + CLEAN_TAG_LENGTH) {
                throw new Error('Данные слишком короткие для дешифровки.');
            }
            if (data[0] !== CLEAN_MAGIC[0] ||
                data[1] !== CLEAN_MAGIC[1] ||
                data[2] !== CLEAN_MAGIC[2]) {
                throw new Error('Неверный формат зашифрованных данных.');
            }

            var iv = data.slice(CLEAN_MAGIC.length, CLEAN_MAGIC.length + CLEAN_IV_LENGTH);
            var ciphertext = data.slice(CLEAN_MAGIC.length + CLEAN_IV_LENGTH);
            var key = await this.deriveKey(password, chatId);

            var plaintext;
            try {
                plaintext = await crypto.subtle.decrypt(
                    { name: this.ALGO, iv: iv },
                    key,
                    ciphertext
                );
            } catch (e) {
                throw new Error('Неверный пароль или повреждённые данные.');
            }
            return utf8Decode(new Uint8Array(plaintext));
        },

        isEncrypted: function (data) {
            if (!data || data.length < CLEAN_MAGIC.length) return false;
            return data[0] === CLEAN_MAGIC[0] &&
                   data[1] === CLEAN_MAGIC[1] &&
                   data[2] === CLEAN_MAGIC[2];
        }
    };

    // ════════════════════════════════════════════════════════════
    //  CompactCipher — length-preserving stream cipher
    // ════════════════════════════════════════════════════════════
    //
    //  - PBKDF2-SHA256(password+chatId, "compact-cipher-v1", 100000) → 256-bit HMAC key
    //  - Keystream: HMAC-SHA256(key, "ENC" || nonce || counter_LE) per 32-byte block
    //  - Cipher:    modular addition (Vigenère-style) over 161-char alphabet
    //  - MAC:       HMAC-SHA256(key, "MAC" || nonce || plaintext) → 6-digit decimal
    //  - Format:    [ciphertext (len = plaintext+6)] [6-char nonce]
    //  - Total overhead: 12 chars (6 MAC + 6 nonce). No base64 inflation.
    //  - NO \n in alphabet (messengers strip newlines); \r\n → space normalization.
    //  - Detection: MAC-validated (1-in-10^6 false positive). Tried last in autoDecode.

    var COMPACT_ALPHA_STR =
        'abcdefghijklmnopqrstuvwxyz' +                       // 26
        'ABCDEFGHIJKLMNOPQRSTUVWXYZ' +                       // 26
        'абвгдеёжзийклмнопрстуфхцчшщъыьэюя' +                 // 33
        'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ' +                 // 33
        '0123456789' +                                       // 10
        ' ' +                                                // 1
        '.,!?;:\'"-()[]{}/@#$%^&*_+=~`|<>\\';                // 31
    // Total: 161 chars (NO \n — messengers strip it from single-line messages)

    var COMPACT_ALPHABET = COMPACT_ALPHA_STR.split('');
    var COMPACT_N = COMPACT_ALPHABET.length; // 161
    var COMPACT_CHAR_TO_IDX = new Map();
    for (var _i = 0; _i < COMPACT_N; _i++) {
        COMPACT_CHAR_TO_IDX.set(COMPACT_ALPHABET[_i], _i);
    }
    var COMPACT_IDX_TO_CHAR = COMPACT_ALPHABET;

    var COMPACT_SALT = utf8Encode('compact-cipher-v1');
    var COMPACT_ITERATIONS = 100000;
    var COMPACT_KEY_BITS = 256;
    var COMPACT_NONCE_CHARS = 6;
    var COMPACT_MAC_DIGITS = 6;
    var COMPACT_TOTAL_OVERHEAD = COMPACT_NONCE_CHARS + COMPACT_MAC_DIGITS; // 12

    var _compactKeyCache = new Map();
    var _COMPACT_KEY_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

    var CompactCipher = {
        id: 'compact',
        label: 'Компактный (1:1)',
        icon: '🗜️',
        alphabet: COMPACT_ALPHA_STR,
        overhead: COMPACT_TOTAL_OVERHEAD,

        isSupported: function (text) {
            if (!text) return true;
            for (var i = 0; i < text.length; i++) {
                if (!COMPACT_CHAR_TO_IDX.has(text[i])) return false;
            }
            return true;
        },

        getUnsupportedChars: function (text) {
            var unsupported = new Set();
            if (!text) return unsupported;
            for (var i = 0; i < text.length; i++) {
                if (!COMPACT_CHAR_TO_IDX.has(text[i])) unsupported.add(text[i]);
            }
            return unsupported;
        },

        encryptedSize: function (textLength) {
            return textLength + COMPACT_TOTAL_OVERHEAD;
        },

        _deriveKey: async function (password, chatId) {
            chatId = chatId || '';
            var cacheKey = password + '\x00' + chatId;
            var cached = _compactKeyCache.get(cacheKey);
            var now = Date.now();
            if (cached && (now - cached.ts) < _COMPACT_KEY_CACHE_TTL) {
                return cached.cryptoKey;
            }

            var material = await crypto.subtle.importKey(
                'raw',
                utf8Encode(password + (chatId ? ':' + chatId : '')),
                { name: 'PBKDF2' },
                false,
                ['deriveKey']
            );

            var cryptoKey = await crypto.subtle.deriveKey(
                { name: 'PBKDF2', salt: COMPACT_SALT, iterations: COMPACT_ITERATIONS, hash: 'SHA-256' },
                material,
                { name: 'HMAC', hash: 'SHA-256', length: COMPACT_KEY_BITS },
                true,
                ['sign']
            );

            _compactKeyCache.set(cacheKey, { cryptoKey: cryptoKey, ts: now });

            // GC stale entries periodically
            if (_compactKeyCache.size > 50) {
                _compactKeyCache.forEach(function (v, k) {
                    if (now - v.ts > _COMPACT_KEY_CACHE_TTL) _compactKeyCache.delete(k);
                });
            }

            return cryptoKey;
        },

        _generateKeystream: async function (key, nonceIndices, length) {
            var result = new Uint8Array(length);
            // prefix = "ENC" (3) || nonce (NONCE_CHARS) || counter (4 LE)
            var prefix = new Uint8Array(3 + nonceIndices.length + 4);
            prefix[0] = 0x45; prefix[1] = 0x4E; prefix[2] = 0x43; // "ENC"
            prefix.set(nonceIndices, 3);

            var numBlocks = Math.ceil(length / 32);
            var offset = 0;

            for (var block = 0; block < numBlocks; block++) {
                prefix[3 + nonceIndices.length]     = block & 0xFF;
                prefix[3 + nonceIndices.length + 1] = (block >> 8) & 0xFF;
                prefix[3 + nonceIndices.length + 2] = (block >> 16) & 0xFF;
                prefix[3 + nonceIndices.length + 3] = (block >> 24) & 0xFF;

                var sigBuf = await crypto.subtle.sign('HMAC', key, prefix);
                var sig = new Uint8Array(sigBuf);

                var remaining = length - offset;
                var toCopy = Math.min(32, remaining);
                result.set(sig.subarray(0, toCopy), offset);
                offset += toCopy;
            }
            return result;
        },

        _computeMAC: async function (key, nonceIndices, plaintext) {
            var ptBytes = utf8Encode(plaintext);
            // data = "MAC" (3) || nonce || plaintext
            var data = new Uint8Array(3 + nonceIndices.length + ptBytes.length);
            data[0] = 0x4D; data[1] = 0x41; data[2] = 0x43; // "MAC"
            data.set(nonceIndices, 3);
            data.set(ptBytes, 3 + nonceIndices.length);

            var sigBuf = await crypto.subtle.sign('HMAC', key, data);
            var sig = new Uint8Array(sigBuf);

            // First 4 bytes as uint32 big-endian, mod 10^6
            var view = new DataView(sig.buffer, sig.byteOffset, 4);
            var uint32 = view.getUint32(0, false); // big-endian
            var macNum = uint32 % 1000000;
            return macNum.toString().padStart(COMPACT_MAC_DIGITS, '0');
        },

        encrypt: async function (plaintext, password, chatId) {
            if (!plaintext) plaintext = '';
            if (!password) throw new Error('Пароль обязателен для компактного шифра.');

            // 1. Normalize: \r\n → space (messengers strip newlines from single-line msgs)
            plaintext = plaintext.replace(/[\r\n]+/g, ' ');

            // 2. Validate: all chars must be in alphabet
            for (var i = 0; i < plaintext.length; i++) {
                if (!COMPACT_CHAR_TO_IDX.has(plaintext[i])) {
                    var ch = plaintext[i];
                    var code = ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
                    throw new Error(
                        'Неподдерживаемый символ «' + ch + '» (U+' + code + '). ' +
                        'Компактный шифр поддерживает латиницу, кириллицу, цифры и основные знаки препинания. ' +
                        'Удалите этот символ или выберите другой режим шифрования.'
                    );
                }
            }

            // 3. Derive key (cached)
            var key = await this._deriveKey(password, chatId);

            // 4. Generate nonce (6 random alphabet indices)
            var nonceIndices = new Uint8Array(COMPACT_NONCE_CHARS);
            crypto.getRandomValues(nonceIndices);
            for (var j = 0; j < COMPACT_NONCE_CHARS; j++) {
                nonceIndices[j] = nonceIndices[j] % COMPACT_N;
            }
            var nonceStr = '';
            for (var k = 0; k < COMPACT_NONCE_CHARS; k++) {
                nonceStr += COMPACT_IDX_TO_CHAR[nonceIndices[k]];
            }

            // 5. MAC: HMAC-SHA256(key, "MAC" || nonce || plaintext) → 6 digits
            var macStr = await this._computeMAC(key, nonceIndices, plaintext);

            // 6. Combine plaintext + MAC, then encrypt
            var combined = plaintext + macStr;
            var combinedIndices = new Uint8Array(combined.length);
            for (var c = 0; c < combined.length; c++) {
                combinedIndices[c] = COMPACT_CHAR_TO_IDX.get(combined[c]);
            }

            // 7. Generate keystream and encrypt via modular addition
            var keystream = await this._generateKeystream(key, nonceIndices, combinedIndices.length);
            var cipherIndices = new Uint8Array(combinedIndices.length);
            for (var m = 0; m < combinedIndices.length; m++) {
                var kk = keystream[m] % COMPACT_N;
                cipherIndices[m] = (combinedIndices[m] + kk) % COMPACT_N;
            }

            // 8. Indices → chars
            var ciphertext = '';
            for (var n = 0; n < cipherIndices.length; n++) {
                ciphertext += COMPACT_IDX_TO_CHAR[cipherIndices[n]];
            }

            // 9. Append nonce at end
            return ciphertext + nonceStr;
        },

        decrypt: async function (ciphertext, password, chatId) {
            if (!ciphertext || !password) return null;

            // 1. Min length check
            if (ciphertext.length < COMPACT_TOTAL_OVERHEAD) return null;

            // 2. All chars must be in alphabet
            for (var i = 0; i < ciphertext.length; i++) {
                if (!COMPACT_CHAR_TO_IDX.has(ciphertext[i])) return null;
            }

            // 3. Extract nonce (last NONCE_CHARS chars)
            var nonceStr = ciphertext.slice(-COMPACT_NONCE_CHARS);
            var nonceIndices = new Uint8Array(COMPACT_NONCE_CHARS);
            for (var k = 0; k < COMPACT_NONCE_CHARS; k++) {
                nonceIndices[k] = COMPACT_CHAR_TO_IDX.get(nonceStr[k]);
            }

            // 4. Extract ciphertext body (without nonce)
            var cipherBody = ciphertext.slice(0, -COMPACT_NONCE_CHARS);
            if (cipherBody.length < COMPACT_MAC_DIGITS) return null;

            // 5. Derive key
            var key;
            try {
                key = await this._deriveKey(password, chatId);
            } catch (e) { return null; }

            // 6. Decrypt via modular subtraction
            var cipherIndices = new Uint8Array(cipherBody.length);
            for (var c = 0; c < cipherBody.length; c++) {
                cipherIndices[c] = COMPACT_CHAR_TO_IDX.get(cipherBody[c]);
            }
            var keystream = await this._generateKeystream(key, nonceIndices, cipherIndices.length);
            var plainIndices = new Uint8Array(cipherIndices.length);
            for (var m = 0; m < cipherIndices.length; m++) {
                var kk = keystream[m] % COMPACT_N;
                plainIndices[m] = (cipherIndices[m] - kk + COMPACT_N) % COMPACT_N;
            }

            // 7. Indices → string
            var decrypted = '';
            for (var n = 0; n < plainIndices.length; n++) {
                decrypted += COMPACT_IDX_TO_CHAR[plainIndices[n]];
            }

            // 8. Extract MAC (last MAC_DIGITS chars)
            var macCandidate = decrypted.slice(-COMPACT_MAC_DIGITS);
            var plaintext = decrypted.slice(0, -COMPACT_MAC_DIGITS);

            // 9. MAC must be all digits
            if (!/^\d{6}$/.test(macCandidate)) return null;

            // 10. Compute expected MAC and timing-safe compare
            var expectedMac = await this._computeMAC(key, nonceIndices, plaintext);
            if (!constantTimeCompare(macCandidate, expectedMac)) return null;

            return plaintext;
        }
    };

    // ════════════════════════════════════════════════════════════
    //  InvisibleSpacesEncoder — base-8 invisible-char encoding
    // ════════════════════════════════════════════════════════════
    //
    //  - 8 invisible/space characters → base-8 encoding (3 bits/char)
    //  - Format: MAGIC_PREFIX (Lo category) + base8(BigInt([MARKER, lenHi, lenLo, ...bytes]))
    //  - SENTINEL (U+FFA0, Lo category) appended at end of encode:
    //    web.max.ru Lexical editor strips trailing Zs whitespace via .trim();
    //    U+FFA0 is a letter (Lo), NOT whitespace, so .trim() preserves it.
    //  - decode() strips trailing SENTINEL before BigInt calculation.

    var INVISIBLE_CHARS = [
        '\u3164', // Hangul Filler — Lo category, invisible, very stable
        '\u115F', // Hangul Choseong Filler — Lo category, invisible, stable
        '\u00A0', // NBSP — Zs, kept for messenger compatibility
        '\u2002', // En Space — Zs, stable in copy-paste
        '\u2003', // Em Space — Zs, stable
        '\u2005', // Four-Per-Em Space — Zs, stable
        '\u202F', // Narrow NBSP — Zs, stable, not normalized
        '\u205F'  // Medium Mathematical Space — Zs, stable
    ];
    var INVISIBLE_BASE = BigInt(INVISIBLE_CHARS.length); // 8
    var INVISIBLE_MAGIC_PREFIX = '\u3164\u115F'; // Lo+Lo (survives .trim())
    var INVISIBLE_SENTINEL = '\uFFA0'; // Halfwidth Hangul Filler, Lo category

    var _invisibleCharToIndex = new Map();
    INVISIBLE_CHARS.forEach(function (ch, i) { _invisibleCharToIndex.set(ch, i); });

    var INVISIBLE_MARKER = 0xFE; // ensures BigInt has no leading zeros

    function _bigIntToBytes(M) {
        if (M === 0n) return new Uint8Array(1);
        var bytes = [];
        while (M > 0n) {
            bytes.unshift(Number(M & 0xFFn));
            M = M >> 8n;
        }
        return new Uint8Array(bytes);
    }

    var InvisibleSpacesEncoder = {
        id: 'invisible-spaces',
        label: 'Невидимые символы',
        icon: '👻',

        capacity: function (textLength) {
            return textLength * 3; // 3 bits per invisible char
        },

        encode: function (bytes) {
            if (!bytes || bytes.length === 0) return INVISIBLE_MAGIC_PREFIX + INVISIBLE_SENTINEL;

            var lenHi = (bytes.length >> 8) & 0xFF;
            var lenLo = bytes.length & 0xFF;

            var combined = new Uint8Array(3 + bytes.length);
            combined[0] = INVISIBLE_MARKER;
            combined[1] = lenHi;
            combined[2] = lenLo;
            combined.set(bytes, 3);

            // BigInt conversion
            var M = 0n;
            for (var i = 0; i < combined.length; i++) {
                M = (M << 8n) | BigInt(combined[i]);
            }

            // Base-8 encode (least significant digit first → reverse)
            var chars = [];
            while (M > 0n) {
                var remainder = M % INVISIBLE_BASE;
                chars.push(INVISIBLE_CHARS[Number(remainder)]);
                M = M / INVISIBLE_BASE;
            }
            chars.reverse();

            // Append SENTINEL (U+FFA0, Lo category) — protects trailing data
            return INVISIBLE_MAGIC_PREFIX + chars.join('') + INVISIBLE_SENTINEL;
        },

        decode: function (text) {
            if (!text || !text.startsWith(INVISIBLE_MAGIC_PREFIX)) return null;

            var data = text.slice(INVISIBLE_MAGIC_PREFIX.length);
            if (data.length === 0) return new Uint8Array(0);

            // Strip trailing SENTINEL (U+FFA0) if present.
            // New format (v2) adds SENTINEL; old format (v1) doesn't — both decode.
            if (data.endsWith(INVISIBLE_SENTINEL)) {
                data = data.slice(0, -1);
            }

            // Base-8 decode (most significant digit first)
            var M = 0n;
            for (var i = 0; i < data.length; i++) {
                var ch = data[i];
                if (ch === INVISIBLE_SENTINEL) continue; // skip stray sentinel
                var idx = _invisibleCharToIndex.get(ch);
                if (idx === undefined) return null;
                M = M * INVISIBLE_BASE + BigInt(idx);
            }

            var allBytes = _bigIntToBytes(M);
            if (allBytes.length < 3 || allBytes[0] !== INVISIBLE_MARKER) return null;

            var byteLength = (allBytes[1] << 8) | allBytes[2];
            var dataBytes = allBytes.slice(3);
            if (dataBytes.length < byteLength) return null;

            return dataBytes.slice(0, byteLength);
        },

        detect: function (text) {
            if (!text || text.length < INVISIBLE_MAGIC_PREFIX.length) return false;
            return text.startsWith(INVISIBLE_MAGIC_PREFIX);
        }
    };

    // ════════════════════════════════════════════════════════════
    //  Base64Encoder — Base64url + Ascii85 with magic prefixes
    // ════════════════════════════════════════════════════════════

    var B64_MAGIC = '𝐁64:';
    var B85_MAGIC = '𝐁85:';

    var B64_CHARS_LOCAL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    var B64_DECODE_LOCAL = new Map();
    B64_CHARS_LOCAL.split('').forEach(function (ch, i) { B64_DECODE_LOCAL.set(ch, i); });

    var A85_START = 33;
    var A85_END = 117;

    function _encodeB64Local(bytes) {
        var result = '';
        var i = 0;
        var len = bytes.length;
        while (i < len) {
            var a = bytes[i++];
            var b = i < len ? bytes[i++] : 0;
            var c = i < len ? bytes[i++] : 0;
            var bits = (a << 16) | (b << 8) | c;
            result += B64_CHARS_LOCAL[(bits >> 18) & 0x3F];
            result += B64_CHARS_LOCAL[(bits >> 12) & 0x3F];
            result += (i - 2 < len) ? B64_CHARS_LOCAL[(bits >> 6) & 0x3F] : '';
            result += (i - 1 < len) ? B64_CHARS_LOCAL[bits & 0x3F] : '';
        }
        return result;
    }

    function _decodeB64Local(str) {
        if (!str) return new Uint8Array(0);
        var padding = str.length % 4;
        var decodedLen = Math.floor(str.length * 3 / 4);
        var bytes = new Uint8Array(decodedLen);
        var byteIdx = 0;
        var i = 0;
        while (i < str.length) {
            var a = B64_DECODE_LOCAL.get(str[i++]) || 0;
            var b = i < str.length ? (B64_DECODE_LOCAL.get(str[i++]) || 0) : 0;
            var c = i < str.length ? (B64_DECODE_LOCAL.get(str[i++]) || 0) : 0;
            var d = i < str.length ? (B64_DECODE_LOCAL.get(str[i++]) || 0) : 0;
            var bits = (a << 18) | (b << 12) | (c << 6) | d;
            if (byteIdx < decodedLen) bytes[byteIdx++] = (bits >> 16) & 0xFF;
            if (byteIdx < decodedLen) bytes[byteIdx++] = (bits >> 8) & 0xFF;
            if (byteIdx < decodedLen) bytes[byteIdx++] = bits & 0xFF;
        }
        return bytes.slice(0, byteIdx);
    }

    function _encodeBase85(bytes) {
        if (bytes.length === 0) return '';
        var padded = new Uint8Array(Math.ceil(bytes.length / 4) * 4);
        padded.set(bytes);
        var originalLen = bytes.length;
        var result = '';
        for (var i = 0; i < padded.length; i += 4) {
            var val = (padded[i] << 24) | (padded[i + 1] << 16) | (padded[i + 2] << 8) | padded[i + 3];
            if (val === 0 && (i + 4 <= originalLen)) {
                result += String.fromCharCode(A85_END + 1); // 'v' for zero group
                continue;
            }
            var group = '';
            var v = val >>> 0; // unsigned
            for (var j = 4; j >= 0; j--) {
                group = String.fromCharCode(A85_START + (v % 85)) + group;
                v = Math.floor(v / 85);
            }
            var bytesInGroup = Math.min(4, originalLen - i);
            result += group.slice(0, bytesInGroup + 1);
        }
        return result;
    }

    function _decodeBase85(str) {
        if (!str) return new Uint8Array(0);
        var bytes = [];
        var i = 0;
        while (i < str.length) {
            if (str.charCodeAt(i) === A85_END + 1) {
                bytes.push(0, 0, 0, 0);
                i++;
                continue;
            }
            var groupLen = Math.min(5, str.length - i);
            var val = 0;
            for (var j = 0; j < 5; j++) {
                var ch = (i + j < str.length) ? str.charCodeAt(i + j) : A85_END;
                val = val * 85 + (ch - A85_START);
            }
            var decodedBytes = [
                (val >> 24) & 0xFF,
                (val >> 16) & 0xFF,
                (val >> 8) & 0xFF,
                val & 0xFF
            ];
            var outputLen = groupLen - 1;
            for (var k = 0; k < outputLen && bytes.length < str.length; k++) {
                bytes.push(decodedBytes[k]);
            }
            i += groupLen;
        }
        return new Uint8Array(bytes);
    }

    var Base64Encoder = {
        id: 'base64',
        label: 'Base64/85',
        icon: '🔤',

        capacity: function (textLength) {
            return Math.floor(textLength * 6);
        },

        encode: function (bytes) {
            if (!bytes || bytes.length === 0) return B64_MAGIC;
            var b85 = _encodeBase85(bytes);
            var b64 = _encodeB64Local(bytes);
            if (b85.length <= b64.length) return B85_MAGIC + b85;
            return B64_MAGIC + b64;
        },

        decode: function (text) {
            if (!text) return null;
            if (text.startsWith(B64_MAGIC)) return _decodeB64Local(text.slice(B64_MAGIC.length));
            if (text.startsWith(B85_MAGIC)) return _decodeBase85(text.slice(B85_MAGIC.length));
            return null;
        },

        detect: function (text) {
            if (!text) return false;
            return text.startsWith(B64_MAGIC) || text.startsWith(B85_MAGIC);
        }
    };

    // ════════════════════════════════════════════════════════════
    //  CompressionEncoder — Deflate-raw + Base64url
    // ════════════════════════════════════════════════════════════
    //
    //  Uses native CompressionStream / DecompressionStream (deflate-raw).
    //  Available in Android System WebView (Chromium 80+, Android 10+).
    //  No external pako dependency needed.
    //  Falls back to no-compression if CompressionStream is unavailable.

    var COMP_MAGIC = 'ZH:';

    async function _compressNative(bytes) {
        var cs = new CompressionStream('deflate-raw');
        var writer = cs.writable.getWriter();
        var reader = cs.readable.getReader();
        writer.write(bytes);
        writer.close();

        var chunks = [];
        while (true) {
            var res = await reader.read();
            if (res.done) break;
            chunks.push(res.value);
        }
        var total = chunks.reduce(function (s, c) { return s + c.length; }, 0);
        var result = new Uint8Array(total);
        var offset = 0;
        for (var i = 0; i < chunks.length; i++) {
            result.set(chunks[i], offset);
            offset += chunks[i].length;
        }
        return result;
    }

    async function _decompressNative(bytes) {
        var ds = new DecompressionStream('deflate-raw');
        var writer = ds.writable.getWriter();
        var reader = ds.readable.getReader();
        writer.write(bytes);
        writer.close();

        var chunks = [];
        while (true) {
            var res = await reader.read();
            if (res.done) break;
            chunks.push(res.value);
        }
        var total = chunks.reduce(function (s, c) { return s + c.length; }, 0);
        var result = new Uint8Array(total);
        var offset = 0;
        for (var i = 0; i < chunks.length; i++) {
            result.set(chunks[i], offset);
            offset += chunks[i].length;
        }
        return result;
    }

    var CompressionEncoder = {
        id: 'compression',
        label: 'Deflate+B64',
        icon: '📦',

        capacity: function (textLength) {
            return Math.floor(textLength * 4.5);
        },

        encode: async function (bytes) {
            if (!bytes || bytes.length === 0) return COMP_MAGIC;
            try {
                if (typeof CompressionStream !== 'undefined') {
                    var compressed = await _compressNative(bytes);
                    return COMP_MAGIC + bytesToBase64url(compressed);
                }
            } catch (e) {
                console.warn('CompressionStream failed, using uncompressed fallback:', e);
            }
            // Fallback: no compression
            return COMP_MAGIC + bytesToBase64url(bytes);
        },

        decode: async function (text) {
            if (!text || !text.startsWith(COMP_MAGIC)) return null;
            var b64 = text.slice(COMP_MAGIC.length);
            var bytes = base64urlToBytes(b64);
            if (!bytes || bytes.length === 0) return bytes;
            try {
                if (typeof DecompressionStream !== 'undefined') {
                    var decompressed = await _decompressNative(bytes);
                    if (decompressed && decompressed.length > 0) return decompressed;
                }
            } catch (e) {
                // Data was not compressed (fallback mode), return raw bytes
            }
            return bytes;
        },

        detect: function (text) {
            if (!text) return false;
            return text.startsWith(COMP_MAGIC);
        }
    };

    // ════════════════════════════════════════════════════════════
    //  EmojiEncoder — 256-emoji alphabet (1 byte = 1 emoji)
    // ════════════════════════════════════════════════════════════

    var EMOJI_MAGIC = '😀🔤';
    var EMOJI_ALPHABET = [
        // Row 1: Faces (0-19)
        '😀','😁','😂','😃','😄','😅','😆','😇','😈','😉',
        '😊','😋','😌','😍','😎','😏','😐','😑','😒','😓',
        // Row 2: Faces (20-39)
        '😔','😕','😖','😗','😘','😙','😚','😛','😜','😝',
        '😞','😟','😠','😡','😢','😣','😤','😥','😦','😧',
        // Row 3: Faces + Cats (40-59)
        '😨','😩','😪','😫','😬','😭','😮','😯','😰','😱',
        '😲','😳','😴','😵','😶','😷','😸','😹','😺','😻',
        // Row 4: Cats + Symbols (60-79)
        '😼','😽','🙀','😿','😾','❤','🔥','⭐','🌈','🎵',
        '🎶','💡','💎','🔑','🔒','🔓','📝','📌','📎','📏',
        // Row 5: Objects (80-99)
        '📐','📕','📗','📘','📙','📚','📖','🔬','🔭','🎥',
        '📷','💾','📞','📟','📠','🔋','🔌','🔦','💰','💳',
        // Row 6: Money + Mail (100-119)
        '💸','💲','📧','📥','📤','📦','📫','📮','📰','🖥',
        '🖨','🖱','🖲','📀','🎞','🔊','🔉','🔈','🔇','🔔',
        // Row 7: Alerts + Time (120-139)
        '🔕','📢','📣','⏳','⌛','⏰','⌚','🔏','🔐','🗝',
        '🔨','⛏','⚒','🛠','🗡','⚔','🔫','🏹','🛡','🔧',
        // Row 8: Tools + Science (140-159)
        '🔩','⚙','🗜','⚖','🔗','⛓','🧰','🧲','🧪','🧫',
        '🧬','💉','🩸','💊','🩹','🩺','🚪','🛏','🛋','🪑',
        // Row 9: Home + Household (160-179)
        '🚽','🚿','🛁','🪒','🧴','🧷','🧹','🧺','🧻','🧼',
        '🧽','🧯','🛒','🚬','⚰','⚱','🗿','🏧','🚮','🚰',
        // Row 10: Signs (180-199)
        '♿','🚹','🚺','🚻','🚼','🚾','🛂','🛃','🛄','🛅',
        '⚠','🚸','⛔','🚫','🚳','🚭','🚯','🚱','🚷','📵',
        // Row 11: Warning + Arrows (200-219)
        '🔞','☢','☣','⬆','↗','➡','↘','⬇','↙','⬅',
        '↖','↕','↔','↩','↪','⤴','⤵','🔃','🔄','🔙',
        // Row 12: Navigation + Religion (220-239)
        '🔚','🔛','🔜','🔝','🛐','⚛','🕉','✡','☸','☯',
        '✝','☦','☪','☮','🕎','🔯','♈','♉','♊','♋',
        // Row 13: Zodiac + Media controls (240-255)
        '♌','♍','♎','♏','♐','♑','♒','♓','⛎','🔀',
        '🔁','🔂','▶','⏩','⏭','⏯'
    ];

    var _emojiToByte = new Map();
    EMOJI_ALPHABET.forEach(function (emoji, i) {
        if (_emojiToByte.has(emoji)) {
            console.warn('Duplicate emoji at index ' + i + ': ' + emoji);
        }
        _emojiToByte.set(emoji, i);
    });

    var EmojiEncoder = {
        id: 'emoji',
        label: 'Эмодзи',
        icon: '😀',

        capacity: function (textLength) {
            return textLength * 8;
        },

        _stripVariationSelectors: function (text) {
            return text.replace(/[\uFE0E\uFE0F\u200B\u200C\u200D\u2060]/g, '');
        },

        encode: function (bytes) {
            if (!bytes || bytes.length === 0) return EMOJI_MAGIC;
            var result = EMOJI_MAGIC;
            for (var i = 0; i < bytes.length; i++) {
                var b = bytes[i];
                if (b >= EMOJI_ALPHABET.length) {
                    result += EMOJI_ALPHABET[0];
                } else {
                    result += EMOJI_ALPHABET[b];
                }
            }
            return result;
        },

        decode: function (text) {
            if (!text) return null;
            var cleanText = EmojiEncoder._stripVariationSelectors(text);
            if (!cleanText.startsWith(EMOJI_MAGIC)) return null;
            var data = cleanText.slice(EMOJI_MAGIC.length);
            if (data.length === 0) return new Uint8Array(0);

            var bytes = [];
            var i = 0;
            while (i < data.length) {
                var matched = false;
                for (var len = Math.min(4, data.length - i); len >= 1; len--) {
                    var candidate = data.substring(i, i + len);
                    var byteVal = _emojiToByte.get(candidate);
                    if (byteVal !== undefined) {
                        bytes.push(byteVal);
                        i += len;
                        matched = true;
                        break;
                    }
                }
                if (!matched) {
                    i++; // skip unknown (skin tone modifier, etc.)
                }
            }
            return bytes.length > 0 ? new Uint8Array(bytes) : null;
        },

        detect: function (text) {
            if (!text) return false;
            return EmojiEncoder._stripVariationSelectors(text).startsWith(EMOJI_MAGIC);
        }
    };

    // ════════════════════════════════════════════════════════════
    //  ChineseEncoder — CJK base-20992 (~14.3 bits/char)
    // ════════════════════════════════════════════════════════════

    var CJK_START = 0x4E00;
    var CJK_END = 0x9FFF;
    var CJK_BASE = BigInt(CJK_END - CJK_START + 1); // 20992
    var CJK_BASE_BITS = Math.log2(20992); // ~14.35
    var CJK_MAGIC = '之码曰';

    var ChineseEncoder = {
        id: 'chinese',
        label: 'Китайские иероглифы',
        icon: '🈳',

        capacity: function (textLength) {
            return Math.floor(textLength * CJK_BASE_BITS);
        },

        encode: function (bytes) {
            if (!bytes || bytes.length === 0) return CJK_MAGIC;
            var M = 0n;
            for (var i = 0; i < bytes.length; i++) {
                M = (M << 8n) | BigInt(bytes[i]);
            }
            if (M === 0n) return CJK_MAGIC + String.fromCharCode(CJK_START);

            var chars = [];
            while (M > 0n) {
                var remainder = Number(M % CJK_BASE);
                chars.push(String.fromCharCode(CJK_START + remainder));
                M = M / CJK_BASE;
            }
            chars.reverse();
            return CJK_MAGIC + chars.join('');
        },

        decode: function (text) {
            if (!text || !text.startsWith(CJK_MAGIC)) return null;
            var data = text.slice(CJK_MAGIC.length);
            if (data.length === 0) return new Uint8Array(0);

            var M = 0n;
            for (var i = 0; i < data.length; i++) {
                var code = data.charCodeAt(i);
                if (code < CJK_START || code > CJK_END) return null;
                var value = BigInt(code - CJK_START);
                M = M * CJK_BASE + value;
            }
            return _bigIntToBytes(M);
        },

        detect: function (text) {
            if (!text) return false;
            return text.startsWith(CJK_MAGIC);
        }
    };

    // ════════════════════════════════════════════════════════════
    //  LayoutSwitchEncoder — Smart word-by-word EN<->RU switcher
    // ════════════════════════════════════════════════════════════
    //
    //  - Encodes: Russian text → English QWERTY keys (as if user forgot layout)
    //  - Decodes: word-by-word direction analysis (hybrid text support)
    //    * Latin-only word → en→ru
    //    * Cyrillic-only word → ru→en
    //    * Mixed (EN+RU) word → leave as is
    //  - Smart punctuation handling (Category A vs B):
    //    * Cat A (, . ; ' [ ] { } < > : "): convert if NEXT char is letter
    //      (covers б/,/ю./ж;/э' — letters at start/middle of word)
    //    * Cat B (? /): convert ONLY if surrounded by letters on both sides
    //      (preserves ? in questions, / in URLs)

    var LAYOUT_RU_TO_EN = {
        'й':'q','ц':'w','у':'e','к':'r','е':'t','н':'y','г':'u','ш':'i','щ':'o','з':'p','х':'[','ъ':']',
        'ф':'a','ы':'s','в':'d','а':'f','п':'g','р':'h','о':'j','л':'k','д':'l','ж':';','э':"'",
        'я':'z','ч':'x','с':'c','м':'v','и':'b','т':'n','ь':'m','б':',','ю':'.',
        'ё':'`',
        // Uppercase
        'Й':'Q','Ц':'W','У':'E','К':'R','Е':'T','Н':'Y','Г':'U','Ш':'I','Щ':'O','З':'P','Х':'{','Ъ':'}',
        'Ф':'A','Ы':'S','В':'D','А':'F','П':'G','Р':'H','О':'J','Л':'K','Д':'L','Ж':':','Э':'"',
        'Я':'Z','Ч':'X','С':'C','М':'V','И':'B','Т':'N','Ь':'M','Б':'<','Ю':'>',
        'Ё':'~',
        // Numbers row
        '1':'1','2':'2','3':'3','4':'4','5':'5','6':'6','7':'7','8':'8','9':'9','0':'0',
        '-':'-','=':'=',
        '!':'!','@':'@','#':'#','$':'$','%':'%','^':'^','&':'&','*':'*','(':'(',')':')',
        '_':'_','+':'+',
        ' ':' ','\n':'\n','\r':'\r','\t':'\t'
    };

    // Reverse: English QWERTY → Russian ЙЦУКЕН
    var LAYOUT_EN_TO_RU = {};
    for (var _ru in LAYOUT_RU_TO_EN) {
        var _en = LAYOUT_RU_TO_EN[_ru];
        if (!LAYOUT_EN_TO_RU[_en] || _ru === _ru.toLowerCase()) {
            LAYOUT_EN_TO_RU[_en] = _ru;
        }
    }
    // Ensure uppercase mappings
    for (var _ru2 in LAYOUT_RU_TO_EN) {
        var _en2 = LAYOUT_RU_TO_EN[_ru2];
        if (_ru2 === _ru2.toUpperCase() && _ru2 !== _ru2.toLowerCase()) {
            LAYOUT_EN_TO_RU[_en2] = _ru2;
        }
    }

    var LAYOUT_RU_PATTERN = /[а-яА-ЯёЁ]/;
    var LAYOUT_EN_PATTERN = /[a-zA-Z]/;
    var LAYOUT_LETTER_PATTERN = /[a-zA-Zа-яА-ЯёЁ]/;

    var AMBIGUOUS_PUNCT_A = new Set([
        ',', '.', ';', "'", '[', ']', '{', '}', '<', '>', ':', '"'
    ]);
    var AMBIGUOUS_PUNCT_B = new Set(['?', '/']);
    var AMBIGUOUS_PUNCT = new Set(
        Array.from(AMBIGUOUS_PUNCT_A).concat(Array.from(AMBIGUOUS_PUNCT_B))
    );

    var LAYOUT_MAGIC = '⌨️⇄:';

    function _layoutIsLetter(ch) {
        if (!ch) return false;
        return LAYOUT_LETTER_PATTERN.test(ch);
    }

    function _switchLayoutSmart(text, direction) {
        var map = direction === 'ru-to-en' ? LAYOUT_RU_TO_EN : LAYOUT_EN_TO_RU;
        var result = '';
        for (var i = 0; i < text.length; i++) {
            var ch = text[i];
            if (ch in map) {
                if (direction === 'en-to-ru' && AMBIGUOUS_PUNCT.has(ch)) {
                    var prevCh = i > 0 ? text[i - 1] : '';
                    var nextCh = i < text.length - 1 ? text[i + 1] : '';
                    if (AMBIGUOUS_PUNCT_B.has(ch)) {
                        // Category B (?, /): convert only if surrounded by letters
                        if (_layoutIsLetter(prevCh) && _layoutIsLetter(nextCh)) {
                            result += map[ch];
                        } else {
                            result += ch;
                        }
                    } else {
                        // Category A (, . ; ' [ ] { } < > : "): convert if NEXT char is letter
                        if (_layoutIsLetter(nextCh)) {
                            result += map[ch];
                        } else {
                            result += ch;
                        }
                    }
                } else {
                    result += map[ch];
                }
            } else {
                result += ch;
            }
        }
        return result;
    }

    var LayoutSwitchEncoder = {
        id: 'layout-switch',
        label: 'Смена раскладки',
        icon: '⌨️',

        capacity: function (textLength) {
            return textLength * 8;
        },

        encode: function (bytes) {
            var text = utf8Decode(bytes);
            if (!text) return LAYOUT_MAGIC;
            var encoded = _switchLayoutSmart(text, 'ru-to-en');
            return LAYOUT_MAGIC + encoded;
        },

        encodeString: function (text, withMagic) {
            if (withMagic === undefined) withMagic = true;
            if (!text) return withMagic ? LAYOUT_MAGIC : '';
            var encoded = _switchLayoutSmart(text, 'ru-to-en');
            return withMagic ? LAYOUT_MAGIC + encoded : encoded;
        },

        decode: function (text) {
            var decoded = LayoutSwitchEncoder.decodeToString(text);
            if (decoded === null) return null;
            return utf8Encode(decoded);
        },

        decodeToString: function (text) {
            if (!text) return null;
            var data = text;
            if (data.startsWith(LAYOUT_MAGIC)) {
                data = data.slice(LAYOUT_MAGIC.length);
            }

            var hasEn = LAYOUT_EN_PATTERN.test(data);
            var hasRu = LAYOUT_RU_PATTERN.test(data);

            // Fast paths
            if (!hasEn && !hasRu) return data;
            if (hasEn && !hasRu) return _switchLayoutSmart(data, 'en-to-ru');
            if (hasRu && !hasEn) return _switchLayoutSmart(data, 'ru-to-en');

            // Hybrid: word-by-word direction analysis
            var tokens = data.split(/(\s+)/);
            var result = '';
            for (var i = 0; i < tokens.length; i++) {
                var token = tokens[i];
                if (!token || /^\s+$/.test(token)) {
                    result += token;
                    continue;
                }
                var tokHasEn = LAYOUT_EN_PATTERN.test(token);
                var tokHasRu = LAYOUT_RU_PATTERN.test(token);
                if (tokHasEn && !tokHasRu) {
                    result += _switchLayoutSmart(token, 'en-to-ru');
                } else if (tokHasRu && !tokHasEn) {
                    result += _switchLayoutSmart(token, 'ru-to-en');
                } else {
                    // Mixed — leave as is
                    result += token;
                }
            }
            return result;
        },

        detect: function (text) {
            if (!text) return false;
            return text.startsWith(LAYOUT_MAGIC);
        },

        quickSwitch: function (text) {
            if (!text) return '';
            return LayoutSwitchEncoder.decodeToString(text) || text;
        }
    };

    // ════════════════════════════════════════════════════════════
    //  Encoder index — getEncoderById, detectEncoder
    // ════════════════════════════════════════════════════════════

    var ENCODERS = [
        InvisibleSpacesEncoder,
        Base64Encoder,
        CompressionEncoder,
        EmojiEncoder,
        ChineseEncoder,
        LayoutSwitchEncoder
    ];

    function getEncoderById(id) {
        for (var i = 0; i < ENCODERS.length; i++) {
            if (ENCODERS[i].id === id) return ENCODERS[i];
        }
        return null;
    }

    function detectEncoder(text) {
        if (!text) return null;
        for (var i = 0; i < ENCODERS.length; i++) {
            try {
                if (ENCODERS[i].detect(text)) return ENCODERS[i];
            } catch (e) {
                console.warn('Encoder ' + ENCODERS[i].id + ' detect error:', e);
            }
        }
        return null;
    }

    // ════════════════════════════════════════════════════════════
    //  LayoutAnalyzer — smart linguistic layout detection
    // ════════════════════════════════════════════════════════════
    //
    //  Used in autoDecode step 4 (always LAST — pure obfuscation, not crypto).
    //  Word-by-word scoring: vowel ratios, impossible EN/RU bigrams,
    //  morpheme markers (cz=ся, jq=ой, ghb=при, sq=ый, yf=на, gj=по),
    //  consonant clusters, URL/email/base64-token protection.

    var LA_EN_TO_RU = {
        'q':'й','w':'ц','e':'у','r':'к','t':'е','y':'н','u':'г',
        'i':'ш','o':'щ','p':'з','[':'х',']':'ъ',
        'a':'ф','s':'ы','d':'в','f':'а','g':'п','h':'р','j':'о',
        'k':'л','l':'д',';':'ж',"'":'э',
        'z':'я','x':'ч','c':'с','v':'м','b':'и','n':'т','m':'ь',
        ',':'б','.':'ю','/':'.',
        'Q':'Й','W':'Ц','E':'У','R':'К','T':'Е','Y':'Н','U':'Г',
        'I':'Ш','O':'Щ','P':'З','{':'Х','}':'Ъ',
        'A':'Ф','S':'Ы','D':'В','F':'А','G':'П','H':'Р','J':'О',
        'K':'Л','L':'Д',':':'Ж','"':'Э',
        'Z':'Я','X':'Ч','C':'С','V':'М','B':'И','N':'Т','M':'Ь',
        '<':'Б','>':'Ю','?':',',
        '`':'ё','~':'Ё',
        '@':'"','#':'№','$':';','^':':','&':'?'
    };

    var LA_RU_TO_EN = {};
    for (var _en3 in LA_EN_TO_RU) {
        var _ru3 = LA_EN_TO_RU[_en3];
        if (!(_ru3 in LA_RU_TO_EN)) {
            LA_RU_TO_EN[_ru3] = _en3;
        }
    }
    for (var _en4 in LA_EN_TO_RU) {
        var _ru4 = LA_EN_TO_RU[_en4];
        if (_en4 >= 'A' && _en4 <= 'Z') {
            LA_RU_TO_EN[_ru4] = _en4;
        }
    }

    var RU_VOWELS = 'аеёиоуыэюяАЕЁИОУЫЭЮЯ';
    var EN_VOWELS = 'aeiouyAEIOUY';

    var LA_URL_RE = /https?:\/\/[^\s<>"']+/gi;
    var LA_EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
    var LA_BASE64_TOKEN_RE = /^[A-Za-z0-9+/_=\-]{24,}$/;
    var LA_HEX_TOKEN_RE = /^(0x)?[0-9a-fA-F]{16,}$/;
    var LA_WHOLE_BASE64_RE = /^[A-Za-z0-9_-]{20,}$/;

    // Impossible-in-EN bigrams/trigrams (markers of RU-typed-in-EN)
    var RU_IN_EN_MARKERS_RE = /(?:cz|jq|bq|ysq|yfz|rfr|ytn|xtn|ghb|ghbd|xtk|yb|df|cj|ltk|kj)/i;
    // Impossible-in-EN endings (markers of RU-typed-in-EN)
    var RU_IN_EN_ENDING_RE = /(?:sq|fz|jt|nm|bt)$/i;
    // Impossible-in-EN prefixes
    var RU_IN_EN_PREFIX_RE = /^(?:yf|gj)/i;
    // Conservative EN-in-RU markers
    var EN_IN_RU_MARKERS_RE = /(?:сщ|ыф|рщ|ещ|нщ|зщ|фы|ащ|яы)/i;

    var EN_WHITELIST = new Set([
        'id','js','ts','css','html','xml','json','yaml','yml','toml',
        'git','npm','yarn','pnpm','api','url','uri','http','https',
        'www','com','org','net','io','app','dev','test','src','lib',
        'bin','tmp','md','txt','log','cfg','conf','env','sql','sh',
        'bash','zsh','ssh','ssl','tls','dns','cdn','vpn','lan','wan',
        'tcp','udp','ftp','sftp','smtp','imap','pop3','jwt','oauth',
        'sso','cpu','gpu','ram','ssd','hdd','usb','hdmi','lcd','led',
        'ocr','rss','sms','mms','sim','pin','otp','mac','pc','ip',
        'var','let','const','if','else','for','while','do','return',
        'function','class','new','this','super','yield','async','await',
        'import','export','default','from','null','true','false',
        'undefined','void','typeof','instanceof','in','of','as','is',
        'the','and','or','not','but','a','an','to','of','in','on',
        'at','by','it','be','go','no','so','up','us','we','he',
        'my','me','hi','ok','im','ur','u','r','n','c','b','x','y',
        'fyi','asap','brb','lol','omg','wtf','btw','imho','imo',
        'afk','ty','np','yw','gg','wp','gl','hf','bbl','ttyl','smh',
        'tbh','ikr','nvm','rofl','lmao','fomo','yolo','pls','plz',
        'thx','thanx','cu','cya','bday','aka','eta','faq','tba',
        'jpg','jpeg','png','gif','bmp','svg','pdf','zip','rar','tar',
        'gz','mp3','mp4','avi','mov','exe','dmg','iso','deb','rpm',
        'msi','apk','ipa',
        'get','set','put','add','del','rm','mv','cp','cd','ls','ps',
        'cat','top','run','fix','bug','wip','todo','done','note','tip',
        'warn','info','err','max','min','avg','sum','len','size','type',
        'name','date','time','year','month','day','hour','min','sec',
        'key','val','item','list','map','que','stk','buf','str','num',
        'int','flt','dbl','bool','char','byte','user','pass','login',
        'logout','sign','signup','signin','home','help','about','search',
        'edit','view','open','close','save','load','start','stop','sync'
    ]);

    function _laConvertText(text, toRussian) {
        var map = toRussian ? LA_EN_TO_RU : LA_RU_TO_EN;
        var out = '';
        for (var i = 0; i < text.length; i++) {
            var ch = text[i];
            out += (ch in map) ? map[ch] : ch;
        }
        return out;
    }

    function _laCountVowels(text, lang) {
        var set = lang === 'ru' ? RU_VOWELS : EN_VOWELS;
        var n = 0;
        for (var i = 0; i < text.length; i++) {
            if (set.indexOf(text[i]) !== -1) n++;
        }
        return n;
    }

    function _laEvaluateWord(word) {
        var no = { shouldSwitch: false, targetLang: null, converted: word, score: 0, reason: '' };
        if (!word || word.length <= 1) return no;

        var clean = word.replace(/[^a-zA-Zа-яА-ЯёЁ]/g, '');
        if (clean.length <= 1) return no;

        if (LA_BASE64_TOKEN_RE.test(word) || LA_HEX_TOKEN_RE.test(word)) return no;

        var lower = clean.toLowerCase();
        if (EN_WHITELIST.has(lower) && clean.length <= 8) return no;

        var enLetters = /^[a-zA-Z]+$/.test(clean);
        var ruLetters = /^[а-яА-ЯёЁ]+$/.test(clean);
        if (!enLetters && !ruLetters) return no;

        // CASE 1: Latin → maybe Russian typed in EN layout
        if (enLetters) {
            var enVowels = _laCountVowels(clean, 'en');
            var enVowelRatio = enVowels / clean.length;

            var ruConverted = _laConvertText(clean, true);
            var ruVowels = _laCountVowels(ruConverted, 'ru');
            var ruVowelRatio = ruVowels / ruConverted.length;

            var hasMarker = RU_IN_EN_MARKERS_RE.test(clean);
            var hasEnding = RU_IN_EN_ENDING_RE.test(clean);
            var hasPrefix = RU_IN_EN_PREFIX_RE.test(clean);
            var consonantCluster = /[^aeiouy\s]{5,}/i.test(clean);

            var score = 0;
            var reasons = [];

            if (clean.length >= 4 && enVowelRatio === 0) {
                score += 3; reasons.push('en-no-vowels');
            } else if (clean.length >= 5 && enVowelRatio < 0.12) {
                score += 3; reasons.push('en-vowel-very-low');
            } else if (clean.length >= 6 && enVowelRatio < 0.20) {
                score += 1; reasons.push('en-vowel-low');
            }

            if (ruVowelRatio >= 0.30) {
                score += 2; reasons.push('ru-vowel-ok');
            } else if (ruVowelRatio >= 0.22) {
                score += 1; reasons.push('ru-vowel-mid');
            }

            if (hasMarker) { score += 3; reasons.push('ru-marker'); }
            if (hasEnding) { score += 3; reasons.push('ru-ending'); }
            if (hasPrefix) { score += 3; reasons.push('ru-prefix'); }
            if (consonantCluster) { score += 1; reasons.push('consonant-cluster'); }

            var hasMorphMarker = hasMarker || hasEnding || hasPrefix;
            var hasVowellessPattern = enVowelRatio === 0 && consonantCluster && ruVowelRatio >= 0.30;
            var hasStrongSignal = hasMorphMarker || hasVowellessPattern;

            if (score >= 4 && hasStrongSignal && ruVowelRatio >= 0.20) {
                var convertedFull = _laConvertText(word, true);
                return {
                    shouldSwitch: true,
                    targetLang: 'ru',
                    converted: convertedFull,
                    score: score,
                    reason: reasons.join('+')
                };
            }
            return no;
        }

        // CASE 2: Cyrillic → maybe English typed in RU layout (conservative)
        if (ruLetters) {
            var ruVowels2 = _laCountVowels(clean, 'ru');
            var ruVowelRatio2 = ruVowels2 / clean.length;

            var enConverted = _laConvertText(clean, false);
            if (!/^[a-zA-Z]+$/.test(enConverted)) return no;

            var enVowels2 = _laCountVowels(enConverted, 'en');
            var enVowelRatio2 = enVowels2 / enConverted.length;

            var hasMarker2 = EN_IN_RU_MARKERS_RE.test(clean);

            var score2 = 0;
            var reasons2 = [];

            if (clean.length >= 3 && ruVowels2 === 0) {
                score2 += 3; reasons2.push('ru-no-vowels');
            } else if (clean.length >= 6 && ruVowelRatio2 < 0.18) {
                score2 += 1; reasons2.push('ru-vowel-low');
            }

            if (clean.length >= 4 && enVowelRatio2 >= 0.20) {
                score2 += 2; reasons2.push('en-vowel-ok');
            }

            if (hasMarker2) { score2 += 3; reasons2.push('en-marker'); }

            var hasStrongSignal2 = hasMarker2 || (clean.length >= 3 && ruVowels2 === 0);
            var enAcceptable = enVowelRatio2 >= 0.15;

            if (score2 >= 4 && hasStrongSignal2 && enAcceptable) {
                var convertedFull2 = _laConvertText(word, false);
                return {
                    shouldSwitch: true,
                    targetLang: 'en',
                    converted: convertedFull2,
                    score: score2,
                    reason: reasons2.join('+')
                };
            }
            return no;
        }

        return no;
    }

    function _laAnalyze(text) {
        var empty = {
            isChanged: false,
            resultText: text || '',
            stats: { total: 0, switched: 0, ratio: 0, reasons: [] }
        };
        if (!text || typeof text !== 'string') return empty;

        var trimmed = text.trim();
        if (LA_WHOLE_BASE64_RE.test(trimmed)) {
            return {
                isChanged: false,
                resultText: text,
                stats: { total: 0, switched: 0, ratio: 0, reasons: ['base64-blob'] }
            };
        }

        // Protect URLs and emails with placeholders
        var placeholders = [];
        var phIdx = 0;
        var PH_START = '\uE000';
        var PH_END = '\uE001';
        var working = text;

        working = working.replace(LA_URL_RE, function (m) {
            var ph = PH_START + phIdx + PH_END;
            placeholders.push({ ph: ph, original: m });
            phIdx++;
            return ph;
        });
        working = working.replace(LA_EMAIL_RE, function (m) {
            var ph = PH_START + phIdx + PH_END;
            placeholders.push({ ph: ph, original: m });
            phIdx++;
            return ph;
        });

        var tokens = working.split(/(\s+)/);
        var analyzedCount = 0;
        var switchedCount = 0;
        var reasons = [];

        var processed = tokens.map(function (tok) {
            if (!tok || tok.length === 0) return tok;
            if (/^\s+$/.test(tok)) return tok;
            analyzedCount++;
            var res = _laEvaluateWord(tok);
            if (res.shouldSwitch) {
                switchedCount++;
                reasons.push(res.reason + ':' + tok.slice(0, 20));
                return res.converted;
            }
            return tok;
        });

        var resultText = processed.join('');

        // Restore URLs and emails
        for (var i = 0; i < placeholders.length; i++) {
            var phEscaped = placeholders[i].ph.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
            resultText = resultText.replace(new RegExp(phEscaped, 'g'), placeholders[i].original);
        }

        var ratio = analyzedCount > 0 ? switchedCount / analyzedCount : 0;
        var isChanged = switchedCount > 0 &&
            (analyzedCount === 1 ? switchedCount >= 1 : ratio >= 0.30);

        return {
            isChanged: isChanged,
            resultText: isChanged ? resultText : text,
            stats: { total: analyzedCount, switched: switchedCount, ratio: ratio, reasons: reasons }
        };
    }

    var LayoutAnalyzer = {
        analyze: _laAnalyze,
        evaluateWord: _laEvaluateWord,
        convertText: _laConvertText
    };

    // ════════════════════════════════════════════════════════════
    //  CT1 Text-File Crypto — Web Crypto API port
    // ════════════════════════════════════════════════════════════
    //
    //  Format: MAGIC "CT1" (3) + IV (12) + AES-256-GCM ciphertext + auth tag
    //  (Web Crypto's encrypt() returns ciphertext+tag concatenated, tag at end.)
    //  KDF: PBKDF2-SHA256, 100000 iters, salt "clean-crypto-v1-aes256gcm"
    //       (compatible with CleanCrypto and EV1 voice).
    //
    //  Original cm-text-file-crypto.js used Node.js `crypto` module; this
    //  port uses crypto.subtle for Android WebView compatibility.

    var CT1_MAGIC = new Uint8Array([0x43, 0x54, 0x31]); // "CT1"
    var CT1_IV_LENGTH = 12;
    var CT1_TAG_LENGTH = 16;

    var TextFileCrypto = {
        MAGIC: CT1_MAGIC,

        /**
         * Encrypt text → Uint8Array (MAGIC + IV + ct+tag).
         * @returns Promise<Uint8Array>
         */
        encryptText: async function (text, password, chatId) {
            if (typeof text !== 'string') text = String(text);
            var key = await CleanCrypto.deriveKey(password, chatId);
            var iv = crypto.getRandomValues(new Uint8Array(CT1_IV_LENGTH));
            var textBytes = utf8Encode(text);

            // Web Crypto returns ciphertext+tag concatenated (tag at end)
            var ctWithTagBuf = await crypto.subtle.encrypt(
                { name: 'AES-GCM', iv: iv },
                key,
                textBytes
            );
            var ctWithTag = new Uint8Array(ctWithTagBuf);

            var result = new Uint8Array(CT1_MAGIC.length + CT1_IV_LENGTH + ctWithTag.length);
            result.set(CT1_MAGIC, 0);
            result.set(iv, CT1_MAGIC.length);
            result.set(ctWithTag, CT1_MAGIC.length + CT1_IV_LENGTH);
            return result;
        },

        /**
         * Decrypt CT1 → plaintext string.
         * @param {Uint8Array} encBuffer — MAGIC + IV + ct+tag
         * @returns Promise<string>
         */
        decryptText: async function (encBuffer, password, chatId) {
            if (!encBuffer) throw new Error('Пустой буфер.');
            if (encBuffer.length < CT1_MAGIC.length + CT1_IV_LENGTH + CT1_TAG_LENGTH) {
                throw new Error('Зашифрованные данные слишком короткие.');
            }
            if (encBuffer[0] !== CT1_MAGIC[0] ||
                encBuffer[1] !== CT1_MAGIC[1] ||
                encBuffer[2] !== CT1_MAGIC[2]) {
                throw new Error('Неверный magic-маркер (ожидался CT1).');
            }

            var iv = encBuffer.slice(CT1_MAGIC.length, CT1_MAGIC.length + CT1_IV_LENGTH);
            var ctWithTag = encBuffer.slice(CT1_MAGIC.length + CT1_IV_LENGTH);

            var key = await CleanCrypto.deriveKey(password, chatId);
            var plainBuf;
            try {
                plainBuf = await crypto.subtle.decrypt(
                    { name: 'AES-GCM', iv: iv },
                    key,
                    ctWithTag
                );
            } catch (e) {
                throw new Error('Неверный пароль или повреждённые данные.');
            }
            return utf8Decode(new Uint8Array(plainBuf));
        },

        isEncryptedText: function (buffer) {
            if (!buffer || buffer.length < CT1_MAGIC.length) return false;
            return buffer[0] === CT1_MAGIC[0] &&
                   buffer[1] === CT1_MAGIC[1] &&
                   buffer[2] === CT1_MAGIC[2];
        },

        generateRandomFilename: function () {
            var CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
            var length = 8 + Math.floor(Math.random() * 3); // 8-10 chars
            var randBytes = crypto.getRandomValues(new Uint8Array(length));
            var name = '';
            for (var i = 0; i < length; i++) {
                name += CHARS[randBytes[i] % CHARS.length];
            }
            return name + '.txt';
        }
    };

    // ════════════════════════════════════════════════════════════
    //  EV1 Voice Crypto — Web Crypto API port
    // ════════════════════════════════════════════════════════════
    //
    //  Format: MAGIC "EV1" (3) + IV (12) + AES-256-GCM ciphertext + auth tag
    //  Same KDF as CT1 / CleanCrypto (per-chat password).
    //  Voice is NOT exposed as a public mode (not in getSupportedModes),
    //  but the helpers are available for the voice-extension.js userscript.

    var EV1_MAGIC = new Uint8Array([0x45, 0x56, 0x31]); // "EV1"
    var EV1_IV_LENGTH = 12;
    var EV1_TAG_LENGTH = 16;

    var VoiceCrypto = {
        MAGIC: EV1_MAGIC,

        /**
         * Encrypt audio bytes → Uint8Array (MAGIC + IV + ct+tag).
         * @param {Uint8Array} audioBuffer
         * @returns Promise<Uint8Array>
         */
        encryptVoice: async function (audioBuffer, password, chatId) {
            var key = await CleanCrypto.deriveKey(password, chatId);
            var iv = crypto.getRandomValues(new Uint8Array(EV1_IV_LENGTH));
            var ctWithTagBuf = await crypto.subtle.encrypt(
                { name: 'AES-GCM', iv: iv },
                key,
                audioBuffer
            );
            var ctWithTag = new Uint8Array(ctWithTagBuf);

            var result = new Uint8Array(EV1_MAGIC.length + EV1_IV_LENGTH + ctWithTag.length);
            result.set(EV1_MAGIC, 0);
            result.set(iv, EV1_MAGIC.length);
            result.set(ctWithTag, EV1_MAGIC.length + EV1_IV_LENGTH);
            return result;
        },

        /**
         * Decrypt EV1 → audio bytes.
         * @param {Uint8Array} encBuffer
         * @returns Promise<Uint8Array>
         */
        decryptVoice: async function (encBuffer, password, chatId) {
            if (!encBuffer || encBuffer.length < EV1_MAGIC.length + EV1_IV_LENGTH + EV1_TAG_LENGTH) {
                throw new Error('Зашифрованные данные голосового слишком короткие.');
            }
            if (encBuffer[0] !== EV1_MAGIC[0] ||
                encBuffer[1] !== EV1_MAGIC[1] ||
                encBuffer[2] !== EV1_MAGIC[2]) {
                throw new Error('Неверный magic-маркер голосового (ожидался EV1).');
            }

            var iv = encBuffer.slice(EV1_MAGIC.length, EV1_MAGIC.length + EV1_IV_LENGTH);
            var ctWithTag = encBuffer.slice(EV1_MAGIC.length + EV1_IV_LENGTH);

            var key = await CleanCrypto.deriveKey(password, chatId);
            var plainBuf;
            try {
                plainBuf = await crypto.subtle.decrypt(
                    { name: 'AES-GCM', iv: iv },
                    key,
                    ctWithTag
                );
            } catch (e) {
                throw new Error('Неверный пароль или повреждённое голосовое.');
            }
            return new Uint8Array(plainBuf);
        },

        isEncryptedVoice: function (buffer) {
            if (!buffer || buffer.length < EV1_MAGIC.length) return false;
            return buffer[0] === EV1_MAGIC[0] &&
                   buffer[1] === EV1_MAGIC[1] &&
                   buffer[2] === EV1_MAGIC[2];
        }
    };

    // ════════════════════════════════════════════════════════════
    //  Public API: window.CryptoEngineAPI
    // ════════════════════════════════════════════════════════════

    var SUBMODE_ENCODER_MAP = {
        'invisible': 'invisible-spaces',
        'base64': 'base64',
        'compression': 'compression',
        'emoji': 'emoji',
        'chinese': 'chinese'
    };

    window.CryptoEngineAPI = {

        /**
         * ENCRYPT
         *
         *   mode "layout"      → LayoutSwitchEncoder.encodeString(text, false)
         *                        (no encryption, no magic prefix — just obfuscation)
         *   mode "aes256"      → CleanCrypto.encrypt → bytesToBase64url
         *                        (pure base64url, no text magic prefix)
         *   mode "compact"     → CompactCipher.encrypt (length-preserving, +12 chars)
         *   mode "textfile"    → TextFileCrypto.encryptText → bytesToBase64url (CT1)
         *   mode invisible/base64/compression/emoji/chinese
         *                      → CleanCrypto.encrypt → encoder.encode(bytes)
         */
        encrypt: async function (plaintext, password, mode, chatId) {
            mode = mode || 'aes256';
            chatId = chatId || '';

            // 1. Layout switch — no encryption, just obfuscation
            if (mode === 'layout') {
                return LayoutSwitchEncoder.encodeString(plaintext, false);
            }

            // 2. AES-256 — pure base64url
            if (mode === 'aes256') {
                var encrypted = await CleanCrypto.encrypt(plaintext, password, chatId);
                return bytesToBase64url(encrypted);
            }

            // 3. Compact cipher — length-preserving stream cipher
            if (mode === 'compact') {
                return await CompactCipher.encrypt(plaintext, password, chatId);
            }

            // 4. Textfile mode — CT1 format, base64url-encoded
            if (mode === 'textfile') {
                var ct1Bytes = await TextFileCrypto.encryptText(plaintext, password, chatId);
                return bytesToBase64url(ct1Bytes);
            }

            // 5. Encoders (invisible, base64, compression, emoji, chinese)
            var encoderId = SUBMODE_ENCODER_MAP[mode];
            if (!encoderId) throw new Error('Unknown mode: ' + mode);

            var encoder = getEncoderById(encoderId);
            if (!encoder) throw new Error('Unknown encoder: ' + encoderId);

            var encryptedBytes = await CleanCrypto.encrypt(plaintext, password, chatId);
            var result = encoder.encode(encryptedBytes);
            if (result && typeof result.then === 'function') {
                result = await result;
            }
            return result;
        },

        /**
         * DECRYPT
         *
         *   mode "layout"   → LayoutSwitchEncoder.decodeToString(text)
         *   mode "aes256"   → base64urlToBytes → CleanCrypto.decrypt
         *   mode "compact"  → CompactCipher.decrypt (MAC-validated, throws on fail)
         *   mode "textfile" → base64urlToBytes → TextFileCrypto.decryptText
         *   others          → detectEncoder → decode → CleanCrypto.decrypt
         */
        decrypt: async function (ciphertext, password, mode, chatId) {
            ciphertext = regexTrim(ciphertext);
            chatId = chatId || '';

            // 1. Layout switch — auto-detect direction
            if (mode === 'layout') {
                return LayoutSwitchEncoder.decodeToString(ciphertext);
            }

            // 2. AES-256 base64
            if (mode === 'aes256') {
                var bytes = base64urlToBytes(ciphertext);
                if (!bytes) throw new Error('Invalid Base64');
                return await CleanCrypto.decrypt(bytes, password, chatId);
            }

            // 3. Compact cipher
            if (mode === 'compact') {
                var compactResult = await CompactCipher.decrypt(ciphertext, password, chatId);
                if (compactResult === null) {
                    throw new Error('Не удалось расшифровать (неверный пароль или данные).');
                }
                return compactResult;
            }

            // 4. Textfile mode (CT1)
            if (mode === 'textfile') {
                var ct1Bytes = base64urlToBytes(ciphertext);
                if (!ct1Bytes) throw new Error('Invalid Base64 (CT1)');
                return await TextFileCrypto.decryptText(ct1Bytes, password, chatId);
            }

            // 5. Auto-detect by magic prefix
            var encoder = detectEncoder(ciphertext);
            if (!encoder) {
                throw new Error('Unable to detect encoding type.');
            }

            var decoded = encoder.decode(ciphertext);
            if (decoded && typeof decoded.then === 'function') {
                decoded = await decoded;
            }
            if (!decoded) {
                throw new Error('Decode error (' + (encoder.label || encoder.id) + ')');
            }

            return await CleanCrypto.decrypt(decoded, password, chatId);
        },

        /**
         * AUTO-DECODE — tries all modes in order:
         *   1. detectEncoder (magic prefix) → decode → decrypt
         *   2. AES-256 base64url (if text matches /^[A-Za-z0-9_-]{20,}$/)
         *   3. Compact cipher (MAC-validated — tried before layout because
         *      layout can "decode" any Latin text, producing garbage for
         *      compact-encrypted messages; MAC check eliminates false positives)
         *   4. Layout analyzer (smart linguistic detection — always LAST)
         *
         * @returns {Promise<{text:string, method:string}|null>}
         */
        autoDecode: async function (ciphertext, password, chatId) {
            if (!ciphertext || !password) return null;
            ciphertext = regexTrim(ciphertext);
            chatId = chatId || '';

            // 1. detectEncoder (magic prefix)
            try {
                var encoder = detectEncoder(ciphertext);
                if (encoder) {
                    var decoded = encoder.decode(ciphertext);
                    if (decoded && typeof decoded.then === 'function') decoded = await decoded;
                    if (decoded) {
                        var decrypted = await CleanCrypto.decrypt(decoded, password, chatId);
                        return { text: decrypted, method: encoder.label || 'auto' };
                    }
                }
            } catch (e) { /* not this type */ }

            // 2. AES-256 base64 (only if text looks like valid base64url)
            if (/^[A-Za-z0-9_-]{20,}$/.test(ciphertext)) {
                try {
                    var aesBytes = base64urlToBytes(ciphertext);
                    if (aesBytes && aesBytes.length >= 31) {
                        var decrypted2 = await CleanCrypto.decrypt(aesBytes, password, chatId);
                        return { text: decrypted2, method: 'AES-256' };
                    }
                } catch (e) { /* not AES-256 */ }
            }

            // 3. Compact cipher (MAC-validated, no magic prefix)
            if (ciphertext.length >= 12 && CompactCipher.isSupported(ciphertext)) {
                try {
                    var compactDecoded = await CompactCipher.decrypt(ciphertext, password, chatId);
                    if (compactDecoded !== null) {
                        return { text: compactDecoded, method: 'Компактный' };
                    }
                } catch (e) { /* not compact */ }
            }

            // 4. Layout analyzer (always LAST — pure obfuscation, not crypto)
            try {
                var layoutAnalysis = LayoutAnalyzer.analyze(ciphertext);
                if (layoutAnalysis.isChanged &&
                    layoutAnalysis.resultText &&
                    layoutAnalysis.resultText !== ciphertext) {
                    return { text: layoutAnalysis.resultText, method: 'Layout' };
                }
            } catch (e) { /* not layout */ }

            return null;
        },

        /**
         * DETECT — checks if text looks like an encrypted/encoded message.
         *
         * CRITICAL: uses regexTrim, NOT .trim() — String.prototype.trim()
         * strips Unicode whitespace (U+00A0, U+2002-2005, U+202F, U+205F)
         * used by invisible-spaces encoder, corrupting the magic prefix.
         */
        detect: function (text) {
            if (!text) {
                return { isEncrypted: false, algorithm: null, isStego: false };
            }
            text = regexTrim(text);

            var encoder = detectEncoder(text);
            if (encoder) {
                var stegoIds = ['invisible-spaces', 'chinese', 'emoji', 'layout-switch'];
                return {
                    isEncrypted: true,
                    algorithm: encoder.id,
                    label: encoder.label || encoder.id,
                    isStego: stegoIds.indexOf(encoder.id) !== -1
                };
            }

            // Also detect pure AES-256 base64 (starts with "Q1JZ" = base64("CRY"))
            if (text.indexOf('Q1JZ') === 0 && /^[A-Za-z0-9_-]+$/.test(text)) {
                return { isEncrypted: true, algorithm: 'aes256', label: 'AES-256', isStego: false };
            }

            // Detect CT1 base64 (starts with "Q1Qx" = base64("CT1"))
            // "CT1" = 0x43 0x54 0x31 → base64url "Q1Qx" (with proper padding logic,
            // but since CT1 is only 3 bytes, the b64url prefix is "Q1Q" with optional padding)
            if (text.indexOf('Q1Q') === 0 && /^[A-Za-z0-9_-]+$/.test(text)) {
                return { isEncrypted: true, algorithm: 'textfile', label: 'CT1', isStego: false };
            }

            return { isEncrypted: false, algorithm: null, isStego: false };
        },

        isReady: function () { return true; },

        getSupportedModes: function () {
            return [
                { id: 'aes256',      label: 'AES-256-GCM',            icon: '🔐' },
                { id: 'compact',     label: 'Компактный (1:1)',        icon: '🗜️' },
                { id: 'textfile',    label: 'Криптоконтейнер (файл)',  icon: '📄' },
                { id: 'layout',      label: 'Смена раскладки',          icon: '⌨️' },
                { id: 'invisible',   label: 'Невидимые символы',       icon: '👻' },
                { id: 'base64',      label: 'Base64/85',              icon: '🔤' },
                { id: 'compression', label: 'Deflate+B64',            icon: '📦' },
                { id: 'emoji',       label: 'Эмодзи',                 icon: '😀' },
                { id: 'chinese',     label: 'Иероглифы',              icon: '🈳' }
            ];
        }
    };

    // ════════════════════════════════════════════════════════════
    //  Exposed internal helpers (for extension scripts that need them)
    // ════════════════════════════════════════════════════════════

    window.CryptoEngineInternal = {
        CleanCrypto: CleanCrypto,
        CompactCipher: CompactCipher,
        InvisibleSpacesEncoder: InvisibleSpacesEncoder,
        Base64Encoder: Base64Encoder,
        CompressionEncoder: CompressionEncoder,
        EmojiEncoder: EmojiEncoder,
        ChineseEncoder: ChineseEncoder,
        LayoutSwitchEncoder: LayoutSwitchEncoder,
        LayoutAnalyzer: LayoutAnalyzer,
        TextFileCrypto: TextFileCrypto,
        VoiceCrypto: VoiceCrypto,
        detectEncoder: detectEncoder,
        getEncoderById: getEncoderById,
        bytesToBase64url: bytesToBase64url,
        base64urlToBytes: base64urlToBytes,
        regexTrim: regexTrim
    };

    // ════════════════════════════════════════════════════════════
    //  Bootstrap
    // ════════════════════════════════════════════════════════════

    window._cryptoEngineReady = true;
    window._cryptoEngineError = null;
    try {
        window.dispatchEvent(new Event('crypto-engine-ready'));
    } catch (e) { /* dispatchEvent may not be available in all contexts */ }

    console.log('CryptoMAX: Engine bundle loaded (Android WebView / Web Crypto API) — modes: aes256, compact, textfile, layout, invisible, base64, compression, emoji, chinese');

})();
