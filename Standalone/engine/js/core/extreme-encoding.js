/**
 * Extreme Channel Classes — Mixed-Radix Stego Engine Integration
 *
 * Three channel classes compatible with the engine's convergence loop.
 * Each channel encodes bits via character manipulation — NO async, NO crypto.
 *
 * ## Channel Interface (same as all engine channels):
 *
 *   channel.name             — string identifier
 *   channel._isTagBased      — boolean flag
 *   channel.analyzeCapacity(text)  → { totalBits, bases, positions }
 *   channel.encode(text, indices)  → encoded text string
 *   channel.decode(text)          → array of indices
 *   channel.restore(text)         → normalized text (for decode path)
 *   channel.normalizeText(text)   → normalizes carrier before encode
 *   channel.getSpans(text)        → array of {start, end}
 *   channel.detect(text)          → boolean (auto-detect on decode)
 *
 * ## Channels:
 *
 * 1. **CaseLadderChannel** ('case-ladder')
 *    Encodes 1 bit per letter via uppercase/lowercase.
 *    Lowercases entire text, then sets selected positions to uppercase.
 *
 * 2. **ZeroWidthExtChannel** ('zero-width-ext')
 *    Encodes base-3 digits via invisible characters at word boundaries.
 *    0→U+200C (ZWNJ), 1→U+200D (ZWJ), 2→U+200B (ZWSP).
 *
 * 3. **CyrillicLatinChannel** ('cyrillic-latin')
 *    Encodes 1 bit per position by swapping Cyrillic↔Latin lookalikes.
 *    0=keep Cyrillic, 1=replace with Latin equivalent.
 *
 * ## Encoding Order (matches engine's "letter-stego goes last" pattern):
 *
 *   case-ladder → cyrillic-latin → zero-width-ext
 *   (case first: modifies case; cyrillic-latin: swaps chars; zw-ext: invisible — least destructive last)
 *
 * ## Decode Order (reverse):
 *
 *   zero-width-ext → cyrillic-latin → case-ladder
 *   (zw-ext first: remove invisible chars; cyrillic-latin: restore Cyrillic; case: lowercase)
 *
 * ## Compatibility Map:
 *
 * | Method           | Disabled Standard Channels                                   |
 * |------------------|---------------------------------------------------------------|
 * | case-ladder      | fio, addresses, playlist, case, pc-parts, auto-parts,        |
 * |                  | gadgets, categorized-words, spaces, letter-stego              |
 * |                  | (CL lowercases all text → destroys LS case-preserved mutations) |
 * | zero-width-ext   | (none — ZW chars are invisible)                               |
 * | cyrillic-latin   | synonyms, abbreviations, duplets, letter-stego, parasites,   |
 * |                  | participles, voice, phrases, yo-replacement,                  |
 * |                  | categorized-words, fio, addresses, playlist, case, spaces,   |
 * |                  | typos, recipes, word-order, dates                            |
 */

// ─── Cyrillic ↔ Latin Lookalike Mapping ──────────────────────────────────────

/**
 * Cyrillic characters that have visually identical Latin counterparts.
 * Each entry maps Cyrillic → Latin.
 */
const CYR_TO_LAT = {
    'А': 'A', 'В': 'B', 'С': 'C', 'Е': 'E', 'К': 'K', 'М': 'M',
    'Н': 'H', 'О': 'O', 'Р': 'P', 'Т': 'T', 'Х': 'X',
    'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x',
};

/**
 * Reverse map: each Latin lookalike → its Cyrillic equivalent.
 * Case is preserved: 'A' → 'А', 'a' → 'а', etc.
 *
 * IMPORTANT: This map is built from CYR_TO_LAT, so each Latin char maps
 * to exactly one Cyrillic char (no ambiguity).
 */
const LAT_TO_CYR = {};
for (const [cyr, lat] of Object.entries(CYR_TO_LAT)) {
    LAT_TO_CYR[lat] = cyr;
}

/** Set of Cyrillic chars that have Latin lookalikes. */
const CYR_MATCHING = new Set(Object.keys(CYR_TO_LAT));

/** Set of Latin chars that are lookalikes of Cyrillic. */
const LAT_MATCHING = new Set(Object.values(CYR_TO_LAT));

// ─── Compatibility Map ──────────────────────────────────────────────────────

/**
 * Which standard channels are broken when an extreme method is active.
 * Used by ExtremeChannelManager.getDisabledChannels().
 */
const COMPAT_MAP = {
    'case-ladder': [
        'fio', 'addresses', 'playlist', 'case',
        'pc-parts', 'auto-parts', 'gadgets',
        'categorized-words', 'spaces', 'letter-stego',
        'cyrillic-latin',  // CL uppercase creates new CYR lookalike positions (m→M is CYR swappable)
    ],
    'zero-width-ext': [],
    'cyrillic-latin': [
        'synonyms', 'abbreviations', 'duplets', 'letter-stego',
        'parasites', 'participles', 'voice', 'phrases',
        'yo-replacement', 'categorized-words',
        'fio', 'addresses', 'playlist', 'case', 'spaces',
        'typos', 'recipes', 'word-order', 'dates',
        'case-ladder',  // CYR Cyrillic→Latin swaps create case differences CL can't reverse
    ],
};

// ─── Shared Helpers (module-level, used by all channels) ────────────────────

/**
 * Find protected regions (emails, URLs, www addresses) in text.
 * Returns sorted array of {start, end} spans for efficient lookup.
 */
function _findProtectedRegions(text) {
    const regions = [];
    let m;

    // Email addresses
    const emailRe = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
    while ((m = emailRe.exec(text)) !== null) {
        regions.push({ start: m.index, end: m.index + m[0].length });
    }

    // URLs with protocol (http/https)
    const urlRe = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/g;
    while ((m = urlRe.exec(text)) !== null) {
        regions.push({ start: m.index, end: m.index + m[0].length });
    }

    // www.* addresses without protocol
    const wwwRe = /www\.[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}[^\s<>"{}|\\^`\[\]]*/g;
    while ((m = wwwRe.exec(text)) !== null) {
        // Skip if already covered by a protocol URL
        const overlaps = regions.some(r =>
            m.index >= r.start && m.index + m[0].length <= r.end
        );
        if (!overlaps) {
            regions.push({ start: m.index, end: m.index + m[0].length });
        }
    }

    regions.sort((a, b) => a.start - b.start);
    return regions;
}

/**
 * Check if a character index falls within any region.
 * Regions must be sorted by start (as returned by _findProtectedRegions).
 * Uses early exit for O(log n) best case.
 */
function _isInRegion(charIndex, regions) {
    for (const r of regions) {
        if (charIndex >= r.start && charIndex < r.end) return true;
        if (charIndex < r.start) return false; // past all possible matches
    }
    return false;
}

/**
 * Find sentence-start positions in text.
 * Returns a Set of character indices.
 *
 * Includes:
 * - The first non-space character (starts the first sentence)
 * - Letters after `.!?` followed by whitespace
 *
 * Note: The regex matches ANY letter (upper or lower case) after `.!?`,
 * because during decode the text may already be lowercased.
 */
function _findSentenceStarts(text) {
    const starts = new Set();

    // First non-space character
    const firstMatch = text.match(/\S/);
    if (firstMatch) starts.add(firstMatch.index);

    // After .!? + whitespace + any letter
    const re = /[.!?]\s+([a-zA-Zа-яёА-ЯЁ])/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        starts.add(m.index + m[0].length - 1);
    }

    return starts;
}

/**
 * Find [steg-*] tag block ranges in text.
 * Returns sorted array of {start, end} spans.
 * Channels skip characters inside these blocks to avoid corrupting
 * generated content from tag-based channels (recipes, addresses, etc.).
 */
function _findTagRanges(text) {
    const ranges = [];
    const re = /\[steg-[^\]]*\]/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        ranges.push({ start: m.index, end: m.index + m[0].length });
    }
    return ranges;
}


// ═══════════════════════════════════════════════════════════════════════════
// CaseLadderChannel
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Encodes 1 bit per letter position via uppercase/lowercase pattern.
 *
 * Encode: lowercase entire text, then set selected positions to uppercase.
 * Decode: for each position, check if char is uppercase (1) or lowercase (0).
 * Restore: lowercase everything — reverses encoding back to carrier state.
 *
 * Positions are all letters (a-zA-Zа-яёА-ЯЁ) excluding:
 *   - Inside emails, URLs, www addresses
 *   - First character of sentences (natural capitalization)
 *   - Inside [steg-*] tag blocks
 */
class CaseLadderChannel {
    constructor() {
        /** @type {string} Channel identifier */
        this.name = 'case-ladder';
        /** @type {boolean} Not tag-based — modifications spread throughout text */
        this._isTagBased = false;
        /** @type {boolean} Extreme channel flag — excluded from standard channel processing */
        this._isExtreme = true;
    }

    /**
     * Find all letter positions that can carry case information.
     *
     * @param {string} text - Input text (any case)
     * @returns {Array<{index: number, char: string}>} Position descriptors
     */
    _findPositions(text) {
        const protectedRegions = _findProtectedRegions(text);
        const sentenceStarts = _findSentenceStarts(text);
        const tagRanges = _findTagRanges(text);
        const positions = [];

        for (let i = 0; i < text.length; i++) {
            // Skip protected regions (emails, URLs)
            if (_isInRegion(i, protectedRegions)) continue;
            // Skip tag blocks
            if (_isInRegion(i, tagRanges)) continue;

            const ch = text[i];
            // Only letters with case distinction
            if (!/[a-zA-Zа-яёА-ЯЁ]/.test(ch)) continue;
            // Skip sentence-start positions (natural capitalization)
            if (sentenceStarts.has(i)) continue;

            positions.push({ index: i, char: ch });
        }

        return positions;
    }

    /**
     * Analyze encoding capacity.
     * Each letter position = base 2 (1 bit).
     *
     * @param {string} text
     * @returns {{ totalBits: number, bases: number[], positions: Array }}
     */
    analyzeCapacity(text) {
        const positions = this._findPositions(text);
        const bases = new Array(positions.length).fill(2);
        return { totalBits: positions.length, bases, positions };
    }

    /**
     * Encode indices into text via case manipulation.
     *
     * Algorithm:
     * 1. Lowercase entire text
     * 2. For each position where indices[i] === 1, set character to uppercase
     *
     * @param {string} text - Carrier text
     * @param {number[]} indices - Array of 0/1 values (length ≤ positions.length)
     * @returns {string} Encoded text
     */
    encode(text, indices) {
        const positions = this._findPositions(text);
        const chars = text.split('');

        // Step 1: lowercase everything (establishes carrier baseline)
        for (let i = 0; i < chars.length; i++) {
            chars[i] = chars[i].toLowerCase();
        }

        // Step 2: apply case ladder — set selected positions to uppercase
        for (let i = 0; i < indices.length && i < positions.length; i++) {
            if (indices[i] === 1) {
                chars[positions[i].index] = chars[positions[i].index].toUpperCase();
            }
        }

        return chars.join('');
    }

    /**
     * Decode indices from case pattern.
     *
     * For each position: uppercase → 1, lowercase → 0.
     *
     * @param {string} text - Encoded text (mixed case)
     * @returns {number[]} Array of 0/1 values
     */
    decode(text) {
        const positions = this._findPositions(text);
        const indices = [];

        for (let i = 0; i < positions.length; i++) {
            const ch = text[positions[i].index];
            indices.push(ch === ch.toUpperCase() ? 1 : 0);
        }

        return indices;
    }

    /**
     * Restore text to carrier state: lowercase everything.
     * This reverses encoding so subsequent channels see the carrier text.
     *
     * @param {string} text
     * @returns {string}
     */
    restore(text) {
        return text.toLowerCase();
    }

    /**
     * Normalize carrier text before encoding: lowercase everything.
     * Ensures carrier text is in a known state so positions are deterministic.
     *
     * @param {string} text
     * @returns {string}
     */
    normalizeText(text) {
        return text.toLowerCase();
    }

    /**
     * No isolated spans — case modifications are spread throughout text.
     *
     * @param {string} text
     * @returns {Array<{start: number, end: number}>}
     */
    getSpans(text) {
        return [];
    }

    /**
     * Detect if case-ladder encoding was used on text.
     *
     * Heuristics:
     * 1. High ratio of uppercase in encodable positions (>35% vs ~5-15% natural)
     * 2. High case alternation rate (>40% transitions between upper/lower)
     *    — natural text clusters upper/lower; binary encoding alternates more uniformly
     *
     * @param {string} text
     * @returns {boolean}
     */
    detect(text) {
        const positions = this._findPositions(text);
        if (positions.length < 6) return false;

        // Count uppercase at encodable positions
        let upperCount = 0;
        for (const pos of positions) {
            const ch = text[pos.index];
            if (ch === ch.toUpperCase() && ch !== ch.toLowerCase()) {
                upperCount++;
            }
        }

        const ratio = upperCount / positions.length;
        // Lowered threshold: 8% (was 35%) for better detection of short messages.
        // Natural Russian text has ~5-15% uppercase (sentence starts, abbreviations).
        // 8% provides a small margin above natural while catching encoded texts.
        if (ratio < 0.08) return false;

        // Measure alternation regularity
        const cases = positions.map(p => {
            const ch = text[p.index];
            return (ch === ch.toUpperCase() && ch !== ch.toLowerCase()) ? 1 : 0;
        });
        let transitions = 0;
        for (let i = 1; i < cases.length; i++) {
            if (cases[i] !== cases[i - 1]) transitions++;
        }
        const transitionRate = transitions / Math.max(1, cases.length - 1);

        // Lowered: 25% alternation (was 40%) or ratio > 15% (was 45%)
        return transitionRate > 0.25 || ratio > 0.15;
    }
}


// ═══════════════════════════════════════════════════════════════════════════
// ZeroWidthExtChannel
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Encodes base-3 digits via invisible zero-width characters at word boundaries.
 *
 * Uses three ZW characters (one per digit value):
 *   0 → U+200C  (ZWNJ — Zero Width Non-Joiner)
 *   1 → U+200D  (ZWJ  — Zero Width Joiner)
 *   2 → U+200B  (ZWSP — Zero Width Space)
 *
 * Each word boundary (position after a space, before next word) carries
 * one base-3 digit ≈ log₂(3) ≈ 1.585 bits.
 *
 * WARNING: Some messengers and servers strip zero-width characters.
 * U+200B (ZWSP) is used as digit 2 — it never appears in natural Russian text
 * and is not used by the marker (which uses U+FEFF). This provides clean separation:
 *   marker = [U+FEFF][flag1][flag2], channel data = U+200C/U+200D/U+200B between words.
 */
class ZeroWidthExtChannel {
    constructor() {
        /** @type {string} Channel identifier */
        this.name = 'zero-width-ext';
        /** @type {boolean} Not tag-based */
        this._isTagBased = false;
        /** @type {boolean} Extreme channel flag — excluded from standard channel processing */
        this._isExtreme = true;
        /** Three zero-width characters indexed by digit value (0, 1, 2) */
        this.ZW_CHARS = ['\u200C', '\u200D', '\u200B'];
        /** Set for O(1) membership test */
        this.ZW_SET = new Set(this.ZW_CHARS);
    }

    /**
     * Find word boundary positions (insertion point after a space).
     *
     * For each space character (regular or non-breaking U+00A0),
     * the insertion position is the character index right after the space.
     *
     * Excludes positions inside protected regions and tag blocks.
     *
     * @param {string} text
     * @returns {Array<{index: number}>} Insertion positions
     */
    _findPositions(text) {
        const protectedRegions = _findProtectedRegions(text);
        const tagRanges = _findTagRanges(text);
        const positions = [];

        for (let i = 0; i < text.length; i++) {
            // Only regular spaces and non-breaking spaces
            if (text[i] !== ' ' && text[i] !== '\u00A0') continue;

            const insertPos = i + 1;

            // Skip if space or insertion point falls in a protected region
            if (_isInRegion(i, protectedRegions)) continue;
            if (_isInRegion(i, tagRanges)) continue;
            if (insertPos >= text.length) continue;

            // Only insert if there's a non-space character following.
            // NOTE: Cannot use /\S/ because some zero-width chars are classified as \s
            // in some JS engines. We only need to exclude space/NBSP here.
            if (text[insertPos] !== ' ' && text[insertPos] !== '\u00A0') {
                positions.push({ index: insertPos });
            }
        }

        return positions;
    }

    /**
     * Analyze encoding capacity.
     * Each word boundary = base 3 ≈ 1.585 bits.
     *
     * @param {string} text
     * @returns {{ totalBits: number, bases: number[], positions: Array }}
     */
    analyzeCapacity(text) {
        const positions = this._findPositions(text);
        const bases = new Array(positions.length).fill(3);
        const totalBits = Math.floor(positions.length * Math.log2(3));
        return { totalBits, bases, positions };
    }

    /**
     * Encode indices as ZW characters at word boundaries.
     *
     * For each position, insert the ZW character corresponding to indices[i]:
     *   0 → U+200C, 1 → U+200D, 2 → U+200B
     *
     * Insertion shifts subsequent character positions, so an offset
     * accumulator tracks the cumulative shift.
     *
     * @param {string} text - Carrier text
     * @param {number[]} indices - Array of 0/1/2 values
     * @returns {string} Encoded text with ZW chars inserted
     */
    encode(text, indices) {
        const positions = this._findPositions(text);
        // Build encoded string in a single pass — O(n) instead of O(n*m) splice.
        // Positions are in ascending order, so we can slice-and-append sequentially.
        let result = '';
        let lastIdx = 0;
        for (let i = 0; i < indices.length && i < positions.length; i++) {
            const pos = positions[i].index;
            const digit = indices[i] || 0;
            const zwChar = this.ZW_CHARS[digit] || this.ZW_CHARS[0];
            result += text.slice(lastIdx, pos) + zwChar;
            lastIdx = pos;
        }
        result += text.slice(lastIdx);
        return result;
    }

    /**
     * Decode indices from ZW characters at word boundaries.
     *
     * On the encoded text, _findPositions finds the same word boundaries.
     * At each boundary, the next character should be a ZW char.
     * Map it back to 0/1/2. If no ZW char is present, default to 0.
     *
     * @param {string} text - Encoded text (with ZW chars at word boundaries)
     * @returns {number[]} Array of 0/1/2 values
     */
    decode(text) {
        const positions = this._findPositions(text);
        const indices = [];

        for (let i = 0; i < positions.length; i++) {
            const pos = positions[i].index;
            if (pos < text.length && this.ZW_SET.has(text[pos])) {
                const idx = this.ZW_CHARS.indexOf(text[pos]);
                indices.push(idx >= 0 ? idx : 0);
            } else {
                indices.push(0);
            }
        }

        return indices;
    }

    /**
     * Restore: remove all extreme ZW characters (U+200C, U+200D, U+200B).
     *
     * @param {string} text
     * @returns {string}
     */
    restore(text) {
        return text.replace(/[\u200C\u200D\u200B]/g, '');
    }

    /**
     * Normalize carrier text: remove any pre-existing extreme ZW characters.
     *
     * @param {string} text
     * @returns {string}
     */
    normalizeText(text) {
        return this.restore(text);
    }

    /**
     * No isolated spans.
     *
     * @param {string} text
     * @returns {Array<{start: number, end: number}>}
     */
    getSpans(text) {
        return [];
    }

    /**
     * Detect if zero-width-ext encoding was used.
     *
     * U+200B (ZWSP) is the reliable detection signal:
     *   - It is NEVER used by the marker (marker uses U+FEFF + U+200D/U+200C)
     *   - It is NEVER produced by any other channel
     *   - It is NEVER present in natural Russian text
     *   - No need to skip the marker prefix (U+200B != U+FEFF)
     *
     * @param {string} text
     * @returns {boolean}
     */
    detect(text) {
        return text.includes('\u200B');
    }
}


// ═══════════════════════════════════════════════════════════════════════════
// CyrillicLatinChannel
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Encodes 1 bit per position by swapping Cyrillic ↔ Latin lookalikes.
 *
 * Each replaceable character carries 1 bit:
 *   0 = keep Cyrillic
 *   1 = replace with Latin equivalent
 *
 * CRITICAL DESIGN: Position finding is INVARIANT under the swap.
 * _findPositions() recognizes BOTH Cyrillic originals and Latin lookalikes
 * as valid positions. This ensures the same positions are found on both
 * the encode text (all Cyrillic) and the decode text (mixed Cyrillic/Latin).
 *
 * Since encoding is 1-to-1 character replacement (Cyrillic → Latin, same
 * string length), character indices never shift — positions are stable.
 *
 * The reverse map (LAT_TO_CYR) preserves case: 'A'→'А', 'a'→'а', etc.
 */
class CyrillicLatinChannel {
    constructor() {
        /** @type {string} Channel identifier */
        this.name = 'cyrillic-latin';
        /** @type {boolean} Not tag-based */
        this._isTagBased = false;
        /** @type {boolean} Extreme channel flag — excluded from standard channel processing */
        this._isExtreme = true;
    }

    /**
     * Find all positions with Cyrillic↔Latin swappable characters.
     *
     * Invariant under swap: recognizes BOTH Cyrillic originals AND Latin
     * lookalikes as valid positions. This is critical for deterministic
     * roundtrip — encode and decode must find the same positions.
     *
     * Excludes: protected regions, sentence starts, tag blocks.
     *
     * @param {string} text
     * @returns {Array<{index: number, char: string}>}
     */
    _findPositions(text) {
        const protectedRegions = _findProtectedRegions(text);
        const sentenceStarts = _findSentenceStarts(text);
        const tagRanges = _findTagRanges(text);
        const positions = [];

        for (let i = 0; i < text.length; i++) {
            if (_isInRegion(i, protectedRegions)) continue;
            if (_isInRegion(i, tagRanges)) continue;
            if (sentenceStarts.has(i)) continue;

            const ch = text[i];
            // Accept Cyrillic originals OR Latin lookalikes (invariant under swap)
            if (CYR_MATCHING.has(ch) || LAT_TO_CYR[ch]) {
                positions.push({ index: i, char: ch });
            }
        }

        return positions;
    }

    /**
     * Analyze encoding capacity.
     * Each swappable position = base 2 (1 bit).
     *
     * @param {string} text
     * @returns {{ totalBits: number, bases: number[], positions: Array }}
     */
    analyzeCapacity(text) {
        const positions = this._findPositions(text);
        const bases = new Array(positions.length).fill(2);
        return { totalBits: positions.length, bases, positions };
    }

    /**
     * Encode indices by replacing Cyrillic chars with Latin equivalents.
     *
     * For each position where indices[i] === 1:
     *   Look up the character in CYR_TO_LAT and replace.
     * For indices[i] === 0: keep the character as-is.
     *
     * IMPORTANT: normalizeText() should be called on the carrier before
     * encoding to ensure all position chars are Cyrillic. Without
     * normalization, Latin lookalikes from the original text would remain
     * and could cause position mismatches during decode.
     *
     * @param {string} text - Carrier text (ideally normalized)
     * @param {number[]} indices - Array of 0/1 values
     * @returns {string} Encoded text with some Cyrillic→Latin swaps
     */
    encode(text, indices) {
        const positions = this._findPositions(text);
        const chars = text.split('');

        for (let i = 0; i < indices.length && i < positions.length; i++) {
            if (indices[i] === 1) {
                const pos = positions[i];
                // Only replace Cyrillic → Latin (CYR_TO_LAT maps Cyrillic keys)
                const latinChar = CYR_TO_LAT[pos.char];
                if (latinChar) {
                    chars[pos.index] = latinChar;
                }
            }
        }

        return chars.join('');
    }

    /**
     * Decode indices from Cyrillic/Latin pattern.
     *
     * For each position:
     *   Latin lookalike (in LAT_TO_CYR) → bit 1
     *   Cyrillic original (in CYR_MATCHING) → bit 0
     *
     * @param {string} text - Encoded text (mixed Cyrillic/Latin)
     * @returns {number[]} Array of 0/1 values
     */
    decode(text) {
        const positions = this._findPositions(text);
        const indices = [];

        for (let i = 0; i < positions.length; i++) {
            const ch = text[positions[i].index];
            indices.push(LAT_TO_CYR[ch] ? 1 : 0);
        }

        return indices;
    }

    /**
     * Restore: replace all Latin lookalikes back to Cyrillic.
     *
     * Uses LAT_TO_CYR which preserves case: 'A'→'А', 'a'→'а', etc.
     * Protected regions (emails, URLs) are skipped — Latin chars there
     * are intentional and must not be changed.
     *
     * @param {string} text
     * @returns {string}
     */
    restore(text) {
        const protectedRegions = _findProtectedRegions(text);
        const chars = text.split('');

        for (let i = 0; i < chars.length; i++) {
            if (_isInRegion(i, protectedRegions)) continue;
            const cyr = LAT_TO_CYR[chars[i]];
            if (cyr) {
                chars[i] = cyr;
            }
        }

        return chars.join('');
    }

    /**
     * Normalize carrier text: replace Latin lookalikes with Cyrillic.
     *
     * This ensures all "slot" characters are Cyrillic before encoding,
     * making position finding deterministic across encode/decode.
     *
     * @param {string} text
     * @returns {string}
     */
    normalizeText(text) {
        return this.restore(text);
    }

    /**
     * No isolated spans.
     *
     * @param {string} text
     * @returns {Array<{start: number, end: number}>}
     */
    getSpans(text) {
        return [];
    }

    /**
     * Detect if cyrillic-latin substitution was used on text.
     *
     * Heuristic: count Latin lookalikes that are SURROUNDED by Cyrillic
     * characters. In natural Russian text this is ~0%. When the channel
     * has been used, 10-50% of relevant positions show Latin lookalikes.
     *
     * The "surrounded by Cyrillic" context check filters out legitimate
     * English words that happen to contain matching Latin chars.
     *
     * @param {string} text
     * @returns {boolean}
     */
    detect(text) {
        const protectedRegions = _findProtectedRegions(text);
        let latinLookalikeCount = 0;
        let totalRelevant = 0;

        for (let i = 0; i < text.length; i++) {
            if (_isInRegion(i, protectedRegions)) continue;
            const ch = text[i];

            if (CYR_MATCHING.has(ch)) {
                totalRelevant++;
            } else if (LAT_TO_CYR[ch]) {
                totalRelevant++;
                const prev = i > 0 ? text[i - 1] : '';
                const next = i < text.length - 1 ? text[i + 1] : '';
                if (/[а-яёА-ЯЁ]/.test(prev) || /[а-яёА-ЯЁ]/.test(next)) {
                    latinLookalikeCount++;
                }
            }
        }

        // Lowered: 3 positions minimum (was 5) and 3% ratio (was 8%)
        if (totalRelevant < 3) return false;
        const ratio = latinLookalikeCount / totalRelevant;
        return ratio > 0.03;
    }
}


// ═══════════════════════════════════════════════════════════════════════════
// ExtremeChannelManager
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Manages extreme channel instances, auto-detection, and compatibility.
 *
 * Provides:
 * - Channel instance access for engine integration
 * - Auto-detection of which extreme methods are present in text
 * - Compatibility mapping (which standard channels to disable)
 * - Capacity analysis across active methods
 *
 * ## Encoding Order:
 *   case-ladder → cyrillic-latin → zero-width-ext
 *   (case first: modifies case; then char swaps; then invisible — least destructive last)
 *
 * ## Integration with StegoEngine:
 *
 *   The engine treats extreme channels like letter-stego:
 *   - Encoded LAST (after standard channels) during encodeMessage()
 *   - Decoded FIRST (before standard channels) during decodeMessage()
 *   - restore() normalizes text for subsequent channels
 *
 *   Each channel's analyzeCapacity(), encode(), decode(), restore(), and
 *   normalizeText() methods participate in the convergence loop exactly
 *   like any other engine channel.
 */
export class ExtremeChannelManager {
    constructor() {
        /** @type {CaseLadderChannel} */
        this.caseLadder = new CaseLadderChannel();
        /** @type {ZeroWidthExtChannel} */
        this.zeroWidthExt = new ZeroWidthExtChannel();
        /** @type {CyrillicLatinChannel} */
        this.cyrillicLatin = new CyrillicLatinChannel();

        /**
         * All extreme channels in encoding order.
         * Decode order is the reverse.
         * @type {Array<CaseLadderChannel|CyrillicLatinChannel|ZeroWidthExtChannel>}
         */
        this.allMethods = [this.caseLadder, this.cyrillicLatin, this.zeroWidthExt];

        /** @type {string[]} Currently active extreme method names */
        this.activeMethods = [];
    }

    /**
     * Set which extreme methods are active.
     *
     * @param {string[]} methodNames - Array of method names (e.g. ['case-ladder', 'zero-width-ext'])
     */
    setActiveMethods(methodNames) {
        this.activeMethods = methodNames.filter(n =>
            this.allMethods.some(m => m.name === n)
        );
    }

    /**
     * Get channel instances for given method names.
     * Returns channels in encoding order (case-ladder → cyrillic-latin → zero-width-ext).
     *
     * @param {string[]} [methodNames] - Method names to filter (defaults to activeMethods)
     * @returns {Array<CaseLadderChannel|CyrillicLatinChannel|ZeroWidthExtChannel>}
     */
    getActiveChannels(methodNames) {
        const names = methodNames || this.activeMethods;
        return this.allMethods.filter(m => names.includes(m.name));
    }

    /**
     * Auto-detect which extreme methods were used on text.
     *
     * Runs each channel's detect() heuristic. Detection order:
     *   case-ladder, cyrillic-latin, zero-width-ext
     *
     * @param {string} text - Text to analyze
     * @returns {string[]} Detected method names
     */
    detectExtremeMethods(text) {
        const detected = [];
        if (this.caseLadder.detect(text)) detected.push('case-ladder');
        if (this.cyrillicLatin.detect(text)) detected.push('cyrillic-latin');
        if (this.zeroWidthExt.detect(text)) detected.push('zero-width-ext');
        return detected;
    }

    /**
     * Get standard channels that must be disabled given the active/detected methods.
     *
     * @param {string[]} [methodNames] - Method names to check (defaults to activeMethods)
     * @returns {string[]} Disabled channel names
     */
    getDisabledChannels(methodNames) {
        const names = methodNames || this.activeMethods;
        const disabled = new Set();
        for (const name of names) {
            (COMPAT_MAP[name] || []).forEach(ch => disabled.add(ch));
        }
        return [...disabled];
    }

    /**
     * Analyze total capacity of active extreme channels on text.
     *
     * @param {string} text
     * @returns {{ totalBits: number, totalBytes: number, perMethod: Object }}
     */
    analyzeCapacity(text) {
        const channels = this.getActiveChannels();
        let totalBits = 0;
        const perMethod = {};

        for (const channel of channels) {
            try {
                const analysis = channel.analyzeCapacity(text);
                totalBits += analysis.totalBits;
                perMethod[channel.name] = {
                    bits: analysis.totalBits,
                    positions: analysis.positions.length,
                };
            } catch (e) {
                perMethod[channel.name] = { bits: 0, positions: 0, error: e.message };
            }
        }

        return {
            totalBits,
            totalBytes: Math.floor(totalBits / 8),
            perMethod,
        };
    }

    /**
     * Get channel instance by name.
     *
     * @param {string} name - Channel name ('case-ladder', 'zero-width-ext', 'cyrillic-latin')
     * @returns {CaseLadderChannel|ZeroWidthExtChannel|CyrillicLatinChannel|undefined}
     */
    getChannel(name) {
        return this.allMethods.find(m => m.name === name);
    }

    /** Compatibility map: extreme method → disabled standard channels */
    static COMPAT_MAP = COMPAT_MAP;
}


// ─── Exports ────────────────────────────────────────────────────────────────

export { CaseLadderChannel, ZeroWidthExtChannel, CyrillicLatinChannel };
export default ExtremeChannelManager;
