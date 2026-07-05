/**
 * Канал кодирования через музыкальные треки — v2 (NO MARKERS)
 *
 * Принцип: находим [stego-music] теги ИЛИ уже существующие треки,
 * соответствующие формату "N. ARTIST — SONG", и заменяем/читаем
 * данные через словарную верификацию (artist И song должны быть в MAP).
 *
 * Обнаружение:
 *   1. Regex: ищем строки по формату "N. ARTIST — SONG"
 *   2. Dictionary check: ARTISTS_MAP.get(artist) !== undefined
 *                        && SONGS_MAP.get(song) !== undefined
 *   → Если ОБА совпали — это гарантированно наш трек (8192×8192 ≈ 67M комбинаций)
 *
 * Вместимость: 26 бит на слот (artistIdx 0–8191 + songIdx 0–8191)
 *
 * Алиас:
 *   [stego-music]  — плейсхолдер для будущей вставки трека
 */

// ─── Helper: Cartesian product ──────────────────────────
function _cartesian(a, b, sep) {
    const result = new Array(a.length * b.length);
    let k = 0;
    for (let i = 0; i < a.length; i++) {
        for (let j = 0; j < b.length; j++) {
            result[k++] = a[i] + sep + b[j];
        }
    }
    return result;
}

// ═══════════════════════════════════════════════════════
// ARTISTS — 8 blocks × 1024 = 8192
// ═══════════════════════════════════════════════════════

// Block 1 — Russian male names (32 × 32 = 1024)
const MR_F = ["Александр","Дмитрий","Сергей","Максим","Егор","Тимур","Иван","Михаил","Денис","Павел","Артем","Антон","Роман","Илья","Влад","Стас","Олег","Евгений","Игорь","Владимир","Григорий","Валерий","Николай","Леонид","Алексей","Андрей","Константин","Виктор","Юрий","Борис","Федор","Лев"];
const MR_L = ["Иванов","Смирнов","Попов","Лебедев","Козлов","Новиков","Морозов","Петров","Волков","Соловьев","Васильев","Зайцев","Павлов","Семенов","Голубев","Виноградов","Богданов","Воробьев","Федоров","Михайлов","Беляев","Тарасов","Белов","Комаров","Орлов","Киселев","Макаров","Андреев","Ковалев","Ильин","Гусев","Титов"];

// Block 2 — Russian female names (32 × 32 = 1024)
const FR_F = ["Анна","Мария","Елена","Дарья","Алина","Ирина","Екатерина","Ольга","Наталья","Юлия","Светлана","Виктория","Ксения","Анастасия","Полина","Вера","Надежда","Любовь","София","Елизавета","Татьяна","Маргарита","Александра","Валерия","Кристина","Евгения","Марина","Лариса","Жанна","Людмила","Галина","Алла"];
const FR_L = ["Иванова","Смирнова","Попова","Лебедева","Козлова","Новикова","Морозова","Петрова","Волкова","Соловьева","Васильева","Зайцева","Павлова","Семенова","Голубева","Виноградова","Богданова","Воробьева","Федорова","Михайлова","Беляева","Тарасова","Белова","Комарова","Орлова","Киселева","Макарова","Андреева","Ковалева","Ильина","Гусева","Титова"];

// Block 3 — Western male names (32 × 32 = 1024)
const ME_F = ["John","Michael","David","James","Robert","William","Joseph","Thomas","Charles","Daniel","Matthew","George","Justin","Ed","Bruno","Shawn","Paul","Peter","Mark","Steven","Kevin","Brian","Bruce","Freddie","Elvis","Elton","Frank","Stevie","Phil","Johnny","Adam","Chris"];
const ME_L = ["Smith","Johnson","Williams","Brown","Jones","Garcia","Miller","Davis","Rodriguez","Martinez","Hernandez","Lopez","Gonzalez","Wilson","Anderson","Thomas","Taylor","Moore","Jackson","Martin","Lee","Perez","Thompson","White","Harris","Sanchez","Clark","Ramirez","Lewis","Robinson","Walker","Young"];

// Block 4 — Western female names (32 × 32 = 1024, reuse ME_L for last names)
const FE_F = ["Sarah","Emily","Jessica","Emma","Olivia","Sophia","Ava","Isabella","Mia","Amelia","Harper","Evelyn","Abigail","Taylor","Dua","Billie","Whitney","Mariah","Celine","Adele","Beyonce","Rihanna","Madonna","Tina","Britney","Kelly","Alicia","Amy","Shakira","Katy","Ariana","Selena"];

// Block 5 — Russian band names (32 × 32 = 1024)
const BR_A = ["Красные","Белые","Черные","Дикие","Ночные","Звездные","Секретные","Скрытые","Вечные","Тихие","Громкие","Первые","Последние","Золотые","Мертвые","Живые","Старые","Новые","Вольные","Гордые","Мрачные","Светлые","Святые","Грешные","Ледяные","Огненные","Свободные","Верные","Рваные","Пьяные","Глупые","Умные"];
const BR_N = ["Снайперы","Звезды","Ангелы","Демоны","Тени","Огни","Ветры","Ночи","Люди","Мальчики","Девочки","Герои","Короли","Шуты","Звери","Птицы","Волки","Сны","Дороги","Сердца","Слова","Города","Машины","Цветы","Реки","Горы","Лучи","Тайны","Голоса","Нервы","Пилоты","Моря"];

// Block 6 — English band names (32 × 32 = 1024)
const BE_A = ["The","Red","Black","Neon","Midnight","Crystal","Silent","Velvet","Iron","Plastic","Wild","Golden","Dark","Sweet","Bitter","Cold","Silver","Magic","Secret","Lost","Crazy","Electric","Bloody","Empty","Heavy","Deep","Blind","Arctic","Royal","Savage","Guns","Rolling"];
const BE_N = ["Monkeys","Dragons","Hearts","Stones","Pilots","Fighters","Rebels","Waves","Dreams","Machines","Stars","Tears","Shadows","Lights","Memories","Roads","Boys","Girls","Kings","Queens","Lions","Wolves","Cats","Dogs","Birds","Skies","Oceans","Fires","Nights","Cities","Souls","Days"];

// Block 7 — Classical composers (32 × 32 = 1024)
const CL_F = ["Wolfgang Amadeus","Ludwig van","Johann Sebastian","Antonio","Pyotr","Sergei","Mikhail","Frederic","Richard","Igor","Dmitri","Anton","Franz","Claude","Giuseppe","Johannes","George","Niccolo","Felix","Hector","Maurice","Gustav","Edvard","Modest","Nikolai","Alexander","Giacomo","Vincenzo","Camille","Jean","Henry","Arthur"];
const CL_L = ["Mozart","Beethoven","Bach","Vivaldi","Tchaikovsky","Rachmaninoff","Glinka","Chopin","Wagner","Stravinsky","Shostakovich","Bruckner","Liszt","Debussy","Verdi","Brahms","Handel","Paganini","Mendelssohn","Berlioz","Ravel","Mahler","Grieg","Mussorgsky","Korsakov","Scriabin","Puccini","Bellini","Saint-Saens","Sibelius","Purcell","Sullivan"];

// Block 8 — Russian rock bands + features (32 × 32 = 1024)
const RD_1 = ["Мираж","Форум","Браво","Ласковый май","Кино","Алиса","ДДТ","Аквариум","Наутилус","Сплин","Би-2","Звери","Мумий Тролль","Ария","Король и Шут","Сектор Газа","Агата Кристи","Ленинград","Пикник","Чайф","Машина Времени","Галлюцинации","Земфира","Танцы Минус","АукцЫон","Крематорий","Оборона","Мельница","Lumen","Слот","Тараканы","Эпидемия"];
const RD_2 = ["feat. Сплин","feat. Би-2","feat. Ария","& Симфонический Оркестр","Live","Acoustic","feat. Земфира","feat. Чайф","Unplugged","feat. Кипелов","Remix","Cover","feat. Lumen","feat. Мельница","feat. Пикник","feat. ДДТ","feat. Браво","feat. Алиса","feat. Мумий Тролль","feat. Звери","feat. Пелагея","feat. КняZz","& Хор","Unreleased","Session","feat. Машина Времени","feat. Агата Кристи","feat. Слот","feat. Ленинград","feat. Louna","Instrumental","feat. Танцы Минус"];

// Build ALL_ARTISTS: 8 × 1024 = 8192
const ALL_ARTISTS = _cartesian(MR_F, MR_L, " ")
    .concat(_cartesian(FR_F, FR_L, " "))
    .concat(_cartesian(ME_F, ME_L, " "))
    .concat(_cartesian(FE_F, ME_L, " "))
    .concat(_cartesian(BR_A, BR_N, " "))
    .concat(_cartesian(BE_A, BE_N, " "))
    .concat(_cartesian(CL_F, CL_L, " "))
    .concat(_cartesian(RD_1, RD_2, " "));

// ═══════════════════════════════════════════════════════
// SONGS — 8 blocks × 1024 = 8192
// ═══════════════════════════════════════════════════════

// Block 1 — Russian adjectives + nouns (32 × 32 = 1024)
const S_RA_1 = ["Белая","Тёмная","Холодная","Горячая","Вечная","Первая","Последняя","Новая","Старая","Чужая","Моя","Твоя","Наша","Золотая","Сладкая","Горькая","Тихая","Громкая","Слепая","Ясная","Святая","Грешная","Далекая","Близкая","Дикая","Нежная","Странная","Синяя","Черная","Красная","Добрая","Злая"];
const S_RN_1 = ["Ночь","Любовь","Звезда","Мечта","Осень","Зима","Весна","Жизнь","Песня","Птица","Река","Вода","Искра","Боль","Слеза","Грусть","Радость","Свобода","Правда","Ложь","Игра","Роль","Тень","Тайна","Машина","Сказка","Кровь","Луна","Планета","Дорога","Дверь","Душа"];

// Block 2 — Russian nouns + genitives (32 × 32 = 1024)
const S_RN_2 = ["Город","Цвет","Свет","Запах","Звук","Голос","Конец","Начало","Смысл","Секрет","Огонь","Ветер","Шум","Край","Берег","Океан","Мир","Взгляд","Путь","Дом","Шаг","День","Год","Век","Час","Миг","Сон","Лес","Брат","Друг","Враг","Снег"];
const S_RN_3 = ["Дорог","Ночи","Любви","Снов","Звезд","Ветра","Огня","Света","Воды","Жизни","Времени","Слов","Надежды","Правды","Свободы","Слез","Чувств","Иллюзий","Теней","Дней","Печали","Радости","Судьбы","Неба","Земли","Солнца","Луны","Весны","Осени","Зимы","Лета","Сердец"];

// Block 3 — Russian verbs + pronouns (32 × 32 = 1024)
const S_RV = ["Забыть","Вспомнить","Уйти","Остаться","Любить","Простить","Понять","Найти","Потерять","Ждать","Верить","Знать","Молчать","Кричать","Плакать","Смеяться","Бежать","Лететь","Смотреть","Дышать","Жить","Умереть","Петь","Искать","Прятать","Терять","Менять","Спасать","Бросать","Держать","Ломать","Строить"];
const S_RP = ["Тебя","Меня","Нас","Всех","Никого","Всё","Ничего","Слова","Сны","Глаза","Руки","Голос","Свет","Ночь","День","Жизнь","Время","Мир","Свой путь","Твой смех","Мою боль","Надежду","Свободу","Любовь","Ветер","Огонь","Слезы","Дождь","Небо","Солнце","Звезды","Тень"];

// Block 4 — Russian adverbs + imperatives (32 × 32 = 1024)
const S_W1 = ["Просто","Только","Снова","Вместе","Рядом","Далеко","Близко","Здесь","Там","Всегда","Никогда","Завтра","Вчера","Сегодня","Сейчас","Потом","Тихо","Громко","Слишком","Очень","Долго","Быстро","Вдруг","Опять","Словно","Будто","Точно","Ясно","Резко","Может","Наверное","Трудно"];
const S_W2 = ["Уходи","Прощай","Привет","Лети","Беги","Дыши","Смотри","Пой","Танцуй","Живи","Мечтай","Молчи","Говори","Держи","Отпусти","Вернись","Спи","Вставай","Иди","Стой","Грусти","Прости","Верь","Сгорай","Люби","Знай","Помни","Забудь","Вспомни","Летай","Падай","Играй"];

// Block 5 — English adjectives + nouns (32 × 32 = 1024)
const S_EN_1 = ["Love","Heart","Dreams","Sky","Ocean","Fire","Night","City","Stars","Tears","Shadows","Light","Memories","Road","Rain","Soul","Time","World","Life","Way","Sun","Moon","Wind","Storm","River","Sea","Eye","Mind","Word","Song","Voice","Blood"];

// Block 6 — English verbs + pronouns (32 × 32 = 1024)
const S_EV_1 = ["Love","Hate","Feel","See","Hear","Know","Want","Need","Take","Give","Let","Make","Find","Lose","Hold","Keep","Stop","Start","Play","Pause","Think","Believe","Wait","Watch","Walk","Run","Fly","Fall","Break","Fix","Save","Kill"];
const S_EP_1 = ["Me","You","Us","Them","It","Everything","Nothing","My Hand","Your Heart","The Night","The Light","The Fire","This Moment","The Way","The Music","Control","A Breath","A Chance","The Time","The World","My Mind","Your Eyes","The Sun","The Moon","The Stars","The Rain","The Road","The Line","The Faith","The Truth","The Pain","The Love"];

// Block 7 — English nouns + "of X" (32 × 32 = 1024)
const S_EN_2 = ["Shape","City","Sound","Taste","Color","Heart","End","Start","Part","Piece","State","King","Queen","Lord","Master","Edge","Voice","Sign","Mark","Ghost","Spirit","Soul","Trace","Echo","River","Sea","Ocean","Mountain","Valley","Path","Door","Key"];
const S_EN_3 = ["You","Me","Us","Love","Hate","Life","Death","Time","Space","Dreams","Tears","Joy","Sorrow","Glory","Honor","Power","Magic","Fire","Water","Earth","Wind","Nature","Beauty","Darkness","Light","Shadows","Silence","Noise","Madness","Reason","Hope","Faith"];

// Block 8 — Electronic music (32 × 32 = 1024)
const S_EM_1 = ["Drop","Beat","Bass","Mix","Remix","Vibe","Flow","Groove","Rhythm","Tempo","Sound","Noise","Track","Tune","Hook","Line","Synth","Pad","Lead","Chord","Pulse","Wave","Trance","House","Techno","Dub","Step","Kick","Snare","Clap","Hat","Crash"];
const S_EM_2 = ["Anthem","Mix","Edit","VIP","Remix","Bootleg","Mashup","Version","Dub","Club","Radio","Extended","Vocal","Instrumental","Acoustic","Original","Rework","Flip","Refix","Cover","Live","Demo","Session","Cut","Loop","Sample","Stem","Beat","Groove","Vibe","Energy","Power"];

// Build ALL_SONGS: 8 × 1024 = 8192
const ALL_SONGS = _cartesian(S_RA_1, S_RN_1, " ")
    .concat(_cartesian(S_RN_2, S_RN_3, " "))
    .concat(_cartesian(S_RV, S_RP, " "))
    .concat(_cartesian(S_W1, S_W2, " "))
    .concat(_cartesian(BE_A, S_EN_1, " "))
    .concat(_cartesian(S_EV_1, S_EP_1, " "))
    .concat(_cartesian(S_EN_2, S_EN_3, " of "))
    .concat(_cartesian(S_EM_1, S_EM_2, " "));

// ═══════════════════════════════════════════════════════
// Maps for O(1) lookup (dictionary verification)
// ═══════════════════════════════════════════════════════
const ARTISTS_MAP = new Map(ALL_ARTISTS.map((name, i) => [name, i]));
const SONGS_MAP = new Map(ALL_SONGS.map((name, i) => [name, i]));

const BASE = 8192;

// ═══════════════════════════════════════════════════════
// Regex for track detection (NO MARKERS)
// Format: "N. ARTIST — SONG" where — is em-dash or regular dash
// ═══════════════════════════════════════════════════════
const TRACK_REGEX = /(?:^|\n)\s*\d+\.\s+([^\n—\-]+?)\s+[—\-]\s+([^\n]+)/g;
const TAG_REGEX = /\[stego-music\]/g;

// ═══════════════════════════════════════════════════════
// PlaylistChannel
// ═══════════════════════════════════════════════════════

export class PlaylistChannel {
    constructor() {
        this.name = 'playlist';
        this.loaded = true;
        this._isTagBased = true;
        this._runSelfTest();
    }

    // ─── Self-test ────────────────────────────────────────
    _runSelfTest() {
        try {
            // Verify data integrity
            if (ALL_ARTISTS.length !== 8192) {
                console.error(`[playlist] Self-test FAILED: ALL_ARTISTS.length = ${ALL_ARTISTS.length}, expected 8192`);
                return;
            }
            if (ALL_SONGS.length !== 8192) {
                console.error(`[playlist] Self-test FAILED: ALL_SONGS.length = ${ALL_SONGS.length}, expected 8192`);
                return;
            }
            if (ARTISTS_MAP.size !== 8192) {
                console.error(`[playlist] Self-test FAILED: ARTISTS_MAP.size = ${ARTISTS_MAP.size}, expected 8192`);
                return;
            }
            if (SONGS_MAP.size !== 8192) {
                console.error(`[playlist] Self-test FAILED: SONGS_MAP.size = ${SONGS_MAP.size}, expected 8192`);
                return;
            }

            // Roundtrip test: encode then decode
            const testText =
                'Мой любимый плейлист:\n' +
                '[stego-music]\n' +
                'Немного другой музыки:\n' +
                '[stego-music]\n' +
                '[stego-music]\n' +
                'И напоследок:\n' +
                '[stego-music]\n';

            // Encode indices: 4 slots × 2 indices = 8 values
            const indices = [0, 0, 100, 200, 4096, 4096, 8191, 8191];
            const encoded = this.encode(testText, indices);
            const decoded = this.decode(encoded);

            if (JSON.stringify(decoded) !== JSON.stringify(indices)) {
                console.error(
                    `[playlist] Self-test FAILED: roundtrip mismatch.\n` +
                    `  Input:  ${JSON.stringify(indices)}\n` +
                    `  Decoded: ${JSON.stringify(decoded)}\n` +
                    `  Encoded text:\n${encoded}`
                );
                return;
            }

            // Test re-encode: encode already-encoded text with different indices
            const indices2 = [50, 75, 3000, 6000, 1234, 5678, 7999, 100];
            const reEncoded = this.encode(encoded, indices2);
            const reDecoded = this.decode(reEncoded);

            if (JSON.stringify(reDecoded) !== JSON.stringify(indices2)) {
                console.error(
                    `[playlist] Self-test FAILED: re-encode mismatch.\n` +
                    `  Input:    ${JSON.stringify(indices2)}\n` +
                    `  Decoded:  ${JSON.stringify(reDecoded)}`
                );
                return;
            }

            // Test capacity
            const cap = this.analyzeCapacity(testText);
            if (cap.totalBits !== 4 * 26) {
                console.error(`[playlist] Self-test FAILED: capacity = ${cap.totalBits}, expected ${4 * 26}`);
                return;
            }

            // Test false-positive rejection: a track line with unknown artist/song should be ignored
            const noiseText = '1. Unknown Artist — Unknown Song\n2. Random Name — Random Track\n';
            const noiseDecoded = this.decode(noiseText);
            if (noiseDecoded.length !== 0) {
                console.error(`[playlist] Self-test FAILED: false positive detected. Decoded: ${JSON.stringify(noiseDecoded)}`);
                return;
            }

            console.log('[playlist] Self-test PASSED ✓');
        } catch (e) {
            console.error('[playlist] Self-test ERROR:', e);
        }
    }

    // ─── Find all slots: tags + pre-existing verified tracks ──
    _findMatches(text) {
        const matches = [];

        // 1. Find [stego-music] tags
        TAG_REGEX.lastIndex = 0;
        let m;
        while ((m = TAG_REGEX.exec(text)) !== null) {
            matches.push({
                start: m.index,                    // start of "[stego-music]"
                end: m.index + m[0].length,        // end of "]"
                spanStart: m.index,
                spanEnd: m.index + m[0].length,
                isTag: true
            });
        }

        // 2. Find tracks via regex + dictionary verification
        TRACK_REGEX.lastIndex = 0;
        while ((m = TRACK_REGEX.exec(text)) !== null) {
            const artist = m[1].trim();
            const song = m[2].trim();

            // Both MUST be in the dictionary — this is the steganographic key
            const artistIdx = ARTISTS_MAP.get(artist);
            const songIdx = SONGS_MAP.get(song);

            if (artistIdx === undefined || songIdx === undefined) {
                // Not our track — skip (false positive filtered out)
                continue;
            }

            // Determine content boundaries (excluding leading \n)
            const matchText = m[0];
            const hasLeadingNewline = matchText.charCodeAt(0) === 0x0A; // '\n'
            const contentStart = hasLeadingNewline ? m.index + 1 : m.index;

            // Find end of line (not including trailing \n)
            const matchEnd = m.index + m[0].length;
            const nextNewline = text.indexOf('\n', matchEnd);
            const spanEnd = nextNewline >= 0 ? nextNewline : text.length;

            // Span includes the leading \n for visual highlighting
            const spanStart = (contentStart > 0 && text.charCodeAt(contentStart - 1) === 0x0A)
                ? contentStart - 1
                : contentStart;

            matches.push({
                start: contentStart,   // where content begins (for replacement)
                end: spanEnd,           // end of line (for replacement)
                spanStart,              // for getSpans (includes leading \n)
                spanEnd,                // for getSpans
                isTag: false,
                artistIdx,
                songIdx
            });
        }

        // Sort by position (stable: tags and tracks interleaved naturally)
        matches.sort((a, b) => a.start - b.start);

        // Remove overlapping matches (keep the one that starts first)
        const deduped = [];
        for (const match of matches) {
            const lastEnd = deduped.length > 0 ? deduped[deduped.length - 1].end : -1;
            if (match.start >= lastEnd) {
                deduped.push(match);
            }
        }

        return deduped;
    }

    // ─── Channel API ────────────────────────────────────────

    analyzeCapacity(text) {
        if (!this.loaded) return { totalBits: 0, positions: [], bases: [] };

        const matches = this._findMatches(text);
        if (matches.length === 0) return { totalBits: 0, positions: [], bases: [] };

        const totalBits = matches.length * 26; // 2 × 13 bits per slot
        const positions = matches.map(m => ({
            start: m.spanStart,
            end: m.spanEnd
        }));
        const bases = [BASE, BASE]; // artistIdx (base 8192), songIdx (base 8192)

        return { totalBits, positions, bases };
    }

    encode(text, indices) {
        if (!this.loaded || indices.length === 0) return text;

        const matches = this._findMatches(text);
        if (matches.length === 0) return text;

        const requiredIndices = matches.length * 2;
        if (indices.length < requiredIndices) {
            console.warn(
                `[playlist] Not enough indices: have ${indices.length}, need ${requiredIndices} ` +
                `(${matches.length} slots × 2). Only first ${matches.length} slots will be filled.`
            );
        }

        // Build replacements and apply in REVERSE order to preserve positions
        let result = text;
        for (let i = matches.length - 1; i >= 0; i--) {
            const match = matches[i];
            const base = i * 2;

            // Check we have enough indices for this slot
            if (base + 1 >= indices.length) break;

            const artistIdx = indices[base];
            const songIdx = indices[base + 1];

            // Bounds check
            if (artistIdx < 0 || artistIdx >= BASE || songIdx < 0 || songIdx >= BASE) {
                console.error(`[playlist] Invalid index at slot ${i}: artistIdx=${artistIdx}, songIdx=${songIdx}`);
                continue;
            }

            const artist = ALL_ARTISTS[artistIdx];
            const song = ALL_SONGS[songIdx];

            // Format: "N. ARTIST — SONG" (N is 1-based sequential number)
            const trackStr = `${i + 1}. ${artist} — ${song}`;

            // Replace the matched content with the new track string.
            // For tags: replace "[stego-music]" → "1. Artist — Song"
            // For existing tracks: replace "N. OldArtist — OldSong" → "1. NewArtist — NewSong"
            result = result.substring(0, match.start) + trackStr + result.substring(match.end);
        }

        return result;
    }

    decode(stegoText) {
        if (!this.loaded) return [];

        const matches = this._findMatches(stegoText);
        const indices = [];

        for (const match of matches) {
            if (match.isTag) continue; // Skip unencoded tags
            indices.push(match.artistIdx, match.songIdx);
        }

        return indices;
    }

    getSpans(text) {
        const matches = this._findMatches(text);
        return matches.map(m => ({
            start: m.spanStart,
            end: m.spanEnd
        }));
    }

    getStats() {
        return {
            name: this.name,
            loaded: this.loaded,
            totalArtists: ALL_ARTISTS.length,
            totalSongs: ALL_SONGS.length,
            artistsMapSize: ARTISTS_MAP.size,
            songsMapSize: SONGS_MAP.size,
            base: BASE,
            bitsPerSlot: 26,
            indicesPerSlot: 2,
            dims: [BASE, BASE],
            tag: '[stego-music]',
            format: 'N. ARTIST — SONG',
            detection: 'regex + dictionary verification'
        };
    }
}

export default PlaylistChannel;
