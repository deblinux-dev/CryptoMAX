/**
 * Канал кодирования через аббревиатуры
 * Заменяет полные формы на аббревиатуры и наоборот.
 *
 * Поддерживает морфологические вариации полных форм:
 * "в Российской Федерации", "Российскую Федерацию" и т.д.
 * — всё распознаётся как полная форма аббревиатуры "РФ".
 *
 * Формы генерируются через AZ.js при наличии морфологии.
 * Без AZ.js работает в режиме точного совпадения (backward compatible).
 */

export class AbbreviationsChannel {
    constructor(morph = null) {
        this.name = 'abbreviations';
        this.morph = morph;
        this.abbrToFull = {};
        this.fullToAbbr = {};
        this.pairs = [];       // [{abbr, full, fullVariations: [string]}]
        this.loaded = false;
        this._formOptionsCache = new Map(); // fullLower -> [{form, label, case, number, gender}]
    }

    async loadDictionary(path = './data/abbreviations.json') {
        try {
            const response = await fetch(path);
            const data = await response.json();
            this._buildIndex(data);
            this.loaded = true;
            console.log(`Loaded ${this.pairs.length} abbreviation pairs`);
        } catch (e) {
            this._buildIndex({
                'РФ': 'Российская Федерация',
                'т.е.': 'то есть',
                'и т.д.': 'и так далее',
                'и т.п.': 'и тому подобное',
                'см.': 'смотри',
                'напр.': 'например',
                'т.к.': 'так как',
                'г.': 'год',
                'кг': 'килограмм',
                'млн': 'миллион',
                'млрд': 'миллиард',
                'км': 'километр'
            });
            this.loaded = true;
        }

        // Generate variations if morphology already available
        if (this.morph && this.morph.isAvailable()) {
            this._generateAllVariations();
        }
    }

    /** Set morphology after async init (called by engine). */
    setMorphology(morph) {
        this.morph = morph;
        if (this.loaded && morph && morph.isAvailable()) {
            this._generateAllVariations();
        }
    }

    _buildIndex(data) {
        this.abbrToFull = {};
        this.fullToAbbr = {};
        this.pairs = [];
        for (const [abbr, full] of Object.entries(data)) {
            const a = abbr.trim();
            const f = full.trim().toLowerCase();
            this.abbrToFull[a.toLowerCase()] = f;
            this.fullToAbbr[f] = a;
            this.pairs.push({ abbr: a, full: f, fullVariations: [] });
        }
    }

    // ─── Morphological variations ──────────────────────────────

    /**
     * Generate morphological variations for all full forms.
     * Called after AZ.js is initialized.
     */
    _generateAllVariations() {
        if (!this.morph || !this.morph.isAvailable()) return;

        for (const pair of this.pairs) {
            const options = this._generateFormOptions(pair.full);
            // Store variations: all forms EXCEPT the base
            pair.fullVariations = options
                .filter(o => o.form !== pair.full)
                .map(o => o.form);
            // Cache for UI
            this._formOptionsCache.set(pair.full, options);
        }
        const total = this.pairs.reduce((s, p) => s + p.fullVariations.length, 0);
        console.log(`Abbreviations: ${total} morphological variations for ${this.pairs.length} pairs`);
    }

    /**
     * Generate all grammatical forms of a phrase with case labels.
     * Handles single words and multi-word phrases (coordinates case).
     * Non-declinable phrases (conjunctions, adverbs) return just the base.
     * Gender-aware: for phrases with adjectives, matches adjective gender to the
     * phrase's governing noun gender (e.g. "Российская Федерация" → femn).
     * @param {string} fullForm — lowercase base form from dictionary
     * @returns {{form: string, label: string, case: string, number: string, gender: string|null}[]}
     */
    _generateFormOptions(fullForm) {
        if (!this.morph || !this.morph.isAvailable()) {
            return [{ form: fullForm, label: 'Базовая', case: '', number: '', gender: null }];
        }

        const words = fullForm.split(/\s+/);
        const wordParses = words.map(w => this.morph.parse(w));

        // Check which words are declinable (NOUN, ADJF, ADJS, PRTF, NUMR)
        const declPOS = new Set(['NOUN', 'ADJF', 'ADJS', 'PRTF', 'NUMR']);
        const adjPOS = new Set(['ADJF', 'ADJS', 'PRTF']);
        const declinable = wordParses.map(p =>
            p.length > 0 && p[0].formCnt && declPOS.has(p[0].tag.POST)
        );

        if (!declinable.some(Boolean)) {
            return [{ form: fullForm, label: 'Базовая', case: '', number: '', gender: null }];
        }

        // Determine phrase gender: first NOUN's gender, then first declinable word's gender
        let phraseGender = null;
        for (let i = 0; i < words.length; i++) {
            if (!declinable[i] || !wordParses[i].length) continue;
            if (wordParses[i][0].tag.POST === 'NOUN' && wordParses[i][0].tag.GNdr) {
                phraseGender = wordParses[i][0].tag.GNdr;
                break;
            }
        }
        if (!phraseGender) {
            for (let i = 0; i < words.length; i++) {
                if (!declinable[i] || !wordParses[i].length) continue;
                if (wordParses[i][0].tag.GNdr) {
                    phraseGender = wordParses[i][0].tag.GNdr;
                    break;
                }
            }
        }

        // Check if the phrase contains any adjectives (for gender-in-label decisions)
        const hasAdjective = words.some((w, i) =>
            declinable[i] && wordParses[i].length && adjPOS.has(wordParses[i][0].tag.POST)
        );

        // Collect all unique (case, number) pairs from declinable words
        const caseNumPairs = new Map(); // "case_number" -> {c, n}
        for (let i = 0; i < words.length; i++) {
            if (!declinable[i]) continue;
            const p = wordParses[i][0];
            for (let j = 0; j < p.formCnt; j++) {
                try {
                    const form = p.inflect(j);
                    const key = `${form.tag.CAse || 'none'}_${form.tag.NMbr || 'sing'}`;
                    if (!caseNumPairs.has(key)) {
                        caseNumPairs.set(key, {
                            case: form.tag.CAse || 'none',
                            number: form.tag.NMbr || 'sing'
                        });
                    }
                } catch (e) { /* skip bad form */ }
            }
        }

        // Sort: singular nominative first, then other cases, then plural
        const caseOrder = ['nomn', 'gent', 'datv', 'accs', 'ablt', 'loct', 'voct', 'none'];
        const sorted = [...caseNumPairs.values()].sort((a, b) => {
            const aSing = a.number === 'sing' ? 0 : 1;
            const bSing = b.number === 'sing' ? 0 : 1;
            if (aSing !== bSing) return aSing - bSing;
            return (caseOrder.indexOf(a.case) + 1) - (caseOrder.indexOf(b.case) + 1);
        });

        const caseLabels = {
            nomn: 'Им.п.', gent: 'Р.п.', datv: 'Д.п.',
            accs: 'В.п.', ablt: 'Т.п.', loct: 'П.п.', voct: 'Зв.п.', none: ''
        };
        const numLabels = { sing: '', plur: ' мн.' };
        const genderLabels = { masc: 'М.р.', femn: 'Ж.р.', neut: 'С.р.' };

        const results = [];
        const added = new Set();

        for (const { case: tc, number: tn } of sorted) {
            const phrase = words.map((w, i) => {
                if (!declinable[i] || !wordParses[i].length) return w;
                const p = wordParses[i][0];
                const wordTag = wordParses[i][0].tag;
                for (let j = 0; j < p.formCnt; j++) {
                    try {
                        const form = p.inflect(j);
                        if ((form.tag.CAse || '') === tc && (form.tag.NMbr || '') === tn) {
                            // For adjectives, also match gender to phrase gender
                            if (adjPOS.has(wordTag.POST) && phraseGender) {
                                if ((form.tag.GNdr || '') !== phraseGender) continue;
                            }
                            return _applyWordCase(form.toString(), w);
                        }
                    } catch (e) {}
                }
                return w;
            }).join(' ');

            // Build label with gender for adjective phrases
            const genderStr = (hasAdjective && phraseGender && tn === 'sing' && genderLabels[phraseGender])
                ? ` ${genderLabels[phraseGender]}` : '';
            const label = `${caseLabels[tc] || ''}${numLabels[tn] || ''}${genderStr}`.trim() || 'Базовая';

            if (!added.has(phrase)) {
                added.add(phrase);
                results.push({ form: phrase, label, case: tc, number: tn, gender: phraseGender });
            }
        }

        return results.length > 0
            ? results
            : [{ form: fullForm, label: 'Базовая', case: '', number: '', gender: null }];
    }

    /**
     * Get form options for a specific full form (for UI dropdown).
     * @returns {{form: string, label: string, case: string, number: string, gender: string|null}[]}
     */
    getFormOptions(fullBase) {
        const key = (typeof fullBase === 'string' ? fullBase : '').toLowerCase();
        if (this._formOptionsCache.has(key)) {
            return this._formOptionsCache.get(key);
        }
        const options = this._generateFormOptions(key);
        this._formOptionsCache.set(key, options);
        return options;
    }

    /**
     * Get expanded abbreviation forms in stego text (for UI panel).
     * @returns {{index, length, currentForm, abbr, fullBase, options}[]}
     */
    getExpandedForms(text) {
        if (!this.loaded) return [];
        return this._findMatches(text)
            .filter(m => m.type === 'full')
            .map(m => ({
                index: m.index,
                length: m.length,
                currentForm: m.found,
                abbr: m.abbr,
                fullBase: m.full,
                options: this.getFormOptions(m.full)
            }));
    }

    /**
     * Get all individual words from ALL abbreviation full forms (base + variations).
     * Useful for synonymizer exclusion: prevents replacing words like "Федерация"
     * when they're part of an abbreviation expansion like "Российская Федерация".
     * @returns {Set<string>}
     */
    getAllFullFormWords() {
        const allWords = new Set();
        for (const pair of this.pairs) {
            pair.full.split(/\s+/).forEach(w => allWords.add(w.toLowerCase()));
            for (const variation of pair.fullVariations) {
                variation.split(/\s+/).forEach(w => allWords.add(w.toLowerCase()));
            }
        }
        return allWords;
    }

    /**
     * Get all individual words that appear in a specific abbreviation's full form.
     * @param {string} abbr - abbreviation to look up
     * @returns {Set<string>|null}
     */
    getFullFormWords(abbr) {
        const key = (typeof abbr === 'string' ? abbr : '').toLowerCase();
        const pair = this.pairs.find(p => p.abbr.toLowerCase() === key);
        if (!pair) return null;

        const allWords = new Set();
        pair.full.split(/\s+/).forEach(w => allWords.add(w.toLowerCase()));
        for (const variation of pair.fullVariations) {
            variation.split(/\s+/).forEach(w => allWords.add(w.toLowerCase()));
        }
        return allWords;
    }

    // ─── Core channel methods ──────────────────────────────────

    _findMatches(text) {
        const matches = [];
        const isExcluded = (start, end) => {
            const spans = this._excludedSpans;
            if (!spans || spans.length === 0) return false;
            return spans.some(s =>
                (start >= s.start && start < s.end) ||
                (end > s.start && end <= s.end) ||
                (start <= s.start && end >= s.end)
            );
        };

        for (const { abbr, full, fullVariations } of this.pairs) {
            // Search for abbreviation
            const abbrEsc = this._escapeRegex(abbr).replace(/ /g, '\\s');
            const abbrRe = new RegExp(`(?<![а-яёА-ЯЁa-zA-Z])${abbrEsc}(?![а-яёА-ЯЁa-zA-Z])`, 'gi');
            let m;
            while ((m = abbrRe.exec(text)) !== null) {
                if (isExcluded(m.index, m.index + m[0].length)) continue;
                matches.push({ index: m.index, length: m[0].length, type: 'abbr', abbr, full, found: m[0] });
            }

            // Search for base full form AND all morphological variations
            const formsToSearch = [full, ...fullVariations];
            for (const form of formsToSearch) {
                const formEsc = this._escapeRegex(form).replace(/ /g, '\\s');
                const formRe = new RegExp(`(?<![а-яёА-ЯЁ])${formEsc}(?![а-яёА-ЯЁ])`, 'gi');
                while ((m = formRe.exec(text)) !== null) {
                    if (isExcluded(m.index, m.index + m[0].length)) continue;
                    // Skip duplicate at same position
                    if (matches.some(x => x.index === m.index && x.length === m[0].length)) continue;
                    matches.push({ index: m.index, length: m[0].length, type: 'full', abbr, full, found: m[0] });
                }
            }
        }

        matches.sort((a, b) => a.index - b.index);
        const filtered = [];
        let lastEnd = -1;
        for (const match of matches) {
            if (match.index >= lastEnd) { filtered.push(match); lastEnd = match.index + match.length; }
        }
        return filtered;
    }

    analyzeCapacity(text) {
        if (!this.loaded) return { totalBits: 0, positions: [], bases: [] };
        const matches = this._findMatches(text);
        const positions = matches.map(m => ({ index: m.index, type: m.type, abbr: m.abbr, full: m.full, variants: 2 }));
        return { totalBits: positions.length, positions, bases: positions.map(() => 2) };
    }

    encode(text, indices) {
        if (!this.loaded || indices.length === 0) return text;
        const matches = this._findMatches(text);
        if (matches.length === 0) return text;

        const toReplace = [];
        for (let i = 0; i < Math.min(matches.length, indices.length); i++) {
            const m = matches[i];
            const useAbbr = indices[i] === 0;
            let replacement = useAbbr ? m.abbr : m.full;
            // Capitalize each word if the found form was capitalized
            if (m.found[0] === m.found[0].toUpperCase() && m.found[0] !== m.found[0].toLowerCase()) {
                replacement = replacement.split(/\s+/).map(w =>
                    w.charAt(0).toUpperCase() + w.slice(1)
                ).join(' ');
            }
            toReplace.push({ index: m.index, length: m.length, replacement });
        }

        toReplace.sort((a, b) => b.index - a.index);
        let result = text;
        for (const r of toReplace)
            result = result.slice(0, r.index) + r.replacement + result.slice(r.index + r.length);
        return result;
    }

    /** Decode: abbreviation → 0, any full form (base or variation) → 1 */
    decode(stegoText) {
        if (!this.loaded) return [];
        return this._findMatches(stegoText).map(m => m.type === 'abbr' ? 0 : 1);
    }

    getSpans(text) {
        if (!this.loaded) return [];
        return this._findMatches(text).map(m => ({ start: m.index, end: m.index + m.length }));
    }

    _escapeRegex(str) { return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

    getStats() { return { name: this.name, loaded: this.loaded, pairs: this.pairs.length }; }
}

// ─── Helpers ────────────────────────────────────────────────────

/** Apply capitalization pattern from source to target word */
function _applyWordCase(target, source) {
    if (!source || !target) return target;
    if (source === source.toUpperCase() && source.length > 1) return target.toUpperCase();
    if (source[0] !== source[0].toLowerCase())
        return target.charAt(0).toUpperCase() + target.slice(1);
    return target.toLowerCase();
}

export default AbbreviationsChannel;
