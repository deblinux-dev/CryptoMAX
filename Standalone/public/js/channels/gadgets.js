/**
 * Канал кодирования через гаджеты — v2
 *
 * Принцип: находим теги [steg-gadget-*] в тексте и заменяем на процедурно
 * сгенерированные описания мобильных устройств. Индексы кодируются в маркере
 * через mixed-radix base-36 — парсинг человекочитаемого текста НЕ нужен.
 *
 * Типы компонентов (алиасы):
 *   [steg-gadget-phone]      — Смартфон
 *   [steg-gadget-tablet]     — Планшет
 *   [steg-gadget-laptop]     — Ноутбук
 *   [steg-gadget-headphones] — Наушники
 *   [steg-gadget-watch]      — Умные часы
 *   [steg-gadget-camera]     — Камера
 */

// ─── Smartphones ───────────────────────────────────────────
const PHN_MODELS = [
    "iPhone 13","iPhone 13 mini","iPhone 13 Pro","iPhone 13 Pro Max",
    "iPhone 14","iPhone 14 Plus","iPhone 14 Pro","iPhone 14 Pro Max",
    "iPhone 15","iPhone 15 Plus","iPhone 15 Pro","iPhone 15 Pro Max",
    "iPhone 16","iPhone 16 Plus","iPhone 16 Pro","iPhone 16 Pro Max",
    "Samsung Galaxy S22","Samsung Galaxy S22 Ultra","Samsung Galaxy S23","Samsung Galaxy S23 Ultra",
    "Samsung Galaxy S24","Samsung Galaxy S24 Ultra","Samsung Galaxy S24 FE",
    "Samsung Galaxy Z Flip 5","Samsung Galaxy Z Fold 5","Samsung Galaxy Z Flip 6","Samsung Galaxy Z Fold 6",
    "Google Pixel 7","Google Pixel 7 Pro","Google Pixel 8","Google Pixel 8 Pro","Google Pixel 9","Google Pixel 9 Pro",
    "Xiaomi 13","Xiaomi 13 Pro","Xiaomi 14","Xiaomi 14 Ultra",
    "OnePlus 11","OnePlus 12","Nothing Phone 2","Nothing Phone 2a"
];
const PHN_STORAGE = ["64GB","128GB","256GB","512GB","1TB"];
const PHN_COLORS = ["Чёрный","Белый","Синий","Красный","Зелёный","Фиолетовый","Розовый","Золотой","Серый","Бежевый","Graphite","Titanium","Midnight","Starlight","Sierra Blue","Alpine Green","Lavender","Cream","Phantom Black","Green"];
const PHN_RAM = ["4GB","6GB","8GB","12GB","16GB"];

// ─── Tablets ───────────────────────────────────────────────
const TBT_MODELS = [
    "iPad Air","iPad Pro 11\"","iPad Pro 12.9\"","iPad 10th gen","iPad mini 6",
    "Samsung Galaxy Tab S8","Samsung Galaxy Tab S9","Samsung Galaxy Tab S9 FE","Samsung Galaxy Tab A9",
    "Xiaomi Pad 6","Xiaomi Pad 6 Pro","Xiaomi Pad 6 Max",
    "Lenovo Tab P12 Pro","Lenovo Tab P11 Pro","Lenovo Tab M11",
    "Google Pixel Tablet","Huawei MatePad Pro","Microsoft Surface Pro 9","Microsoft Surface Go 3",
    "Sony Xperia Tablet Z","ASUS ZenPad S8","OnePlus Pad"
];
const TBT_STORAGE = ["64GB","128GB","256GB","512GB","1TB"];
const TBT_SCREEN = ['8"','8.3"','8.4"','10.1"','10.4"','10.5"','10.9"','11"','12.4"','12.9"','13"','14.1"'];
const TBT_CONN = ["Wi-Fi","Wi-Fi + Cellular","Wi-Fi + 5G","LTE"];

// ─── Laptops ───────────────────────────────────────────────
const LPT_MODELS = [
    "MacBook Air M2","MacBook Air M3","MacBook Pro 14\" M3","MacBook Pro 16\" M3 Pro","MacBook Pro 14\" M3 Max",
    "Dell XPS 13","Dell XPS 15","Dell Inspiron 15","Dell Latitude 14",
    "Lenovo ThinkPad X1 Carbon","Lenovo ThinkPad T14","Lenovo IdeaPad 5","Lenovo Yoga 7",
    "HP Pavilion 15","HP EliteBook 840","HP Spectre x360",
    "ASUS ZenBook 14","ASUS ROG Strix G16","ASUS VivoBook 15",
    "Acer Swift 3","Acer Aspire 5","Acer Predator Helios 16",
    "MSI Katana 15","MSI Prestige 14"
];
const LPT_CPU = ["i3-1215U","i5-1235U","i5-1340P","i7-1355U","i7-13700H","i9-13900H","Ryzen 5 5500U","Ryzen 5 5600H","Ryzen 7 6800H","Ryzen 7 7840HS","Ryzen 9 7945HX","Apple M2","Apple M3","Apple M3 Pro","Apple M3 Max"];
const LPT_RAM = ["8GB","16GB","32GB","64GB"];
const LPT_STORAGE = ["256GB SSD","512GB SSD","1TB SSD","2TB SSD","256GB NVMe","512GB NVMe","1TB NVMe","2TB NVMe"];

// ─── Headphones ────────────────────────────────────────────
const HPH_BRANDS = ["Sony","Sennheiser","Bose","JBL","Jabra","HyperX","SteelSeries","Logitech","Razer","Audio-Technica","Beyerdynamic","AKG","Beats","Samsung","Apple AirPods","Huawei FreeBuds","Xiaomi","Nothing","Marshall","JBL Tune"];
const HPH_MODELS = ["WH-1000XM5","WH-1000XM4","HD 660S","HD 600","Momentum 4","QuietComfort 45","QuietComfort Ultra","Tune 770NC","Elite 85t","Cloud III","Arctis Nova Pro","G Pro X 2","BlackShark V2","GSP 670","ATH-M50x","DT 990 Pro","K371","Studio3","FreeBuds Pro 3","Nothing Ear 2","Indy Evo","Major IV","Stockwell II","Live 770NC"];
const HPH_TYPE = ["Проводные","Bluetooth","2.4GHz беспроводные","USB-C","Проводные + Bluetooth","TWS"];
const HPH_DRIVER = ["30mm","40mm","50mm","53mm","Dynamic","Planar Magnetic","Electret","Balanced Armature"];

// ─── Smartwatches ──────────────────────────────────────────
const WCH_MODELS = [
    "Apple Watch Ultra 2","Apple Watch Series 9","Apple Watch SE 2",
    "Samsung Galaxy Watch 6","Samsung Galaxy Watch 6 Classic",
    "Google Pixel Watch 2",
    "Huawei Watch GT 4","Huawei Watch 4 Pro",
    "Xiaomi Watch S3 Active","Xiaomi Watch 2 Pro",
    "Garmin Venu 3","Garmin Forerunner 265",
    "Amazfit GTR 4","Amazfit GTS 4",
    "OnePlus Watch 2","Nothing Watch",
    "TicWatch Pro 5","Mobvoi TicWatch E3",
    "Realme Watch","Honor Watch 4"
];
const WCH_SIZE = ["38mm","40mm","41mm","42mm","44mm","45mm","46mm","47mm","49mm"];
const WCH_BAND = ["Силикон","Нержавеющая сталь","Титан","Алюминий","Нейлон","Кожа","Фторкаучук"];
const WCH_FEAT = ["GPS","GPS + LTE","GPS + NFC","GPS + LTE + NFC","Базовые","Спортивные","Классические"];

// ─── Cameras ───────────────────────────────────────────────
const CAM_MODELS = [
    "Canon EOS R6 Mark II","Canon EOS R5","Canon EOS R50",
    "Sony A7 IV","Sony A7R V","Sony A6700","Sony ZV-E1",
    "Nikon Z6 III","Nikon Z8","Nikon Z50 II",
    "Fujifilm X-T5","Fujifilm X-S20","Fujifilm X100VI",
    "Panasonic Lumix S5 II","Panasonic Lumix GH6",
    "Leica Q3","Leica M11",
    "OM System OM-1 Mark II","Hasselblad X2D 100C",
    "DJI Pocket 3","GoPro Hero 12","Insta360 X4"
];
const CAM_RES = ["12MP","20MP","24MP","26MP","30MP","33MP","45MP","50MP","61MP","100MP"];
const CAM_LENS = ["Kit 18-55mm","Kit 28-70mm","24-70mm f/2.8","70-200mm f/2.8","50mm f/1.4","35mm f/1.8","85mm f/1.8","24-105mm f/4","Fixed","Prime 28mm","Superzoom","Ultrawide 16mm"];
const CAM_FMT = ["Full Frame","APS-C","MFT","APS-H","Medium Format",'1" сенсор',"Action Cam"];

// ─── Component Type Registry ────────────────────────────────
const GADGET_TYPES = {
    phone: { dims: [PHN_MODELS, PHN_STORAGE, PHN_COLORS, PHN_RAM], marker: 'PHN', format: (v) => `${v[0]} ${v[1]} ${v[2]} / ${v[3]} RAM` },
    tablet: { dims: [TBT_MODELS, TBT_STORAGE, TBT_SCREEN, TBT_CONN], marker: 'TBT', format: (v) => `${v[0]} ${v[1]} ${v[2]}, ${v[3]}` },
    laptop: { dims: [LPT_MODELS, LPT_CPU, LPT_RAM, LPT_STORAGE], marker: 'LPT', format: (v) => `${v[0]} ${v[1]} / ${v[2]} / ${v[3]}` },
    headphones: { dims: [HPH_BRANDS, HPH_MODELS, HPH_TYPE, HPH_DRIVER], marker: 'HPH', format: (v) => `${v[0]} ${v[1]}, ${v[2]}, ${v[3]}` },
    watch: { dims: [WCH_MODELS, WCH_SIZE, WCH_BAND, WCH_FEAT], marker: 'WCH', format: (v) => `${v[0]} ${v[1]}, ${v[2]}, ${v[3]}` },
    camera: { dims: [CAM_MODELS, CAM_RES, CAM_LENS, CAM_FMT], marker: 'CAM', format: (v) => `${v[0]} ${v[1]} ${v[2]}, ${v[3]}` }
};

export class GadgetsChannel {
    constructor() {
        this.name = 'gadgets';
        this.loaded = true;
        this._isTagBased = true;
        this.TAG_REGEX = /\[steg-gadget-(phone|tablet|laptop|headphones|watch|camera)\]/g;
        this.DETECT_REGEX = /(?:PHN|TBT|LPT|HPH|WCH|CAM)-[A-Z0-9]{4}/g;
        this._selfTest();
    }

    _selfTest() {
        try {
            for (const [typeKey, type] of Object.entries(GADGET_TYPES)) {
                const maxIndices = type.dims.map(d => d.length - 1);
                const code = this._encodeIndices(maxIndices, type.dims);
                const decoded = this._decodeIndices(code, type.dims);
                if (!decoded || JSON.stringify(decoded) !== JSON.stringify(maxIndices)) {
                    console.error(`[gadgets] Self-test FAILED for ${typeKey}`); continue;
                }
                const zeros = type.dims.map(() => 0);
                const code0 = this._encodeIndices(zeros, type.dims);
                const decoded0 = this._decodeIndices(code0, type.dims);
                if (!decoded0 || JSON.stringify(decoded0) !== JSON.stringify(zeros)) {
                    console.error(`[gadgets] Self-test FAILED for ${typeKey} (zeros)`); continue;
                }
            }
            console.log('[gadgets] Self-test PASSED ✓');
        } catch (e) { console.error('[gadgets] Self-test ERROR:', e); }
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
            const type = GADGET_TYPES[typeKey];
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
            const typeKey = Object.keys(GADGET_TYPES).find(k => GADGET_TYPES[k].marker === marker);
            if (!typeKey) continue;
            if (m.index > 0 && text[m.index - 1] === '[') continue;
            if (m.index > 0 && /[A-Za-z0-9_]/.test(text[m.index - 1])) continue;
            matches.push({ index: m.index, length: m[0].length, typeKey, marker, code, full: m[0], isTag: false });
        }
        matches.sort((a, b) => a.index - b.index);
        return matches;
    }

    _buildComponent(typeKey, indices) {
        const type = GADGET_TYPES[typeKey];
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
            const type = GADGET_TYPES[match.typeKey];
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
            const type = GADGET_TYPES[match.typeKey];
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
            const type = GADGET_TYPES[match.typeKey];
            if (!type) continue;
            const parsed = this._decodeIndices(match.code, type.dims);
            if (parsed) {
                indices.push(...parsed);
            } else {
                console.warn(`[gadgets] Decode failed for ${match.marker}-${match.code} (${match.typeKey}): value out of range. Text may be from an older version — please re-encode.`);
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
        for (const [k, v] of Object.entries(GADGET_TYPES)) {
            typeStats[k] = {
                dims: v.dims.map(d => d.length),
                bits: v.dims.reduce((s, d) => s + Math.log2(d.length), 0).toFixed(1)
            };
        }
        return { name: this.name, loaded: this.loaded, types: typeStats };
    }
}

export default GadgetsChannel;
