/**
 * Канал кодирования через номера телефонов (российские)
 *
 * Принцип: находим в тексте российские номера телефонов и заменяем их
 * на закодированные варианты. Формат номера несёт информацию:
 *
 * Кодируемые компоненты (каждый = позиция в mixed-radix):
 *   1. Префикс: "7" | "+7" | "8"  → base 3
 *   2. Код оператора: 900–999     → base 100
 *   3. Стиль форматирования: 5 вариантов → base 5
 *      (скобки встроены в стиль — НЕ отдельная размерность!)
 *   4–10. 7 цифр номера: каждая 0–9  → base 10 × 7
 *
 * Итого: ~34.2 бит на номер телефона (10 позиций)
 *
 * 5 стилей форматирования:
 *   0: none    → 79621111111
 *   1: spaces  → 7 962 111 11 11
 *   2: sp_br   → 7 (962) 111 11 11
 *   3: dash_br → 7 (962) 111-11-11
 *   4: dash    → 7-962-111-11-11
 *
 * ВАЖНО: Скобки НЕ отдельная размерность — они встроены в стиль (2 и 3).
 * Это гарантирует однозначное определение стиля при декодировании.
 */

export class PhonesChannel {
    constructor() {
        this.name = 'phones';

        // Российские мобильные коды (900-999), все 100 для максимума ёмкости
        this.OPERATOR_CODES = [];
        for (let i = 900; i <= 999; i++) this.OPERATOR_CODES.push(i);

        // Стили форматирования (скобки встроены в стиль)
        // Каждый стиль однозначно определяет внешний вид телефона
        this.FORMAT_STYLES = [
            'none',      // 0: 79621111111
            'spaces',    // 1: 7 962 111 11 11
            'spaces_br', // 2: 7 (962) 111 11 11
            'dash_br',   // 3: 7 (962) 111-11-11
            'dash',      // 4: 7-962-111-11-11
        ];

        // Regex для поиска российских номеров телефонов в тексте
        this.PHONE_REGEX = /(?:\+?7|8)[\s\-]*\(?\d{3}\)?[\s\-]*\d{3}[\s\-]*\d{2}[\s\-]*\d{2}/g;

        // Regex для поиска URL и email — чтобы исключить коллизии
        // КРИТИЧЕСКО: URL regex захватывает query (?...) и hash (#...) СРАЗУ после домена.
        // Старый вариант (?:\/[^\s<>"']*)? терял query/hash для裸доменов.
        // ВАЖНО: запятая и точка с запятой — разделители в тексте, НЕ часть URL.
        this._urlRegex = /(?:https?:\/\/)?(?:www\.)?[a-zA-Z0-9][-a-zA-Z0-9]*(?:\.[a-zA-Z0-9][-a-zA-Z0-9]*)+(?:[/?#][^\s,;<>"']*)?/g;
        // КРИТИЧЕСКО: local part включает + (как в основном regex emails.js)
        this._emailRegex = /[a-zA-Z0-9][a-zA-Z0-9._+\-]*@[a-zA-Z0-9][-a-zA-Z0-9]*\.[a-zA-Z0-9][-a-zA-Z0-9.]*/g;
    }

    /**
     * Найти все номера телефонов в тексте, ИСКЛЮЧАЯ совпадения внутри URL и email.
     */
    _findPhones(text) {
        // Находим все URL-спаны
        const urlSpans = [];
        this._urlRegex.lastIndex = 0;
        let m;
        while ((m = this._urlRegex.exec(text)) !== null) {
            if (m[0].includes('.') && m[0].length > 5) {
                urlSpans.push({ start: m.index, end: m.index + m[0].length });
            }
        }

        // Находим все email-спаны
        const emailSpans = [];
        this._emailRegex.lastIndex = 0;
        while ((m = this._emailRegex.exec(text)) !== null) {
            emailSpans.push({ start: m.index, end: m.index + m[0].length });
        }

        const excludedSpans = [...urlSpans, ...emailSpans];

        const matches = [];
        this.PHONE_REGEX.lastIndex = 0;
        while ((m = this.PHONE_REGEX.exec(text)) !== null) {
            const phoneStart = m.index;
            const phoneEnd = m.index + m[0].length;

            // Пропускаем телефон, пересекающийся с URL или email
            const overlaps = excludedSpans.some(es =>
                (phoneStart >= es.start && phoneStart < es.end) ||
                (phoneEnd > es.start && phoneEnd <= es.end) ||
                (phoneStart <= es.start && phoneEnd >= es.end)
            );
            if (overlaps) continue;

            matches.push({
                index: m.index,
                full: m[0],
                length: m[0].length
            });
        }
        return matches;
    }

    /**
     * Разобрать номер телефона на компоненты
     * Возвращает { prefix, opCode, sepStyle, digits }
     */
    _parsePhone(phoneStr) {
        // Убираем все не-цифры для извлечения цифр
        const digits = phoneStr.replace(/\D/g, '');

        // Need at least 11 digits (7/8 + 3 digit operator code + 7 digit number)
        if (digits.length < 11) return null;

        // Префикс
        let prefix;
        if (phoneStr.startsWith('+7')) prefix = 1;      // +7
        else if (phoneStr.startsWith('8')) prefix = 2;   // 8
        else prefix = 0;                                  // 7 (or no prefix)

        // Код оператора (3 цифры после 7 или 8)
        const opCode = parseInt(digits.substring(1, 4));

        // 7 цифр номера
        const phoneDigits = digits.substring(4, 11).split('').map(Number);

        // Стиль форматирования — однозначное определение
        const hasBrackets = /\(\d{3}\)/.test(phoneStr);
        const hasSpaces = /\s/.test(phoneStr);
        const hasDashes = /-/.test(phoneStr);

        let sepStyle;
        if (!hasSpaces && !hasDashes) {
            sepStyle = 0; // none: 79621111111
        } else if (hasSpaces && !hasDashes && !hasBrackets) {
            sepStyle = 1; // spaces: 7 962 111 11 11
        } else if (hasSpaces && !hasDashes && hasBrackets) {
            sepStyle = 2; // spaces_br: 7 (962) 111 11 11
        } else if (hasDashes && hasBrackets) {
            sepStyle = 3; // dash_br: 7 (962) 111-11-11
        } else if (hasDashes && !hasBrackets) {
            sepStyle = 4; // dash: 7-962-111-11-11
        } else {
            // Fallback: mixed spaces and dashes — treat as "none"
            sepStyle = 0;
        }

        return { prefix, opCode, sepStyle, digits: phoneDigits };
    }

    /**
     * Собрать номер телефона из компонентов
     */
    _buildPhone(prefix, opCode, sepStyle, digits) {
        const prefixStr = ['7', '+7', '8'][prefix] || '7';
        const opStr = String(opCode).padStart(3, '0');
        const d = digits.map(n => String(n)).join('');

        switch (sepStyle) {
            case 0: // none: 79621111111
                return `${prefixStr}${opStr}${d}`;

            case 1: // spaces: 7 962 111 11 11
                return `${prefixStr} ${opStr} ${d.slice(0,3)} ${d.slice(3,5)} ${d.slice(5)}`;

            case 2: // spaces_br: 7 (962) 111 11 11
                return `${prefixStr} (${opStr}) ${d.slice(0,3)} ${d.slice(3,5)} ${d.slice(5)}`;

            case 3: // dash_br: 7 (962) 111-11-11
                return `${prefixStr} (${opStr}) ${d.slice(0,3)}-${d.slice(3,5)}-${d.slice(5)}`;

            case 4: // dash: 7-962-111-11-11
                return `${prefixStr}-${opStr}-${d.slice(0,3)}-${d.slice(3,5)}-${d.slice(5)}`;

            default:
                return `${prefixStr}${opStr}${d}`;
        }
    }

    analyzeCapacity(text) {
        const phones = this._findPhones(text);
        if (phones.length === 0) {
            return { totalBits: 0, positions: [], bases: [] };
        }

        // Каждый номер = 10 позиций: prefix(3) + opCode(100) + sepStyle(5) + 7×digits(10)
        const positions = [];
        const bases = [];

        for (const phone of phones) {
            positions.push({
                index: phone.index,
                length: phone.length,
                type: 'phone'
            });
            // Fixed bases per phone number (10 positions)
            bases.push(3, 100, 5, 10, 10, 10, 10, 10, 10, 10);
        }

        const totalBits = bases.reduce((sum, b) => sum + Math.log2(b), 0);

        return { totalBits, positions, bases };
    }

    encode(text, indices) {
        if (indices.length === 0) return text;

        const phones = this._findPhones(text);
        if (phones.length === 0) return text;

        // Process replacements in reverse order to preserve indices
        const replacements = [];
        let idx = 0;
        const POS_PER_PHONE = 10;

        for (const phone of phones) {
            if (idx + POS_PER_PHONE > indices.length) break;

            const prefix   = indices[idx] % 3;
            const opCode   = 900 + (indices[idx + 1] % 100);
            const sepStyle = indices[idx + 2] % 5;
            const d0 = indices[idx + 3] % 10;
            const d1 = indices[idx + 4] % 10;
            const d2 = indices[idx + 5] % 10;
            const d3 = indices[idx + 6] % 10;
            const d4 = indices[idx + 7] % 10;
            const d5 = indices[idx + 8] % 10;
            const d6 = indices[idx + 9] % 10;

            const newPhone = this._buildPhone(prefix, opCode, sepStyle, [d0, d1, d2, d3, d4, d5, d6]);
            replacements.push({
                index: phone.index,
                length: phone.length,
                replacement: newPhone
            });

            idx += POS_PER_PHONE;
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
        const phones = this._findPhones(stegoText);
        const indices = [];

        for (const phone of phones) {
            const p = this._parsePhone(phone.full);
            if (!p) continue; // Skip invalid phone formats

            indices.push(p.prefix);

            // opCode → index in 900-999 range
            const opIdx = this.OPERATOR_CODES.indexOf(p.opCode);
            indices.push(opIdx >= 0 ? opIdx : 0);

            indices.push(p.sepStyle);

            for (const d of p.digits) {
                indices.push(d);
            }
        }

        return indices;
    }

    /**
     * Вернуть спаны всех найденных телефонов для _excludedSpans механизма.
     * Позволяет другим каналам (spaces, punctuation и т.д.) исключать
     * регионы телефонов из своего анализа.
     */
    getSpans(text) {
        const phones = this._findPhones(text);
        return phones.map(p => ({ start: p.index, end: p.index + p.length }));
    }

    getStats() {
        return {
            name: this.name,
            loaded: true,
            operatorCodes: this.OPERATOR_CODES.length,
            formatStyles: this.FORMAT_STYLES.length,
            bitsPerPhone: Math.log2(3) + Math.log2(100) + Math.log2(5) + 7 * Math.log2(10)
        };
    }
}

export default PhonesChannel;
