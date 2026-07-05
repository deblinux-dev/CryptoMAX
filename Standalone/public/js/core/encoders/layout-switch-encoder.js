/**
 * Layout Switch Encoder
 * Simulates typing with the wrong keyboard layout (Russian ↔ English).
 * Like a simplified Punto Switcher.
 *
 * Can work WITHOUT encryption (just obfuscation).
 * With encryption: first encrypt, then layout-switch the result.
 *
 * ## Гибридный текст (v2)
 *
 * Поддержка сообщений, содержащих слова в разных раскладках:
 *   "Ghbdtn rfr ltkf? Z ctujlyz pfi`k yf пщщпду."
 *   → "Привет как дела? Я сегодня зашёл на google."
 *
 * Алгоритм: пословный анализ направления + умная обработка пунктуации.
 *
 * ## Проблема пунктуации
 *
 * На клавиатуре ЙЦУКЕН буква "б" находится на клавише "," (EN), буква "ю" —
 * на "." (EN), и т.д. Это создаёт неоднозначность при декодировании:
 *   - "," в EN-тексте может быть запятой (пунктуация) или буквой "б"
 *   - "?" в EN-тексте может быть вопросом (пунктуация) или запятой ","
 *     в RU (т.к. Shift+/ = ? в EN, = , в RU)
 *
 * Решение: контекстный анализ. Символы пунктуации, которые могут быть
 * буквами в целевой раскладке, конвертируются ТОЛЬКО если они окружены
 * буквами с обеих сторон (без пробелов). Это обеспечивает:
 *   - "ltkf?" → "дела?" (? в конце, не окружена → пунктуация)
 *   - "cj,frf" → "собака" (, между буквами → буква "б")
 *   - "Ghbdtn, rfr" → "Привет, как" (, перед пробелом → пунктуация)
 */

// Russian ЙЦУКЕН → English QWERTY mapping (lowercase)
const RU_TO_EN = {
    'й':'q','ц':'w','у':'e','к':'r','е':'t','н':'y','г':'u','ш':'i','щ':'o','з':'p','х':'[','ъ':']',
    'ф':'a','ы':'s','в':'d','а':'f','п':'g','р':'h','о':'j','л':'k','д':'l','ж':';','э':"'",
    'я':'z','ч':'x','с':'c','м':'v','и':'b','т':'n','ь':'m','б':',','ю':'.',
    'ё':'`',
    // Uppercase
    'Й':'Q','Ц':'W','У':'E','К':'R','Е':'T','Н':'Y','Г':'U','Ш':'I','Щ':'O','З':'P','Х':'{','Ъ':'}',
    'Ф':'A','Ы':'S','В':'D','А':'F','П':'G','Р':'H','О':'J','Л':'K','Д':'L','Ж':':','Э':'"',
    'Я':'Z','Ч':'X','С':'C','М':'V','И':'B','Т':'N','Ь':'M','Б':'<','Ю':'>',
    'Ё':'~',
    // Numbers row (same in both layouts, but some symbols differ)
    '1':'1','2':'2','3':'3','4':'4','5':'5','6':'6','7':'7','8':'8','9':'9','0':'0',
    '-':'-','=':'=',
    '!':'!','@':'@','#':'#','$':'$','%':'%','^':'^','&':'&','*':'*','(':'(',')':')',
    '_':'_','+':'+',
    ' ':' ','\n':'\n','\r':'\r','\t':'\t',
};

// Reverse: English QWERTY → Russian ЙЦУКЕН
const EN_TO_RU = {};
for (const [ru, en] of Object.entries(RU_TO_EN)) {
    if (!EN_TO_RU[en] || ru === ru.toLowerCase()) {
        // Prefer lowercase for reverse mapping, unless it's uppercase
        EN_TO_RU[en] = ru;
    }
}
// Ensure uppercase mappings too
for (const [ru, en] of Object.entries(RU_TO_EN)) {
    if (ru === ru.toUpperCase() && ru !== ru.toLowerCase()) {
        EN_TO_RU[en] = ru;
    }
}

// Russian letter detection pattern
const RU_PATTERN = /[а-яА-ЯёЁ]/;
const EN_PATTERN = /[a-zA-Z]/;
const LETTER_PATTERN = /[a-zA-Zа-яА-ЯёЁ]/;

// EN punctuation chars that map to RU letters (ambiguous: could be
// punctuation OR a letter in the target RU layout).
//
// Две категории неоднозначности:
//
// КАТЕГОРИЯ A (',', '.', ';', "'", '[', ']', '{', '}', '<', '>', ':', '"'):
//   Эти символы часто являются буквами в RU раскладке (б, ю, ж, э, х, ъ, ...).
//   Правило: конвертировать, если СЛЕДУЮЩИЙ символ — буква.
//   Это покрывает букву в начале и середине слова (,skj→было, cj,frf→собака).
//   Пунктуация в конце слова (после которой пробел/конец) сохраняется.
//   Ограничение: буква в самом конце слова (хлеб→[kt,→хле,) теряется —
//   это редкий компромисс (слова на б/ю/ж/э в конце немногочисленны).
//
// КАТЕГОРИЯ B ('?', '/'):
//   '?' → ',' (запятая RU) и '/' → '.' (точка RU) — почти всегда пунктуация.
//   Как буквы — только глубоко внутри слова (экстремально редкий случай).
//   Правило: конвертировать ТОЛЬКО если окружена буквами с обеих сторон.
//   Это сохраняет '?' в конце вопроса и '/' в URL/путях.
const AMBIGUOUS_PUNCT_A = new Set([
    ',', '.', ';', "'", '[', ']', '{', '}', '<', '>', ':', '"',
]);
const AMBIGUOUS_PUNCT_B = new Set(['?', '/']);
const AMBIGUOUS_PUNCT = new Set([...AMBIGUOUS_PUNCT_A, ...AMBIGUOUS_PUNCT_B]);

// Backtick and tilde: these map to ё/Ё. They are NOT punctuation in the
// traditional sense — they are layout-specific symbols. Always convert.
// (Trade-off: a real backtick in text becomes ё. Acceptable for chat.)

const MAGIC = '⌨️⇄:';

export default class LayoutSwitchEncoder {
    static get id()    { return 'layout-switch'; }
    static get label() { return 'Смена раскладки'; }
    static get icon()  { return '⌨️'; }

    static capacity(textLength) {
        // Same length as input (1:1 character mapping)
        return textLength * 8; // assuming UTF-8 bytes
    }

    /**
     * Encode: convert Russian text to English QWERTY equivalent
     * (as if user forgot to switch keyboard layout)
     * @param {Uint8Array} bytes - text data to encode
     * @returns {string}
     */
    static encode(bytes) {
        const text = new TextDecoder().decode(bytes);
        if (!text) return MAGIC;

        const encoded = _switchLayoutSmart(text, 'ru-to-en');
        return MAGIC + encoded;
    }

    /**
     * Encode string directly (no bytes conversion needed)
     * @param {string} text - Russian text
     * @param {boolean} withMagic - add magic prefix
     * @returns {string}
     */
    static encodeString(text, withMagic = true) {
        if (!text) return withMagic ? MAGIC : '';
        const encoded = _switchLayoutSmart(text, 'ru-to-en');
        return withMagic ? MAGIC + encoded : encoded;
    }

    /**
     * Decode: convert English QWERTY-typed text back to Russian
     * @param {string} text
     * @returns {Uint8Array|null}
     */
    static decode(text) {
        const decoded = LayoutSwitchEncoder.decodeToString(text);
        if (decoded === null) return null;
        return new TextEncoder().encode(decoded);
    }

    /**
     * Decode to string.
     *
     * Поддерживает гибридный текст (слова в разных раскладках) через
     * пословный анализ направления:
     *   - Слово только из латиницы → en→ru
     *   - Слово только из кириллицы → ru→en
     *   - Смешанное слово → оставить как есть
     *
     * @param {string} text
     * @returns {string|null}
     */
    static decodeToString(text) {
        if (!text) return null;

        let data = text;
        if (data.startsWith(MAGIC)) {
            data = data.slice(MAGIC.length);
        }

        // Быстрый путь: если нет ни латиницы, ни кириллицы — вернуть как есть
        const hasEn = EN_PATTERN.test(data);
        const hasRu = RU_PATTERN.test(data);
        if (!hasEn && !hasRu) return data;

        // Если только латиница — весь текст en→ru
        if (hasEn && !hasRu) {
            return _switchLayoutSmart(data, 'en-to-ru');
        }

        // Если только кириллица — весь текст ru→en
        if (hasRu && !hasEn) {
            return _switchLayoutSmart(data, 'ru-to-en');
        }

        // ГИБРИДНЫЙ ТЕКСТ: пословный анализ направления.
        // Разбиваем на токены (слова + разделители сохраняются).
        const tokens = data.split(/(\s+)/);
        let result = '';

        for (const token of tokens) {
            if (!token || /^\s+$/.test(token)) {
                result += token;
                continue;
            }

            const tokHasEn = EN_PATTERN.test(token);
            const tokHasRu = RU_PATTERN.test(token);

            if (tokHasEn && !tokHasRu) {
                // Чистая латиница → en→ru
                result += _switchLayoutSmart(token, 'en-to-ru');
            } else if (tokHasRu && !tokHasEn) {
                // Чистая кириллица → ru→en
                result += _switchLayoutSmart(token, 'ru-to-en');
            } else {
                // Смешанное (EN+RU в одном токене) — не трогаем
                result += token;
            }
        }

        return result;
    }

    /**
     * Detect layout switch encoding
     * ONLY detects by magic prefix — auto-detection by content
     * is too unreliable (normal English text, base64, etc. would false-positive).
     * Content-based direction detection is used only during decode.
     * @param {string} text
     * @returns {boolean}
     */
    static detect(text) {
        if (!text) return false;
        return text.startsWith(MAGIC);
    }

    /**
     * Switch layout without magic prefix (for non-encrypted mode)
     * @param {string} text
     * @returns {string}
     */
    static quickSwitch(text) {
        if (!text) return '';
        // Используем decodeToString для поддержки гибридного текста
        return LayoutSwitchEncoder.decodeToString(text) || text;
    }
}

// ─── Internal ───────────────────────────────────────────────

/**
 * Проверка, является ли символ буквой (латиница или кириллица).
 * @param {string} ch
 * @returns {boolean}
 */
function _isLetter(ch) {
    if (!ch) return false;
    return LETTER_PATTERN.test(ch);
}

/**
 * Умное переключение раскладки.
 *
 * Для ru→en: конвертирует все RU буквы в EN клавиши (включая б→, ю→. и т.д.).
 * Пунктуация и цифры остаются как есть.
 *
 * Для en→ru: конвертирует EN буквы в RU буквы. Символы пунктуации, которые
 * могут быть буквами в RU раскладке (, . ; ' [ ] { } < > : " / ?), конвертируются
 * ТОЛЬКО если они окружены буквами с обеих сторон (контекстный анализ).
 * Backtick (`) и тильда (~) всегда конвертируются в ё/Ё (это символы раскладки).
 *
 * @param {string} text
 * @param {'ru-to-en'|'en-to-ru'} direction
 * @returns {string}
 */
function _switchLayoutSmart(text, direction) {
    const map = direction === 'ru-to-en' ? RU_TO_EN : EN_TO_RU;
    let result = '';

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];

        if (ch in map) {
            // Для en→ru: проверяем неоднозначную пунктуацию
            if (direction === 'en-to-ru' && AMBIGUOUS_PUNCT.has(ch)) {
                const prevCh = i > 0 ? text[i - 1] : '';
                const nextCh = i < text.length - 1 ? text[i + 1] : '';

                if (AMBIGUOUS_PUNCT_B.has(ch)) {
                    // Категория B (?, /): строго — окружена буквами с обеих сторон
                    if (_isLetter(prevCh) && _isLetter(nextCh)) {
                        result += map[ch];
                    } else {
                        result += ch;
                    }
                } else {
                    // Категория A (, . ; ' [ ] { } < > : ""):
                    // Конвертировать, если СЛЕДУЮЩИЙ символ — буква.
                    // Это покрывает букву в начале/середине слова.
                    if (_isLetter(nextCh)) {
                        result += map[ch];
                    } else {
                        // Пунктуация в конце слова — оставить как есть
                        result += ch;
                    }
                }
            } else {
                // Буквы, backtick, тильда, цифры, пробелы — конвертируем
                result += map[ch];
            }
        } else {
            // Символа нет в карте — оставить как есть
            result += ch;
        }
    }

    return result;
}

/**
 * Простое переключение раскладки (без контекстного анализа пунктуации).
 * Сохранено для обратной совместимости — НЕ используется в новых методах.
 * @deprecated Используйте _switchLayoutSmart
 * @param {string} text
 * @param {'ru-to-en'|'en-to-ru'} direction
 * @returns {string}
 */
function _switchLayout(text, direction) {
    const map = direction === 'ru-to-en' ? RU_TO_EN : EN_TO_RU;
    let result = '';
    for (const ch of text) {
        result += map[ch] ?? ch;
    }
    return result;
}
