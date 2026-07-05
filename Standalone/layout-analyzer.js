/**
 * LayoutAnalyzer — умный лингвистический анализатор неверной раскладки.
 *
 * Модуль Electron-прослойки (не ядро Стегонатора).
 *
 * Назначение
 * ----------
 * Определить, набрано ли сообщение в неверной раскладке (русский текст в
 * EN-раскладке или английский — в RU-раскладке), и вернуть декодированный
 * текст. Заменяет собой наивный regex-фильтр `!hasCyrillic && !isBase64Like`
 * в engine-loader.js --> autoDecode (блок 3), который не учитывал:
 *   - URL и email в сообщении (не должны переключаться),
 *   - английские слова/аббревиатуры, вставленные в русский текст,
 *   - base64/hex-токены и идентификаторы (AES-ciphertext и т.п.),
 *   - смешанные сообщения (переключаться должны только «подозрительные»
 *     слова, а нормальные EN/RU слова и URL — сохраняться),
 *   - короткие слова и междометия, которые невозможно надёжно классифицировать.
 *
 * Алгоритм
 * --------
 * 1. Сообщение целиком — pure base64url-блоб (≥20 символов без пробелов)?
 *    Не анализируем (это AES-256 территория, блок 2 autoDecode).
 * 2. Защищаем URL и email плейсхолдерами — они не анализируются и не
 *    переключаются.
 * 3. Токенизация по пробелам (разделители сохраняются).
 * 4. Для каждого токена:
 *    - пустой / только-пробелы / только-цифры-пунктуация --> пропустить;
 *    - base64/hex-токен (≥24 символа) --> пропустить;
 *    - короткое EN-слово из whitelist (id, js, npm, www, ...) --> пропустить;
 *    - смешанное (EN+RU в одном токене) --> пропустить;
 *    - латиница --> оценить как «возможно русский в EN»;
 *    - кириллица --> оценить как «возможно английский в RU».
 * 5. Лингвистический скоринг слова:
 *    - vowel ratio в исходной раскладке (RU-в-EN даёт очень мало EN-гласных,
 *      т.к. русские гласные а/о/е/и/ы попадают на согласные f/j/t/b/s),
 *    - vowel ratio в целевой раскладке (должен восстановиться),
 *    - невозможные в EN биграммы/триграммы (cz=ся, jq=ой, bq=ий, ysq=ый,
 *      ghb=при, rfr=как, ytn=нет, ltk=дел, и т.п.),
 *    - кластеры из 5+ согласных подряд (аномалия для EN),
 *    - для RU-->EN: консервативные маркеры (сщ=so, ыф=sa, ...) и требование,
 *      что EN-вариант явно «лучше».
 * 6. Решение на уровне слова: переключить, если суммарный score ≥ порога
 *    И целевая раскладка «лучше» исходной (vowel ratio выше с запасом).
 * 7. Решение на уровне сообщения: переключить, если ≥1 слово переключено
 *    И доля переключённых слов от анализируемых ≥ 30% (для однословного
 *    сообщения достаточно 1 переключения).
 *
 * Экспорт:
 *   LayoutAnalyzer.analyze(text)
 *     --> { isChanged: boolean, resultText: string,
 *           stats: { total, switched, ratio, reasons: string[] } }
 *   LayoutAnalyzer.evaluateWord(word)
 *     --> { shouldSwitch, targetLang, converted, score, reason }
 *   LayoutAnalyzer.convertText(text, toRussian)
 *     --> string
 */

// Карты раскладок (ЙЦУКЕН ↔ QWERTY)
const EN_TO_RU = {
    'q': 'й', 'w': 'ц', 'e': 'у', 'r': 'к', 't': 'е', 'y': 'н', 'u': 'г',
    'i': 'ш', 'o': 'щ', 'p': 'з', '[': 'х', ']': 'ъ',
    'a': 'ф', 's': 'ы', 'd': 'в', 'f': 'а', 'g': 'п', 'h': 'р', 'j': 'о',
    'k': 'л', 'l': 'д', ';': 'ж', "'": 'э',
    'z': 'я', 'x': 'ч', 'c': 'с', 'v': 'м', 'b': 'и', 'n': 'т', 'm': 'ь',
    ',': 'б', '.': 'ю', '/': '.',
    'Q': 'Й', 'W': 'Ц', 'E': 'У', 'R': 'К', 'T': 'Е', 'Y': 'Н', 'U': 'Г',
    'I': 'Ш', 'O': 'Щ', 'P': 'З', '{': 'Х', '}': 'Ъ',
    'A': 'Ф', 'S': 'Ы', 'D': 'В', 'F': 'А', 'G': 'П', 'H': 'Р', 'J': 'О',
    'K': 'Л', 'L': 'Д', ':': 'Ж', '"': 'Э',
    'Z': 'Я', 'X': 'Ч', 'C': 'С', 'V': 'М', 'B': 'И', 'N': 'Т', 'M': 'Ь',
    '<': 'Б', '>': 'Ю', '?': ',',
    '`': 'ё', '~': 'Ё',
    '@': '"', '#': '№', '$': ';', '^': ':', '&': '?',
};

const RU_TO_EN = {};
for (const [en, ru] of Object.entries(EN_TO_RU)) {
    // Первое (обычно строчное) соответствие выигрывает; заглавные добавляем
    // только если строчного ещё нет — это сохраняет регистр при обратном
    // преобразовании для пар типа 'й'-->q и 'Й'-->Q.
    if (!(ru in RU_TO_EN)) {
        RU_TO_EN[ru] = en;
    }
}
// Дописываем заглавные явно, чтобы 'Й'-->Q, 'Ц'-->W, ...
for (const [en, ru] of Object.entries(EN_TO_RU)) {
    if (en >= 'A' && en <= 'Z') {
        RU_TO_EN[ru] = en;
    }
}

const RU_VOWELS = 'аеёиоуыэюяАЕЁИОУЫЭЮЯ';
const EN_VOWELS = 'aeiouyAEIOUY';

// Паттерны исключений
const URL_RE = /https?:\/\/[^\s<>"']+/gi;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// base64/base64url/hex-токен: длинная сплошная строка без пробелов.
// AES-256-GCM ciphertext в base64url — минимум ~42 символа (31 байт × 4/3),
// так что порог 24 безопасно отсекает и base64, и hex-хэши, и UUID-ы без дефисов.
const BASE64_TOKEN_RE = /^[A-Za-z0-9+/_=\-]{24,}$/;
const HEX_TOKEN_RE = /^(0x)?[0-9a-fA-F]{16,}$/;
// Pure base64url-блоб на ВСЁ сообщение (для быстрого выхода в autoDecode).
const WHOLE_BASE64_RE = /^[A-Za-z0-9_-]{20,}$/;

// Невозможные в EN биграммы/триграммы (маркеры RU-в-EN)
// Эти сочетания не встречаются в реальных английских словах, но естественно
// возникают при наборе русского текста в EN-раскладке:
//   cz=ся, jq=ой, bq=ий, ysq=ый, yfz=ная, rfr=как, ytn=нет, xtn=чен,
//   ghb=при, ghbd=прив, xtk=дел, yb=ны, df=ва, cj=со, ltk=дел, kj=ло
// ВНИМАНИЕ: 'ty', 'lf', 'ct' убраны — они встречаются в реальных EN словах
// (fifty, self, act). Оставлены только гарантированно невозможные в EN.
const RU_IN_EN_MARKERS_RE = /(?:cz|jq|bq|ysq|yfz|rfr|ytn|xtn|ghb|ghbd|xtk|yb|df|cj|ltk|kj)/i;

// Окончания-маркеры (только в конце слова)
// Русские морфемные окончания, которые в EN-раскладке дают невозможные
// для реальных английских слов концовки:
//   ый --> sq,   ая --> fz,   ое --> jt,   ть --> nm,   ие --> bt
// 'sq' безопасно: в EN "sq" встречается только как "squ" (square, squad),
// т.е. никогда в самом конце слова. 'fz', 'jt', 'nm', 'bt' в конце EN слов
// не встречаются вовсе.
const RU_IN_EN_ENDING_RE = /(?:sq|fz|jt|nm|bt)$/i;

// Приставки/предлоги-маркеры (только в начале слова)
// Русские приставки/предлоги, которые в EN-раскладке дают невозможные
// для реальных английских слов начала:
//   на --> yf,   по --> gj
// 'yf' в начале EN слова не встречается (yellow, yes — 'ye'; year — 'ye').
// 'gj' в начале EN слова — экстремальная редкость (только транслит имен).
// В середине слова эти сочетания могут встречаться (lyft, magjic?), поэтому
// маркерим строго начало.
const RU_IN_EN_PREFIX_RE = /^(?:yf|gj)/i;

// Маркеры EN-в-RU (консервативные)
// Биграммы, редкие в русском, но возникающие при наборе EN в RU-раскладке:
//   сщ=so, ыф=sa, рщ=ho, ещ=to, нщ=yo, зщ=zo, фы=as, ащ=fo, яы=za
// 'рщ' оставлено, т.к. встречается в реальных RU словах ('борщ'), но в паре
// с др. признаками допустимо.
const EN_IN_RU_MARKERS_RE = /(?:сщ|ыф|рщ|ещ|нщ|зщ|фы|ащ|яы)/i;

// Словарь частых EN слов/аббревиатур (не переключать)
// Короткие (≤6 букв) — пропускаются без анализа. Длинные специфичные термины
// тоже пропускаются, чтобы не ломать технические сообщения.
const EN_WHITELIST = new Set([
    // служебные / расширения
    'id', 'js', 'ts', 'css', 'html', 'xml', 'json', 'yaml', 'yml', 'toml',
    'git', 'npm', 'yarn', 'pnpm', 'api', 'url', 'uri', 'http', 'https',
    'www', 'com', 'org', 'net', 'io', 'app', 'dev', 'test', 'src', 'lib',
    'bin', 'tmp', 'md', 'txt', 'log', 'cfg', 'conf', 'env', 'sql', 'sh',
    'bash', 'zsh', 'ssh', 'ssl', 'tls', 'dns', 'cdn', 'vpn', 'lan', 'wan',
    'tcp', 'udp', 'ftp', 'sftp', 'smtp', 'imap', 'pop3', 'jwt', 'oauth',
    'sso', 'cpu', 'gpu', 'ram', 'ssd', 'hdd', 'usb', 'hdmi', 'lcd', 'led',
    'ocr', 'rss', 'sms', 'mms', 'sim', 'pin', 'otp', 'mac', 'pc', 'ip',
    // языки / ключевики
    'var', 'let', 'const', 'if', 'else', 'for', 'while', 'do', 'return',
    'function', 'class', 'new', 'this', 'super', 'yield', 'async', 'await',
    'import', 'export', 'default', 'from', 'null', 'true', 'false',
    'undefined', 'void', 'typeof', 'instanceof', 'in', 'of', 'as', 'is',
    // короткие общие
    'the', 'and', 'or', 'not', 'but', 'a', 'an', 'to', 'of', 'in', 'on',
    'at', 'by', 'it', 'be', 'go', 'no', 'so', 'up', 'us', 'we', 'he',
    'my', 'me', 'hi', 'ok', 'im', 'ur', 'u', 'r', 'n', 'c', 'b', 'x', 'y',
    // мессенджер-аббревиатуры
    'fyi', 'asap', 'brb', 'lol', 'omg', 'wtf', 'btw', 'imho', 'imo',
    'afk', 'ty', 'np', 'yw', 'gg', 'wp', 'gl', 'hf', 'bbl', 'ttyl', 'smh',
    'tbh', 'ikr', 'nvm', 'rofl', 'lmao', 'fomo', 'yolo', 'pls', 'plz',
    'thx', 'thanx', 'cu', 'cya', 'bday', 'aka', 'eta', 'faq', 'tba',
    // форматы файлов
    'jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'pdf', 'zip', 'rar', 'tar',
    'gz', 'mp3', 'mp4', 'avi', 'mov', 'exe', 'dmg', 'iso', 'deb', 'rpm',
    'msi', 'apk', 'ipa',
    // общие короткие глаголы/существительные
    'get', 'set', 'put', 'add', 'del', 'rm', 'mv', 'cp', 'cd', 'ls', 'ps',
    'cat', 'top', 'run', 'fix', 'bug', 'wip', 'todo', 'done', 'note', 'tip',
    'warn', 'info', 'err', 'max', 'min', 'avg', 'sum', 'len', 'size', 'type',
    'name', 'date', 'time', 'year', 'month', 'day', 'hour', 'min', 'sec',
    'key', 'val', 'item', 'list', 'map', 'que', 'stk', 'buf', 'str', 'num',
    'int', 'flt', 'dbl', 'bool', 'char', 'byte', 'user', 'pass', 'login',
    'logout', 'sign', 'signup', 'signin', 'home', 'help', 'about', 'search',
    'edit', 'view', 'open', 'close', 'save', 'load', 'start', 'stop', 'sync',
]);

// Утилиты

function convertText(text, toRussian) {
    const map = toRussian ? EN_TO_RU : RU_TO_EN;
    let out = '';
    for (const ch of text) {
        out += (ch in map) ? map[ch] : ch;
    }
    return out;
}

function countVowels(text, lang) {
    const set = lang === 'ru' ? RU_VOWELS : EN_VOWELS;
    let n = 0;
    for (let i = 0; i < text.length; i++) {
        if (set.indexOf(text[i]) !== -1) n++;
    }
    return n;
}

function isPureLetters(text, lang) {
    if (lang === 'ru') return /^[а-яА-ЯёЁ]+$/.test(text);
    if (lang === 'en') return /^[a-zA-Z]+$/.test(text);
    return false;
}

// Анализ одного слова

/**
 * @param {string} word — токен без пробелов (может содержать пунктуацию/цифры)
 * @returns {{shouldSwitch:boolean, targetLang:('ru'|'en'|null), converted:string, score:number, reason:string}}
 */
function evaluateWord(word) {
    const no = { shouldSwitch: false, targetLang: null, converted: word, score: 0, reason: '' };
    if (!word || word.length <= 1) return no;

    // Чистая буквенная часть (без цифр и пунктуации)
    const clean = word.replace(/[^a-zA-Zа-яА-ЯёЁ]/g, '');
    if (clean.length <= 1) return no;

    // base64/hex-токен — пропустить
    if (BASE64_TOKEN_RE.test(word) || HEX_TOKEN_RE.test(word)) {
        return no;
    }

    const lower = clean.toLowerCase();

    // Короткое EN-слово из whitelist — пропустить
    if (EN_WHITELIST.has(lower) && clean.length <= 8) {
        return no;
    }

    const enLetters = /^[a-zA-Z]+$/.test(clean);
    const ruLetters = /^[а-яА-ЯёЁ]+$/.test(clean);
    // Смешанное (EN+RU в одном токене) — не трогаем
    if (!enLetters && !ruLetters) return no;

    // СЛУЧАЙ 1: латиница --> возможно, русский в EN-раскладке
    if (enLetters) {
        const enVowels = countVowels(clean, 'en');
        const enVowelRatio = enVowels / clean.length;

        const ruConverted = convertText(clean, true);
        const ruVowels = countVowels(ruConverted, 'ru');
        const ruVowelRatio = ruVowels / ruConverted.length;

        const hasMarker = RU_IN_EN_MARKERS_RE.test(clean);
        const hasEnding = RU_IN_EN_ENDING_RE.test(clean);
        const hasPrefix = RU_IN_EN_PREFIX_RE.test(clean);
        // 5+ согласных подряд (y считается гласной) — сильная аномалия для EN
        const consonantCluster = /[^aeiouy\s]{5,}/i.test(clean);

        let score = 0;
        const reasons = [];

        // EN vowel ratio: русский текст в EN-раскладке почти не содержит
        // EN-гласных (a/e/i/o/u/y), т.к. русские гласные а/о/е/и/ы попадают
        // на f/j/t/b/s (согласные). Только русская "у"-->e даёт EN-гласную.
        if (clean.length >= 4 && enVowelRatio === 0) {
            score += 3;
            reasons.push('en-no-vowels');
        } else if (clean.length >= 5 && enVowelRatio < 0.12) {
            score += 3;
            reasons.push('en-vowel-very-low');
        } else if (clean.length >= 6 && enVowelRatio < 0.20) {
            score += 1;
            reasons.push('en-vowel-low');
        }

        // RU vowel ratio в конвертированном варианте — должен восстановиться
        if (ruVowelRatio >= 0.30) {
            score += 2;
            reasons.push('ru-vowel-ok');
        } else if (ruVowelRatio >= 0.22) {
            score += 1;
            reasons.push('ru-vowel-mid');
        }

        // Невозможная в EN биграмма/триграмма (cz, jq, bq, ysq, ghb, rfr, ...)
        if (hasMarker) {
            score += 3;
            reasons.push('ru-marker');
        }

        // Невозможное в EN окончание (sq=ый, fz=ая, jt=ое, nm=ть, bt=ие)
        if (hasEnding) {
            score += 3;
            reasons.push('ru-ending');
        }

        // Невозможное в EN начало-приставка (yf=на, gj=по)
        if (hasPrefix) {
            score += 3;
            reasons.push('ru-prefix');
        }

        // Кластер согласных
        if (consonantCluster) {
            score += 1;
            reasons.push('consonant-cluster');
        }

        // Решение: переключить, только если есть СИЛЬНЫЙ сигнал.
        //
        // Сильный сигнал = явный морфемный маркер (невозможная в EN биграмма/
        // окончание/приставка) ИЛИ комбинация «полностью нет EN-гласных» +
        // «5+ согласных подряд» + «RU-вариант с высоким vowel ratio (≥0.30)».
        //
        // Почему так строго: реальные EN слова с редким vowel ratio (strengths,
        // twelfths, crypt, lynx, rhythm, glyph) при конвертации в RU дают
        // высокий vowel ratio (т.к. EN согласные t/h/s/f/e-->русские гласные
        // е/р/ы/а/у), и простой проверки «EN vowel ratio низкий, RU высокий»
        // недостаточно — она даёт ложные срабатывания на этих словах.
        //
        // Морфемные маркеры (cz, jq, ghb, sq, yf, gj, ...) гарантированно
        // невозможны в реальных EN словах, поэтому они — надёжный сигнал.
        // Случай «0 EN-гласных + 5+ согласных + высокий RU vowel ratio» — это
        // типичный паттерн длинного русского слова в EN-раскладке (программа,
        // государство), но мы дополнительно требуем ruVowelRatio ≥ 0.30, чтобы
        // отсечь редкие EN слова без гласных (crwth, cwtch, phpht), у которых
        // RU-вариант имеет мало гласных (~0.20).
        const hasMorphMarker = hasMarker || hasEnding || hasPrefix;
        const hasVowellessPattern = enVowelRatio === 0 && consonantCluster &&
            ruVowelRatio >= 0.30;
        const hasStrongSignal = hasMorphMarker || hasVowellessPattern;

        if (score >= 4 && hasStrongSignal && ruVowelRatio >= 0.20) {
            const convertedFull = convertText(word, true);
            return {
                shouldSwitch: true,
                targetLang: 'ru',
                converted: convertedFull,
                score,
                reason: reasons.join('+'),
            };
        }
        return no;
    }

    // СЛУЧАЙ 2: кириллица --> возможно, английский в RU-раскладке
    // Будем КОНСЕРВАТИВНЫ: ложное срабатывание здесь превратит нормальное
    // русское слово в бессмысленную латиницу. Требуем сильных маркеров.
    if (ruLetters) {
        const ruVowels = countVowels(clean, 'ru');
        const ruVowelRatio = ruVowels / clean.length;

        const enConverted = convertText(clean, false);
        // EN-вариант должен состоять ТОЛЬКО из EN-букв. Если в нём осталась
        // пунктуация (например, "борщ" --> ",jho" из-за 'б'-->,), это не
        // валидное EN слово — пропускаем.
        if (!/^[a-zA-Z]+$/.test(enConverted)) return no;

        const enVowels = countVowels(enConverted, 'en');
        const enVowelRatio = enVowels / enConverted.length;

        const hasMarker = EN_IN_RU_MARKERS_RE.test(clean);

        let score = 0;
        const reasons = [];

        // Русское слово без гласных — сильная аномалия
        if (clean.length >= 3 && ruVowels === 0) {
            score += 3;
            reasons.push('ru-no-vowels');
        } else if (clean.length >= 6 && ruVowelRatio < 0.18) {
            score += 1;
            reasons.push('ru-vowel-low');
        }

        // EN-вариант выглядит как реальное EN слово (vowel ratio нормальный)
        if (clean.length >= 4 && enVowelRatio >= 0.20) {
            score += 2;
            reasons.push('en-vowel-ok');
        }

        // Невозможная в RU биграмма (сщ=so, ыф=sa, ...) — сильный маркер
        if (hasMarker) {
            score += 3;
            reasons.push('en-marker');
        }

        // Решение: консервативный порог score ≥ 4.
        // Обязательны: маркер ИЛИ полное отсутствие RU-гласных (сильные
        // признаки), И EN-вариант приемлем (vowel ratio ≥ 0.15). Запас
        // vowel ratio НЕ требуем: короткие EN слова (const=20%) имеют меньше
        // гласных, чем типичные RU (40%), и это нормально.
        const hasStrongSignal = hasMarker ||
            (clean.length >= 3 && ruVowels === 0);
        const enAcceptable = enVowelRatio >= 0.15;

        if (score >= 4 && hasStrongSignal && enAcceptable) {
            const convertedFull = convertText(word, false);
            return {
                shouldSwitch: true,
                targetLang: 'en',
                converted: convertedFull,
                score,
                reason: reasons.join('+'),
            };
        }
        return no;
    }

    return no;
}

// Анализ сообщения

/**
 * @param {string} text
 * @returns {{isChanged:boolean, resultText:string, stats:{total:number, switched:number, ratio:number, reasons:string[]}}}
 */
function analyze(text) {
    const empty = {
        isChanged: false,
        resultText: text || '',
        stats: { total: 0, switched: 0, ratio: 0, reasons: [] },
    };
    if (!text || typeof text !== 'string') return empty;

    const trimmed = text.trim();

    // Pure base64url-блоб на всё сообщение — не анализируем (AES-256 территория)
    if (WHOLE_BASE64_RE.test(trimmed)) {
        return {
            isChanged: false,
            resultText: text,
            stats: { total: 0, switched: 0, ratio: 0, reasons: ['base64-blob'] },
        };
    }

    // Защитить URL и email плейсхолдерами (не анализировать, не переключать)
    const placeholders = [];
    let phIdx = 0;
    const PH_START = '\uE000';
    const PH_END = '\uE001';
    let working = text;

    working = working.replace(URL_RE, (m) => {
        const ph = PH_START + phIdx + PH_END;
        placeholders.push({ ph, original: m });
        phIdx++;
        return ph;
    });
    working = working.replace(EMAIL_RE, (m) => {
        const ph = PH_START + phIdx + PH_END;
        placeholders.push({ ph, original: m });
        phIdx++;
        return ph;
    });

    // Токенизация по пробелам (разделители сохраняются)
    const tokens = working.split(/(\s+)/);
    let analyzedCount = 0;
    let switchedCount = 0;
    const reasons = [];

    const processed = tokens.map((tok) => {
        if (!tok || tok.length === 0) return tok;
        if (/^\s+$/.test(tok)) return tok;

        analyzedCount++;
        const res = evaluateWord(tok);
        if (res.shouldSwitch) {
            switchedCount++;
            reasons.push(res.reason + ':' + tok.slice(0, 20));
            return res.converted;
        }
        return tok;
    });

    let resultText = processed.join('');

    // Восстановить URL/email
    for (const { ph, original } of placeholders) {
        const phEscaped = ph.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
        resultText = resultText.replace(new RegExp(phEscaped, 'g'), original);
    }

    // Решение на уровне сообщения:
    // - однословное сообщение: переключить, если 1 слово переключено;
    // - многословное: переключить, если доля переключённых ≥ 30%.
    //   (типичный layout-message переключается целиком; смешанное с 1
    //    переключённым словом из 5 — скорее всего шум, пропускаем).
    const ratio = analyzedCount > 0 ? switchedCount / analyzedCount : 0;
    const isChanged = switchedCount > 0 &&
        (analyzedCount === 1 ? switchedCount >= 1 : ratio >= 0.30);

    return {
        isChanged,
        resultText: isChanged ? resultText : text,
        stats: { total: analyzedCount, switched: switchedCount, ratio, reasons },
    };
}

const LayoutAnalyzer = { analyze, evaluateWord, convertText };

export default LayoutAnalyzer;
export { LayoutAnalyzer, analyze, evaluateWord, convertText };
