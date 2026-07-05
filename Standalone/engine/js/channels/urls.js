/**
 * Канал кодирования через URL-адреса
 *
 * Принцип: находим в тексте URL-адреса и модифицируем их компоненты
 * для кодирования данных. Основной домен и путь сохраняются.
 *
 * Кодируемые компоненты (позиции mixed-radix, ВСЕГДА присутствуют):
 *   1. Протокол: нет | http:// | https://  → base 3
 *   2. www: нет | www.                     → base 2
 *   3–21. ysclid значение: 19 символов base-37 (0=отсутствует, 1-36=символ) → base 37 × 19
 *   22. utm_source: N источников + "отсутствует" → base 20
 *   23–30. hash значение: 8 символов base-17 (0=отсутствует, 1-16=символ) → base 17 × 8
 *
 * Всего 30 позиций, ~140 бит на URL.
 *
 * При кодировании ВСЕГДА добавляем ysclid и hash (если данные есть).
 * Декодер извлекает URL и читает все компоненты.
 * Если компонент отсутствует в оригинальном URL — его индекс = 0.
 *
 * ВАЖНО: URL не детектируются внутри email-адресов или номеров телефонов.
 * Если URL совпадает с доменом email (например mail.ru из user@mail.ru),
 * он пропускается — это домен email, а не отдельный URL.
 */

export class UrlsChannel {
    constructor() {
        this.name = 'urls';

        // Российские источники для utm_source
        this.UTM_SOURCES = [
            null,           // 0 = отсутствует
            'yandex',       'dzen',         'vk',           'ok',
            'mail',         'rambler',      'rutube',       'gazeta',
            'lenta',        'avito',        'wildberries',  'ozon',
            'hh',           'habr',         'ria',          'tass',
            'kp',           'afisha',
        ];

        // Characters for ysclid: 0-9 a-z (36 chars, base 36)
        // Each position always carries a character — no "absent" state
        this.YSCLID_CHARS = '0123456789abcdefghijklmnopqrstuvwxyz';
        this.YSCLID_LENGTH = 19;

        // Characters for hash: 0-9 a-f (16 chars, base 16)
        // Each position always carries a character — no "absent" state
        this.HASH_CHARS = '0123456789abcdef';
        this.HASH_LENGTH = 8;

        // Regex для поиска URL в тексте
        // Matches: [protocol][www]domain/path[?query][#hash]
        // Query and hash are included in the match
        // КРИТИЧЕСКО: (?:[/?#][^\s,;<>"']*)? захватывает query (?ysclid=...)
        // и hash (#...) СРАЗУ после домена, даже без предшествующего пути (/).
        // ВАЖНО: запятая и точка с запятой — разделители в тексте, НЕ часть URL.
        // Без их исключения URL regex «съедал» соседний телефон после кодирования,
        // вызывая потерю ёмкости при конвергенции (convergence failure).
        this.URL_REGEX = /(?:https?:\/\/)?(?:www\.)?[a-zA-Z0-9][-a-zA-Z0-9]*(?:\.[a-zA-Z0-9][-a-zA-Z0-9]*)+(?:[/?#][^\s,;<>"']*)?/g;

        // Positions per URL: protocol(1) + www(1) + ysclid(19) + utm(1) + hash(8) = 30
        this.POS_PER_URL = 1 + 1 + this.YSCLID_LENGTH + 1 + this.HASH_LENGTH;

        // Regex для поиска email и телефонов — чтобы исключить коллизии
        // КРИТИЧЕСКО: local part включает + (как в основном regex emails.js)
        this._emailRegex = /[a-zA-Z0-9][a-zA-Z0-9._+\-]*@[a-zA-Z0-9][-a-zA-Z0-9]*\.[a-zA-Z0-9][-a-zA-Z0-9.]*/g;
        this._phoneRegex = /(?:\+?7|8)[\s\-]*\(?\d{3}\)?[\s\-]*\d{3}[\s\-]*\d{2}[\s\-]*\d{2}/g;
    }

    /**
     * Найти все URL в тексте, ИСКЛЮЧАЯ совпадения внутри email и телефонов.
     *
     * ВАЖНО: двухпроходный алгоритм для разрыва циклической зависимости
     * между URL и телефонами. После кодирования ysclid может содержать
     * цифры, похожие на номер телефона (например "7200000000"). Чтобы
     * телефонный regex внутри ysclid не исключал весь URL, мы сначала
     * находим все URL-спаны, затем исключаем из phone-спанов те, что
     * находятся ВНУТРИ URL.
     */
    _findUrls(text) {
        // Сначала находим все email-спаны
        const emailSpans = [];
        this._emailRegex.lastIndex = 0;
        let m;
        while ((m = this._emailRegex.exec(text)) !== null) {
            emailSpans.push({ start: m.index, end: m.index + m[0].length });
        }

        // ПЕРВЫЙ ПРОХОД: находим ВСЕ потенциальные URL (без исключения)
        // для определения их спанов — они нужны чтобы корректно
        // отфильтровать ложные phone-совпадения внутри ysclid/hash.
        const preliminaryUrlSpans = [];
        this.URL_REGEX.lastIndex = 0;
        while ((m = this.URL_REGEX.exec(text)) !== null) {
            if (m[0].includes('.') && m[0].length > 5) {
                preliminaryUrlSpans.push({ start: m.index, end: m.index + m[0].length });
            }
        }

        // Находим phone-спаны, ИСКЛЮЧАЯ те что ВНУТРИ URL
        // (ysclid может содержать цифры, похожие на телефон)
        const phoneSpans = [];
        this._phoneRegex.lastIndex = 0;
        while ((m = this._phoneRegex.exec(text)) !== null) {
            const ps = { start: m.index, end: m.index + m[0].length };
            const insideUrl = preliminaryUrlSpans.some(us =>
                ps.start >= us.start && ps.end <= us.end
            );
            if (!insideUrl) {
                phoneSpans.push(ps);
            }
        }

        const excludedSpans = [...emailSpans, ...phoneSpans];

        // ВТОРОЙ ПРОХОД: находим URL, исключая пересечения с email/phone
        const matches = [];
        this.URL_REGEX.lastIndex = 0;
        while ((m = this.URL_REGEX.exec(text)) !== null) {
            if (!m[0].includes('.') || m[0].length <= 5) continue;

            const urlStart = m.index;
            const urlEnd = m.index + m[0].length;

            // Пропускаем URL, перед которым стоит @ (домен email)
            if (urlStart > 0 && text[urlStart - 1] === '@') continue;

            // Пропускаем URL, пересекающийся с email или телефоном
            const overlaps = excludedSpans.some(es =>
                (urlStart >= es.start && urlStart < es.end) ||
                (urlEnd > es.start && urlEnd <= es.end) ||
                (urlStart <= es.start && urlEnd >= es.end)
            );
            if (overlaps) continue;

            // Валидация: домен должен заканчиваться TLD (2–10 букв, без цифр).
            // Это отсеивает ложные срабатывания: даты (15.03.2024),
            // частоты (4.5GHz), бренды (G.Skill).
            if (!this._isValidDomainTld(m[0])) continue;

            matches.push({ index: m.index, full: m[0], length: m[0].length });
        }
        return matches;
    }

    /**
     * Проверяет, что URL-подобная строка заканчивается валидным TLD.
     * Отсеивает ложные срабатывания: даты (15.03.2024), частоты (4.5GHz),
     * бренды с точками (G.Skill, H.PB), IP-адреса и т.п.
     */
    _isValidDomainTld(urlStr) {
        let remaining = urlStr;

        // Убираем протокол
        if (remaining.startsWith('https://')) remaining = remaining.slice(8);
        else if (remaining.startsWith('http://')) remaining = remaining.slice(7);

        // Убираем www.
        if (remaining.startsWith('www.')) remaining = remaining.slice(4);

        // Теперь remaining = domain/path?query#hash — извлекаем домен
        let domain = remaining;
        const slashIdx = domain.indexOf('/');
        if (slashIdx >= 0) domain = domain.substring(0, slashIdx);
        const qIdx = domain.indexOf('?');
        if (qIdx >= 0) domain = domain.substring(0, qIdx);
        const hIdx = domain.indexOf('#');
        if (hIdx >= 0) domain = domain.substring(0, hIdx);

        // Последний компонент домена = TLD
        const parts = domain.split('.');
        if (parts.length < 2) return false;
        const tld = parts[parts.length - 1];

        // TLD: только буквы, 2–10 символов (com, ru, org, info, etc.)
        if (!/^[a-zA-Z]{2,10}$/.test(tld)) return false;

        // Без протокола — дополнительно проверяем что первый компонент ≥ 3 символов.
        // Это отсеивает G.Skill, I.P и прочие бренды.
        if (!urlStr.startsWith('http://') && !urlStr.startsWith('https://')) {
            if (parts[0].length < 3) return false;
        }

        return true;
    }

    _parseUrl(urlStr) {
        let remaining = urlStr;
        let protocol = 0;
        let www = 0;

        if (remaining.startsWith('https://')) { protocol = 2; remaining = remaining.slice(8); }
        else if (remaining.startsWith('http://')) { protocol = 1; remaining = remaining.slice(7); }

        if (remaining.startsWith('www.')) { www = 1; remaining = remaining.slice(4); }

        const qIdx = remaining.indexOf('?');
        const hIdx = remaining.indexOf('#');

        let domainPath, queryString = '', hashString = '';

        if (hIdx >= 0 && (qIdx < 0 || hIdx < qIdx)) {
            domainPath = remaining.slice(0, hIdx);
            hashString = remaining.slice(hIdx + 1);
        } else if (qIdx >= 0) {
            domainPath = remaining.slice(0, qIdx);
            const afterQ = remaining.slice(qIdx + 1);
            const hIdx2 = afterQ.indexOf('#');
            if (hIdx2 >= 0) { queryString = afterQ.slice(0, hIdx2); hashString = afterQ.slice(hIdx2 + 1); }
            else queryString = afterQ;
        } else {
            domainPath = remaining;
        }

        let ysclidValue = null;
        let utmSource = null;

        if (queryString) {
            for (const param of queryString.split('&')) {
                const eqIdx = param.indexOf('=');
                if (eqIdx < 0) continue;
                const key = param.slice(0, eqIdx);
                const val = param.slice(eqIdx + 1);
                if (key === 'ysclid') ysclidValue = decodeURIComponent(val);
                else if (key === 'utm_source') utmSource = decodeURIComponent(val);
            }
        }

        return { protocol, www, domainPath, ysclidValue, utmSource, hashString, queryString };
    }

    // ─── ysclid encode/decode ─────────────────────────────────────

    _ysclidToIndices(value) {
        const indices = [];
        if (!value) {
            // No ysclid in original URL → all zeros
            for (let i = 0; i < this.YSCLID_LENGTH; i++) indices.push(0);
            return indices;
        }
        const clean = value.toLowerCase().replace(/[^0-9a-z]/g, '');
        for (let i = 0; i < this.YSCLID_LENGTH; i++) {
            if (i < clean.length) {
                const charIdx = this.YSCLID_CHARS.indexOf(clean[i]);
                indices.push(charIdx >= 0 ? charIdx : 0);
            } else {
                indices.push(0); // padding with '0' char (index 0)
            }
        }
        return indices;
    }

    _indicesToYsclid(indices) {
        let result = '';
        for (let i = 0; i < indices.length; i++) {
            const idx = indices[i] % 36;
            result += this.YSCLID_CHARS[idx];
        }
        return result;
    }

    // ─── hash encode/decode ────────────────────────────────────────

    _hashToIndices(value) {
        const indices = [];
        if (!value) {
            for (let i = 0; i < this.HASH_LENGTH; i++) indices.push(0);
            return indices;
        }
        const clean = value.toLowerCase().replace(/[^0-9a-f]/g, '');
        for (let i = 0; i < this.HASH_LENGTH; i++) {
            if (i < clean.length) {
                const charIdx = this.HASH_CHARS.indexOf(clean[i]);
                indices.push(charIdx >= 0 ? charIdx : 0);
            } else {
                indices.push(0);
            }
        }
        return indices;
    }

    _indicesToHash(indices) {
        let result = '';
        for (let i = 0; i < indices.length; i++) {
            const idx = indices[i] % 16;
            result += this.HASH_CHARS[idx];
        }
        return result;
    }

    // ─── Public API ────────────────────────────────────────────────

    analyzeCapacity(text) {
        const urls = this._findUrls(text);
        if (urls.length === 0) return { totalBits: 0, positions: [], bases: [] };

        const positions = [];
        const bases = [];

        for (const url of urls) {
            positions.push({ index: url.index, length: url.length, type: 'url' });
            bases.push(3);                                  // protocol
            bases.push(2);                                  // www
            for (let i = 0; i < this.YSCLID_LENGTH; i++) bases.push(36); // ysclid (base-36)
            bases.push(this.UTM_SOURCES.length);            // utm_source
            for (let i = 0; i < this.HASH_LENGTH; i++) bases.push(16);  // hash (base-16)
        }

        const totalBits = bases.reduce((sum, b) => sum + Math.log2(b), 0);
        return { totalBits, positions, bases };
    }

    encode(text, indices) {
        if (indices.length === 0) return text;

        const urls = this._findUrls(text);
        if (urls.length === 0) return text;

        const replacements = [];
        let idx = 0;

        for (const url of urls) {
            if (idx + this.POS_PER_URL > indices.length) break;

            const parsed = this._parseUrl(url.full);

            const protocol = indices[idx] % 3;
            const www = indices[idx + 1] % 2;
            const ysclidIndices = indices.slice(idx + 2, idx + 2 + this.YSCLID_LENGTH);
            const utmIdx = indices[idx + 2 + this.YSCLID_LENGTH] % this.UTM_SOURCES.length;
            const hashIndices = indices.slice(idx + 3 + this.YSCLID_LENGTH, idx + 3 + this.YSCLID_LENGTH + this.HASH_LENGTH);

            // Build URL
            let newUrl = '';
            if (protocol === 1) newUrl += 'http://';
            else if (protocol === 2) newUrl += 'https://';
            if (www === 1) newUrl += 'www.';
            newUrl += parsed.domainPath;

            // Query parameters — always add ysclid + hash (they carry data)
            // Preserve original non-stego query params
            const queryParts = [];

            // Preserve original params except ysclid and utm_source
            if (parsed.queryString) {
                for (const param of parsed.queryString.split('&')) {
                    const eqIdx = param.indexOf('=');
                    if (eqIdx < 0) continue;
                    const key = param.slice(0, eqIdx);
                    if (key !== 'ysclid' && key !== 'utm_source' && key !== 'utm_medium') {
                        queryParts.push(param);
                    }
                }
            }

            // ysclid (always present — carries 19 × log2(36) ≈ 98 bits)
            const ysclidVal = this._indicesToYsclid(ysclidIndices);
            queryParts.push('ysclid=' + ysclidVal);

            // utm_source
            const utmSource = this.UTM_SOURCES[utmIdx];
            if (utmSource) {
                queryParts.push('utm_source=' + utmSource);
                // Add realistic utm_medium
                const mediums = { yandex: 'cpc', vk: 'social', ok: 'social', mail: 'email' };
                queryParts.push('utm_medium=' + (mediums[utmSource] || 'referral'));
            }

            if (queryParts.length > 0) newUrl += '?' + queryParts.join('&');

            // Hash fragment (always present — carries 8 × log2(16) = 32 bits)
            const hashVal = this._indicesToHash(hashIndices);
            newUrl += '#' + hashVal;

            replacements.push({ index: url.index, length: url.length, replacement: newUrl });
            idx += this.POS_PER_URL;
        }

        // Apply in reverse order
        let result = text;
        for (let i = replacements.length - 1; i >= 0; i--) {
            const r = replacements[i];
            result = result.slice(0, r.index) + r.replacement + result.slice(r.index + r.length);
        }
        return result;
    }

    decode(stegoText) {
        const urls = this._findUrls(stegoText);
        const indices = [];

        for (const url of urls) {
            const p = this._parseUrl(url.full);

            indices.push(p.protocol);
            indices.push(p.www);

            // ysclid
            const ysclidIdx = this._ysclidToIndices(p.ysclidValue);
            indices.push(...ysclidIdx);

            // utm_source
            let utmIdx = 0;
            if (p.utmSource) {
                const found = this.UTM_SOURCES.indexOf(p.utmSource.toLowerCase());
                utmIdx = found >= 0 ? found : 0;
            }
            indices.push(utmIdx);

            // hash
            const hashIdx = this._hashToIndices(p.hashString);
            indices.push(...hashIdx);
        }

        return indices;
    }

    getStats() {
        return {
            name: this.name,
            loaded: true,
            utmSources: this.UTM_SOURCES.length - 1,
            ysclidLength: this.YSCLID_LENGTH,
            hashLength: this.HASH_LENGTH,
            bitsPerUrl: Math.log2(3) + 1 + this.YSCLID_LENGTH * Math.log2(36)
                + Math.log2(this.UTM_SOURCES.length) + this.HASH_LENGTH * Math.log2(16)
        };
    }
}

export default UrlsChannel;
