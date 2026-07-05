/**
 * Канал кодирования через JSON-конфигурацию с UUID-значениями — v2
 *
 * Принцип: находим теги [steg-json] в тексте и заменяем на JSON-записи
 * с UUID-значениями, замаскированные под реальную server/infrastructure
 * конфигурацию deployment-файла.
 *
 * Каждый UUID несёт 128 бит данных (16 байт).
 * Индексы кодируются непосредственно как байты UUID — маркеры не нужны.
 *
 * Алиас: [steg-json] — одна JSON-запись с UUID (128 бит / 16 байт)
 *
 * Формат генерируемой записи:
 *   "worker_node_0": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
 *
 * Ключи выглядят естественно — как настоящая инфраструктурная конфигурация:
 *   worker_node, root_user, main_desktop, docker_container,
 *   app_server, db_instance, cache_node, proxy_server, и т.д.
 *
 * Детекция: поиск ключей "prefix_N" с UUID-значениями по regex.
 * Каждая запись содержит 16 байт = 128 бит данных.
 */

const KEY_PREFIXES = [
    "worker_node", "root_user", "main_desktop", "docker_container",
    "app_server", "db_instance", "cache_node", "proxy_server",
    "api_gateway", "web_frontend", "auth_service", "queue_worker",
    "scheduler_pod", "build_runner", "monitor_agent", "log_collector",
    "deploy_target", "backup_host", "cdn_edge", "lb_instance",
    "redis_master", "pg_replica", "mq_broker", "dns_resolver"
];

export class JsonConfigChannel {
    constructor() {
        this.name = 'json-config';
        this.loaded = true;
        this._isTagBased = true;

        // Tag pattern: [steg-json]
        this.TAG_REGEX = /\[steg-json\]/g;

        // Detection: JSON key matching any of our natural prefixes + "_N": "uuid"
        // Groups: 1 = full key (e.g. "worker_node_0"), 2 = key index N, 3-7 = UUID segments
        const prefixAlternation = KEY_PREFIXES.join('|');
        this.DETECT_REGEX = new RegExp(
            `"((?:${prefixAlternation})_(\\d+))"\\s*:\\s*"([a-fA-F0-9]{8})-([a-fA-F0-9]{4})-([a-fA-F0-9]{4})-([a-fA-F0-9]{4})-([a-fA-F0-9]{12})"`,
            'g'
        );

        // Each tag: 16 bases of 256 (16 bytes × 8 bits = 128 bits)
        this.DIMS = new Array(16).fill(256);

        // Self-test: verify encode→decode roundtrip and regex detection
        this._selfTest();
    }

    _selfTest() {
        try {
            // Test UUID roundtrip with max indices (all 255)
            const maxIndices = new Array(16).fill(255);
            const uuid = this._buildUuid(maxIndices);
            const decoded = this._parseUuid(uuid);
            if (!decoded || JSON.stringify(decoded) !== JSON.stringify(maxIndices)) {
                console.error('[json-config] Self-test FAILED for max indices:', uuid, '→', decoded);
                return;
            }

            // Test with zeros
            const zeros = new Array(16).fill(0);
            const uuid0 = this._buildUuid(zeros);
            const decoded0 = this._parseUuid(uuid0);
            if (!decoded0 || JSON.stringify(decoded0) !== JSON.stringify(zeros)) {
                console.error('[json-config] Self-test FAILED for zeros:', uuid0, '→', decoded0);
                return;
            }

            // Test with specific pattern
            const testIndices = [0, 255, 128, 42, 17, 200, 99, 1, 255, 0, 128, 64, 32, 16, 8, 4];
            const uuid1 = this._buildUuid(testIndices);
            const decoded1 = this._parseUuid(uuid1);
            if (!decoded1 || JSON.stringify(decoded1) !== JSON.stringify(testIndices)) {
                console.error('[json-config] Self-test FAILED for pattern test:', uuid1, '→', decoded1);
                return;
            }

            // Test regex detection on a generated entry
            const prefix = KEY_PREFIXES[0]; // worker_node
            const entry = `"${prefix}_42": "${uuid1}"`;
            this.DETECT_REGEX.lastIndex = 0;
            const reMatch = this.DETECT_REGEX.exec(entry);
            if (!reMatch || reMatch[2] !== '42') {
                console.error('[json-config] Self-test FAILED for regex detection on:', entry);
                return;
            }

            // Verify no legacy "_stego_cfg_" prefix leaks anywhere
            if (this.DETECT_REGEX.source.includes('stego_cfg')) {
                console.error('[json-config] Self-test FAILED: legacy _stego_cfg_ prefix detected in regex!');
                return;
            }

            console.log('[json-config] Self-test PASSED ✓');
        } catch (e) {
            console.error('[json-config] Self-test ERROR:', e);
        }
    }

    // ─── UUID ↔ indices conversion ──────────────────────

    /**
     * Build UUID string from 16 byte indices (0-255 each).
     * Output format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
     */
    _buildUuid(indices) {
        const hex = indices.map(b => b.toString(16).padStart(2, '0')).join('');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }

    /**
     * Parse UUID string back to 16 byte indices (0-255 each).
     * Returns null if UUID is invalid.
     */
    _parseUuid(uuid) {
        const hex = uuid.replace(/-/g, '');
        if (hex.length !== 32) return null;
        const indices = [];
        for (let i = 0; i < 32; i += 2) {
            const byte = parseInt(hex.slice(i, i + 2), 16);
            if (isNaN(byte)) return null;
            indices.push(byte);
        }
        return indices;
    }

    // ─── Find tags + generated blocks ───────────────────

    _findMatches(text) {
        const matches = [];

        // 1. Find tags [steg-json]
        this.TAG_REGEX.lastIndex = 0;
        let m;
        while ((m = this.TAG_REGEX.exec(text)) !== null) {
            matches.push({ index: m.index, length: m[0].length, full: m[0], isTag: true });
        }

        // 2. Find generated blocks ("prefix_N": "uuid")
        this.DETECT_REGEX.lastIndex = 0;
        while ((m = this.DETECT_REGEX.exec(text)) !== null) {
            const keyIndex = parseInt(m[2], 10);
            const uuid = `${m[3]}-${m[4]}-${m[5]}-${m[6]}-${m[7]}`;
            // Skip if preceded by [ (tag format — shouldn't happen but be safe)
            if (m.index > 0 && text[m.index - 1] === '[') continue;
            matches.push({ index: m.index, length: m[0].length, keyIndex, uuid, full: m[0], isTag: false });
        }

        matches.sort((a, b) => a.index - b.index);
        return matches;
    }

    // ─── Build generated JSON entry ─────────────────────

    /**
     * Build a natural-looking JSON key-value pair carrying hidden data.
     * Cycles through KEY_PREFIXES so different entries use different key names.
     */
    _buildEntry(indices, counter) {
        const uuid = this._buildUuid(indices);
        const prefix = KEY_PREFIXES[counter % KEY_PREFIXES.length];
        return `"${prefix}_${counter}": "${uuid}"`;
    }

    // ─── Channel API ────────────────────────────────────

    analyzeCapacity(text) {
        if (!this.loaded) return { totalBits: 0, positions: [], bases: [] };
        const matches = this._findMatches(text);
        if (matches.length === 0) return { totalBits: 0, positions: [], bases: [] };

        const positions = [];
        const bases = [];
        for (const match of matches) {
            positions.push({ index: match.index, length: match.length, type: 'json-config', word: match.full });
            bases.push(...this.DIMS);
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
        let counter = 0;
        for (const match of matches) {
            if (idx + 16 > indices.length) break;
            const entryIndices = indices.slice(idx, idx + 16);
            const entry = this._buildEntry(entryIndices, counter);
            replacements.push({ index: match.index, length: match.length, replacement: entry });
            idx += 16;
            counter++;
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
            const parsed = this._parseUuid(match.uuid);
            if (parsed) {
                indices.push(...parsed);
            } else {
                console.warn(`[json-config] Decode failed for ${match.uuid}: invalid UUID. Text may be corrupted — please re-encode.`);
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
        return {
            name: this.name,
            loaded: this.loaded,
            types: {
                'steg-json': {
                    dims: this.DIMS,
                    bits: (16 * Math.log2(256)).toFixed(1)
                }
            }
        };
    }
}

export default JsonConfigChannel;
