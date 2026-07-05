/**
 * Канал кодирования через ФИО (Фамилия Имя Отчество) — v3
 *
 * Принцип: находим в тексте теги [steg-fio] или существующие ФИО по паттерну
 * (3 заглавных русских слова подряд) и заменяем на сгенерированные из словаря
 * российские ФИО.
 *
 * Формат: Фамилия Имя Отчество (без кавычек — детекция по паттерну)
 *
 * Кодируемые компоненты (каждый = позиция в mixed-radix):
 *   1. Пол: мужской (0) | женский (1)  → base 2 (1 бит)
 *   2. Фамилия: индекс в словаре        → base surnameBase (varies)
 *   3. Имя: индекс в словаре            → base nameBase (varies)
 *   4. Отчество: индекс в словаре       → base patronymicBase (varies)
 *
 * Базы рассчитываются как min(мужской, женский) для имён и отчеств,
 * чтобы кодирование/декодирование было детерминированным
 * (без зависимости от пола, который сам является кодируемым значением).
 *
 * Изоляция каналов:
 *   - ФИО блоки ИСКЛЮЧИТЕЛЬНО обрабатываются каналом ФИО
 *   - Другие каналы (синонимы, пунктуация, ё, пробелы, letter-stego)
 *     пропускают позиции внутри ФИО блоков
 *   - Engine устанавливает _excludedSpans перед запуском каналов
 *
 * Детерминизм:
 *   - analyzeCapacity(carrier) видит [steg-fio] / ФИО → N слотов → N × 4 bases
 *   - analyzeCapacity(stego) видит ФИО → N ФИО → N × 4 bases
 *   - Оба возвращают одинаковое количество bases.
 *
 * Обнаружение ФИО:
 *   - Поддерживаются оба порядка слов:
 *     • Стандартный: Фамилия Имя Отчество ("Иванов Иван Иванович")
 *     • Обратный: Имя Отчество Фамилия ("Иван Иванович Иванов")
 *   - Проверка по словарю (pattern + dictionary) исключает ложные срабатывания
 *   - Кодирование ВСЕГДА выдаёт стандартный порядок (Фамилия Имя Отчество)
 */

// ─── Supplementary common surnames ──────────────────────────────
// Самые распространённые российские фамилии, которых нет в процедурном
// генераторе. Пары (мужская, женская) добавляются к словарю при загрузке.
const EXTRA_MALE_SURNAMES = [
    'Иванов','Петров','Сидоров','Смирнов','Кузнецов','Попов','Васильев',
    'Новиков','Фёдоров','Морозов','Волков','Алексеев','Лебедев','Семёнов',
    'Егоров','Павлов','Козлов','Степанов','Николаев','Орлов','Андреев',
    'Макаров','Никитин','Захаров','Зайцев','Соловьёв','Борисов','Яковлев',
    'Григорьев','Романов','Воробьёв','Сергеев','Кузьмин','Фролов',
    'Александров','Дмитриев','Королёв','Гусев','Киселёв','Ильин','Максимов',
    'Поляков','Сорокин','Виноградов','Ковалёв','Белов','Медведев','Антонов',
    'Тарасов','Жуков','Баранов','Филиппов','Мартынов','Осипов','Титов',
    'Комаров','Орлов','Киселёв','Михайлов','Пономарёв','Ефимов','Соболев',
    'Панфилов','Наумов','Карпов','Игнатьев','Зуев','Белоусов','Романов',
    'Герасимов','Кузьмин','Фомин','Данилов','Тимофеев','Щербаков',
    'Перов','Голубев','Виноградов','Богданов','Воронин','Филатов',
    'Давыдов','Григорьев','Беляев','Калинин','Рожков','Миронов',
    'Никонов','Савельев','Лазарев','Медведев','Ершов','Никонов',
    'Пирогов','Соболев','Третьяков','Горбачёв','Носов','Куликов',
    'Щербаков','Овчинников','Сорокин','Колесников','Куликов','Пономарёв',
    'Назаров','Суворов','Рыбаков','Герасимов','Котов','Власов',
    'Абрамов','Гусев','Беляев','Павлов','Лазарев','Макаров',
    'Быков','Суханов','Блинов','Ширяев','Фокин','Власов',
    'Марков','Зверев','Громов','Кудрявцев','Фёдоров','Лебедев',
    'Щукин','Пушкин','Лермонтов','Чехов','Толстой','Достоевский',
    'Гоголь','Тургенев','Есенин','Блок','Маяковский','Горький',
    'Пастернак','Булгаков','Набоков','Солженицын','Шолохов',
    'Паустовский','Платонов','Замятин','Белый','Бунин','Куприн',
    'Ахматова','Цветаева','Твардовский','Симонов','Исаковский',
    'Гумилёв','Есенин','Асеев','Багрицкий','Свирин','Катаев',
    'Фадеев','Шишков','Зощенко','Ильф','Петров','Олеша',
    'Каверин','Паустовский','Пришвин','Гайдар','Чуковский',
    'Маршак','Михалков','Барто','Остер','Успенский',
];

const EXTRA_FEMALE_SURNAMES = [
    'Иванова','Петрова','Сидорова','Смирнова','Кузнецова','Попова','Васильева',
    'Новикова','Фёдорова','Морозова','Волкова','Алексеева','Лебедева','Семёнова',
    'Егорова','Павлова','Козлова','Степанова','Николаева','Орлова','Андреева',
    'Макарова','Никитина','Захарова','Зайцева','Соловьёва','Борисова','Яковлева',
    'Григорьева','Романова','Воробьёва','Сергеева','Кузьмина','Фролова',
    'Александрова','Дмитриева','Королёва','Гусева','Киселёва','Ильина','Максимова',
    'Полякова','Сорокина','Виноградова','Ковалёва','Белова','Медведева','Антонова',
    'Тарасова','Жукова','Баранова','Филиппова','Мартынова','Осипова','Титова',
    'Комарова','Орлова','Киселёва','Михайлова','Пономарёва','Ефимова','Соболева',
    'Панфилова','Наумова','Карпова','Игнатьева','Зуева','Белоусова','Романова',
    'Герасимова','Кузьмина','Фомина','Данилова','Тимофеева','Щербакова',
    'Перова','Голубева','Виноградова','Богданова','Воронина','Филатова',
    'Давыдова','Григорьева','Беляева','Калинина','Рожкова','Миронова',
    'Никонова','Савельева','Лазарева','Медведева','Ершова','Никонова',
    'Пирогова','Соболева','Третьякова','Горбачёва','носова','Куликова',
    'Щербакова','Овчинникова','Сорокина','Колесникова','Куликова','Пономарёва',
    'Назарова','Суворова','Рыбакова','Герасимова','Котова','Власова',
    'Абрамова','Гусева','Беляева','Павлова','Лазарева','Макарова',
    'Быкова','Суханова','Блинова','Ширяева','Фокина','Власова',
    'Маркова','Зверева','Громова','Кудрявцева','Фёдорова','Лебедева',
    'Щукина','Пушкина','Лермонтова','Чехова','Толстая','Достоевская',
    'Гоголь','Тургенева','Есенина','Блок','Маяковская','Горькая',
    'Пастернак','Булгакова','Набокова','Солженицына','Шолохова',
    'Паустовская','Платонова','Замятина','Белая','Бунина','Куприна',
    'Ахматова','Цветаева','Твардовская','Симонова','Исаковская',
    'Гумилёва','Есенина','Асеева','Багрицкая','Свирина','Катаева',
    'Фадеева','Шишкова','Зощенко','Ильф','Петрова','Олеша',
    'Каверина','Паустовская','Пришвина','Гайдар','Чуковская',
    'Маршак','Михалкова','Барто','Остер','Успенская',
];

export class FioChannel {
    constructor() {
        this.name = 'fio';
        this.loaded = false;
        this._isTagBased = true;

        // Regex для поиска тегов в тексте-носителе
        this.TAG_REGEX = /\[steg-fio\]/g;

        // Dictionaries (loaded from data file, filtered + supplemented)
        this.maleNames = [];
        this.femaleNames = [];
        this.malePatronymics = [];
        this.femalePatronymics = [];
        this.maleSurnames = [];
        this.femaleSurnames = [];

        // Lookup maps for fast decoding
        this.maleNameMap = null;
        this.femaleNameMap = null;
        this.malePatronymicMap = null;
        this.femalePatronymicMap = null;
        this.maleSurnameMap = null;
        this.femaleSurnameMap = null;

        // Combined lookup maps: any patronymic → { gender, index }
        this.anyPatronymicMap = null;
        // Any name → { gender, index }
        this.anyNameMap = null;

        // Bases (calculated after loading)
        this.nameBase = 0;
        this.patronymicBase = 0;
        this.surnameBase = 0;
    }

    /**
     * Загрузка словарей из JSON-файла.
     * Фильтрует x-префиксные заглушки, добавляет распространённые фамилии,
     * рассчитывает базы (min по полу для имён и отчеств).
     */
    async loadDictionary(path) {
        try {
            const resp = await fetch(path);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();

            // ─── Фильтруем x-префиксные заглушки (только реальные имена/отчества) ───
            this.maleNames = (data.mn || []).filter(n => !n.startsWith('x'));
            this.femaleNames = (data.fn || []).filter(n => !n.startsWith('x'));
            this.malePatronymics = (data.mp || []).filter(p => !p.startsWith('x'));
            this.femalePatronymics = (data.fp || []).filter(p => !p.startsWith('x'));

            // Фамилии — все реальные (8192), но добавляем распространённые
            this.maleSurnames = [...(data.ms || [])];
            this.femaleSurnames = [...(data.fs || [])];

            // ─── Добавляем распространённые фамилии ───
            for (const s of EXTRA_MALE_SURNAMES) {
                if (!this.maleSurnames.includes(s)) {
                    this.maleSurnames.push(s);
                }
            }
            for (const s of EXTRA_FEMALE_SURNAMES) {
                if (!this.femaleSurnames.includes(s)) {
                    this.femaleSurnames.push(s);
                }
            }

            // ─── Сортируем словари ───
            this.maleSurnames.sort((a, b) => a.localeCompare(b, 'ru'));
            this.femaleSurnames.sort((a, b) => a.localeCompare(b, 'ru'));

            // ─── Рассчитываем базы (min по полу = гарантия детерминизма) ───
            this.nameBase = Math.min(this.maleNames.length, this.femaleNames.length);
            this.patronymicBase = Math.min(this.malePatronymics.length, this.femalePatronymics.length);
            this.surnameBase = Math.min(this.maleSurnames.length, this.femaleSurnames.length);

            // ─── Строим lookup-таблицы ───
            this.maleNameMap = new Map(this.maleNames.map((v, i) => [v, i]));
            this.femaleNameMap = new Map(this.femaleNames.map((v, i) => [v, i]));
            this.malePatronymicMap = new Map(this.malePatronymics.map((v, i) => [v, i]));
            this.femalePatronymicMap = new Map(this.femalePatronymics.map((v, i) => [v, i]));
            this.maleSurnameMap = new Map(this.maleSurnames.map((v, i) => [v, i]));
            this.femaleSurnameMap = new Map(this.femaleSurnames.map((v, i) => [v, i]));

            // Combined maps: для быстрого определения пола по слову
            this.anyPatronymicMap = new Map();
            for (const [v, i] of this.malePatronymicMap) this.anyPatronymicMap.set(v, { gender: 'm', index: i });
            for (const [v, i] of this.femalePatronymicMap) this.anyPatronymicMap.set(v, { gender: 'f', index: i });

            this.anyNameMap = new Map();
            for (const [v, i] of this.maleNameMap) this.anyNameMap.set(v, { gender: 'm', index: i });
            for (const [v, i] of this.femaleNameMap) this.anyNameMap.set(v, { gender: 'f', index: i });

            this.loaded = true;

            const totalBits = Math.log2(2) + Math.log2(this.surnameBase) + Math.log2(this.nameBase) + Math.log2(this.patronymicBase);
            console.log(
                `FioChannel: initialized — ` +
                `${this.maleNames.length}+${this.femaleNames.length} names (base=${this.nameBase}), ` +
                `${this.malePatronymics.length}+${this.femalePatronymics.length} patronymics (base=${this.patronymicBase}), ` +
                `${this.maleSurnames.length}+${this.femaleSurnames.length} surnames (base=${this.surnameBase}) ` +
                `(~${totalBits.toFixed(1)} bits/FIO)`
            );
        } catch (e) {
            console.error('FioChannel: failed to load dictionary:', e);
            this.loaded = false;
        }
    }

    // ─── Span helpers ───────────────────────────────────────────

    /**
     * Получить спаны ФИО-блоков в тексте (для эксклюзии другими каналами).
     * Возвращает массив { start, end } для engine._excludedSpans.
     * @param {string} text
     * @returns {{ start: number, end: number }[]}
     */
    getFioSpans(text) {
        if (!this.loaded) return [];
        const matches = this._findMatches(text);
        return matches.map(m => ({
            start: m.index,
            end: m.index + m.length,
        }));
    }

    // ─── Internal matching ──────────────────────────────────────

    /**
     * Найти все теги [steg-fio] и ФИО-паттерны в тексте.
     * Поддерживает оба порядка слов: стандартный и обратный.
     *
     * Алгоритм:
     * 1. Находим все заглавные русские слова с проверкой границ
     * 2. Группируем последовательные слова (разделённые пробелами)
     * 3. Скользим окном по 3 слова по каждой группе
     * 4. Верифицируем каждое окно по словарю (оба порядка)
     * 5. Разрешаем пересечения (левый выигрывает)
     */
    _findMatches(text) {
        const matches = [];

        // 1. Найти теги [steg-fio]
        this.TAG_REGEX.lastIndex = 0;
        let m;
        while ((m = this.TAG_REGEX.exec(text)) !== null) {
            matches.push({
                index: m.index,
                length: m[0].length,
                full: m[0],
                type: 'tag'
            });
        }

        // 2. Найти все слова с заглавной русской буквы
        //    Границы: до и после слова — НЕ русская/латинская буква
        const wordRe = /[А-ЯЁ][а-яё]{1,}/g;
        const words = [];
        while ((m = wordRe.exec(text)) !== null) {
            const before = m.index > 0 ? text[m.index - 1] : '';
            const afterChar = m.index + m[0].length < text.length ? text[m.index + m[0].length] : '';
            // Пропускаем если слово — часть более длинного слова
            if (/[А-ЯЁа-яёA-Za-z]/.test(before)) continue;
            if (/[А-ЯЁа-яёA-Za-z]/.test(afterChar)) continue;
            words.push({
                word: m[0],
                index: m.index,
                end: m.index + m[0].length
            });
        }

        // 3. Группируем последовательные слова (разделённые пробелами/табами)
        const groups = [];
        let currentGroup = [];
        for (const w of words) {
            if (currentGroup.length === 0) {
                currentGroup.push(w);
            } else {
                const prev = currentGroup[currentGroup.length - 1];
                const gap = text.slice(prev.end, w.index);
                if (/^[ \t]+$/.test(gap)) {
                    currentGroup.push(w);
                } else {
                    if (currentGroup.length >= 3) groups.push([...currentGroup]);
                    currentGroup = [w];
                }
            }
        }
        if (currentGroup.length >= 3) groups.push([...currentGroup]);

        // 4. Скользим окном по 3 слова, верифицируем по словарю
        const verifiedMatches = [];
        for (const group of groups) {
            for (let i = 0; i <= group.length - 3; i++) {
                const w1 = group[i], w2 = group[i + 1], w3 = group[i + 2];

                // Пробуем стандартный порядок: Фамилия Имя Отчество
                const stdOrder = this._tryVerify(w1.word, w2.word, w3.word);
                // Пробуем обратный порядок: Имя Отчество Фамилия
                const revOrder = stdOrder ? null : this._tryVerify(w3.word, w1.word, w2.word);

                if (stdOrder || revOrder) {
                    verifiedMatches.push({
                        index: w1.index,
                        end: w3.end,
                        length: w3.end - w1.index,
                        full: text.slice(w1.index, w3.end),
                        surname: stdOrder ? w1.word : w3.word,
                        name: stdOrder ? w2.word : w1.word,
                        patronymic: stdOrder ? w3.word : w2.word,
                        type: 'fio',
                        order: stdOrder ? 'standard' : 'reverse'
                    });
                }
            }
        }

        // 5. Разрешаем пересечения (левый выигрывает)
        verifiedMatches.sort((a, b) => a.index - b.index);
        let lastEnd = -1;
        for (const vm of verifiedMatches) {
            // Пропускаем пересечения с тегами
            const overlapsTag = matches.some(t =>
                (vm.index >= t.index && vm.index < t.index + t.length) ||
                (vm.end > t.index && vm.end <= t.index + t.length)
            );
            if (overlapsTag) continue;
            // Пропускаем пересечения с уже принятым ФИО
            if (vm.index < lastEnd) continue;
            matches.push(vm);
            lastEnd = vm.end;
        }

        // 6. Сортируем ВСЕ матчи по индексу (теги + ФИО)
        //    КРИТИЧЕСКО: encode() применяет замены в обратном порядке (от конца к началу).
        //    Это работает ТОЛЬКО если матчи отсортированы по возрастанию индекса —
        //    тогда reverse loop начинается с самого правого матча и сдвигает текст
        //    только для младших индексов, которые ещё не обработаны.
        //    Без сортировки тег (индекс 21) может быть перед ФИО (индекс 0) в массиве,
        //    и reverse loop сначала применит замену по индексу 0, сдвинув позиции.
        matches.sort((a, b) => a.index - b.index);

        return matches;
    }

    /**
     * Проверить что surname/name/patronymic (в стандартном порядке) есть в словаре.
     * Проверяет оба пола.
     * @returns {{ gender: 'm'|'f', surnameIdx: number, nameIdx: number, patronymicIdx: number }|null}
     */
    _tryVerify(surname, name, patronymic) {
        // Мужской пол
        const msIdx = this.maleSurnameMap.get(surname);
        const mnIdx = this.maleNameMap.get(name);
        const mpIdx = this.malePatronymicMap.get(patronymic);
        if (msIdx !== undefined && mnIdx !== undefined && mpIdx !== undefined) {
            return { gender: 'm', surnameIdx: msIdx, nameIdx: mnIdx, patronymicIdx: mpIdx };
        }

        // Женский пол
        const fsIdx = this.femaleSurnameMap.get(surname);
        const fnIdx = this.femaleNameMap.get(name);
        const fpIdx = this.femalePatronymicMap.get(patronymic);
        if (fsIdx !== undefined && fnIdx !== undefined && fpIdx !== undefined) {
            return { gender: 'f', surnameIdx: fsIdx, nameIdx: fnIdx, patronymicIdx: fpIdx };
        }

        return null;
    }

    // ─── Build / Parse ──────────────────────────────────────────

    /**
     * Построить строку ФИО по индексам.
     * ВСЕГДА выдаёт стандартный порядок: Фамилия Имя Отчество
     */
    _buildFio(genderIdx, surnameIdx, nameIdx, patronymicIdx) {
        const isMale = genderIdx === 0;
        const surname = isMale
            ? this.maleSurnames[surnameIdx % this.maleSurnames.length]
            : this.femaleSurnames[surnameIdx % this.femaleSurnames.length];
        const name = isMale
            ? this.maleNames[nameIdx % this.maleNames.length]
            : this.femaleNames[nameIdx % this.femaleNames.length];
        const patronymic = isMale
            ? this.malePatronymics[patronymicIdx % this.malePatronymics.length]
            : this.femalePatronymics[patronymicIdx % this.femalePatronymics.length];
        return `${surname} ${name} ${patronymic}`;
    }

    /**
     * Разобрать ФИО (стандартный порядок: Фамилия Имя Отчество) обратно в индексы.
     * Возвращает null если слова не найдены в словаре.
     */
    _parseFio(surname, name, patronymic) {
        // Мужской пол
        const msIdx = this.maleSurnameMap.get(surname);
        const mnIdx = this.maleNameMap.get(name);
        const mpIdx = this.malePatronymicMap.get(patronymic);
        if (msIdx !== undefined && mnIdx !== undefined && mpIdx !== undefined) {
            return { genderIdx: 0, surnameIdx: msIdx, nameIdx: mnIdx, patronymicIdx: mpIdx };
        }

        // Женский пол
        const fsIdx = this.femaleSurnameMap.get(surname);
        const fnIdx = this.femaleNameMap.get(name);
        const fpIdx = this.femalePatronymicMap.get(patronymic);
        if (fsIdx !== undefined && fnIdx !== undefined && fpIdx !== undefined) {
            return { genderIdx: 1, surnameIdx: fsIdx, nameIdx: fnIdx, patronymicIdx: fpIdx };
        }

        return null;
    }

    // ─── Channel API ───────────────────────────────────────────

    analyzeCapacity(text) {
        if (!this.loaded) return { totalBits: 0, positions: [], bases: [] };

        const matches = this._findMatches(text);
        if (matches.length === 0) return { totalBits: 0, positions: [], bases: [] };

        const positions = [];
        const bases = [];

        for (const match of matches) {
            positions.push({
                index: match.index,
                length: match.length,
                type: match.type,
                word: match.full,
            });
            // Базы: gender(2) + surname(surnameBase) + name(nameBase) + patronymic(patronymicBase)
            bases.push(2, this.surnameBase, this.nameBase, this.patronymicBase);
        }

        const totalBits = bases.reduce((sum, b) => sum + Math.log2(b), 0);
        return { totalBits, positions, bases };
    }

    encode(text, indices) {
        if (!this.loaded || indices.length === 0) return text;

        const matches = this._findMatches(text);
        if (matches.length === 0) return text;

        const POS_PER_FIO = 4;
        const replacements = [];
        let idx = 0;

        for (const match of matches) {
            if (idx + POS_PER_FIO > indices.length) break;

            const genderIdx = indices[idx] % 2;
            const surnameIdx = indices[idx + 1] % this.surnameBase;
            const nameIdx = indices[idx + 2] % this.nameBase;
            const patronymicIdx = indices[idx + 3] % this.patronymicBase;

            const newFio = this._buildFio(genderIdx, surnameIdx, nameIdx, patronymicIdx);
            replacements.push({
                index: match.index,
                length: match.length,
                replacement: newFio
            });

            idx += POS_PER_FIO;
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
            if (match.type !== 'fio') continue;

            // Для декодирования важны surname, name, patronymic (в стандартном порядке)
            // Поскольку кодирование ВСЕГДА выдаёт стандартный порядок,
            // декодер тоже ищет стандартный порядок.
            const p = this._parseFio(match.surname, match.name, match.patronymic);
            if (!p) continue;

            indices.push(p.genderIdx, p.surnameIdx, p.nameIdx, p.patronymicIdx);
        }

        return indices;
    }

    getStats() {
        return {
            name: this.name,
            loaded: this.loaded,
            maleNames: this.maleNames.length,
            femaleNames: this.femaleNames.length,
            malePatronymics: this.malePatronymics.length,
            femalePatronymics: this.femalePatronymics.length,
            maleSurnames: this.maleSurnames.length,
            femaleSurnames: this.femaleSurnames.length,
            nameBase: this.nameBase,
            patronymicBase: this.patronymicBase,
            surnameBase: this.surnameBase,
            positionsPerFio: 4,
            bitsPerFio: Math.log2(2) + Math.log2(this.surnameBase) + Math.log2(this.nameBase) + Math.log2(this.patronymicBase),
        };
    }
}

export default FioChannel;
