/**
 * Канал кодирования через российские почтовые адреса — v2 (NO MARKERS)
 *
 * Принцип: находим [steg-address] теги ИЛИ уже существующие адреса,
 * соответствующие формату "РЕГИОН, г./город ГОРОД, ул./улица УЛИЦА, д./дом N[, кв./квартира N]",
 * и заменяем/читаем данные через верификацию по словарям (CITY_MAP и STREET_MAP).
 *
 * Обнаружение:
 *   1. Regex: ищем строки по формату адреса РФ
 *   2. Dictionary check: city ∈ CITY_MAP && street ∈ STREET_MAP
 *   3. Если ОБА совпали — это гарантированно наш адрес
 *
 * Аббревиатуры несут доп. биты: г./город, ул./улица, д./дом, кв./квартира
 * Квартира может отсутствовать (index=0) для естественности.
 *
 * Размерности mixed-radix (11 измерений):
 *   region(64) × cityPref(64) × citySuff(64) × streetPref(64) × streetSuff(64)
 *   × house(512) × apartment(512) × abbrCity(2) × abbrStreet(2) × abbrHouse(2) × abbrAppt(2)
 *   = 6+6+6+6+6+9+9+1+1+1+1 = 52 бита на тег
 *
 * Алиас:
 *   [steg-address] — Один российский адрес (52 бита)
 */

// ─── Regions (64) ─────────────────────────────────────────
const REGIONS = [
    "Московская обл.", "Ленинградская обл.", "Свердловская обл.", "Ростовская обл.",
    "Нижегородская обл.", "Челябинская обл.", "Самарская обл.", "Омская обл.",
    "Кемеровская обл.", "Саратовская обл.", "Воронежская обл.", "Волгоградская обл.",
    "Краснодарский край", "Красноярский край", "Алтайский край", "Пермский край",
    "Приморский край", "Ставропольский край", "Хабаровский край", "Камчатский край",
    "Республика Татарстан", "Республика Башкортостан", "Республика Крым", "Республика Саха",
    "Республика Дагестан", "Республика Бурятия", "Республика Коми", "Республика Карелия",
    "Республика Алтай", "Республика Тыва", "Республика Хакасия", "Удмуртская Республика",
    "Чувашская Республика", "Чеченская Республика", "Кабардино-Балкарская Республика", "Рязанская обл.",
    "Пензенская обл.", "Тульская обл.", "Кировская обл.", "Липецкая обл.",
    "Астраханская обл.", "Томская обл.", "Калмыкия", "Ивановская обл.", "Тверская обл.",
    "Белгородская обл.", "Брянская обл.", "Владимирская обл.", "Курская обл.",
    "Калужская обл.", "Орловская обл.", "Смоленская обл.", "Тамбовская обл.",
    "Ярославская обл.", "Вологодская обл.", "Архангельская обл.", "Мурманская обл.",
    "Курганская обл.", "Тюменская обл.", "Оренбургская обл.", "Забайкальский край",
    "Амурская обл.", "Сахалинская обл.", "Магаданская обл."
];

// ─── City Components ──────────────────────────────────────
const CITY_PREFS = [
    "Ново", "Красно", "Бело", "Старо", "Верхне", "Нижне", "Горно", "Южно",
    "Северо", "Восточно", "Западно", "Мало", "Велико", "Светло", "Темно", "Черно",
    "Ясно", "Добро", "Зелено", "Сине", "Крае", "Волго", "Дон", "Кам",
    "Росто", "Урал", "Сиб", "Том", "Ом", "Самар", "Сарат", "Уф",
    "Перм", "Киров", "Иван", "Твер", "Туль", "Рязан", "Брян", "Орл",
    "Курск", "Белгород", "Воронеж", "Кемеров", "Барнаул", "Иркут", "Хабаров", "Влад",
    "Соч", "Ялт", "Симферо", "Севасто", "Мурман", "Архангел", "Волог", "Псков",
    "Новгород", "Казан", "Пенз", "Тюмен", "Сургут", "Магадан", "Якут", "Грозн"
];

const CITY_SUFS = [
    "ск", "овск", "евск", "инск", "енск", "бург", "град", "поль",
    "ово", "ево", "ино", "ыно", "ичи", "ицы", "цы", "дону",
    "горск", "реченск", "озерск", "углеск", "водск", "славль", "уральск", "каменск",
    "морск", "донск", "волжск", "сибирск", "азиатск", "европейск", "заводск", "строй",
    "дар", "мир", "свет", "лес", "бор", "яр", "лог", "острог",
    "вал", "порт", "мост", "брод", "ключ", "камень", "мыс", "куст",
    "рог", "сад", "дол", "река", "озеро", "гора", "долина", "поляна",
    "село", "деревня", "хутор", "стан", "аул", "кишлак", "юрт", "погост"
];

// ─── Street Components ────────────────────────────────────
const STREET_PREFS = [
    "", "1-я ", "2-я ", "3-я ", "4-я ", "5-я ", "6-я ", "7-я ",
    "8-я ", "9-я ", "10-я ", "Верхняя ", "Нижняя ", "Малая ", "Большая ", "Старая ",
    "Новая ", "Главная ", "Центральная ", "Северная ", "Южная ", "Западная ", "Восточная ", "Красная ",
    "Белая ", "Зеленая ", "Синяя ", "Правая ", "Левая ", "Дальняя ", "Ближняя ", "Широкая ",
    "Узкая ", "Прямая ", "Кривая ", "Высокая ", "Низкая ", "Крутая ", "Пологая ", "Горная ",
    "Луговая ", "Лесная ", "Степная ", "Водная ", "Каменная ", "Песчаная ", "Глиняная ", "Золотая ",
    "Серебряная ", "Медная ", "Железная ", "Светлая ", "Темная ", "Чистая ", "Грязная ", "Добрая ",
    "Тихая ", "Шумная ", "Быстрая ", "Медленная ", "Теплая ", "Холодная ", "Весенняя ", "Осенняя "
];

const STREET_SUFS = [
    "Ленина", "Пушкина", "Гагарина", "Мира", "Свободы", "Победы", "Дружбы", "Труда",
    "Маяковского", "Чехова", "Лермонтова", "Горького", "Суворова", "Жукова", "Кутузова", "Королева",
    "Садовая", "Лесная", "Парковая", "Школьная", "Заводская", "Строителей", "Рабочая", "Вокзальная",
    "Железнодорожная", "Набережная", "Степная", "Луговая", "Полевая", "Цветочная", "Вишневая", "Яблоневая",
    "Сиреневая", "Березовая", "Сосновая", "Кленовая", "Рябиновая", "Солнечная", "Звездная", "Лунная",
    "Космическая", "Октябрьская", "Комсомольская", "Пионерская", "Советская", "Молодежная", "Спортивная", "Клубная",
    "Музейная", "Театральная", "Аптечная", "Больничная", "Почтовая", "Рыночная", "Торговая", "Промышленная",
    "Фабричная", "Станционная", "Портовая", "Аэродромная", "Речная", "Озерная", "Морская", "Океанская"
];

// ─── Number ranges ────────────────────────────────────────
const HOUSES = Array.from({ length: 512 }, (_, i) => String(i + 1));
const APARTMENTS = Array.from({ length: 512 }, (_, i) => String(i + 1));

// ─── Abbreviation variants (each encodes 1 bit) ───────────
const ABBR_CITY = ["г.", "город"];
const ABBR_STREET = ["ул.", "улица"];
const ABBR_HOUSE = ["д.", "дом"];
const ABBR_APPT = ["кв.", "квартира"];

// ─── Build city lookup maps (cartesian product, collision-safe) ──
const CITY_MAP = {};       // cityName → flatIndex
const CITY_BY_INDEX = [];  // flatIndex → cityName
for (let p = 0; p < CITY_PREFS.length; p++) {
    for (let s = 0; s < CITY_SUFS.length; s++) {
        const flatIdx = p * CITY_SUFS.length + s;
        let name = CITY_PREFS[p] + CITY_SUFS[s];
        if (CITY_MAP[name] !== undefined) {
            name = name + '-' + s;
        }
        CITY_MAP[name] = flatIdx;
        CITY_BY_INDEX[flatIdx] = name;
    }
}

// ─── Build street lookup maps (cartesian product, collision-safe) ─
const STREET_MAP = {};       // streetName → flatIndex
const STREET_BY_INDEX = [];  // flatIndex → streetName
for (let p = 0; p < STREET_PREFS.length; p++) {
    for (let s = 0; s < STREET_SUFS.length; s++) {
        const flatIdx = p * STREET_SUFS.length + s;
        let name = STREET_PREFS[p] + STREET_SUFS[s];
        if (STREET_MAP[name] !== undefined) {
            name = name + '-' + s;
        }
        STREET_MAP[name] = flatIdx;
        STREET_BY_INDEX[flatIdx] = name;
    }
}

// ─── Mixed-radix dimension arrays ─────────────────────────
const ADDR_DIMS = [REGIONS, CITY_PREFS, CITY_SUFS, STREET_PREFS, STREET_SUFS,
    HOUSES, APARTMENTS, ABBR_CITY, ABBR_STREET, ABBR_HOUSE, ABBR_APPT];

// ─── Escape helper for regex ──────────────────────────────
function _esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ─── Build detection regex ────────────────────────────────
// Matches: REGION, [г./город] CITY, [ул./улица] STREET, [д./дом] NUMBER[, [кв./квартира] NUMBER]
const _REGION_PAT = REGIONS.map(_esc).join('|');
// NOTE: \w does NOT match Cyrillic in JavaScript (only [a-zA-Z0-9_]).
// We must use explicit character classes to match Russian city/street names.
//
// Using [^,]+? (non-comma chars) for city/street names is BOTH fast and correct:
// - Fast: no catastrophic backtracking (no \s in character class with 64 region alternatives)
// - Correct: city and street names never contain commas, so [^,]+ captures them fully
// - Multi-word names like "Белая Яблоневая" are handled (spaces are not commas)
const ADDR_DETECT_REGEX = new RegExp(
    '(' + _REGION_PAT + ')' +
    ',\\s*' +                     // comma after region
    '(г\\.\\s*|город\\s+)' +
    '([^,]+?)' +                 // city: everything up to comma (non-greedy)
    ',\\s*' +
    '(ул\\.\\s*|улица\\s+)' +
    '([^,]+?)' +                 // street: everything up to comma (non-greedy)
    ',\\s*' +
    '(д\\.\\s*|дом\\s+)' +
    '(\\d{1,3})' +
    '(?:,\\s*(кв\\.\\s*|квартира\\s+)(\\d{1,3}))?',
    'g'
);

const TAG_REGEX = /\[steg-address\]/g;

export class AddressesChannel {
    constructor() {
        this.name = 'addresses';
        this.loaded = true;
        this._isTagBased = true;
        this._selfTest();
    }

    // ─── Self-test ────────────────────────────────────────
    _selfTest() {
        try {
            // Test with max indices
            const maxIndices = ADDR_DIMS.map(d => d.length - 1);
            const encoded = this._buildAddress(maxIndices);
            const parsed = this._parseAddressLine(encoded);
            if (!parsed) {
                console.error('[addresses] Self-test FAILED: could not parse own max-indices address:', encoded);
                return;
            }
            if (JSON.stringify(parsed.indices) !== JSON.stringify(maxIndices)) {
                console.error('[addresses] Self-test FAILED (max): expected', JSON.stringify(maxIndices), 'got', JSON.stringify(parsed.indices));
                return;
            }

            // Test with zeros (no apartment)
            const zeros = ADDR_DIMS.map(() => 0);
            const enc0 = this._buildAddress(zeros);
            const par0 = this._parseAddressLine(enc0);
            if (!par0) {
                console.error('[addresses] Self-test FAILED: could not parse own zero address:', enc0);
                return;
            }
            if (JSON.stringify(par0.indices) !== JSON.stringify(zeros)) {
                console.error('[addresses] Self-test FAILED (zeros): expected', JSON.stringify(zeros), 'got', JSON.stringify(par0.indices));
                return;
            }
            // Verify no apartment in zero-address
            if (enc0.includes('кв') || enc0.includes('квартира')) {
                console.error('[addresses] Self-test FAILED: zero address should have no apartment');
                return;
            }

            // Test with apartment present (index 42)
            const mid = ADDR_DIMS.map((d, i) => i === 6 ? 42 : Math.floor(d.length / 2));
            const encMid = this._buildAddress(mid);
            const parMid = this._parseAddressLine(encMid);
            if (!parMid) {
                console.error('[addresses] Self-test FAILED: could not parse own mid address:', encMid);
                return;
            }
            if (JSON.stringify(parMid.indices) !== JSON.stringify(mid)) {
                console.error('[addresses] Self-test FAILED (mid): expected', JSON.stringify(mid), 'got', JSON.stringify(parMid.indices));
                return;
            }
            if (!encMid.includes('кв') && !encMid.includes('квартира')) {
                console.error('[addresses] Self-test FAILED: mid address should have apartment');
                return;
            }

            // Roundtrip: encode tags → decode
            const testText = 'Текст с адресом: [steg-address] и ещё один [steg-address].';
            const cap = this.analyzeCapacity(testText);
            if (cap.bases.length !== 22) { // 2 tags × 11 dims
                console.error('[addresses] Self-test FAILED (capacity): expected 22 bases, got', cap.bases.length);
                return;
            }

            // Encode with some indices and decode back
            const testIndices = [];
            for (let t = 0; t < 2; t++) {
                for (let d = 0; d < 11; d++) {
                    testIndices.push((t * 11 + d * 7 + 3) % ADDR_DIMS[d].length);
                }
            }
            const encRt = this.encode(testText, testIndices);
            const decoded = this.decode(encRt);
            if (JSON.stringify(decoded) !== JSON.stringify(testIndices)) {
                console.error('[addresses] Self-test FAILED (roundtrip): expected', JSON.stringify(testIndices), 'got', JSON.stringify(decoded));
                return;
            }

            console.log('[addresses] Self-test PASSED ✓');
        } catch (e) {
            console.error('[addresses] Self-test ERROR:', e);
        }
    }

    // ─── Build address string from indices ──────────────────
    _buildAddress(indices) {
        const regionIdx = indices[0];
        const cityPrefIdx = indices[1];
        const citySuffIdx = indices[2];
        const streetPrefIdx = indices[3];
        const streetSuffIdx = indices[4];
        const houseIdx = indices[5];
        const apptIdx = indices[6];
        const cityAbbrIdx = indices[7];
        const streetAbbrIdx = indices[8];
        const houseAbbrIdx = indices[9];
        const apptAbbrIdx = indices[10];

        const region = REGIONS[regionIdx % REGIONS.length];
        const cityFlatIdx = cityPrefIdx * CITY_SUFS.length + (citySuffIdx % CITY_SUFS.length);
        const city = CITY_BY_INDEX[cityFlatIdx] || 'Неизвестный';
        const streetFlatIdx = streetPrefIdx * STREET_SUFS.length + (streetSuffIdx % STREET_SUFS.length);
        const street = STREET_BY_INDEX[streetFlatIdx] || 'Неизвестная';
        const house = HOUSES[houseIdx % HOUSES.length];
        const appt = APARTMENTS[apptIdx % APARTMENTS.length];
        const cityAbbr = ABBR_CITY[cityAbbrIdx % ABBR_CITY.length];
        const streetAbbr = ABBR_STREET[streetAbbrIdx % ABBR_STREET.length];
        const houseAbbr = ABBR_HOUSE[houseAbbrIdx % ABBR_HOUSE.length];
        const apptAbbr = ABBR_APPT[apptAbbrIdx % ABBR_APPT.length];

        let addr = `${region}, ${cityAbbr} ${city}, ${streetAbbr} ${street}, ${houseAbbr} ${house}`;

        // Apartment: index 0 = no apartment (for naturalness)
        if (apptIdx > 0) {
            addr += `, ${apptAbbr} ${appt}`;
        }

        return addr;
    }

    // ─── Parse an address line back to indices ────────────────
    // Returns { indices, start, end } or null
    _parseAddressLine(line) {
        const savedLastIndex = ADDR_DETECT_REGEX.lastIndex;
        ADDR_DETECT_REGEX.lastIndex = 0;
        const m = ADDR_DETECT_REGEX.exec(line);
        ADDR_DETECT_REGEX.lastIndex = savedLastIndex;
        if (!m) return null;

        const region = m[1].trim();
        const cityAbbrRaw = m[2].trim();
        const cityName = m[3].trim();
        const streetAbbrRaw = m[4].trim();
        const streetName = m[5].trim();
        const houseAbbrRaw = m[6].trim();
        const houseNum = parseInt(m[7], 10);
        const apptAbbrRaw = m[8] ? m[8].trim() : null;
        const apptNum = m[9] ? parseInt(m[9], 10) : null;

        // Verify against dictionaries
        const rIdx = REGIONS.indexOf(region);
        const cFlatIdx = CITY_MAP[cityName];
        const sFlatIdx = STREET_MAP[streetName];

        if (rIdx === -1) return null;
        if (cFlatIdx === undefined) return null;
        if (sFlatIdx === undefined) return null;
        if (houseNum < 1 || houseNum > 512) return null;
        if (apptNum !== null && (apptNum < 1 || apptNum > 512)) return null;

        // Decompose flat indices
        const cityPrefIdx = Math.floor(cFlatIdx / CITY_SUFS.length);
        const citySuffIdx = cFlatIdx % CITY_SUFS.length;
        const streetPrefIdx = Math.floor(sFlatIdx / STREET_SUFS.length);
        const streetSuffIdx = sFlatIdx % STREET_SUFS.length;

        // Abbreviation indices
        const cityAbbrIdx = (cityAbbrRaw === 'г.') ? 0 : 1;
        const streetAbbrIdx = (streetAbbrRaw === 'ул.') ? 0 : 1;
        const houseAbbrIdx = (houseAbbrRaw === 'д.') ? 0 : 1;
        const apptAbbrIdx = apptAbbrRaw ? ((apptAbbrRaw === 'кв.') ? 0 : 1) : 0;
        const apptIdx = apptNum !== null ? apptNum - 1 : 0;

        const indices = [
            rIdx, cityPrefIdx, citySuffIdx,
            streetPrefIdx, streetSuffIdx,
            houseNum - 1, apptIdx,
            cityAbbrIdx, streetAbbrIdx, houseAbbrIdx, apptAbbrIdx
        ];

        return {
            indices,
            start: m.index,
            end: m.index + m[0].length
        };
    }

    // ─── Find tags + generated blocks ─────────────────────
    _findMatches(text) {
        const matches = [];

        // 1. Find tags
        TAG_REGEX.lastIndex = 0;
        let m;
        while ((m = TAG_REGEX.exec(text)) !== null) {
            matches.push({
                start: m.index,
                end: m.index + m[0].length,
                isTag: true,
                full: m[0]
            });
        }

        // 2. Find generated blocks via regex + dictionary verification
        ADDR_DETECT_REGEX.lastIndex = 0;
        while ((m = ADDR_DETECT_REGEX.exec(text)) !== null) {
            // Re-parse properly via _parseAddressLine for full verification
            const line = text.slice(m.index, m.index + m[0].length);
            const parsed = this._parseAddressLine(line);
            if (!parsed) continue;

            // Find line boundaries for span
            const lineStart = text.lastIndexOf('\n', m.index - 1) + 1;
            const lineEnd = text.indexOf('\n', m.index + m[0].length);
            const spanEnd = lineEnd === -1 ? text.length : lineEnd;

            matches.push({
                start: m.index,
                end: m.index + m[0].length,
                spanStart: lineStart,
                spanEnd: spanEnd,
                isTag: false,
                indices: parsed.indices,
                full: text.slice(m.index, m.index + m[0].length)
            });
        }

        // Sort by position and deduplicate
        matches.sort((a, b) => a.start - b.start);
        const deduped = [];
        for (const match of matches) {
            const lastEnd = deduped.length > 0 ? deduped[deduped.length - 1].end : -1;
            if (match.start >= lastEnd) {
                deduped.push(match);
            }
        }
        return deduped;
    }

    // ─── Channel API ────────────────────────────────────────

    analyzeCapacity(text) {
        if (!this.loaded) return { totalBits: 0, positions: [], bases: [] };

        const matches = this._findMatches(text);
        if (matches.length === 0) return { totalBits: 0, positions: [], bases: [] };

        const positions = [];
        const bases = [];

        for (const match of matches) {
            const spanStart = match.spanStart !== undefined ? match.spanStart : match.start;
            const spanEnd = match.spanEnd !== undefined ? match.spanEnd : match.end;
            positions.push({ index: spanStart, length: spanEnd - spanStart, type: 'address' });
            for (const dim of ADDR_DIMS) bases.push(dim.length);
        }

        const totalBits = bases.reduce((s, b) => s + Math.log2(b), 0);
        return { totalBits, positions, bases };
    }

    encode(text, indices) {
        if (!this.loaded || indices.length === 0) return text;

        const matches = this._findMatches(text);
        if (matches.length === 0) return text;

        const replacements = [];
        let idx = 0;
        const dimCount = ADDR_DIMS.length; // 11

        for (const match of matches) {
            if (idx + dimCount > indices.length) break;

            const componentIndices = indices.slice(idx, idx + dimCount);
            const newAddress = this._buildAddress(componentIndices);

            // For pre-existing blocks (non-tag), we need to ensure proper newlines
            let replacement = newAddress;
            if (!match.isTag) {
                // Preserve surrounding whitespace
                const before = text.slice(Math.max(0, match.start - 2), match.start);
                const after = text.slice(match.end, match.end + 2);
                const hasNewlineBefore = before.endsWith('\n');
                if (!hasNewlineBefore && match.start > 0) {
                    replacement = '\n' + replacement;
                }
            }

            replacements.push({
                start: match.isTag ? match.start : (match.spanStart !== undefined ? match.spanStart : match.start),
                end: match.isTag ? match.end : (match.spanEnd !== undefined ? match.spanEnd : match.end),
                replacement
            });
            idx += dimCount;
        }

        // Apply in reverse order to preserve string indices
        let result = text;
        for (let i = replacements.length - 1; i >= 0; i--) {
            const r = replacements[i];
            result = result.slice(0, r.start) + r.replacement + result.slice(r.end);
        }

        return result;
    }

    decode(stegoText) {
        if (!this.loaded) return [];

        const matches = this._findMatches(stegoText);
        const indices = [];

        for (const match of matches) {
            if (match.isTag) continue;
            if (match.indices) {
                indices.push(...match.indices);
            }
        }

        return indices;
    }

    getSpans(text) {
        const matches = this._findMatches(text);
        return matches.map(m => {
            if (m.isTag) {
                return { start: m.start, end: m.end };
            }
            return {
                start: m.spanStart !== undefined ? m.spanStart : m.start,
                end: m.spanEnd !== undefined ? m.spanEnd : m.end
            };
        });
    }

    getStats() {
        return {
            name: this.name,
            loaded: this.loaded,
            dims: ADDR_DIMS.map(d => d.length),
            bitsPerTag: ADDR_DIMS.reduce((s, d) => s + Math.log2(d.length), 0).toFixed(1),
            tag: '[steg-address]',
            detection: 'regex + dictionary verification (CITY_MAP + STREET_MAP)',
            hasOptionalApartment: true,
            abbrVariants: ['г./город', 'ул./улица', 'д./дом', 'кв./квартира']
        };
    }
}

export default AddressesChannel;
