import { EmojiStego } from './emoji-stego.js';

/**
 * Helper: check if a Unicode codepoint is an emoji base character.
 * Covers the main emoji ranges: BMP emoji (U+1F300–U+1F9FF),
 * supplemental symbols (U+1FA00–U+1FAFF), emoticons (U+2600–U+26FF),
 * dingbats (U+2700–U+27BF), misc symbols (U+2300–U+23FF), and
 * regional indicators (U+1F1E6–U+1F1FF).
 */
function _isEmojiBase(cp) {
    return (cp >= 0x1F300 && cp <= 0x1F9FF) ||
           (cp >= 0x1FA00 && cp <= 0x1FAFF) ||
           (cp >= 0x2600  && cp <= 0x26FF) ||
           (cp >= 0x2700  && cp <= 0x27BF) ||
           (cp >= 0x2300  && cp <= 0x23FF) ||
           (cp >= 0x2B50  && cp <= 0x2B55) ||
           (cp >= 0x1F1E6 && cp <= 0x1F1FF) ||
           (cp >= 0x1F000 && cp <= 0x1F02F) ||  // Mahjong / Domino
           (cp >= 0xFE00  && cp <= 0xFE0F) ||   // Also treat lone VS as base (edge case)
           (cp >= 0x200D);                       // ZWJ pass-through (handled by caller)
}

/**
 * Helper: check if a codepoint is a stego variation selector.
 */
function _isStegoVS(cp) {
    return (cp >= 0xFE00 && cp <= 0xFE0F) ||   // VS1–VS16
           (cp >= 0xE0100 && cp <= 0xE01EF);    // IVS range
}

export class EmojiStegoChannel {
    constructor() {
        this.name = 'emoji-stego';
        this._isTagBased = true; // Isolated channel — doesn't overlap with others
    }

    /**
     * Find stego emojis in text using DIRECT CODEPOINT scanning.
     *
     * IMPORTANT: This method does NOT use Intl.Segmenter's grapheme clustering.
     * Intl.Segmenter may split a base emoji + 256 variation selectors into
     * multiple grapheme clusters (browser-specific behavior for very long
     * Extend sequences). This would cause _findStegoEmojis to return MORE
     * emojis during decode (long VS sequence) than during encode (short IVS),
     * producing a base-count mismatch that breaks the mixed-radix roundtrip.
     *
     * Instead, we scan codepoints directly:
     * 1. Find an emoji base character
     * 2. Consume optional skin-tone modifiers (U+1F3FB–U+1F3FF)
     * 3. Consume optional FE0F (emoji presentation selector — NOT stego data)
     * 4. Consume stego VS characters (FE00–FE0E, E0100–E01EF)
     * 5. That entire span is ONE stego-emoji
     */
    _findStegoEmojis(text) {
        if (!text) return [];
        const results = [];
        const codePoints = [...text]; // Spread handles surrogate pairs
        let i = 0;
        let charOffset = 0; // UTF-16 code unit offset

        while (i < codePoints.length) {
            const cp = codePoints[i].codePointAt(0);
            const cpLen = codePoints[i].length; // UTF-16 code units for this codepoint

            // Skip non-emoji characters (ASCII, Cyrillic, punctuation, etc.)
            if (!_isEmojiBase(cp) && !(cp >= 0x1F3FB && cp <= 0x1F3FF)) {
                charOffset += cpLen;
                i++;
                continue;
            }

            // We found a potential emoji base. Collect the full emoji sequence:
            // baseEmoji [+ skin-tone] [+ FE0F] [+ ZWJ + moreEmoji]*
            const emojiStart = i;
            const emojiOffsetStart = charOffset;
            let j = i;

            // 1. Consume the base emoji character
            j++;

            // 2. Consume optional skin-tone modifiers (U+1F3FB–U+1F3FF)
            while (j < codePoints.length) {
                const next = codePoints[j].codePointAt(0);
                if (next >= 0x1F3FB && next <= 0x1F3FF) {
                    j++;
                } else break;
            }

            // 3. Consume optional FE0F (emoji presentation selector — NOT stego)
            //    Only consume if NO stego VS follows (FE00-FE0F or E0100-E01EF).
            //    FIX: _byteToVS(15) produces FE0F. When byte value 15 is encoded,
            //    FE0F appears in the VS sequence. Without this lookahead, step 3
            //    would consume FE0F as "presentation selector", and step 7 would
            //    stop scanning at FE0F (range FE00-FE0E excludes it), causing
            //    decode to return fewer indices than analyzeCapacity reports.
            if (j < codePoints.length && codePoints[j].codePointAt(0) === 0xFE0F) {
                const nextCp = j + 1 < codePoints.length ? codePoints[j + 1].codePointAt(0) : -1;
                const hasStegoAfter = (nextCp >= 0xFE00 && nextCp <= 0xFE0F) ||
                                      (nextCp >= 0xE0100 && nextCp <= 0xE01EF);
                if (!hasStegoAfter) {
                    j++;
                }
            }

            // 4. Consume ZWJ sequences (emoji + ZWJ + emoji + modifiers + FE0F)
            while (j < codePoints.length && codePoints[j].codePointAt(0) === 0x200D) {
                j++; // consume ZWJ
                // Next emoji in ZWJ sequence
                if (j < codePoints.length) {
                    j++; // consume next emoji base
                    // Optional skin-tone after joined emoji
                    while (j < codePoints.length) {
                        const st = codePoints[j].codePointAt(0);
                        if (st >= 0x1F3FB && st <= 0x1F3FF) j++;
                        else break;
                    }
                    // Optional FE0F after joined emoji
                    if (j < codePoints.length && codePoints[j].codePointAt(0) === 0xFE0F) j++;
                }
            }

            // 5. Regional indicator pairs (flags)
            if (cp >= 0x1F1E6 && cp <= 0x1F1FF) {
                while (j < codePoints.length) {
                    const ri = codePoints[j].codePointAt(0);
                    if (ri >= 0x1F1E6 && ri <= 0x1F1FF) j++;
                    else break;
                }
            }

            // 6. Keycap sequences (emoji + FE0F + U+20E3)
            if (j < codePoints.length && codePoints[j].codePointAt(0) === 0x20E3) {
                j++;
            }

            // Calculate emoji sequence length in UTF-16 code units
            let emojiSeqLen = 0;
            for (let k = emojiStart; k < j; k++) {
                emojiSeqLen += codePoints[k].length;
            }

            // 7. Consume stego variation selectors (FE00–FE0F, E0100–E01EF)
            // These are the data-carrying VS characters. FE0F is included because
            // byte value 15 maps to FE0F via _byteToVS().
            const vsStart = j;
            let hasIVS = false;
            let hasNonFE0F_VS = false;
            while (j < codePoints.length) {
                const vsc = codePoints[j].codePointAt(0);
                if (vsc >= 0xE0100 && vsc <= 0xE01EF) {
                    hasIVS = true;
                    j++;
                } else if (vsc >= 0xFE00 && vsc <= 0xFE0F) {
                // FIX: include FE0F (byte value 15) in the stego VS range.
                // Previously FE0F was excluded, causing step 7 to stop scanning
                // and losing all subsequent VS characters.
                    hasNonFE0F_VS = true;
                    j++;
                } else {
                    break; // Not a stego VS — stop consuming
                }
            }

            // If this emoji has stego VS data, record it
            if (hasIVS || hasNonFE0F_VS) {
                // Total span in UTF-16 code units
                let totalLen = emojiSeqLen;
                for (let k = vsStart; k < j; k++) {
                    totalLen += codePoints[k].length;
                }

                // baseEnd = number of codepoints in the emoji part (before VS)
                const baseEnd = vsStart - emojiStart;

                results.push({
                    offset: emojiOffsetStart,
                    length: totalLen,
                    // Extract the full string span for encode/decode
                    _codePoints: codePoints.slice(emojiStart, j),
                    baseEnd,
                });
            }

            // Advance to end of consumed sequence (even if not stego)
            charOffset = emojiOffsetStart;
            for (let k = emojiStart; k < j; k++) {
                charOffset += codePoints[k].length;
            }
            i = j;
        }
        return results;
    }

    analyzeCapacity(text) {
        const stegoEmojis = this._findStegoEmojis(text);
        if (stegoEmojis.length === 0) {
            return { totalBits: 0, positions: [], bases: [] };
        }
        const BYTES_PER_EMOJI = EmojiStego.MAX_BYTES; // 256
        const BITS_PER_BYTE = 8;
        const totalBits = stegoEmojis.length * BYTES_PER_EMOJI * BITS_PER_BYTE;
        // For mixed-radix: each byte position has base 256
        const bases = [];
        for (let i = 0; i < stegoEmojis.length; i++) {
            for (let b = 0; b < BYTES_PER_EMOJI; b++) {
                bases.push(256);
            }
        }
        // For UI highlighting: one position per stego emoji (to avoid overlap issues)
        const positions = stegoEmojis.map((se, i) => ({
            index: se.offset,
            length: se.length,
            bits: BYTES_PER_EMOJI * BITS_PER_BYTE,
            variants: undefined, // signal to use pos.bits directly
        }));
        return { totalBits, positions, bases };
    }

    encode(text, indices) {
        if (!indices || indices.length === 0) return text;
        const stegoEmojis = this._findStegoEmojis(text);
        if (stegoEmojis.length === 0) return text;

        const BYTES_PER_EMOJI = EmojiStego.MAX_BYTES;
        let result = text;
        let indexOffset = 0;

        // Process from end to start to preserve character offsets
        for (let i = stegoEmojis.length - 1; i >= 0; i--) {
            const se = stegoEmojis[i];
            const byteCount = Math.min(BYTES_PER_EMOJI, indices.length - indexOffset);
            if (byteCount <= 0) break;

            const byteIndices = indices.slice(indexOffset, indexOffset + byteCount);
            // Extract base emoji (everything before the first variation selector)
            const cps = se._codePoints;
            const baseEmoji = cps.slice(0, se.baseEnd).join('');

            // Encode byte indices as variation selectors
            let vsSequence = '';
            for (const byteIdx of byteIndices) {
                vsSequence += EmojiStego._byteToVS(byteIdx);
            }
            const newGrapheme = baseEmoji + vsSequence;
            result = result.slice(0, se.offset) + newGrapheme + result.slice(se.offset + se.length);
            indexOffset += byteCount;
        }
        return result;
    }

    decode(text) {
        const stegoEmojis = this._findStegoEmojis(text);
        if (stegoEmojis.length === 0) return [];
        const BYTES_PER_EMOJI = EmojiStego.MAX_BYTES;
        const indices = [];
        for (const se of stegoEmojis) {
            const cps = se._codePoints;
            // Find start of variation selectors
            let vsStart = se.baseEnd;
            let count = 0;
            for (let k = vsStart; k < cps.length && count < BYTES_PER_EMOJI; k++) {
                const cp = cps[k].codePointAt(0);
                if ((cp >= 0xFE00 && cp <= 0xFE0F) || (cp >= 0xE0100 && cp <= 0xE01EF)) {
                    try {
                        indices.push(EmojiStego._vsToByte(cp));
                        count++;
                    } catch { break; }
                } else { break; }
            }
        }
        return indices;
    }

    /**
     * Return spans for each stego emoji region.
     * This allows the span exclusion system to prevent other channels
     * from analyzing text inside the stego emoji's variation selector sequence.
     */
    getSpans(text) {
        const stegoEmojis = this._findStegoEmojis(text);
        return stegoEmojis.map(se => ({
            start: se.offset,
            end: se.offset + se.length,
        }));
    }

    getStats() { return { name: this.name, loaded: true, maxBytesPerEmoji: EmojiStego.MAX_BYTES }; }
}

export default EmojiStegoChannel;
