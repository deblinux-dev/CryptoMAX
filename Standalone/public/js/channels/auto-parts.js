/**
 * Канал кодирования через автозапчасти — v2
 *
 * Принцип: находим теги [steg-auto-*] в тексте и заменяем на процедурно
 * сгенерированные описания автозапчастей. Индексы кодируются в маркере
 * через mixed-radix base-36 — парсинг человекочитаемого текста НЕ нужен.
 *
 * Типы компонентов (алиасы):
 *   [steg-auto-engine]  — Двигатель
 *   [steg-auto-spark]   — Свеча зажигания
 *   [steg-auto-filter]  — Фильтр
 *   [steg-auto-paint]   — Автомобильная краска
 *   [steg-auto-tire]    — Шина
 *   [steg-auto-battery] — Аккумулятор
 */

// ─── Engine ─────────────────────────────────────────────────
const ENG_BRANDS = ["VAG","Toyota","Honda","Ford","BMW","Mercedes","Nissan","Mazda","Hyundai","Kia","Chevrolet","Mitsubishi","Subaru","Renault","Peugeot","Citroen"];
const ENG_DISP = ["1.0","1.2","1.3","1.4","1.5","1.6","1.8","2.0","2.2","2.4","2.5","2.7","3.0","3.2","3.5","3.8","4.0","4.4","4.7","5.0","5.2","5.7","6.0","6.2","6.5","7.0"];
const ENG_FUEL = ["Бензин","Дизель","Гибрид","Электро","Газ","Turbo Бензин","Biturbo Дизель"];
const ENG_HP = ["75-90 л.с.","90-110 л.с.","110-130 л.с.","130-150 л.с.","150-180 л.с.","180-200 л.с.","200-250 л.с.","250-300 л.с.","300-350 л.с.","350-400 л.с.","400-500 л.с.","500+ л.с."];

// ─── Spark Plugs ───────────────────────────────────────────
const SPK_BRANDS = ["Bosch","NGK","Denso","Champion","Beru"];
const SPK_PREFIXES = ["0-242","0-241","0-250","0-261","BKR","BPR","BCPR","DCPR","DPR","ILZFR","ILZKR","SILZKR","K20","IK20","IK16","VK20","VKH20","RC","RN","RE","RS","Z","UX","UXF","14"];
const SPK_HEAT = Array.from({length: 27}, (_, i) => String(i + 4));
const SPK_SUFFIXES = ["","E","ES","GP","GS","IX","EIX","TT","S","P","Y","YC","MC","SB","-SB","-SB0","R-U","PR-U","HR-U","TT-4","A-SB","R-SB8"];

// ─── Filters ───────────────────────────────────────────────
const FLT_BRANDS = ["Mann-Filter","Bosch","Mahle","Hengst","Filtron","Knecht","Blue Print","SCT","Goodwill","Masuma"];
const FLT_TYPE = ["Масляный","Воздушный","Топливный","Салонный"];
const FLT_PREFIXES = ["HU","W","WP","WD","H","C","CF","CU","CUK","WK","WK/2","PU","PL","E","OP","AP","K","LA","LAK","FP"];
const FLT_SERIES = Array.from({length: 500}, (_, i) => String(i + 100));

// ─── Paint ─────────────────────────────────────────────────
const PNT_BRANDS = ["Toyota","VAG","BMW","Mercedes-Benz","Ford","Honda","Mazda","Nissan","Hyundai","Kia","Chevrolet","Volvo","Lexus","Audi","Porsche","Subaru"];
const PNT_CODES = ["040","058","1C0","1F7","3P0","6Q1","8P4","LA7W","LC9A","LY7W","LZ7S","300","668","B39","C07","C24","149","650","787","904","M7","G1","EB","K3","UA","NH-0","NH-578","R-81","25D","34K","39A","QAB","QAC","K23","KY0"];
const PNT_NAMES = ["Белый","Серебристый","Серый","Чёрный","Синий","Красный","Коричневый","Бежевый","Зелёный","Жёлтый","Оранжевый","Перламутровый","Графитовый","Тёмно-синий","Бордовый","Металлик","Перламутровый металлик","Ночной","Фирменный синий","Лунный серебристый"];
const PNT_KIND = ["Металлик","Перламутр","Матовый","Акрил","Меламин","Уретан","Эмаль"];

// ─── Tires ─────────────────────────────────────────────────
const TRD_BRANDS = ["Michelin","Continental","Pirelli","Goodyear","Bridgestone","Hankook","Nokian","Nexen","Kumho","Yokohama","Dunlop","Toyo","Falken","Maxxis","Cordiant","Viatti"];
const TRD_WIDTH = ["145","155","165","175","185","195","205","215","225","235","245","255","265","275","285","295","305","315","325"];
const TRD_PROFILE = ["30","35","40","45","50","55","60","65","70","75","80"];
const TRD_DIAM = ["R12","R13","R14","R15","R16","R17","R18","R19","R20","R21","R22"];

// ─── Battery ───────────────────────────────────────────────
const BAT_BRANDS = ["Varta","Bosch","Mutlu","Exide","Yuasa","Banner","Moll","Centra","Atlas","Delkor"];
const BAT_CAPS = ["40Ah","45Ah","50Ah","55Ah","60Ah","65Ah","70Ah","75Ah","80Ah","85Ah","90Ah","95Ah","100Ah","110Ah","120Ah","130Ah","140Ah","150Ah","160Ah","180Ah","200Ah"];
const BAT_VOLT = ["12V","24V","36V","48V","60V","72V"];
const BAT_KIND = ["AGM","GEL","EFB","Li-Ion","LiFePO4","Свинцово-кислотная","Ca-Ca","Гибридная"];

// ─── Component Type Registry ────────────────────────────────
const AUTO_TYPES = {
    engine: { dims: [ENG_BRANDS, ENG_DISP, ENG_FUEL, ENG_HP], marker: 'ENG', format: (v) => `${v[0]} ${v[1]}L ${v[2]} ${v[3]}` },
    spark: { dims: [SPK_BRANDS, SPK_PREFIXES, SPK_HEAT, SPK_SUFFIXES], marker: 'SPK', format: (v) => `${v[0]} ${v[1]}${v[2]}${v[3]}` },
    filter: { dims: [FLT_BRANDS, FLT_TYPE, FLT_PREFIXES, FLT_SERIES], marker: 'FLT', format: (v) => `${v[0]} ${v[1]} ${v[2]}${v[3]}` },
    paint: { dims: [PNT_BRANDS, PNT_CODES, PNT_NAMES, PNT_KIND], marker: 'PNT', format: (v) => `${v[0]} ${v[1]} ${v[2]} (${v[3]})` },
    tire: { dims: [TRD_BRANDS, TRD_WIDTH, TRD_PROFILE, TRD_DIAM], marker: 'TRD', format: (v) => `${v[0]} ${v[1]}/${v[2]} ${v[3]}` },
    battery: { dims: [BAT_BRANDS, BAT_CAPS, BAT_VOLT, BAT_KIND], marker: 'BAT', format: (v) => `${v[0]} ${v[1]} ${v[2]} ${v[3]}` }
};

export class AutoPartsChannel {
    constructor() {
        this.name = 'auto-parts';
        this.loaded = true;
        this._isTagBased = true;
        this.TAG_REGEX = /\[steg-auto-(engine|spark|filter|paint|tire|battery)\]/g;
        this.DETECT_REGEX = /(?:ENG|SPK|FLT|PNT|TRD|BAT)-[A-Z0-9]{4}/g;
        this._selfTest();
    }

    _selfTest() {
        try {
            for (const [typeKey, type] of Object.entries(AUTO_TYPES)) {
                const maxIndices = type.dims.map(d => d.length - 1);
                const code = this._encodeIndices(maxIndices, type.dims);
                const decoded = this._decodeIndices(code, type.dims);
                if (!decoded || JSON.stringify(decoded) !== JSON.stringify(maxIndices)) {
                    console.error(`[auto-parts] Self-test FAILED for ${typeKey}`); continue;
                }
                const zeros = type.dims.map(() => 0);
                const code0 = this._encodeIndices(zeros, type.dims);
                const decoded0 = this._decodeIndices(code0, type.dims);
                if (!decoded0 || JSON.stringify(decoded0) !== JSON.stringify(zeros)) {
                    console.error(`[auto-parts] Self-test FAILED for ${typeKey} (zeros)`); continue;
                }
            }
            console.log('[auto-parts] Self-test PASSED ✓');
        } catch (e) { console.error('[auto-parts] Self-test ERROR:', e); }
    }

    // ─── Mixed-radix index encoding ───────────────────────
    _encodeIndices(indices, dims) {
        let value = 0n;
        let base = 1n;
        for (let i = indices.length - 1; i >= 0; i--) {
            value += BigInt(indices[i]) * base;
            base *= BigInt(dims[i].length);
        }
        return value.toString(36).toUpperCase().padStart(4, '0');
    }

    _decodeIndices(code, dims) {
        const parsed = parseInt(code, 36);
        if (isNaN(parsed)) return null;
        let value = BigInt(parsed);
        const indices = [];
        for (let i = dims.length - 1; i >= 0; i--) {
            const base = BigInt(dims[i].length);
            indices.unshift(Number(value % base));
            value = value / base;
        }
        if (value > 0n) return null;
        return indices;
    }

    // ─── Find tags + generated blocks ─────────────────────
    _findMatches(text) {
        const matches = [];
        this.TAG_REGEX.lastIndex = 0;
        let m;
        while ((m = this.TAG_REGEX.exec(text)) !== null) {
            const typeKey = m[1];
            const type = AUTO_TYPES[typeKey];
            if (!type) continue;
            matches.push({ index: m.index, length: m[0].length, typeKey, marker: type.marker, full: m[0], isTag: true });
        }
        this.DETECT_REGEX.lastIndex = 0;
        while ((m = this.DETECT_REGEX.exec(text)) !== null) {
            const markerStr = m[0];
            const dashIdx = markerStr.indexOf('-');
            if (dashIdx === -1) continue;
            const marker = markerStr.substring(0, dashIdx);
            const code = markerStr.substring(dashIdx + 1);
            const typeKey = Object.keys(AUTO_TYPES).find(k => AUTO_TYPES[k].marker === marker);
            if (!typeKey) continue;
            if (m.index > 0 && text[m.index - 1] === '[') continue;
            if (m.index > 0 && /[A-Za-z0-9_]/.test(text[m.index - 1])) continue;
            matches.push({ index: m.index, length: m[0].length, typeKey, marker, code, full: m[0], isTag: false });
        }
        matches.sort((a, b) => a.index - b.index);
        return matches;
    }

    _buildComponent(typeKey, indices) {
        const type = AUTO_TYPES[typeKey];
        const vals = type.dims.map((dim, i) => dim[indices[i] % dim.length]);
        const text = type.format(vals);
        const code = this._encodeIndices(indices, type.dims);
        return `${text} ${type.marker}-${code}`;
    }

    analyzeCapacity(text) {
        if (!this.loaded) return { totalBits: 0, positions: [], bases: [] };
        const matches = this._findMatches(text);
        if (matches.length === 0) return { totalBits: 0, positions: [], bases: [] };
        const positions = [];
        const bases = [];
        for (const match of matches) {
            const type = AUTO_TYPES[match.typeKey];
            if (!type) continue;
            positions.push({ index: match.index, length: match.length, type: match.typeKey, word: match.full });
            for (const dim of type.dims) bases.push(dim.length);
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
        for (const match of matches) {
            const type = AUTO_TYPES[match.typeKey];
            if (!type) continue;
            const dimCount = type.dims.length;
            if (idx + dimCount > indices.length) break;
            const newComponent = this._buildComponent(match.typeKey, indices.slice(idx, idx + dimCount));
            replacements.push({ index: match.index, length: match.length, replacement: newComponent });
            idx += dimCount;
        }
        let result = text;
        for (let i = replacements.length - 1; i >= 0; i--) {
            const r = replacements[i];
            result = result.slice(0, r.index) + r.replacement + result.slice(r.index + r.length);
        }
        return result;
    }

    decode(stegoText) {
        if (!this.loaded) return [];
        const matches = this._findMatches(stegoText);
        const indices = [];
        for (const match of matches) {
            if (match.isTag) continue;
            const type = AUTO_TYPES[match.typeKey];
            if (!type) continue;
            const parsed = this._decodeIndices(match.code, type.dims);
            if (parsed) {
                indices.push(...parsed);
            } else {
                console.warn(`[auto-parts] Decode failed for ${match.marker}-${match.code} (${match.typeKey}): value out of range. Text may be from an older version — please re-encode.`);
            }
        }
        return indices;
    }

    getSpans(text) {
        const matches = this._findMatches(text);
        return matches.map(m => {
            if (m.isTag) {
                return { start: m.index, end: m.index + m.length };
            }
            const lineStart = text.lastIndexOf('\n', m.index - 1) + 1;
            const lineEnd = text.indexOf('\n', m.index + m.length);
            return { start: lineStart, end: lineEnd === -1 ? text.length : lineEnd };
        });
    }

    getStats() {
        const typeStats = {};
        for (const [k, v] of Object.entries(AUTO_TYPES)) {
            typeStats[k] = {
                dims: v.dims.map(d => d.length),
                bits: v.dims.reduce((s, d) => s + Math.log2(d.length), 0).toFixed(1)
            };
        }
        return { name: this.name, loaded: this.loaded, types: typeStats };
    }
}

export default AutoPartsChannel;
