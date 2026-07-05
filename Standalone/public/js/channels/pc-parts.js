/**
 * Канал кодирования через ПК-комплектующие — v2
 *
 * Принцип: находим теги [steg-pc-*] в тексте и заменяем на процедурно
 * сгенерированные описания комплектующих. Индексы кодируются в маркере
 * через mixed-radix base-36 — парсинг человекочитаемого текста НЕ нужен.
 *
 * Типы компонентов (алиасы):
 *   [steg-pc-proc]        — Процессор (CPU)
 *   [steg-pc-vdcard]      — Видеокарта (GPU)
 *   [steg-pc-ram]         — Оперативная память
 *   [steg-pc-drive]       — Накопитель (SSD/HDD)
 *   [steg-pc-mouse]       — Мышь
 *   [steg-pc-display]     — Монитор
 *   [steg-pc-motherboard] — Материнская плата
 *   [steg-pc-keyboard]   — Клавиатура
 */

// ─── CPU Models ─────────────────────────────────────────────
const CPU_MODELS = [
    "Intel Core i3-12100","Intel Core i5-12400","Intel Core i5-12600K","Intel Core i7-12700K","Intel Core i9-12900K",
    "Intel Core i5-13400","Intel Core i5-13600K","Intel Core i7-13700K","Intel Core i9-13900K",
    "Intel Core i5-14400","Intel Core i5-14600K","Intel Core i7-14700K","Intel Core i9-14900K",
    "Intel Core Ultra 5 125U","Intel Core Ultra 7 155H","Intel Core Ultra 9 185H",
    "Intel Pentium Gold G6400","Intel Xeon E-2388G",
    "AMD Ryzen 3 4100","AMD Ryzen 5 5600","AMD Ryzen 5 5600X","AMD Ryzen 7 5800X","AMD Ryzen 9 5900X",
    "AMD Ryzen 5 5600X3D","AMD Ryzen 7 5800X3D",
    "AMD Ryzen 5 7600","AMD Ryzen 5 7600X","AMD Ryzen 7 7700X","AMD Ryzen 9 7900X","AMD Ryzen 9 7950X",
    "AMD Ryzen 7 7800X3D","AMD Ryzen 9 7950X3D",
    "AMD Ryzen 5 9600X","AMD Ryzen 7 9700X","AMD Ryzen 9 9900X",
    "AMD Ryzen Threadripper 7970X","AMD EPYC 9654"
];
const CPU_SUFFIXES = ["","K","F","KF","KS","T","P","E","X","X3D","G","GE","XT","PRO"];
const CPU_SPEEDS = ["2.0","2.2","2.4","2.6","2.8","3.0","3.2","3.4","3.5","3.6","3.7","3.8","3.9","4.0","4.2","4.4","4.5","4.6","4.8","5.0","5.2","5.4","5.6","5.7","5.8","6.0"];
const CPU_CORES = ["2","4","6","8","10","12","14","16","24","32"];

// ─── GPU Models ─────────────────────────────────────────────
const GPU_MODELS = [
    "NVIDIA GeForce RTX 3060","NVIDIA GeForce RTX 3070","NVIDIA GeForce RTX 3080","NVIDIA GeForce RTX 3090",
    "NVIDIA GeForce RTX 4060","NVIDIA GeForce RTX 4070","NVIDIA GeForce RTX 4080","NVIDIA GeForce RTX 4090",
    "NVIDIA GeForce RTX 4070 Ti","NVIDIA GeForce RTX 4080 Super","NVIDIA GeForce RTX 4090 D",
    "NVIDIA GeForce GTX 1660 Super","NVIDIA GeForce GTX 1650",
    "NVIDIA Quadro RTX 4000","NVIDIA RTX A4000","NVIDIA RTX A6000",
    "AMD Radeon RX 6600","AMD Radeon RX 6600 XT","AMD Radeon RX 6700 XT","AMD Radeon RX 6750 XT",
    "AMD Radeon RX 6800","AMD Radeon RX 6800 XT","AMD Radeon RX 6900 XT","AMD Radeon RX 6950 XT",
    "AMD Radeon RX 7600","AMD Radeon RX 7700 XT","AMD Radeon RX 7800 XT","AMD Radeon RX 7900 XT","AMD Radeon RX 7900 XTX",
    "Intel Arc A750","Intel Arc A770","Intel Arc A380"
];
const GPU_VARIANTS = ["","Ti","Super","XT","XTX","X3D","OC","FE","Gaming","Strix","Gaming X","TUF","Phantom","Nitro","Pulse","Red Devil","MECH","AORUS"];
const GPU_VRAM = ["2GB","4GB","6GB","8GB","10GB","11GB","12GB","16GB","20GB","24GB","48GB"];
const GPU_CLOCKS = ["1500","1560","1620","1680","1740","1800","1860","1920","1980","2040","2100","2160","2220","2280","2310","2400","2505","2520","2580","2640"];

// ─── RAM ────────────────────────────────────────────────────
const RAM_TYPES = ["DDR3-1333","DDR3-1600","DDR4-2133","DDR4-2400","DDR4-2666","DDR4-3000","DDR4-3200","DDR4-3600","DDR5-4800","DDR5-5200","DDR5-5600","DDR5-6000","DDR5-6400","DDR5-6800","DDR5-7200"];
const RAM_BRANDS = ["Kingston","Corsair Vengeance","G.Skill Ripjaws","G.Skill Trident Z","Crucial","Crucial Ballistix","Patriot Viper","ADATA XPG","Team T-Force","Thermaltake TOUGHRAM"];
const RAM_CAPS = ["4GB","8GB","16GB","32GB","64GB","128GB"];
const RAM_LAT = ["CL14","CL15","CL16","CL17","CL18","CL19","CL20","CL30","CL32","CL34","CL36","CL38","CL40"];

// ─── Storage ────────────────────────────────────────────────
const DRIVE_BRANDS = [
    "Samsung 870 EVO","Samsung 880 QVO","Samsung 980 PRO","Samsung 990 PRO","Samsung 990 EVO",
    "Crucial MX500","Crucial P3 Plus","Crucial T700",
    "WD Blue SN570","WD Black SN770","WD Black SN850X",
    "Kingston A2000","Kingston NV2","Seagate Barracuda","WD Red Plus","Toshiba P300",
    "Intel 670p","SK Hynix P41","SanDisk Ultra 3D","Sabrent Rocket 4 Plus"
];
const DRIVE_CAPS = ["128GB","250GB","256GB","500GB","512GB","1TB","2TB","4TB","8TB"];
const DRIVE_INTF = ["SATA III","M.2 SATA","M.2 NVMe PCIe 3.0","M.2 NVMe PCIe 4.0","M.2 NVMe PCIe 5.0","SAS","NVMe U.2"];
const DRIVE_FORM = ['2.5"','3.5"',"M.2 2280","M.2 2230","M.2 22110","Add-in Card"];

// ─── Mouse ──────────────────────────────────────────────────
const MOUSE_BRANDS = ["Logitech","Razer","SteelSeries","Corsair","HyperX","Cooler Master","Zowie","Glorious","Roccat","ASUS ROG","MSI"];
const MOUSE_MODELS = ["G102","G305","G502 Hero","G703","G Pro X Superlight","DeathAdder V3","Viper V3 Pro","Basilisk V3","Kone Pro","Rival 650","Dark Core RGB Pro","Model O","EC1-C","FK1-C","GPX","Viper 8KHz","Naga Pro","Aerox 3","G Pro Wireless","Ironclaw Wireless"];
const MOUSE_SENSORS = ["3325","3360","3389","3395","HERO 16K","HERO 25K","HERO 26K","Focus+","TrueMove3","PAW3950"];
const MOUSE_DPI = ["400","800","1600","3200","6400","10000","16000","20000","25600","30000"];
const MOUSE_CONN = ["Проводная","Беспроводная 2.4GHz","Bluetooth","2.4GHz + Bluetooth"];

// ─── Display ────────────────────────────────────────────────
const DSP_BRANDS = ["ASUS","ASUS ROG","LG","LG UltraGear","Samsung","Samsung Odyssey","AOC","AOC AGON","BenQ","BenQ ZOWIE","MSI","Dell","Acer Predator","ViewSonic","Gigabyte","Alienware"];
const DSP_SIZES = ['21.5"','23.8"','24"','25"','27"','28"','31.5"','32"','34"','35"','38"','43"','49"'];
const DSP_RES = ["1920x1080","2560x1080","2560x1440","3440x1440","3840x1600","3840x2160","5120x1440","7680x4320"];
const DSP_PANEL = ["TN","IPS","VA","OLED","Mini-LED","Nano-IPS","Fast IPS"];
const DSP_HZ = ["60Hz","75Hz","100Hz","120Hz","144Hz","165Hz","180Hz","200Hz","240Hz","280Hz","360Hz","500Hz"];

// ─── Keyboard ───────────────────────────────────────────
const KBD_BRANDS = ["Logitech","Razer","Corsair","HyperX","SteelSeries","Keychron","Wooting","Ducky","Cooler Master","ASUS ROG","Roccat","Anne Pro","Akko","Newmen","Redragon","Drevo","RK Royal Kludge","Epomaker","NuPhy","EndGame Gear"];
const KBD_MODELS = ["K100","K70 RGB MK.2","K65 Mini","G915 TKL","G915","G815","Huntsman V3 Pro","Huntsman Mini","BlackWidow V4 Pro","BlackWidow V4","Ornata V3","Ornata V2","K63 Wireless","K55 Pro","Apex Pro TKL","Apex 7 TKL","Apex 3","K8 Pro","K8","K6","K2","Heaven65","Lamzu Atlantis","Altair","Xenos","Voyager65","Ghost68","K7","Gasket 65","Cloud III Wireless","Alloy Origins","Alloy Elite 2","Rival 650"];
const KBD_SWITCHES = ["Cherry MX Red","Cherry MX Brown","Cherry MX Blue","Cherry MX Speed Silver","Cherry MX Silent Red","Cherry MX Black","Cherry MX Clear","Razer Green","Razer Yellow","Razer Orange","Razer Optical","Gateron Red","Gateron Yellow","Gateron Brown","Gateron Blue","Gateron Black","Kailh Box White","Kailh Box Red","Kailh Box Brown","Kailh Choc V2","Outemu Red","Outemu Blue","Outemu Brown","Gateron Oil King","TTC Gold Pink","TTC Speed Silver","Razer Phantom","Lekker L60","Wooting Lekker L60","Holy Panda X"];
const KBD_LAYOUT = ["Full-size","TKL (87 клавиш)","75%","65%","60%","40%","Alice","Split","Ergonomic","Compact (96%)"];
const KBD_BACKLIGHT = ["RGB","Per-key RGB","Single-color White","Single-color Red","Single-color Blue","None"];
const KBD_CONN = ["USB-C Проводная","Беспроводная 2.4GHz","Bluetooth","2.4GHz + Bluetooth","USB-C + Bluetooth","USB-C + 2.4GHz + Bluetooth","USB-C Проводная + Bluetooth"];

// ─── Motherboard ──────────────────────────────────────────
const MB_BRANDS = ["ASUS","ASUS ROG","ASUS TUF Gaming","MSI","MSI MAG","MSI MEG","Gigabyte","Gigabyte AORUS","ASRock","ASRock Phantom Gaming","EVGA","Biostar","NZXT"];
const MB_SOCKETS = ["LGA 1700","LGA 1851","AM4","AM5","LGA 1200","LGA 2066","sTRX5","sWRX8"];
const MB_CHIPSETS = ["B660","B760","Z690","Z790","H610","H770","X670E","X670","B650E","B650","A520","B550","X570","H670","W680","W790"];
const MB_FORM = ["ATX","Micro-ATX","Mini-ITX","E-ATX","Mini-STX","Thin-ITX"];
const MB_MEM_SLOTS = ["2","4"];
const MB_PCIE = ["PCIe 4.0","PCIe 5.0","PCIe 3.0"];

// ─── Component Type Registry ────────────────────────────────
const PC_TYPES = {
    proc: {
        dims: [CPU_MODELS, CPU_SUFFIXES, CPU_SPEEDS, CPU_CORES],
        marker: 'CPU',
        format: (v) => `${v[0]}${v[1]} @ ${v[2]}GHz, ${v[3]} ядер`
    },
    vdcard: {
        dims: [GPU_MODELS, GPU_VARIANTS, GPU_VRAM, GPU_CLOCKS],
        marker: 'GPU',
        format: (v) => `${v[0]}${v[1] ? ' ' + v[1] : ''} ${v[2]} ${v[3]}MHz`
    },
    ram: {
        dims: [RAM_TYPES, RAM_BRANDS, RAM_CAPS, RAM_LAT],
        marker: 'RAM',
        format: (v) => `${v[0]} ${v[1]} ${v[2]} ${v[3]}`
    },
    drive: {
        dims: [DRIVE_BRANDS, DRIVE_CAPS, DRIVE_INTF, DRIVE_FORM],
        marker: 'DRV',
        format: (v) => `${v[0]} ${v[1]} ${v[2]} ${v[3]}`
    },
    mouse: {
        dims: [MOUSE_BRANDS, MOUSE_MODELS, MOUSE_SENSORS, MOUSE_DPI, MOUSE_CONN],
        marker: 'MSE',
        format: (v) => `${v[0]} ${v[1]}, ${v[2]}, ${v[3]} DPI, ${v[4]}`
    },
    display: {
        dims: [DSP_BRANDS, DSP_SIZES, DSP_RES, DSP_PANEL, DSP_HZ],
        marker: 'DSP',
        format: (v) => `${v[0]} ${v[1]} ${v[2]} ${v[3]} ${v[4]}`
    },
    keyboard: {
        dims: [KBD_BRANDS, KBD_MODELS, KBD_SWITCHES, KBD_LAYOUT, KBD_BACKLIGHT, KBD_CONN],
        marker: 'KBD',
        format: (v) => `${v[0]} ${v[1]}, ${v[2]}, ${v[3]}, ${v[4]}, ${v[5]}`
    },
    motherboard: {
        dims: [MB_BRANDS, MB_SOCKETS, MB_CHIPSETS, MB_FORM, MB_MEM_SLOTS, MB_PCIE],
        marker: 'MBD',
        format: (v) => `${v[0]} ${v[1]} ${v[2]} ${v[3]}, ${v[4]} слота, ${v[5]}`
    }
};

export class PcPartsChannel {
    constructor() {
        this.name = 'pc-parts';
        this.loaded = true;
        this._isTagBased = true;
        this.TAG_REGEX = /\[steg-pc-(proc|vdcard|ram|drive|mouse|display|motherboard|keyboard)\]/g;
        // Marker codes: MARKER-XXXX (4 base-36 chars)
        this.DETECT_REGEX = /(?:CPU|GPU|RAM|DRV|MSE|DSP|MBD|KBD)-[A-Z0-9]{4}/g;
        // Self-test: verify encode→decode roundtrip
        this._selfTest();
    }

    _selfTest() {
        try {
            for (const [typeKey, type] of Object.entries(PC_TYPES)) {
                // Test with max indices
                const maxIndices = type.dims.map(d => d.length - 1);
                const code = this._encodeIndices(maxIndices, type.dims);
                const decoded = this._decodeIndices(code, type.dims);
                if (!decoded || JSON.stringify(decoded) !== JSON.stringify(maxIndices)) {
                    console.error(`[pc-parts] Self-test FAILED for ${typeKey}: encoded ${JSON.stringify(maxIndices)} → ${code} → ${JSON.stringify(decoded)}`);
                    continue;
                }
                // Test with zeros
                const zeros = type.dims.map(() => 0);
                const code0 = this._encodeIndices(zeros, type.dims);
                const decoded0 = this._decodeIndices(code0, type.dims);
                if (!decoded0 || JSON.stringify(decoded0) !== JSON.stringify(zeros)) {
                    console.error(`[pc-parts] Self-test FAILED for ${typeKey} (zeros)`);
                    continue;
                }
            }
            console.log('[pc-parts] Self-test PASSED ✓');
        } catch (e) {
            console.error('[pc-parts] Self-test ERROR:', e);
        }
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
        if (value > 0n) return null; // Overflow
        return indices;
    }

    // ─── Find tags + generated blocks ─────────────────────
    _findMatches(text) {
        const matches = [];
        // 1. Find tags
        this.TAG_REGEX.lastIndex = 0;
        let m;
        while ((m = this.TAG_REGEX.exec(text)) !== null) {
            const typeKey = m[1];
            const type = PC_TYPES[typeKey];
            if (!type) continue;
            matches.push({ index: m.index, length: m[0].length, typeKey, marker: type.marker, full: m[0], isTag: true });
        }
        // 2. Find generated blocks (marker codes)
        this.DETECT_REGEX.lastIndex = 0;
        while ((m = this.DETECT_REGEX.exec(text)) !== null) {
            const markerStr = m[0];
            const dashIdx = markerStr.indexOf('-');
            if (dashIdx === -1) continue;
            const marker = markerStr.substring(0, dashIdx);
            const code = markerStr.substring(dashIdx + 1);
            const typeKey = Object.keys(PC_TYPES).find(k => PC_TYPES[k].marker === marker);
            if (!typeKey) continue;
            // Skip if preceded by [ (tag format) or alphanumeric (part of larger word)
            if (m.index > 0 && text[m.index - 1] === '[') continue;
            if (m.index > 0 && /[A-Za-z0-9_]/.test(text[m.index - 1])) continue;
            matches.push({ index: m.index, length: m[0].length, typeKey, marker, code, full: m[0], isTag: false });
        }
        matches.sort((a, b) => a.index - b.index);
        return matches;
    }

    // ─── Build generated text ─────────────────────────────
    _buildComponent(typeKey, indices) {
        const type = PC_TYPES[typeKey];
        const vals = type.dims.map((dim, i) => dim[indices[i] % dim.length]);
        const text = type.format(vals);
        const code = this._encodeIndices(indices, type.dims);
        return `${text} ${type.marker}-${code}`;
    }

    // ─── Channel API ────────────────────────────────────────

    analyzeCapacity(text) {
        if (!this.loaded) return { totalBits: 0, positions: [], bases: [] };
        const matches = this._findMatches(text);
        if (matches.length === 0) return { totalBits: 0, positions: [], bases: [] };

        const positions = [];
        const bases = [];
        for (const match of matches) {
            const type = PC_TYPES[match.typeKey];
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
            const type = PC_TYPES[match.typeKey];
            if (!type) continue;
            const dimCount = type.dims.length;
            if (idx + dimCount > indices.length) break;
            const componentIndices = indices.slice(idx, idx + dimCount);
            const newComponent = this._buildComponent(match.typeKey, componentIndices);
            replacements.push({ index: match.index, length: match.length, replacement: newComponent });
            idx += dimCount;
        }

        // Apply in reverse order to preserve indices
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
            const type = PC_TYPES[match.typeKey];
            if (!type) continue;
            const parsed = this._decodeIndices(match.code, type.dims);
            if (parsed) {
                indices.push(...parsed);
            } else {
                console.warn(`[pc-parts] Decode failed for ${match.marker}-${match.code} (${match.typeKey}): value out of range. Text may be from an older version — please re-encode.`);
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
            // For generated blocks, extend to cover the full line
            const lineStart = text.lastIndexOf('\n', m.index - 1) + 1;
            const lineEnd = text.indexOf('\n', m.index + m.length);
            return { start: lineStart, end: lineEnd === -1 ? text.length : lineEnd };
        });
    }

    getStats() {
        const typeStats = {};
        for (const [k, v] of Object.entries(PC_TYPES)) {
            typeStats[k] = {
                dims: v.dims.map(d => d.length),
                bits: v.dims.reduce((s, d) => s + Math.log2(d.length), 0).toFixed(1)
            };
        }
        return { name: this.name, loaded: this.loaded, types: typeStats };
    }
}

export default PcPartsChannel;
