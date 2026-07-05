/**
 * Канал кодирования через категоризированные слова — словари категорий
 *
 * Принцип: в тексте обнаруживаются слова из категоризированных словарей
 * (фильмы, видеоигры, породы собак, породы кошек). Кодирование заключается
 * в замене найденного слова на другое из того же словаря по индексу.
 *
 * Форматы категорий:
 *   - Фильмы: в кавычках («...» / "..."), регистрозависимые
 *   - Видеоигры: без кавычек, регистрозависимые
 *   - Породы собак: без кавычек, без учёта регистра
 *   - Породы кошек: без кавычек, без учёта регистра
 *
 * Алиасы для вставки:
 *   [steg-movie]       → случайный фильм в кавычках
 *   [steg-videogame]   → случайная видеоигра
 *   [steg-dog]         → случайная порода собак
 *   [steg-cat]         → случайная порода кошек
 *
 * Детекция: сначала самое длинное совпадение (longest match first).
 * Например: «Аватар: Легенда об Аанге» приоритетнее, чем «Аватар».
 *
 * Каналы категорий НЕ обрабатываются другими каналами кодирования:
 * синонимизатор пропускает эти слова, декодер это знает.
 */

// ─── Конфигурация категорий ───────────────────────────────────
const CATEGORY_CONFIG = {
    movies:     { caseSensitive: true,  quoteRequired: true,  alias: 'movie' },
    videogames: { caseSensitive: true,  quoteRequired: false, alias: 'videogame' },
    dogs:       { caseSensitive: false, quoteRequired: false, alias: 'dog' },
    cats:       { caseSensitive: false, quoteRequired: false, alias: 'cat' },
};

const CATEGORY_ALIASES = Object.values(CATEGORY_CONFIG).map(c => c.alias);

/**
 * Убрать ведущие/замыкающие не-алфавитные символы из слова.
 * "Survivors:" → "Survivors", "(гурдбасар)" → "гурдбасар", "собака," → "собака"
 */
function _normalizeWord(w) {
    return w.replace(/^[^a-zA-Zа-яёА-ЯЁ0-9]+/, '').replace(/[^a-zA-Zа-яёА-ЯЁ0-9]+$/, '');
}

export class CategorizedWordsChannel {
    constructor() {
        this.name = 'categorized-words';
        this.loaded = false;
        this._isTagBased = true; // Теговый для алиасов; также детектирует естественные вхождения

        // Словари: category → { entries: string[] (sorted by length desc), hashMap, prefixIndex }
        this.dictionaries = {};

        // Regex для алиасов
        this.TAG_REGEX = new RegExp(
            '\\[steg-(' + CATEGORY_ALIASES.join('|') + ')\\]', 'g'
        );

        // Типы кавычек для фильмов
        this.QUOTE_PAIRS = [
            ['«', '»'], ['\u201C', '\u201D'], ['\u201E', '\u201D'], ['"', '"'], ['\u2018', '\u2019']
        ];
    }

    // ─── Загрузка словарей ────────────────────────────────────────

    async loadDictionaries(dataPath = './data') {
        try {
            for (const [cat, config] of Object.entries(CATEGORY_CONFIG)) {
                const response = await fetch(`${dataPath}/categories/${cat}.txt`);
                if (!response.ok) {
                    console.warn(`[categorized-words] Не удалось загрузить ${cat}: ${response.status}`);
                    continue;
                }
                const text = await response.text();
                // Убираем BOM, пустые строки, дубликаты
                let entries = text
                    .replace(/^\uFEFF/, '')
                    .split('\n')
                    .map(s => s.trim())
                    .filter(s => s.length > 0);
                entries = [...new Set(entries)];

                // Сортируем по длине по убыванию (longest match first)
                entries.sort((a, b) => b.length - a.length);

                // Строим lookup-структуры
                const hashMap = new Map(); // entry → index (for exact match)
                for (let i = 0; i < entries.length; i++) {
                    if (config.caseSensitive) {
                        hashMap.set(entries[i], i);
                    } else {
                        const key = entries[i].toLowerCase();
                        if (!hashMap.has(key)) hashMap.set(key, i);
                    }
                }

                // Префиксный индекс: нормализованное первое слово → [{entry, index, normWords}]
                const prefixIndex = new Map();
                for (let i = 0; i < entries.length; i++) {
                    const entry = entries[i];
                    const words = entry.split(/\s+/);
                    if (words.length === 0) continue;
                    const firstNorm = _normalizeWord(words[0]);
                    const firstKey = config.caseSensitive ? firstNorm : firstNorm.toLowerCase();
                    if (!firstKey) continue;
                    if (!prefixIndex.has(firstKey)) {
                        prefixIndex.set(firstKey, []);
                    }
                    // Сохраняем нормализованные слова для сравнения
                    const normWords = words.map(w => {
                        const nw = _normalizeWord(w);
                        return config.caseSensitive ? nw : nw.toLowerCase();
                    });
                    prefixIndex.get(firstKey).push({ entry, index: i, words, normWords });
                }

                this.dictionaries[cat] = {
                    entries,
                    hashMap,
                    prefixIndex,
                    config,
                };
            }

            this.loaded = true;
            const stats = Object.entries(this.dictionaries).map(
                ([k, v]) => `${k}: ${v.entries.length}`
            ).join(', ');
            console.log(`[categorized-words] Загружено: ${stats}`);
        } catch (e) {
            console.error('[categorized-words] Ошибка загрузки:', e);
        }
    }

    // ─── Поиск алиасов ───────────────────────────────────────────

    _findTags(text) {
        const tags = [];
        this.TAG_REGEX.lastIndex = 0;
        let m;
        while ((m = this.TAG_REGEX.exec(text)) !== null) {
            // Определяем категорию по алиасу
            let category = null;
            for (const [cat, cfg] of Object.entries(CATEGORY_CONFIG)) {
                if (cfg.alias === m[1]) { category = cat; break; }
            }
            if (category) {
                tags.push({
                    start: m.index,
                    end: m.index + m[0].length,
                    category,
                    isTag: true,
                    full: m[0],
                });
            }
        }
        return tags;
    }

    // ─── Поиск фильмов (в кавычках, longest match first) ────────

    _findMovies(text) {
        const matches = [];
        const dict = this.dictionaries.movies;
        if (!dict) return matches;

        // Находим все кавычки в тексте
        const quotePositions = [];
        for (let i = 0; i < text.length; i++) {
            for (const [openQ, closeQ] of this.QUOTE_PAIRS) {
                if (text.slice(i, i + openQ.length) === openQ) {
                    quotePositions.push({ pos: i, char: openQ, type: 'open', pair: closeQ, len: openQ.length });
                }
            }
        }

        // Находим пары кавычек
        for (let qi = 0; qi < quotePositions.length; qi++) {
            const open = quotePositions[qi];
            if (open.type !== 'open') continue;

            const contentStart = open.pos + open.len;
            // Ищем закрывающую кавычку
            const closeIdx = text.indexOf(open.pair, contentStart);
            if (closeIdx === -1) continue;

            const content = text.slice(contentStart, closeIdx);
            if (content.length === 0) continue;

            // Ищем longest match в словаре
            // Пытаемся найти полное совпадение, затем убираем по одному слову с конца
            const contentWords = content.split(/\s+/);
            let bestMatch = null;

            for (let wLen = contentWords.length; wLen >= 1; wLen--) {
                const candidate = contentWords.slice(0, wLen).join(' ');
                const idx = dict.hashMap.get(candidate);
                if (idx !== undefined) {
                    if (!bestMatch || wLen > bestMatch.wordCount) {
                        bestMatch = {
                            entry: dict.entries[idx],
                            dictIndex: idx,
                            wordCount: wLen,
                            textStart: contentStart,
                            textEnd: contentStart + candidate.length,
                            // Включаем кавычки в span для исключения из других каналов
                            spanStart: open.pos,
                            spanEnd: closeIdx + open.pair.length,
                        };
                    }
                    break; // Нашли longest match для этого количества слов
                }
            }

            if (bestMatch) {
                matches.push({
                    start: bestMatch.textStart,
                    end: bestMatch.textEnd,
                    spanStart: bestMatch.spanStart,
                    spanEnd: bestMatch.spanEnd,
                    category: 'movies',
                    isTag: false,
                    matchedText: bestMatch.entry,
                    dictIndex: bestMatch.dictIndex,
                    bits: Math.log2(dict.entries.length),
                });
            }
        }

        return matches;
    }

    // ─── Поиск по словарю через префиксный индекс ───────────────

    _findDictMatches(text, category) {
        const dict = this.dictionaries[category];
        if (!dict) return [];
        const { config, prefixIndex, entries } = dict;

        const matches = [];
        const usedRanges = []; // track used [start, end) ranges

        // Токенизируем текст: извлекаем слова с позициями
        // Апостроф включён для обработки «Link's», «Don't», «Garry's Mod» и т.п.
        const textWords = [];
        const wordRegex = /([a-zA-Zа-яёА-ЯЁ0-9][a-zA-Zа-яёА-ЯЁ0-9\-']*)/g;
        let wm;
        while ((wm = wordRegex.exec(text)) !== null) {
            textWords.push({
                word: wm[0],
                start: wm.index,
                end: wm.index + wm[0].length,
            });
        }

        // Сканируем каждое слово текста
        for (let wi = 0; wi < textWords.length; wi++) {
            const tw = textWords[wi];
            const lookupKey = config.caseSensitive ? tw.word : tw.word.toLowerCase();

            const candidates = prefixIndex.get(lookupKey);
            if (!candidates) continue;

            // Для каждого кандидата, проверяем совпадение
            for (const cand of candidates) {
                const candWords = cand.normWords; // Используем нормализованные слова
                if (candWords.length === 0) continue;

                // Проверяем что есть достаточно слов после текущего
                if (wi + candWords.length > textWords.length) continue;

                // Проверяем совпадение всех слов
                let matchEnd = wi;
                let fullMatch = true;
                for (let ci = 1; ci < candWords.length; ci++) {
                    const nextTW = textWords[wi + ci];

                    // Проверяем, что между словами только пробелы/разделители
                    if (nextTW.start > textWords[wi + ci - 1].end + 5) {
                        fullMatch = false;
                        break;
                    }

                    const actual = config.caseSensitive
                        ? nextTW.word
                        : nextTW.word.toLowerCase();

                    if (actual !== candWords[ci]) {
                        fullMatch = false;
                        break;
                    }
                    matchEnd = wi + ci;
                }

                if (!fullMatch) continue;

                const matchStartChar = textWords[wi].start;
                const matchEndChar = textWords[matchEnd].end;

                // Проверяем что нет пробела перед совпадением (начало слова/строки)
                if (wi > 0) {
                    const charBefore = text[textWords[wi].start - 1];
                    if (charBefore !== ' ' && charBefore !== '\n' && charBefore !== '(' &&
                        charBefore !== '[' && charBefore !== ',' && charBefore !== ':' &&
                        charBefore !== ';' && charBefore !== '—' && charBefore !== '-' &&
                        charBefore !== '\u00AB' && charBefore !== '"' && charBefore !== '\u201C' &&
                        charBefore !== '\u201E' && charBefore !== '\u2018') {
                        // Слово является частью более длинного слова — пропускаем
                        continue;
                    }
                }

                // Проверяем что после совпадения — конец текста или разделитель
                const charAfter = text[matchEndChar];
                if (charAfter && charAfter !== ' ' && charAfter !== '\n' && charAfter !== ')' &&
                    charAfter !== ']' && charAfter !== ',' && charAfter !== '.' &&
                    charAfter !== '!' && charAfter !== '?' && charAfter !== ':' &&
                    charAfter !== ';' && charAfter !== '—' && charAfter !== '-' &&
                    charAfter !== '\u00BB' && charAfter !== '"' && charAfter !== '\u201D' &&
                    charAfter !== '\u2019') {
                    // Это часть более длинного слова — пропускаем
                    continue;
                }

                // Проверяем что не внутри тега [steg-...]
                if (text[matchStartChar - 1] === '[' && text[matchEndChar] === ']') {
                    continue;
                }

                // Проверяем пересечение с уже использованными диапазонами
                const overlaps = usedRanges.some(
                    r => matchStartChar < r[1] && matchEndChar > r[0]
                );
                if (overlaps) continue;

                usedRanges.push([matchStartChar, matchEndChar]);

                matches.push({
                    start: matchStartChar,
                    end: matchEndChar,
                    category,
                    isTag: false,
                    matchedText: text.slice(matchStartChar, matchEndChar),
                    dictIndex: cand.index,
                    bits: Math.log2(entries.length),
                });

                break; // Нашли longest match для этой позиции
            }
        }

        return matches;
    }

    // ─── Общий поиск всех совпадений ──────────────────────────────

    _findMatches(text) {
        const matches = [];

        // 1. Теги-алиасы
        const tags = this._findTags(text);
        for (const tag of tags) {
            matches.push(tag);
        }

        // 2. Фильмы (в кавычках)
        const movieMatches = this._findMovies(text);
        for (const m of movieMatches) {
            matches.push(m);
        }

        // 3. Видеоигры, собаки, кошки (префиксный поиск)
        for (const cat of ['videogames', 'dogs', 'cats']) {
            const catMatches = this._findDictMatches(text, cat);
            for (const m of catMatches) {
                matches.push(m);
            }
        }

        // Сортируем по позиции в тексте
        matches.sort((a, b) => a.start - b.start);

        // Устраняем пересечения: более длинный побеждает
        const resolved = [];
        for (const m of matches) {
            const mEnd = m.spanEnd !== undefined ? m.spanEnd : m.end;
            const mStart = m.spanStart !== undefined ? m.spanStart : m.start;
            const overlaps = resolved.some(
                r => {
                    const rEnd = r.spanEnd !== undefined ? r.spanEnd : r.end;
                    const rStart = r.spanStart !== undefined ? r.spanStart : r.start;
                    return mStart < rEnd && mEnd > rStart;
                }
            );
            if (!overlaps) {
                resolved.push(m);
            }
        }

        return resolved;
    }

    // ─── Channel API ─────────────────────────────────────────────

    analyzeCapacity(text) {
        if (!this.loaded) return { totalBits: 0, positions: [], bases: [] };

        const matches = this._findMatches(text);
        if (matches.length === 0) return { totalBits: 0, positions: [], bases: [] };

        const positions = [];
        const bases = [];

        for (const match of matches) {
            const dict = this.dictionaries[match.category];
            if (!dict || dict.entries.length < 2) continue;

            const spanStart = match.spanStart !== undefined ? match.spanStart : match.start;
            const spanEnd = match.spanEnd !== undefined ? match.spanEnd : match.end;

            positions.push({
                index: spanStart,
                length: spanEnd - spanStart,
                category: match.category,
                word: match.isTag ? match.full : match.matchedText,
                bits: Math.log2(dict.entries.length),
            });
            bases.push(dict.entries.length);
        }

        const totalBits = bases.reduce((s, b) => s + Math.log2(b), 0);
        return { totalBits, positions, bases };
    }

    encode(text, indices) {
        if (!this.loaded || indices.length === 0) return text;

        const matches = this._findMatches(text);
        const replacements = [];
        let idx = 0;

        for (const match of matches) {
            const dict = this.dictionaries[match.category];
            if (!dict || dict.entries.length < 2) continue;
            if (idx >= indices.length) break;

            const encodedIdx = indices[idx] % dict.entries.length;
            const replacement = dict.entries[encodedIdx];
            const config = dict.config;

            if (match.isTag) {
                // Заменяем алиас на словарное слово
                let finalReplacement = replacement;
                if (config.quoteRequired) {
                    finalReplacement = `«${replacement}»`;
                }
                replacements.push({
                    index: match.start,
                    length: match.end - match.start,
                    replacement: finalReplacement,
                });
            } else {
                // Заменяем существующее словарное слово на другое
                const spanStart = match.spanStart !== undefined ? match.spanStart : match.start;
                const spanEnd = match.spanEnd !== undefined ? match.spanEnd : match.end;

                let finalReplacement;
                if (config.quoteRequired && match.spanStart !== undefined) {
                    // Для фильмов: заменяем содержимое внутри кавычек, кавычки остаются
                    const quoteOpen = text[spanStart];
                    const quoteClose = text[spanEnd - 1];
                    // Находим закрывающую кавычку
                    const closeIdx = spanEnd - 1;
                    finalReplacement = text.slice(spanStart, match.start) +
                        replacement +
                        text.slice(match.end, closeIdx + 1);
                    replacements.push({
                        index: spanStart,
                        length: spanEnd - spanStart,
                        replacement: finalReplacement,
                    });
                } else {
                    // Сохраняем регистр первой буквы для case-insensitive категорий
                    if (!config.caseSensitive && match.matchedText) {
                        const originalFirst = match.matchedText[0];
                        if (originalFirst === originalFirst.toUpperCase() && originalFirst !== originalFirst.toLowerCase()) {
                            finalReplacement = replacement.charAt(0).toUpperCase() + replacement.slice(1);
                        } else {
                            finalReplacement = replacement;
                        }
                    } else {
                        finalReplacement = replacement;
                    }
                    replacements.push({
                        index: match.start,
                        length: match.end - match.start,
                        replacement: finalReplacement,
                    });
                }
            }

            idx++;
        }

        // Применяем замены в обратном порядке
        let result = text;
        for (let i = replacements.length - 1; i >= 0; i--) {
            const r = replacements[i];
            result = result.slice(0, r.index) + r.replacement + result.slice(r.index + r.length);
        }
        return result;
    }

    decode(stegoText) {
        if (!this.loaded) return [];

        // При декодировании ищем ТОЛЬКО естественные совпадения (не теги)
        const allMatches = this._findMatches(stegoText);
        const dictMatches = allMatches.filter(m => !m.isTag);

        return dictMatches.filter(match => {
            const dict = this.dictionaries[match.category];
            return dict && dict.entries.length >= 2;
        }).map(match => {
            // Используем dictIndex напрямую из _findDictMatches/_findMovies,
            // а не re-lookup по matchedText. Проблема: matchedText вычисляется
            // через text.slice(start, end) где end = конец последнего СЛОВА,
            // но regex-токенизатор не включает ")" и другие знаки препинания
            // в состав слова. Для записи "фарфоровая гончая (порселен)"
            // matchedText = "фарфоровая гончая (порселен" (без ")"),
            // что не совпадает с ключом в hashMap → decode возвращает 0.
            // dictIndex хранит правильный индекс из словаря.
            return match.dictIndex !== undefined ? match.dictIndex : 0;
        });
    }

    getSpans(text) {
        const matches = this._findMatches(text);
        return matches.map(m => ({
            start: m.spanStart !== undefined ? m.spanStart : m.start,
            end: m.spanEnd !== undefined ? m.spanEnd : m.end,
        }));
    }

    /**
     * Получить случайное слово из категории (для T9-подсказок)
     */
    getRandomEntry(category) {
        const dict = this.dictionaries[category];
        if (!dict || dict.entries.length === 0) return null;
        return dict.entries[Math.floor(Math.random() * dict.entries.length)];
    }

    /**
     * Получить размер словаря категории
     */
    getDictSize(category) {
        return this.dictionaries[category]?.entries?.length || 0;
    }

    getStats() {
        const cats = {};
        for (const [cat, dict] of Object.entries(this.dictionaries)) {
            cats[cat] = {
                entries: dict.entries.length,
                bits: dict.entries.length >= 2 ? Math.log2(dict.entries.length).toFixed(1) : 0,
            };
        }
        return {
            name: this.name,
            loaded: this.loaded,
            categories: cats,
        };
    }
}

export default CategorizedWordsChannel;
