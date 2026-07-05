/**
 * EmojiStego — Encode/decode data inside a single emoji using Unicode variation selectors
 *
 * Algorithm: UTF-8 bytes → variation selectors appended after a base emoji.
 * Each byte maps to one VS (0xFE00-FE0F for bytes 0-15, 0xE0100-E01EF for bytes 16-255).
 * Max capacity: 256 bytes (~128 Cyrillic chars) per emoji.
 *
 * Encoding:
 *   1. Encode message to UTF-8 bytes via TextEncoder
 *   2. Map each byte (0-255) to a Unicode variation selector
 *   3. Append all VS characters after the base emoji
 *
 * Decoding:
 *   1. Iterate the string in grapheme clusters
 *   2. Identify variation selectors following the base emoji
 *   3. Convert selectors back to bytes, then decode via TextDecoder
 *
 * Detection:
 *   Any grapheme cluster containing a char in U+E0100-U+E01EF is a stego emoji.
 *   These IVS (Ideographic Variation Selector) codepoints are never used in normal emoji rendering.
 */

export class EmojiStego {
    /** Maximum number of input characters allowed for encoding */
    static MAX_INPUT_CHARS = 512;

    /** Maximum number of UTF-8 bytes that can be encoded per emoji */
    static MAX_BYTES = 256;

    // ─── Unicode Ranges ─────────────────────────────────────────────────────────

    /** Text presentation variation selectors: U+FE00 – U+FE0F (16 values, bytes 0-15) */
    static _VS_TEXT_START = 0xFE00;
    static _VS_TEXT_END   = 0xFE0F;

    /** Emoji/ideographic variation selectors: U+E0100 – U+E01EF (240 values, bytes 16-255) */
    static _VS_EXT_START  = 0xE0100;
    static _VS_EXT_END    = 0xE01EF;

    // ─── Encoding ──────────────────────────────────────────────────────────────

    /**
     * Encode a message string into a stego emoji.
     *
     * @param {string} baseEmoji - A single emoji character (or emoji sequence) to use as the carrier
     * @param {string} message   - The secret message to hide
     * @returns {string} The base emoji with variation selectors appended
     * @throws {Error} If baseEmoji is empty, message exceeds limits, or bytes exceed capacity
     *
     * @example
     *   EmojiStego.encode('😀', 'Hello!')  // '😀' followed by invisible VS chars
     */
    static encode(baseEmoji, message) {
        // Validate inputs
        if (!baseEmoji || typeof baseEmoji !== 'string' || baseEmoji.length === 0) {
            throw new Error('baseEmoji must be a non-empty string');
        }
        if (typeof message !== 'string') {
            throw new Error('message must be a string');
        }
        if (message.length > EmojiStego.MAX_INPUT_CHARS) {
            throw new Error(
                `Message exceeds maximum input length (${message.length} > ${EmojiStego.MAX_INPUT_CHARS} chars)`
            );
        }

        // Encode message to UTF-8 bytes
        const encoder = new TextEncoder();
        const bytes = encoder.encode(message);

        if (bytes.length === 0) {
            return baseEmoji;
        }
        if (bytes.length > EmojiStego.MAX_BYTES) {
            throw new Error(
                `Encoded message exceeds byte capacity (${bytes.length} > ${EmojiStego.MAX_BYTES} bytes). ` +
                `Try a shorter message or use ASCII-only text.`
            );
        }

        // Convert each byte to a variation selector
        let vsSequence = '';
        for (let i = 0; i < bytes.length; i++) {
            vsSequence += EmojiStego._byteToVS(bytes[i]);
        }

        return baseEmoji + vsSequence;
    }

    // ─── Decoding ──────────────────────────────────────────────────────────────

    /**
     * Decode a stego emoji and extract the hidden message.
     *
     * @param {string} stegoEmoji - The emoji string that may contain hidden data
     * @returns {{ base: string, message: string }} The base emoji and extracted message
     * @throws {Error} If the string contains no decodable data
     *
     * @example
     *   EmojiStego.decode(stegoStr)  // { base: '😀', message: 'Hello!' }
     */
    static decode(stegoEmoji) {
        if (!stegoEmoji || typeof stegoEmoji !== 'string') {
            throw new Error('stegoEmoji must be a non-empty string');
        }

        // Parse codepoints
        const codePoints = [...stegoEmoji]; // spread handles surrogate pairs correctly

        // Find where variation selectors start
        let baseEnd = 0;
        for (let i = 0; i < codePoints.length; i++) {
            const cp = codePoints[i].codePointAt(0);
            if (EmojiStego._isVariationSelector(cp)) {
                baseEnd = i;
                break;
            }
        }

        // If no variation selectors found, there's nothing to decode
        if (baseEnd === 0) {
            throw new Error('No variation selectors found — this is not a stego emoji');
        }

        // Extract base emoji (all codepoints before the first VS)
        const base = codePoints.slice(0, baseEnd).join('');

        // Extract variation selectors
        const vsCodePoints = [];
        for (let i = baseEnd; i < codePoints.length; i++) {
            const cp = codePoints[i].codePointAt(0);
            if (EmojiStego._isVariationSelector(cp)) {
                vsCodePoints.push(cp);
            } else {
                // Stop at first non-VS character
                break;
            }
        }

        if (vsCodePoints.length === 0) {
            throw new Error('No valid variation selectors found');
        }

        // Convert VS sequence back to bytes
        const bytes = new Uint8Array(vsCodePoints.length);
        for (let i = 0; i < vsCodePoints.length; i++) {
            bytes[i] = EmojiStego._vsToByte(vsCodePoints[i]);
        }

        // Decode bytes back to UTF-8 string
        const decoder = new TextDecoder('utf-8', { fatal: true });
        const message = decoder.decode(bytes);

        return { base, message };
    }

    // ─── Detection ─────────────────────────────────────────────────────────────

    /**
     * Detect all stego emojis in a text string.
     *
     * Scans through text using grapheme cluster iteration and identifies
     * any cluster containing extended variation selectors (U+E0100-E01EF).
     *
     * @param {string} text - The text to scan
     * @returns {Array<{ start: number, end: number, emoji: string, data: string }>}
     *   Array of detected stego entries with their positions and decoded messages
     *
     * @example
     *   EmojiStego.detect('Hello 😀<invisible> world')
     *   // [{ start: 6, end: 8, emoji: '😀<invisible>', data: 'Hello!' }]
     */
    static detect(text) {
        if (!text || typeof text !== 'string') return [];

        const graphemes = EmojiStego._iterateGraphemes(text);
        const results = [];
        let charOffset = 0;

        for (const grapheme of graphemes) {
            if (EmojiStego.isStegoEmoji(grapheme)) {
                try {
                    const decoded = EmojiStego.decode(grapheme);
                    results.push({
                        start: charOffset,
                        end: charOffset + grapheme.length,
                        emoji: grapheme,
                        data: decoded.message,
                    });
                } catch {
                    // Silently skip malformed stego emojis
                }
            }
            charOffset += grapheme.length;
        }

        return results;
    }

    // ─── Stego Check ───────────────────────────────────────────────────────────

    /**
     * Check if a single grapheme cluster is a stego emoji.
     *
     * A grapheme is considered a stego emoji if it contains at least one
     * extended variation selector in the range U+E0100-U+E01EF.
     * These codepoints (Ideographic Variation Sequences) are never used in
     * normal emoji rendering, so their presence is a reliable indicator.
     *
     * @param {string} grapheme - A single grapheme cluster string
     * @returns {boolean} True if the grapheme contains steganographic data
     */
    static isStegoEmoji(grapheme) {
        if (!grapheme || typeof grapheme !== 'string') return false;

        for (const char of grapheme) {
            const cp = char.codePointAt(0);
            if (cp >= 0xE0100 && cp <= 0xE01EF) return true;
            if (cp >= 0xFE00 && cp <= 0xFE0E) return true; // FE0F (text presentation) is excluded
        }
        return false;
    }

    // ─── Capacity Info ─────────────────────────────────────────────────────────

    /**
     * Get capacity information for a given message.
     *
     * @param {string} message - The message to measure
     * @returns {{ byteLength: number, maxBytes: number, inputLength: number, maxInputChars: number, fits: boolean }}
     *
     * @example
     *   EmojiStego.getCapacity('Hello')
     *   // { byteLength: 5, maxBytes: 256, inputLength: 5, maxInputChars: 512, fits: true }
     */
    static getCapacity(message) {
        if (typeof message !== 'string') {
            return { byteLength: 0, maxBytes: EmojiStego.MAX_BYTES, inputLength: 0, maxInputChars: EmojiStego.MAX_INPUT_CHARS, fits: false };
        }

        const encoder = new TextEncoder();
        const byteLength = encoder.encode(message).length;

        return {
            byteLength,
            maxBytes: EmojiStego.MAX_BYTES,
            inputLength: message.length,
            maxInputChars: EmojiStego.MAX_INPUT_CHARS,
            fits: byteLength <= EmojiStego.MAX_BYTES && message.length <= EmojiStego.MAX_INPUT_CHARS,
        };
    }

    // ─── Extract All ───────────────────────────────────────────────────────────

    /**
     * Extract all stego data from a text string.
     *
     * Similar to detect(), but returns decoded message data grouped by
     * the base emoji that carries it. Useful for batch decoding.
     *
     * @param {string} text - The text to scan
     * @returns {Array<{ start: number, end: number, base: string, message: string, fullEmoji: string }>}
     *   Array of decoded entries sorted by position
     *
     * @example
     *   EmojiStego.extractAll('Check this: 😀<invisible> and 🔥<invisible>')
     *   // [{ start: 11, end: 13, base: '😀', message: 'secret1', fullEmoji: '😀<invisible>' }, ...]
     */
    static extractAll(text) {
        if (!text || typeof text !== 'string') return [];

        const graphemes = EmojiStego._iterateGraphemes(text);
        const results = [];
        let charOffset = 0;

        for (const grapheme of graphemes) {
            if (EmojiStego.isStegoEmoji(grapheme)) {
                try {
                    const decoded = EmojiStego.decode(grapheme);
                    results.push({
                        start: charOffset,
                        end: charOffset + grapheme.length,
                        base: decoded.base,
                        message: decoded.message,
                        fullEmoji: grapheme,
                    });
                } catch {
                    // Silently skip malformed stego emojis
                }
            }
            charOffset += grapheme.length;
        }

        return results;
    }

    // ─── Private Helpers ───────────────────────────────────────────────────────

    /**
     * Convert a single byte (0-255) to its corresponding Unicode variation selector.
     * @param {number} byte - A value between 0 and 255
     * @returns {string} The variation selector character
     * @private
     */
    static _byteToVS(byte) {
        if (byte >= 0 && byte <= 15) {
            // Bytes 0-15 → Text presentation VS: U+FE00 to U+FE0F
            return String.fromCodePoint(EmojiStego._VS_TEXT_START + byte);
        }
        // Bytes 16-255 → Extended VS: U+E0100 to U+E01EF
        return String.fromCodePoint(EmojiStego._VS_EXT_START + (byte - 16));
    }

    /**
     * Convert a variation selector codepoint back to its byte value.
     * @param {number} cp - A Unicode codepoint in the VS range
     * @returns {number} The corresponding byte value (0-255)
     * @throws {Error} If the codepoint is not a valid stego variation selector
     * @private
     */
    static _vsToByte(cp) {
        if (cp >= EmojiStego._VS_TEXT_START && cp <= EmojiStego._VS_TEXT_END) {
            return cp - EmojiStego._VS_TEXT_START; // 0-15
        }
        if (cp >= EmojiStego._VS_EXT_START && cp <= EmojiStego._VS_EXT_END) {
            return (cp - EmojiStego._VS_EXT_START) + 16; // 16-255
        }
        throw new Error(`Invalid variation selector codepoint: U+${cp.toString(16).toUpperCase()}`);
    }

    /**
     * Check if a codepoint is a variation selector used by this stego scheme.
     * @param {number} cp - Unicode codepoint
     * @returns {boolean}
     * @private
     */
    static _isVariationSelector(cp) {
        return (
            (cp >= EmojiStego._VS_TEXT_START && cp <= EmojiStego._VS_TEXT_END) ||
            (cp >= EmojiStego._VS_EXT_START && cp <= EmojiStego._VS_EXT_END)
        );
    }

    /**
     * Iterate through a string in grapheme clusters.
     *
     * Uses Intl.Segmenter when available (modern browsers and Node.js ≥ 16),
     * with a regex-based fallback for older environments.
     *
     * @param {string} text - The input string
     * @returns {string[]} Array of grapheme cluster strings
     * @private
     */
    static _iterateGraphemes(text) {
        // Preferred: Intl.Segmenter (available in modern browsers + Node 16+)
        if (typeof Intl !== 'undefined' && Intl.Segmenter) {
            const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
            return [...segmenter.segment(text)].map(s => s.segment);
        }

        // Fallback: iterate by codepoints and group emoji sequences
        const graphemes = [];
        const codePoints = [...text];

        let i = 0;
        while (i < codePoints.length) {
            const cp = codePoints[i].codePointAt(0);

            // Check if this codepoint starts a variation selector sequence (stego data)
            if (EmojiStego._isVariationSelector(cp)) {
                // Collect consecutive variation selectors
                const vsRun = [];
                while (i < codePoints.length && EmojiStego._isVariationSelector(codePoints[i].codePointAt(0))) {
                    vsRun.push(codePoints[i]);
                    i++;
                }
                graphemes.push(vsRun.join(''));
                continue;
            }

            // Check for emoji ZWJ sequences, regional indicators, keycaps, etc.
            // Match emoji + optional FE0F + optional skin tone modifiers + ZWJ sequences
            let cluster = codePoints[i];
            i++;

            // Consume emoji modifiers (skin tones: U+1F3FB to U+1F3FF)
            while (i < codePoints.length) {
                const nextCp = codePoints[i].codePointAt(0);
                if (nextCp >= 0x1F3FB && nextCp <= 0x1F3FF) {
                    cluster += codePoints[i];
                    i++;
                } else {
                    break;
                }
            }

            // Consume optional FE0F (emoji presentation selector)
            if (i < codePoints.length && codePoints[i].codePointAt(0) === 0xFE0F) {
                cluster += codePoints[i];
                i++;
            }

            // Consume ZWJ sequences (emoji + ZWJ + emoji)
            while (i < codePoints.length && codePoints[i].codePointAt(0) === 0x200D) {
                cluster += codePoints[i];
                i++;
                // Next emoji in the ZWJ sequence
                if (i < codePoints.length) {
                    cluster += codePoints[i];
                    i++;
                }
                // Optional FE0F after joined emoji
                if (i < codePoints.length && codePoints[i].codePointAt(0) === 0xFE0F) {
                    cluster += codePoints[i];
                    i++;
                }
                // Optional skin tone modifier
                while (i < codePoints.length) {
                    const skinCp = codePoints[i].codePointAt(0);
                    if (skinCp >= 0x1F3FB && skinCp <= 0x1F3FF) {
                        cluster += codePoints[i];
                        i++;
                    } else {
                        break;
                    }
                }
            }

            // Regional indicator pairs (flag sequences: 2x U+1F1E6-U+1F1FF)
            if (cp >= 0x1F1E6 && cp <= 0x1F1FF) {
                while (i < codePoints.length) {
                    const nextCp = codePoints[i].codePointAt(0);
                    if (nextCp >= 0x1F1E6 && nextCp <= 0x1F1FF) {
                        cluster += codePoints[i];
                        i++;
                    } else {
                        break;
                    }
                }
            }

            // Keycap sequences (emoji + U+FE0F + U+20E3)
            if (i < codePoints.length && codePoints[i].codePointAt(0) === 0x20E3) {
                cluster += codePoints[i];
                i++;
            }

            graphemes.push(cluster);
        }

        return graphemes;
    }
}

export default EmojiStego;
