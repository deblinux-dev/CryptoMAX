/**
 * Канал кодирования через слова-паразиты — v2 (REPLACE-подход)
 *
 * ## Принцип
 * Вместо вставки/удаления паразитов (которое ломает позиции),
 * ЗАМЕНЯЕМ уже существующие слова-паразиты на другие из той же группы.
 *
 * Каждая группа содержит взаимозаменяемые вводные слова/междометия,
 * которые не несут смысловой нагрузки. Замена одного на другое
 * практически не меняет смысла текста.
 *
 * ## Безопасность (SAFE_DEFAULT_GROUPS)
 * Все группы отфильтрованы от слов, которые:
 * - Могут быть сказуемыми, наречиями или дополнениями ("вообще не пьёт", "по факту")
 * - Являются глаголами с прямым действием ("надо сказать правду", "стоит отметить праздник")
 * - Являются наречиями образа действия ("заодно", "параллельно")
 * - Могут быть обстоятельством места ("с другой стороны")
 * - Являются степенями сравнения ("точнее", "вернее")
 * - Являются краткими прилагательными ("очевидно", "естественно")
 *
 * ## Детерминизм
 * - encode: находим паразит в тексте → определяем группу → заменяем на group[index]
 * - decode: находим паразит в тексте → определяем группу → возвращаем индекс в группе
 * - Количество матчей одинаково при encode и decode (REPLACE, не INSERT)
 * - Длина текста может меняться, но REPLACE сохраняет число "слотов"
 *
 * ## Многокомпонентные паразиты
 * Многие паразиты содержат пробелы ("в общем", "по сути").
 * Они корректно обрабатываются — regex ищет точное совпадение с границами слов.
 *
 * ## Эксклюзия
 * Синонимы не трогают слова-паразиты (через _excludedSpans/getSpans).
 */

// ─── Группы взаимозаменяемых паразитов (БЕЗОПАСНЫЕ) ─────────
// Все слова отфильтрованы: убраны глаголы, наречия, дополнения,
// обстоятельства, краткие прилагательные — только чистые вводные.
const SAFE_DEFAULT_GROUPS = [
    // Группа 0: Общие слова-заполнители
    // Убраны "вообще" (наречие "вообще не пьет") и "по факту" (оплата по факту).
    ['в целом', 'по сути', 'в сущности', 'по большому счету', 'в принципе', 'в общем-то', 'по сути дела'],

    // Группа 1: Неустойчивость/неуверенность
    // Убраны: возможно, вероятно (могут быть сказуемыми), должно быть (глагол), кажется (глагол).
    ['вроде бы', 'пожалуй', 'видимо', 'наверное', 'скорее всего', 'по всей видимости'],

    // Группа 2: Признание/откровенность
    // Убраны: признаться, надо признаться, скажу прямо (это глаголы с прямым действием).
    ['честно говоря', 'откровенно говоря', 'по правде говоря', 'если честно', 'положа руку на сердце'],

    // Группа 3: Переход/отступление
    // Убраны: да, и еще, заодно (заодно - это наречие образа действия).
    ['кстати', 'между прочим', 'к слову', 'кстати говоря', 'кстати сказать', 'к слову сказать'],

    // Группа 4: Подчеркивание реальности
    // Убраны: фактически, реально (наречия: "выглядит вполне реально"). Оставлено "действительно", так как оно почти всегда частица/вводное.
    ['действительно', 'на самом деле', 'в действительности', 'в самом деле', 'поистине'],

    // Группа 5: Обобщение / Перефразирование
    // Убраны: в двух словах, одним словом ("ответь одним словом" - дополнение).
    ['в общем', 'короче говоря', 'иными словами', 'иначе говоря', 'другими словами', 'проще говоря'],

    // Группа 6: Противопоставление (Уступка)
    // Убрано: с другой стороны ("подойди с другой стороны" - обстоятельство места).
    ['впрочем', 'однако же', 'всё же', 'все же', 'всё-таки', 'все-таки', 'однако', 'тем не менее', 'при всем при том'],

    // Группа 7: Подтверждение / Акцентирование внимания
    // ПОЛНАЯ ЗАЧИСТКА. Были сплошные глаголы ("надо сказать правду", "стоит отметить праздник"). Заменены на безопасные вводные.
    ['справедливости ради', 'как ни крути', 'что и говорить'],

    // Группа 9: Вводные конструкции (Идиоматические)
    // Убраны глаголы: знаете ли, понимаете ли, видите ли, согласитесь, представьте себе.
    ['так сказать', 'как говорится'],

    // Группа 10: Модальные вводные (Субъективное мнение)
    // Убраны: я считаю ("я считаю до 10"), мне кажется ("это мне кажется странным").
    ['по-моему', 'на мой взгляд', 'как мне кажется', 'по моему мнению', 'с моей точки зрения'],

    // Группа 11: Уверенность (Абсолютная)
    // Убраны: само собой, естественно, очевидно, бесспорно, разумеется (опасные краткие прилагательные и наречия).
    ['безусловно', 'несомненно', 'конечно же', 'без сомнения', 'вне сомнений'],

    // Группа 12: Уточнение (Корректировка сказанного)
    // Убраны: точнее, вернее (степени сравнения).
    ['точнее говоря', 'а точнее', 'если точнее', 'вернее сказать', 'более того'],

    // Группа 13: Нейтральные связки (Логический вывод)
    // Убраны: значит, выходит ("он выходит"), таким образом ("сделал таким образом"), в итоге ("в итоге матча").
    ['следовательно', 'итак', 'стало быть', 'в конечном счете'],

    // Группа 14: Оценка логичности
    // ПОЛНАЯ ЗАМЕНА. Исходные слова (понятно, ясно, логично, разумно) — это сказуемые или наречия. Заменены на вводные конструкции того же смысла.
    ['как и следовало ожидать', 'что вполне логично', 'по понятным причинам', 'как и предполагалось'],

    // Группа 15: Оценочные (Негативные эмоции / Сожаление)
    // Убрано: на беду ("оставил на беду").
    ['к сожалению', 'к несчастью', 'к огорчению', 'как назло', 'увы'],

    // Группа 16: Оценочные (Позитивные эмоции / Радость)
    // Убрано: на радость ("пели на радость людям").
    ['к счастью', 'к радости', 'к удаче', 'по счастливой случайности'],

    // Группа 17: Временные связки (Параллельность действий)
    // Убрано: параллельно ("линии идут параллельно").
    ['тем временем', 'в то же время', 'между тем', 'вместе с тем', 'наряду с этим'],

    // Группа 18: Уточняющие частицы
    // ЗАЧИЩЕНО. Исходные (именно, как раз, ровно, точно) намертво встроены в синтаксис. Оставлены только безопасные усилители.
    ['прямо-таки', 'просто-напросто'],

    // Группа 19: Разговорное согласие
    // Убраны: верно ("решил верно"), точно ("попал точно"), в точку ("попал в точку").
    ['конечно', 'вот именно', 'ага', 'сто процентов'],
];

// ─── Построение индексов ─────────────────────────────────────
function buildIndex(groups) {
    const memberToGroup = new Map();   // memberLower → { groupIdx, memberIdx }
    const allMembers = [];             // flat list of all members (for backward compat)
    const groupSizes = [];             // groupSizes[i] = groups[i].length

    for (let gi = 0; gi < groups.length; gi++) {
        const group = groups[gi];
        groupSizes.push(group.length);
        for (let mi = 0; mi < group.length; mi++) {
            const member = group[mi];
            const key = member.toLowerCase();
            // Если слово встречается в нескольких группах — оставляем только первое вхождение
            if (!memberToGroup.has(key)) {
                memberToGroup.set(key, { groupIdx: gi, memberIdx: mi });
                allMembers.push(member);
            }
        }
    }

    return { memberToGroup, allMembers, groupSizes, groups };
}

export class ParasitesChannel {
    constructor() {
        this.name = 'parasites';
        this.loaded = false;
        this._index = null; // built by loadDictionary
    }

    async loadDictionary(path = './data/parasites.json') {
        try {
            const response = await fetch(path);
            const data = await response.json();

            // Новый формат: массив групп
            if (Array.isArray(data) && data.length > 0 && Array.isArray(data[0])) {
                this._index = buildIndex(data);
                this.loaded = true;
                const total = this._index.allMembers.length;
                console.log(`[parasites] Loaded ${data.length} groups, ${total} words (REPLACE mode)`);
                return;
            }

            // Старый формат: плоский массив строк
            if (Array.isArray(data)) {
                const groups = data.map(w => [w]); //每组只有一个成员 → 没有替换可能
                this._index = buildIndex(SAFE_DEFAULT_GROUPS); // 使用默认组
                this.loaded = true;
                console.log(`[parasites] Old format detected, using ${SAFE_DEFAULT_GROUPS.length} default groups`);
                return;
            }

            // JSON объект с полем "groups"
            if (data && Array.isArray(data.groups)) {
                this._index = buildIndex(data.groups);
                this.loaded = true;
                console.log(`[parasites] Loaded ${data.groups.length} groups from data.groups`);
                return;
            }
        } catch (e) {
            console.warn('[parasites] Failed to load dictionary, using defaults:', e.message);
        }

        // 内置默认值
        this._index = buildIndex(SAFE_DEFAULT_GROUPS);
        this.loaded = true;
        console.log(`[parasites] Using ${SAFE_DEFAULT_GROUPS.length} built-in groups (${this._index.allMembers.length} words)`);
    }

    // ─── Поиск паразитов в тексте ──────────────────────────────

    /**
     * Найти все вхождения слов-паразитов в тексте.
     * Для каждого вхождения определяем группу и индекс внутри группы.
     * Фильтруем перекрытия (последний символ первого не должен пересекаться с началом второго).
     * Уважаем _excludedSpans (не ищем внутри защищённых зон).
     */
    _findMatches(text) {
        if (!this._index) return [];
        const { memberToGroup, groups } = this._index;
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

        // Ищем каждое слово-паразит (сортируем по длине DESC для приоритета длинных)
        const allEntries = [...memberToGroup.entries()].sort((a, b) => b[0].length - a[0].length);

        for (const [memberLower, info] of allEntries) {
            const escaped = this._escapeRegex(memberLower).replace(/ /g, '\\s');
            // Границы: не должно быть кириллической/латинской буквы до/после
            const re = new RegExp(`(?<![а-яёА-ЯЁa-zA-Z])${escaped}(?![а-яёА-ЯЁa-zA-Z])`, 'gi');
            let m;
            while ((m = re.exec(text)) !== null) {
                if (isExcluded(m.index, m.index + m[0].length)) continue;
                matches.push({
                    index: m.index,
                    length: m[0].length,
                    groupIdx: info.groupIdx,
                    memberIdx: info.memberIdx,
                    groupSize: groups[info.groupIdx].length,
                    found: m[0],
                    group: groups[info.groupIdx]
                });
            }
        }

        // Сортируем по позиции, убираем перекрытия
        matches.sort((a, b) => a.index - b.index);
        const filtered = [];
        let lastEnd = -1;
        for (const match of matches) {
            if (match.index >= lastEnd) {
                filtered.push(match);
                lastEnd = match.index + match.length;
            }
        }
        return filtered;
    }

    // ─── Channel API ──────────────────────────────────────────

    analyzeCapacity(text) {
        if (!this.loaded) return { totalBits: 0, positions: [], bases: [] };
        const matches = this._findMatches(text);
        if (matches.length === 0) return { totalBits: 0, positions: [], bases: [] };

        const positions = matches.map(m => ({
            index: m.index,
            length: m.length,
            groupIdx: m.groupIdx,
            memberIdx: m.memberIdx,
            variants: m.groupSize,
            word: m.found
        }));

        const totalBits = positions.reduce((s, p) => s + Math.log2(p.variants), 0);
        return { totalBits, positions, bases: positions.map(p => p.variants) };
    }

    encode(text, indices) {
        if (!this.loaded || !indices || indices.length === 0) return text;
        const matches = this._findMatches(text);
        if (matches.length === 0) return text;

        const { groups } = this._index;
        const toReplace = [];

        for (let i = 0; i < Math.min(matches.length, indices.length); i++) {
            const m = matches[i];
            const group = groups[m.groupIdx];
            const targetIdx = indices[i] % m.groupSize;
            let replacement = group[targetIdx];

            // Сохраняем регистр первой буквы оригинала
            if (m.found[0] !== m.found[0].toLowerCase()) {
                replacement = replacement.charAt(0).toUpperCase() + replacement.slice(1);
            }
            if (m.found === m.found.toUpperCase()) {
                replacement = replacement.toUpperCase();
            }

            toReplace.push({ index: m.index, length: m.length, replacement });
        }

        // Применяем замены в обратном порядке (с конца текста)
        toReplace.sort((a, b) => b.index - a.index);
        let result = text;
        for (const r of toReplace) {
            result = result.slice(0, r.index) + r.replacement + result.slice(r.index + r.length);
        }
        return result;
    }

    /**
     * Декодирование: для каждого паразита в тексте определяем
     * его группу и позицию внутри группы → индекс.
     */
    decode(stegoText) {
        if (!this.loaded) return [];
        const matches = this._findMatches(stegoText);
        return matches.map(m => m.memberIdx);
    }

    /**
     * Возвращает спаны найденных паразитов для эксклюзии.
     * Синонимы и letter-stego не будут модифицировать эти области.
     */
    getSpans(text) {
        if (!this.loaded) return [];
        const matches = this._findMatches(text);
        return matches.map(m => ({ start: m.index, end: m.index + m.length }));
    }

    _escapeRegex(str) {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    getStats() {
        if (!this._index) return { name: this.name, loaded: this.loaded };
        return {
            name: this.name,
            loaded: this.loaded,
            groups: this._index.groups.length,
            words: this._index.allMembers.length,
            mode: 'replace'
        };
    }
}

export default ParasitesChannel;
