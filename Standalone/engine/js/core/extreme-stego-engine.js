/**
 * ExtremeStegoEngine — Standalone extreme steganography engine
 *
 * Completely independent of the standard StegoEngine convergence loop.
 * Uses a simple, deterministic pipeline:
 *
 *   ENCODE: secret → AES-CTR encrypt → bits → distribute across methods → apply to carrier
 *   DECODE: detect methods → extract bits → AES-CTR decrypt → secret
 *
 * ## 4 Independent Methods (each toggles on/off):
 *
 * 1. **zero-width**  — invisible chars between ALL characters (4 bits/position, 2 ZW chars each)
 * 2. **spaces**      — regular ↔ non-breaking space (1 bit/space)
 * 3. **case**        — uppercase/lowercase on Cyrillic + safe Latin letters (1 bit/letter)
 * 4. **cyrillic-latin** — Cyrillic ↔ Latin lookalike swap (1 bit/position)
 *
 * ## Method properties:
 *   - Each works ALONE or in ANY combination with others
 *   - Zero-width is the highest density method
 *   - All methods are position-deterministic (encode/decode find same positions)
 *   - Protected regions (URLs, emails) are skipped
 *
 * ## Encoding format (bit stream):
 *
 *   [METHOD_FLAGS: 8 bits] [DATA_LENGTH: 16 bits] [AES_CIPHERTEXT: variable bits]
 *
 *   METHOD_FLAGS  — bitmask of which methods were used (bits 0-3: ZW, spaces, case, cyr-lat)
 *   DATA_LENGTH   — length of AES ciphertext in bytes (max 65535)
 *   AES_CIPHERTEXT — encrypted secret bytes (from CryptoEngine)
 *
 * ## Carrier sanitization:
 *   Before encoding, the carrier text is sanitized:
 *   - Pre-existing ZW chars (U+200B, U+200C, U+200D, U+FEFF) are removed
 *   - NBSP (U+00A0) is normalized to regular space
 *   This prevents false position mapping during decode.
 *
 * ## Case method rules:
 *   - ALL Cyrillic letters are safe (case changes within Cyrillic are natural)
 *   - Latin letters are safe EXCEPT: B/b, Y/y, T/t, M/m, H/h, K/k
 *     (these look like Cyrillic in one case but NOT the other — changing case
 *      creates a visible artifact, e.g. B→b or H→h)
 *   - Sentence-start positions are excluded (preserves natural capitalization)
 *   - Protected regions are excluded
 */

import { CryptoEngine } from './crypto.js';

// ─── Method Constants ──────────────────────────────────────────────────────

const METHOD = {
    'zero-width':     { bit: 0, label: 'Zero-width символы' },
    'spaces':         { bit: 1, label: 'Пробелы' },
    'case':           { bit: 2, label: 'Регистр' },
    'cyrillic-latin': { bit: 3, label: 'Кириллица → Латиница' },
};

/** Encoding order: ZW first (invisible, no index shift), then spaces (no index shift),
 *  then case (case change, no length change), then cyrillic-latin (char swap, no length change).
 *
 *  IMPORTANT interactions:
 *  - case MUST run before cyr-lat because case can create uppercase Cyrillic
 *    letters (т→Т) that are in CYR_TO_LAT, creating NEW cyr-lat positions.
 *  - During DECODE, case positions must be found on text BEFORE cyr-lat normalization,
 *    because cyr-lat can swap Cyrillic to Latin (Т→T), and Latin T/B/H/K/M/Y are
 *    excluded from case positions. So we normalize Latin lookalikes back to Cyrillic
 *    before finding case positions during decode.
 *  Decode order is the same — bits are extracted in the same order they were written. */
const ENCODE_ORDER = ['zero-width', 'spaces', 'case', 'cyrillic-latin'];

// ─── Cyrillic ↔ Latin Map ──────────────────────────────────────────────────

const CYR_TO_LAT = {
    'А': 'A', 'В': 'B', 'С': 'C', 'Е': 'E', 'К': 'K', 'М': 'M',
    'Н': 'H', 'О': 'O', 'Р': 'P', 'Т': 'T', 'Х': 'X',
    'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x',
};

const LAT_TO_CYR = {};
for (const [cyr, lat] of Object.entries(CYR_TO_LAT)) {
    LAT_TO_CYR[lat] = cyr;
}

const CYR_MATCHING = new Set(Object.keys(CYR_TO_LAT));

// ─── Safe Case Letters ────────────────────────────────────────────────────
// Case method: uppercase/lowercase encodes 1 bit per letter.
//
// Convergence table (Latin ↔ Cyrillic visual equivalence):
//   Uppercase matches: A-А, B-В, T-Т, P-Р, M-М, H-Н, E-Е, O-О, X-Х, C-С, K-К
//   Lowercase matches: a-а, e-е, o-о, p-р, x-х, y-у, c-с
//   Cross-case mismatches: B↔b, Y↔y, T↔t, M↔m, H↔h, K↔k
//
// Rule: Exclude Latin B/b, Y/y, T/t, M/m, H/h, K/k from case changes.
// These Latin letters look like Cyrillic in one case but NOT the other,
// so flipping case creates a visible artifact.
// All other characters (all Cyrillic + remaining Latin) are safe.

const EXCLUDED_LATIN_CASE = new Set('BbYyTtMmHhKk');

function isSafeCaseChar(ch) {
    // All Cyrillic letters are safe
    if (/[а-яёА-ЯЁ]/.test(ch)) return true;
    // Latin letters: safe unless in exclude set
    if (/[a-zA-Z]/.test(ch)) return !EXCLUDED_LATIN_CASE.has(ch);
    return false;
}

// ─── Zero-Width Characters ─────────────────────────────────────────────────

const ZW_ENCODE_CHARS = ['\u200C', '\u200D', '\u200B', '\uFEFF']; // 4 chars = 2 bits each
const ZW_DECODE_SET = new Set(ZW_ENCODE_CHARS);
const ZW_CHARS_PER_POSITION = 2; // Each position carries 2 ZW chars = 4 bits

// ─── Carrier Sanitization ──────────────────────────────────────────────────

/** Remove all ZW chars from text (prevents false position mapping) */
function sanitizeZW(text) {
    return [...text].filter(c => !ZW_DECODE_SET.has(c)).join('');
}

/** Normalize NBSP to regular space */
function sanitizeSpaces(text) {
    return text.replace(/\u00A0/g, ' ');
}

/** Full carrier sanitization */
function sanitizeCarrier(text) {
    return sanitizeSpaces(sanitizeZW(text));
}

// ─── Protected Region Helpers ──────────────────────────────────────────────

function findProtectedRegions(text) {
    const regions = [];
    let m;

    const emailRe = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
    while ((m = emailRe.exec(text)) !== null) {
        regions.push({ start: m.index, end: m.index + m[0].length });
    }

    const urlRe = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/g;
    while ((m = urlRe.exec(text)) !== null) {
        regions.push({ start: m.index, end: m.index + m[0].length });
    }

    const wwwRe = /www\.[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}[^\s<>"{}|\\^`\[\]]*/g;
    while ((m = wwwRe.exec(text)) !== null) {
        const overlaps = regions.some(r =>
            m.index >= r.start && m.index + m[0].length <= r.end
        );
        if (!overlaps) regions.push({ start: m.index, end: m.index + m[0].length });
    }

    regions.sort((a, b) => a.start - b.start);
    return regions;
}

function isInRegion(idx, regions) {
    for (const r of regions) {
        if (idx >= r.start && idx < r.end) return true;
        if (idx < r.start) return false;
    }
    return false;
}

function findSentenceStarts(text) {
    const starts = new Set();
    const firstMatch = text.match(/\S/);
    if (firstMatch) starts.add(firstMatch.index);

    const re = /[.!?]\s+([a-zA-Zа-яёА-ЯЁ])/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        starts.add(m.index + m[0].length - 1);
    }
    return starts;
}

// ─── Bit Stream Helpers ────────────────────────────────────────────────────

class BitWriter {
    constructor() { this.bits = []; }

    writeBit(b) { this.bits.push(b & 1); }

    writeBits(value, count) {
        for (let i = count - 1; i >= 0; i--) {
            this.bits.push((value >> i) & 1);
        }
    }

    writeBytes(bytes) {
        for (const b of bytes) {
            this.writeBits(b, 8);
        }
    }

    get length() { return this.bits.length; }
}

class BitReader {
    constructor(bits) { this.bits = bits; this.pos = 0; }

    readBit() {
        if (this.pos >= this.bits.length) return 0;
        return this.bits[this.pos++];
    }

    readBits(count) {
        let value = 0;
        for (let i = 0; i < count; i++) {
            value = (value << 1) | this.readBit();
        }
        return value;
    }

    readBytes(byteCount) {
        const bytes = new Uint8Array(byteCount);
        for (let i = 0; i < byteCount; i++) {
            bytes[i] = this.readBits(8);
        }
        return bytes;
    }

    get remaining() { return this.bits.length - this.pos; }
}

// ─── Position Finders (one per method) ─────────────────────────────────────

/**
 * Zero-width positions: after every character in the text.
 * EXCLUDES: inside protected regions, after tag blocks [steg-*].
 * Maximum density: ~4 bits per character (2 ZW chars × 2 bits each).
 */
function findZWPositions(text) {
    const regions = findProtectedRegions(text);
    const tagRanges = [];
    let m;
    const tagRe = /\[steg-[^\]]*\]/g;
    while ((m = tagRe.exec(text)) !== null) {
        tagRanges.push({ start: m.index, end: m.index + m[0].length });
    }

    const positions = [];
    // Position 0 = before first character
    if (!isInRegion(0, regions) && !isInRegion(0, tagRanges)) {
        positions.push(0);
    }
    // After each character
    for (let i = 1; i <= text.length; i++) {
        if (isInRegion(i - 1, regions) || isInRegion(i - 1, tagRanges)) continue;
        if (i < text.length && (isInRegion(i, regions) || isInRegion(i, tagRanges))) {
            continue;
        }
        positions.push(i);
    }
    return positions;
}

/**
 * Space positions: every space character (regular or NBSP).
 * EXCLUDES: inside protected regions.
 * Each space encodes 1 bit.
 */
function findSpacePositions(text) {
    const regions = findProtectedRegions(text);
    const positions = [];
    for (let i = 0; i < text.length; i++) {
        if (text[i] !== ' ' && text[i] !== '\u00A0') continue;
        if (isInRegion(i, regions)) continue;
        positions.push(i);
    }
    return positions;
}

/**
 * Case positions: every letter that CAN carry case info.
 * EXCLUDES: protected regions, sentence starts,
 * Latin letters B/b, Y/y, T/t, M/m, H/h, K/k (cross-case visual mismatch).
 *
 * All Cyrillic letters are safe (case changes within Cyrillic are natural).
 * Latin letters are safe except the excluded set (see EXCLUDED_LATIN_CASE).
 */
function findCasePositions(text) {
    const regions = findProtectedRegions(text);
    const sentenceStarts = findSentenceStarts(text);
    const positions = [];

    for (let i = 0; i < text.length; i++) {
        if (isInRegion(i, regions)) continue;
        if (sentenceStarts.has(i)) continue;
        const ch = text[i];
        if (!isSafeCaseChar(ch)) continue;
        positions.push(i);
    }
    return positions;
}

/**
 * Cyrillic-Latin positions: every Cyrillic char that has a Latin lookalike.
 * EXCLUDES: protected regions, sentence starts.
 * Each position encodes 1 bit.
 */
function findCyrLatPositions(text) {
    const regions = findProtectedRegions(text);
    const sentenceStarts = findSentenceStarts(text);
    const positions = [];

    for (let i = 0; i < text.length; i++) {
        if (isInRegion(i, regions)) continue;
        if (sentenceStarts.has(i)) continue;
        const ch = text[i];
        // Accept Cyrillic originals OR Latin lookalikes (invariant under swap)
        if (CYR_MATCHING.has(ch) || LAT_TO_CYR[ch]) {
            positions.push(i);
        }
    }
    return positions;
}

// ─── Method Implementations ────────────────────────────────────────────────

/**
 * Apply zero-width encoding: insert ZW characters at positions.
 * Each position gets ZW_CHARS_PER_POSITION ZW chars = 4 bits per position.
 */
function zwEncode(text, positions, bitReader) {
    const chars = [];
    let lastIdx = 0;
    for (let i = 0; i < positions.length; i++) {
        const pos = positions[i];
        // Push text chars FIRST (establishes correct position mapping)
        for (let j = lastIdx; j < pos && j < text.length; j++) {
            chars.push(text[j]);
        }
        // THEN insert ZW_CHARS_PER_POSITION ZW chars (each encodes 2 bits)
        for (let k = 0; k < ZW_CHARS_PER_POSITION; k++) {
            const bitVal = bitReader.readBits(2);
            const zwChar = ZW_ENCODE_CHARS[bitVal] || ZW_ENCODE_CHARS[0];
            chars.push(zwChar);
        }
        lastIdx = pos;
    }
    for (let j = lastIdx; j < text.length; j++) {
        chars.push(text[j]);
    }
    return chars.join('');
}

/**
 * Extract bits from zero-width characters.
 * Scans encoded text, mapping ZW chars to original positions.
 * Each position has ZW_CHARS_PER_POSITION ZW chars = 4 bits.
 */
function zwDecode(text, positions, bitWriter) {
    const zwMap = new Map(); // originalPos → array of ZW chars
    let origIdx = 0;
    let i = 0;
    const maxPos = positions.length > 0 ? positions[positions.length - 1] : 0;

    while (i < text.length && origIdx <= maxPos) {
        const ch = text[i];
        if (ZW_DECODE_SET.has(ch)) {
            if (!zwMap.has(origIdx)) {
                zwMap.set(origIdx, []);
            }
            zwMap.get(origIdx).push(ch);
            i++;
            continue;
        }
        origIdx++;
        i++;
    }

    for (const pos of positions) {
        const zwChars = zwMap.get(pos) || [];
        for (let k = 0; k < ZW_CHARS_PER_POSITION; k++) {
            const zwChar = zwChars[k];
            if (zwChar) {
                const idx = ZW_ENCODE_CHARS.indexOf(zwChar);
                bitWriter.writeBits(idx >= 0 ? idx : 0, 2);
            } else {
                bitWriter.writeBits(0, 2);
            }
        }
    }
    return bitWriter;
}

/**
 * Apply space encoding: toggle spaces between ' ' (0) and '\u00A0' (1).
 */
function spaceEncode(text, positions, bitReader) {
    const chars = text.split('');
    for (const pos of positions) {
        const bit = bitReader.readBit();
        chars[pos] = bit ? '\u00A0' : ' ';
    }
    return chars.join('');
}

/**
 * Extract bits from space encoding.
 */
function spaceDecode(text, positions, bitWriter) {
    for (const pos of positions) {
        bitWriter.writeBit(text[pos] === '\u00A0' ? 1 : 0);
    }
    return bitWriter;
}

/**
 * Apply case encoding: 0=lowercase, 1=uppercase.
 * First, lowercase ALL positions to establish baseline.
 * Operates on all Cyrillic letters + safe Latin letters (excludes B/b, Y/y, T/t, M/m, H/h, K/k).
 */
function caseEncode(text, positions, bitReader) {
    const chars = text.split('');
    // First, lowercase all positions
    for (const pos of positions) {
        chars[pos] = chars[pos].toLowerCase();
    }
    // Then, set selected positions to uppercase
    for (const pos of positions) {
        const bit = bitReader.readBit();
        if (bit) {
            chars[pos] = chars[pos].toUpperCase();
        }
    }
    return chars.join('');
}

/**
 * Extract bits from case encoding.
 * Reads case at positions found by findCasePositions.
 * Works for both Cyrillic and Latin letters.
 */
function caseDecode(text, positions, bitWriter) {
    for (const pos of positions) {
        const ch = text[pos];
        // Check if uppercase (1) or lowercase (0) — works for both Cyrillic and Latin
        const isUpper = ch === ch.toUpperCase() && ch !== ch.toLowerCase();
        bitWriter.writeBit(isUpper ? 1 : 0);
    }
    return bitWriter;
}

/**
 * Apply cyrillic-latin encoding: 0=keep Cyrillic, 1=replace with Latin.
 * First, normalize all positions to Cyrillic.
 */
function cyrLatEncode(text, positions, bitReader) {
    const chars = text.split('');
    // First, normalize all positions to Cyrillic
    for (const pos of positions) {
        const cyr = LAT_TO_CYR[chars[pos]];
        if (cyr) chars[pos] = cyr;
    }
    // Then, replace selected positions with Latin
    for (const pos of positions) {
        const bit = bitReader.readBit();
        if (bit) {
            const lat = CYR_TO_LAT[chars[pos]];
            if (lat) chars[pos] = lat;
        }
    }
    return chars.join('');
}

/**
 * Extract bits from cyrillic-latin encoding.
 */
function cyrLatDecode(text, positions, bitWriter) {
    for (const pos of positions) {
        const ch = text[pos];
        bitWriter.writeBit(LAT_TO_CYR[ch] ? 1 : 0);
    }
    return bitWriter;
}

// ─── Main Engine ────────────────────────────────────────────────────────────

export class ExtremeStegoEngine {
    constructor() {
        this.crypto = new CryptoEngine();
        this._finders = {
            'zero-width': findZWPositions,
            'spaces': findSpacePositions,
            'case': findCasePositions,
            'cyrillic-latin': findCyrLatPositions,
        };
        this._encoders = {
            'zero-width': zwEncode,
            'spaces': spaceEncode,
            'case': caseEncode,
            'cyrillic-latin': cyrLatEncode,
        };
        this._decoders = {
            'zero-width': zwDecode,
            'spaces': spaceDecode,
            'case': caseDecode,
            'cyrillic-latin': cyrLatDecode,
        };
    }

    /**
     * Calculate capacity for given text and enabled methods.
     *
     * NOTE: This is a CONSERVATIVE estimate. When both case and cyr-lat are
     * enabled, case encoding creates additional cyr-lat positions (by uppercasing
     * Cyrillic letters that then match CYR_TO_LAT). The actual capacity at encode
     * time may be higher. The encode method does an exact check internally.
     *
     * @param {string} carrierText
     * @param {Object} enabledMethods - { 'zero-width': true, 'spaces': false, ... }
     * @returns {{ totalBits: number, totalBytes: number, perMethod: Object }}
     */
    getCapacity(carrierText, enabledMethods) {
        const perMethod = {};
        let totalBits = 0;

        for (const methodName of ENCODE_ORDER) {
            if (!enabledMethods[methodName]) {
                perMethod[methodName] = { bits: 0, positions: 0 };
                continue;
            }

            try {
                const positions = this._finders[methodName](carrierText);
                let bits;
                if (methodName === 'zero-width') {
                    bits = positions.length * 2 * ZW_CHARS_PER_POSITION;
                } else {
                    bits = positions.length;
                }
                perMethod[methodName] = { bits, positions: positions.length };
                totalBits += bits;
            } catch (e) {
                perMethod[methodName] = { bits: 0, positions: 0, error: e.message };
            }
        }

        // Subtract header overhead (8 bits method flags + 16 bits data length = 24 bits)
        const usableBits = Math.max(0, totalBits - 24);
        const usableBytes = Math.floor(usableBits / 8);

        return {
            totalBits,
            usableBits,
            usableBytes,
            headerBits: 24,
            perMethod,
        };
    }

    /**
     * Encode secret message into carrier text.
     *
     * @param {string} carrierText - Plain text to hide message in
     * @param {string} secret - Secret message to hide
     * @param {string} password - Encryption password
     * @param {Object} enabledMethods - { 'zero-width': true, 'spaces': false, ... }
     * @returns {{ encoded: string, stats: Object }}
     */
    async encode(carrierText, secret, password, enabledMethods) {
        // 0. Sanitize carrier text — remove pre-existing ZW chars and normalize spaces
        carrierText = sanitizeCarrier(carrierText);

        // 1. Encrypt secret (capacity check happens after encoding with actual positions)
        const secretBytes = this.crypto.stringToBytes(secret);
        const ciphertext = await this.crypto.encrypt(secretBytes, password);

        // 3. Build bit stream
        const writer = new BitWriter();

        // Method flags (8 bits)
        let methodFlags = 0;
        for (const methodName of ENCODE_ORDER) {
            if (enabledMethods[methodName]) {
                methodFlags |= (1 << METHOD[methodName].bit);
            }
        }
        writer.writeBits(methodFlags, 8);

        // Data length (16 bits)
        writer.writeBits(ciphertext.length, 16);

        // Ciphertext
        writer.writeBytes(ciphertext);

        const totalBitsNeeded = writer.length;

        // Quick sanity check: if not even zero-width (highest density) would fit, abort early
        // This avoids wasting expensive encryption on clearly impossible messages.
        const zwOnlyCap = this.getCapacity(carrierText, { 'zero-width': true, 'spaces': false, 'case': false, 'cyrillic-latin': false });
        if (totalBitsNeeded > zwOnlyCap.totalBits) {
            throw new Error(
                `Недостаточно ёмкости.\nНужно: ${totalBitsNeeded} бит. Даже Zero-width не хватает.\nИспользуйте более длинный текст.`
            );
        }

        // 4. Apply methods in order (ENCODE_ORDER), counting actual positions
        let text = carrierText;
        const bitReader = new BitReader(writer.bits);
        const methodStats = {};
        let totalAvailableBits = 0;

        for (const methodName of ENCODE_ORDER) {
            if (!enabledMethods[methodName]) continue;

            const positions = this._finders[methodName](text);
            const methodBits = methodName === 'zero-width'
                ? positions.length * 2 * ZW_CHARS_PER_POSITION
                : positions.length;
            totalAvailableBits += methodBits;

            text = this._encoders[methodName](text, positions, bitReader);
            methodStats[methodName] = { bitsWritten: methodBits, positions: positions.length };
        }

        // 5. Exact capacity check (after finding actual positions)
        if (totalBitsNeeded > totalAvailableBits) {
            throw new Error(
                `Недостаточно ёмкости.\nНужно: ${totalBitsNeeded} бит, реально доступно: ${totalAvailableBits} бит.\nВключите больше методов или используйте более длинный текст.`
            );
        }

        return {
            encoded: text,
            stats: {
                totalBits: totalBitsNeeded,
                ciphertextBytes: ciphertext.length,
                secretBytes: secretBytes.length,
                methods: methodStats,
            },
        };
    }

    /**
     * Decode secret message from stego text.
     *
     * Auto-detection strategy (two-phase):
     *   Phase 1: If ZW chars present, read method flags directly from ZW bits
     *            (first 8 bits of the stream are always in ZW if ZW was used).
     *   Phase 2: If ZW not present, use heuristic detection for other methods.
     *
     * @param {string} stegoText - Text with hidden message
     * @param {string} password - Decryption password
     * @param {Object|null} enabledMethods - If null, auto-detect methods
     * @returns {{ secret: string, detectedMethods: string[] }}
     */
    async decode(stegoText, password, enabledMethods = null) {
        let methods;

        if (enabledMethods) {
            // Explicitly specified methods — use as-is
            methods = Object.keys(enabledMethods).filter(k => enabledMethods[k]);
        } else {
            // Phase 1: If ZW chars present, read method flags from ZW bits
            const hasZW = ZW_ENCODE_CHARS.some(c => stegoText.includes(c));

            if (hasZW) {
                methods = this._readMethodFlagsFromZW(stegoText);
            }

            // Phase 2: If ZW not present or flags read failed, use heuristics
            if (!methods || methods.length === 0) {
                methods = this.detectMethods(stegoText);
            }
        }

        if (!methods || methods.length === 0) {
            throw new Error('Не обнаружены экстремальные методы кодирования в тексте.');
        }

        // Try decode. If method flags don't match (detection missed some methods),
        // retry with the flag-indicated methods.
        try {
            return await this._decodeWithMethods(stegoText, password, methods);
        } catch (e) {
            // Check if it was a flag mismatch — try with corrected methods
            if (e._flaggedMethods) {
                return await this._decodeWithMethods(stegoText, password, e._flaggedMethods);
            }
            throw e;
        }
    }

    /**
     * Read method flags from ZW characters in the encoded text.
     * The first 8 bits of the bit stream are always stored in ZW positions.
     * Returns the list of method names indicated by the flags, or null on failure.
     */
    _readMethodFlagsFromZW(stegoText) {
        try {
            const zwPositions = this._findZWPositionsForDecode(stegoText);
            if (zwPositions.length < 2) return null; // Need at least 2 positions for 8 bits (4 bits each)

            const collector = new BitWriter();
            zwDecode(stegoText, zwPositions, collector);

            if (collector.length < 8) return null;

            const reader = new BitReader(collector.bits);
            const flags = reader.readBits(8);

            // Validate: at least one method bit must be set
            if (flags === 0) return null;

            // Validate: only known bits should be set (bits 0-3)
            if (flags > 0x0F) return null;

            return ENCODE_ORDER.filter(m => flags & (1 << METHOD[m].bit));
        } catch {
            return null;
        }
    }

    /**
     * Normalize Latin lookalikes back to Cyrillic for position finding.
     * Used during decode because case runs before cyr-lat during encode:
     * case creates uppercase Cyrillic (т→Т), then cyr-lat swaps some to Latin (Т→T).
     * Latin T/B/H/K/M/Y are excluded from case positions, causing mismatches.
     * Normalizing ensures case positions match what was found during encode.
     */
    _normalizeCyrLatToCyrillic(text) {
        let result = '';
        for (let i = 0; i < text.length; i++) {
            result += LAT_TO_CYR[text[i]] || text[i];
        }
        return result;
    }

    async _decodeWithMethods(stegoText, password, methods) {
        // Pre-compute normalized text for case position finding
        // (must undo cyr-lat swaps to match encode-time positions)
        const textForCasePos = methods.includes('cyrillic-latin')
            ? this._normalizeCyrLatToCyrillic(stegoText)
            : stegoText;

        // 1. Extract bits from all methods (in ENCODE order)
        const allBits = [];
        const methodStats = {};

        for (const methodName of ENCODE_ORDER) {
            if (!methods.includes(methodName)) continue;

            const bitCollector = new BitWriter();
            let positions;

            if (methodName === 'zero-width') {
                positions = this._findZWPositionsForDecode(stegoText);
            } else if (methodName === 'case') {
                // CRITICAL: use normalized text (Latin→Cyrillic) so positions
                // match what case encoding found on pre-cyr-lat text
                positions = this._finders['case'](textForCasePos);
            } else {
                positions = this._finders[methodName](stegoText);
            }

            this._decoders[methodName](stegoText, positions, bitCollector);
            allBits.push(...bitCollector.bits);
            methodStats[methodName] = { bitsExtracted: bitCollector.length, positions: positions.length };
        }

        if (allBits.length < 24) {
            throw new Error('Недостаточно данных для чтения заголовка.');
        }

        // 2. Parse header
        const reader = new BitReader(allBits);
        const methodFlags = reader.readBits(8);
        const dataLength = reader.readBits(16);

        // 3. Verify method flags match attempted methods
        const flagsMethods = ENCODE_ORDER.filter(m => methodFlags & (1 << METHOD[m].bit));

        // ALL flagged methods must be in our attempted set
        const allMatched = flagsMethods.every(m => methods.includes(m));
        // ALL attempted methods must be in the flags
        const noExtras = methods.every(m => flagsMethods.includes(m));

        if (!allMatched || !noExtras) {
            const err = new Error(
                `Несовпадение методов: флаги=[${flagsMethods.join(',')}] попытка=[${methods.join(',')}]`
            );
            err._flaggedMethods = flagsMethods; // Attach for retry logic
            throw err;
        }

        // 4. Check if enough bits remain for ciphertext
        const ciphertextBits = dataLength * 8;
        if (dataLength === 0 || dataLength > 65535) {
            throw new Error('Повреждённый заголовок: неверная длина данных.');
        }
        if (reader.remaining < ciphertextBits) {
            throw new Error('Недостаточно данных для расшифровки. Текст мог быть повреждён.');
        }

        // 5. Read ciphertext and decrypt
        const ciphertext = reader.readBytes(dataLength);
        const secretBytes = await this.crypto.decrypt(ciphertext, password);

        // 6. Convert bytes to string
        const secret = this.crypto.bytesToString(secretBytes);

        return {
            secret,
            detectedMethods: flagsMethods,
            stats: methodStats,
        };
    }

    /**
     * Check if a method could plausibly be present (quick pre-check).
     */
    _canDetectMethod(text, methodName) {
        switch (methodName) {
            case 'zero-width':
                return ZW_ENCODE_CHARS.some(c => text.includes(c));
            case 'spaces':
                return text.includes('\u00A0');
            case 'case':
                return [...text].some(ch => isSafeCaseChar(ch) && ch !== ch.toLowerCase());
            case 'cyrillic-latin':
                return [...text].some(ch => LAT_TO_CYR[ch]);
            default:
                return false;
        }
    }

    /**
     * Auto-detect which extreme methods are present in text.
     *
     * NOTE: This is the fallback when ZW is not present (so flags can't be read from ZW).
     * When ZW IS present, decode reads flags directly from ZW bits — much more reliable.
     *
     * Heuristics err on the side of INCLUSION (false positives are OK — the header
     * flags in the bit stream will disambiguate). False negatives are dangerous.
     *
     * @param {string} text
     * @returns {string[]} Detected method names
     */
    detectMethods(text) {
        const detected = [];
        const regions = findProtectedRegions(text);

        // Zero-width: look for any of the 4 ZW chars
        // ZW chars are extremely rare in natural Russian text
        if (ZW_ENCODE_CHARS.some(c => text.includes(c))) {
            detected.push('zero-width');
        }

        // Spaces: look for NBSP (U+00A0) outside protected regions
        // Natural Russian text almost never uses NBSP
        let nbspCount = 0;
        for (let i = 0; i < text.length; i++) {
            if (text[i] === '\u00A0' && !isInRegion(i, regions)) {
                nbspCount++;
            }
        }
        if (nbspCount >= 2) {
            detected.push('spaces');
        }

        // Case: uppercase letters at safe positions outside sentence starts.
        // All Cyrillic + safe Latin letters are considered.
        // IMPORTANT: normalize Latin lookalikes to Cyrillic first, because if cyr-lat
        // was also used, some case-eligible Cyrillic positions may now hold Latin
        // chars that are excluded (T, B, H, K, M, Y).
        const textForCase = this._normalizeCyrLatToCyrillic(text);
        const casePositions = findCasePositions(textForCase);
        if (casePositions.length > 3) {
            let upperCount = 0;
            for (const pos of casePositions) {
                const ch = textForCase[pos];
                if (ch === ch.toUpperCase() && ch !== ch.toLowerCase()) upperCount++;
            }
            // Very low threshold — any uppercase outside sentence starts triggers detection.
            // False positives are handled by header flag verification in _decodeWithMethods.
            if (upperCount >= 2) {
                detected.push('case');
            }
        }

        // Cyrillic-Latin: look for Latin lookalikes surrounded by Cyrillic text.
        // Also detect standalone Latin lookalikes (the surrounding-Cyrillic check
        // can fail if ZW chars are adjacent to the lookalike).
        let cyrLatCount = 0;
        for (let i = 0; i < text.length; i++) {
            if (isInRegion(i, regions)) continue;
            const ch = text[i];
            if (LAT_TO_CYR[ch]) {
                // Check if surrounded by Cyrillic (standard check)
                const prev = i > 0 ? text[i - 1] : '';
                const next = i < text.length - 1 ? text[i + 1] : '';
                if (/[а-яёА-ЯЁ]/.test(prev) || /[а-яёА-ЯЁ]/.test(next)) {
                    cyrLatCount++;
                } else {
                    // Fallback: also count if there's Cyrillic within 3 chars
                    // (handles ZW chars between lookalike and Cyrillic)
                    const nearText = text.substring(Math.max(0, i - 3), i + 4);
                    if (/[а-яёА-ЯЁ]/.test(nearText)) {
                        cyrLatCount++;
                    }
                }
            }
        }
        if (cyrLatCount >= 2) {
            detected.push('cyrillic-latin');
        }

        return detected;
    }

    /**
     * For ZW decoding: reconstruct original character positions from encoded text.
     * Scans through the text, counting non-ZW characters as "original" positions.
     * At each original position boundary, checks if ZW chars follow.
     * Each position has ZW_CHARS_PER_POSITION ZW chars.
     *
     * Returns array of original positions that had ZW chars inserted.
     */
    _findZWPositionsForDecode(text) {
        // Reconstruct original text by removing ZW chars
        const origText = [...text].filter(c => !ZW_DECODE_SET.has(c)).join('');

        // Now find ZW positions on original text (same logic as encode)
        const positions = findZWPositions(origText);

        // Build ZW map: scan encoded text, group ZW chars by original position
        const zwMap = new Map(); // origPos → array of ZW chars
        let origIdx = 0;
        let i = 0;
        const maxPos = positions.length > 0 ? positions[positions.length - 1] : 0;

        while (i < text.length && origIdx <= maxPos) {
            if (ZW_DECODE_SET.has(text[i])) {
                if (!zwMap.has(origIdx)) {
                    zwMap.set(origIdx, []);
                }
                zwMap.get(origIdx).push(text[i]);
                i++;
                continue;
            }
            origIdx++;
            i++;
        }

        // Return only positions that actually have ZW chars
        return positions.filter(pos => {
            const chars = zwMap.get(pos);
            return chars && chars.length > 0;
        });
    }
}

export default ExtremeStegoEngine;
