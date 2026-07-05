/**
 * Главный движок системы стеганографии
 *
 * ## Архитектура Mixed-Radix Numeral System
 *
 * Каждая позиция в тексте — это "цифра" в системе счисления с основанием N
 * (N = количество вариантов для данной позиции).
 *
 * Пример:
 *   bases = [3, 2, 5, 4, ...]  ← основания от каждого канала
 *   maxValue = 3 × 2 × 5 × 4 × ...
 *   M = BigInt(encrypted_bytes)  ← число для кодирования (M < maxValue)
 *
 *   encode: i0 = M % base0, M = M / base0
 *           i1 = M % base1, M = M / base1  ...
 *
 *   decode: M = i0 + base0*(i1 + base1*(i2 + base2*(i3 + ...)))
 *
 * ## Принцип детерминизма
 *
 * Для корректного decode без оригинала необходимо:
 * 1. analyzeCapacity(stegoText) возвращает ТЕ ЖЕ bases что analyzeCapacity(originalText)
 * 2. Каждый канал decode(stegoText) возвращает ТЕ ЖЕ индексы что были вложены при encode
 *
 * Это достигается через:
 * - Синонимы: canonical synset (алф.сортировка, все члены — ключи) + симуляция decode при encode
 * - Другие каналы: работают с фиксированными паттернами (даты, е↔ё, дефис и т.п.)
 * - letter-stego применяется ПОСЛЕДНИМ (после синонимов), decode — первым
 */

import MixedRadixEncoder from './mixed-radix.js';
import CryptoEngine from './crypto.js';
import RussianMorphology from './morphology.js';

import SynonymChannel from '../channels/synonyms.js';
import YoReplacementChannel from '../channels/yo-replacement.js';
import PunctuationChannel from '../channels/punctuation.js';
import WordOrderChannel from '../channels/word-order.js';
import NumbersChannel from '../channels/numbers.js';
import ParasitesChannel from '../channels/parasites.js';
import AbbreviationsChannel from '../channels/abbreviations.js';
import DupletsChannel from '../channels/duplets.js';
import DatesChannel from '../channels/dates.js';
import SpacesChannel from '../channels/spaces.js';
import CaseChannel from '../channels/case.js';
import TyposChannel from '../channels/typos.js';
import SmilesChannel from '../channels/smiles.js';
import VoiceChannel from '../channels/voice.js';
import ParticiplesChannel from '../channels/participles.js';
import PhrasesChannel from '../channels/phrases.js';
import { LetterStegoChannel } from '../channels/letter-stego.js';
import PhonesChannel from '../channels/phones.js';
import UrlsChannel from '../channels/urls.js';
import EmailsChannel from '../channels/emails.js';
import FioChannel from '../channels/fio.js';
import PcPartsChannel from '../channels/pc-parts.js';
import AutoPartsChannel from '../channels/auto-parts.js';
import GadgetsChannel from '../channels/gadgets.js';
import RecipesChannel from '../channels/recipes.js';
import AddressesChannel from '../channels/addresses.js';
import PlaylistChannel from '../channels/playlist.js';
import CodeStegoChannel from '../channels/code-stego.js';
import JsonConfigChannel from '../channels/json-config.js';
import CategorizedWordsChannel from '../channels/categorized-words.js';
import { EmojiStegoChannel } from '../channels/emoji-stego-channel.js';
import { ExtremeChannelManager } from './extreme-encoding.js';

export class StegoEngine {
    constructor() {
        this.mixedRadix  = new MixedRadixEncoder();
        this.crypto      = new CryptoEngine();
        this.morphology  = new RussianMorphology();
        this.extremeManager = new ExtremeChannelManager();
        this._extremeActiveChannels = []; // active extreme channel instances
        this.channels    = {};
        this.activeChannels = [];
        this.stats       = {};
    }

    registerChannel(channel) {
        this.channels[channel.name] = channel;
    }

    setActiveChannels(channelNames) {
        this.activeChannels = channelNames
            .map(name => this.channels[name])
            .filter(Boolean);
        // CRITICAL: Clear extreme channels when standard mode is set.
        // Without this, unchecking extreme checkboxes would leave stale
        // _extremeActiveChannels, causing encodeMessage step 3e to
        // re-encode old extreme channels on every standard encode.
        this._extremeActiveChannels = [];
    }

    async loadChannels(basePath = '') {
        const dataPath = basePath ? `${basePath}/data` : './data';
        const libPath  = basePath ? `${basePath}/lib/dicts` : './lib/dicts';

        await this.morphology.init(libPath);

        // Синонимы
        const synonyms = new SynonymChannel(this.morphology);
        await synonyms.loadDictionary(`${dataPath}/synonyms.json`);
        this.registerChannel(synonyms);

        // Структурные каналы (работают с фиксированными паттернами)
        this.registerChannel(new YoReplacementChannel());
        this.registerChannel(new PunctuationChannel());
        this.registerChannel(new DatesChannel());
        this.registerChannel(new TyposChannel());

        // Канал детерминированных буквенных мутаций (letter-stego v4)
        // Использует Az.Morph для поиска "safe" позиций
        // Инициализируется ПОСЛЕ morphology.init() — Az.Morph уже готов
        const letterStego = new LetterStegoChannel();
        await letterStego.loadDictionary(); // Uses Az.Morph directly, no file needed
        this.registerChannel(letterStego);
        this.registerChannel(new SpacesChannel());

        const duplets = new DupletsChannel();
        await duplets.loadDictionary(`${dataPath}/duplets.json`);
        this.registerChannel(duplets);

        const abbreviations = new AbbreviationsChannel(this.morphology);
        await abbreviations.loadDictionary(`${dataPath}/abbreviations.json`);
        this.registerChannel(abbreviations);

        // Остальные каналы (пока отключены — нарушают детерминизм синонимов)
        this.registerChannel(new WordOrderChannel());
        this.registerChannel(new NumbersChannel(this.morphology));
        this.registerChannel(new CaseChannel(this.morphology));
        this.registerChannel(new SmilesChannel());
        this.registerChannel(new EmojiStegoChannel());

        const voice = new VoiceChannel(this.morphology);
        await voice.loadDictionary(`${dataPath}/voice-forms.json`);
        this.registerChannel(voice);

        const participles = new ParticiplesChannel(this.morphology);
        await participles.loadDictionary(`${dataPath}/participles.json`);
        this.registerChannel(participles);

        const parasites = new ParasitesChannel();
        await parasites.loadDictionary(`${dataPath}/parasites.json`);
        this.registerChannel(parasites);

        const phrases = new PhrasesChannel();
        await phrases.loadDictionary(`${dataPath}/phrases.json`);
        this.registerChannel(phrases);

        // Каналы высокой ёмкости: телефоны, URL, email
        const phones = new PhonesChannel();
        this.registerChannel(phones);

        const urls = new UrlsChannel();
        this.registerChannel(urls);

        const emails = new EmailsChannel();
        await emails.loadDictionary(`${dataPath}/dictionaries/email-names-compact.json`);
        this.registerChannel(emails);

        // Канал ФИО (российские ФИО, паттерн + словарь, алиас [steg-fio])
        const fio = new FioChannel();
        await fio.loadDictionary(`${dataPath}/fio-dictionary.json`);
        this.registerChannel(fio);

        // Каналы процедурной генерации комплектующих
        this.registerChannel(new PcPartsChannel());
        this.registerChannel(new AutoPartsChannel());
        this.registerChannel(new GadgetsChannel());

        // Канал кулинарных рецептов (теговый, очень высокая ёмкость)
        this.registerChannel(new RecipesChannel());

        // Новые теговые каналы
        this.registerChannel(new AddressesChannel());
        this.registerChannel(new PlaylistChannel());
        this.registerChannel(new CodeStegoChannel());
        this.registerChannel(new JsonConfigChannel());

        // Канал категоризированных слов (словари: фильмы, игры, породы)
        const catWords = new CategorizedWordsChannel();
        await catWords.loadDictionaries(dataPath);
        this.registerChannel(catWords);

        // Экстремальные каналы (регистрируем но НЕ добавляем в default active list)
        this.registerChannel(this.extremeManager.caseLadder);
        this.registerChannel(this.extremeManager.cyrillicLatin);
        this.registerChannel(this.extremeManager.zeroWidthExt);

        // По умолчанию: только безопасные каналы
        this._setDefaultChannels();

        console.log('✅ Channels:', Object.keys(this.channels).join(', '));
        console.log('✅ Active:', this.activeChannels.map(c => c.name).join(', '));
    }

    _setDefaultChannels() {
        // Порядок каналов ВАЖЕН для детерминизма:
        //
        // letter-stego ПОСЛЕДНИМ при encode → ПЕРВЫМ при decode.
        // Это гарантирует что:
        // 1. letter-stego видит текст ПОСЛЕ синонимов → его bases стабильны
        // 2. При decode: letter-stego restore → текст = carrierText + синонимы + пунктуация
        // 3. analyzeCarrier(textAfterRestore) даст те же bases что при encode
        //
        // Структурные каналы (punctuation, dates, typos, duplets)
        // не меняют слова → их bases не зависят от синонимов → стабильны.
        //
        // КРИТИЧЕСКО: Каналы phones, emails, urls, fio МОДИФИЦИРУЮТ текст,
        // создавая новые паттерны (например, пробел перед номером телефона).
        // Канал spaces находит позиции по паттерну «буква-пробел-цифра»
        // — после кодирования телефона «+79123456789» → «7 (900) 243 61 85»
        //   появляется новая позиция (ru пробел 7). Если spaces стоит ПЕРЕД
        //   phones/emails/urls, он анализирует оригинальный текст (0 позиций),
        //   а decode анализирует закодированный (1+ позиций) → mismatch →
        //   convergence loop never converges → roundtrip ломается.
        // Решение: spaces стоит ПОСЛЕ phones/emails/urls/fio, чтобы
        // видеть закодированный текст и находить те же позиции что decode.
        //
        // abbreviations стоит ПЕРЕД word-dependent каналами (synonyms, parasites).
        // При encode: «Российской Федерации» → «РФ» значительно сокращает текст.
        // Если бы abbreviation был ПОСЛЕ synonyms/parasites, то:
        //   - encode: synonyms анализируют текст ДО сокращения (длинный текст)
        //   - decode simulation: ALL каналы анализируют текст ПОСЛЕ сокращения (короткий)
        //   → mismatch → convergence loop не сходится → roundtrip ломается.
        // Размещение abbreviations ПЕРВЫМ среди не-структурных каналов гарантирует
        // что ALL каналы видят один и тот же текст (после сокращения).
        //
        // Синонимы используют canonical synset (все члены проиндексированы) →
        // getSynset работает для ЛЮБОГО члена → bases стабильны.
        //
        // parasites (v2 REPLACE): заменяет существующие слова-паразиты на другие
        // из той же группы. Не меняет количество «слотов», детерминистичный decode.
        const safe = [
            'punctuation',    // structural (fixed patterns)
            'dates',          // structural (fixed patterns)
            'typos',          // structural (fixed phrases with dashes)
            'duplets',        // structural (orthographic variants)
            'abbreviations',  // ← BEFORE word-dependent channels: abbreviation shortens text,
                             //   so all subsequent channels must analyze the shortened text
            'synonyms',       // word-dependent
            'phones',         // structural (fixed patterns)
            'emails',         // structural (fixed patterns)
            'urls',           // structural (fixed patterns)
            'fio',            // structural (fixed patterns)
            'spaces',         // ← AFTER phones/emails/urls/fio: encode creates new
                             //   letter-space-digit boundaries that decode also finds.
                             //   Must analyze POST-encoding text, not original carrier.
            'pc-parts',       // tag-based
            'auto-parts',     // tag-based
            'gadgets',        // tag-based
            'parasites',      // word-dependent
            // letter-stego ПОСЛЕДНИМ — анализирует текст после всех каналов
            'letter-stego',
            // recipes ПОСЛЕ letter-stego — теговый канал, полностью изолирован
            // от других каналов через getSpans. Последний в порядке encoding.
            'recipes',
            // Новые теговые каналы (все после recipes, изолированы через getSpans)
            'addresses',     // Адреса РФ с аббревиатурными битами
            'playlist',      // Музыкальные треки (8192×8192 комбинаций)
            'code-stego',    // Код на Python/TypeScript/Go/Rust/CSS
            'json-config',   // JSON конфиги с UUID (128 бит/тег)
            'categorized-words', // Категоризированные слова (фильмы, игры, породы)
            'smiles',           // emoji swaps (deterministic — swaps existing emojis)
            'emoji-stego',       // emoji variation selector stego (isolated — doesn't overlap)
        ].filter(name => this.channels[name]);
        this.setActiveChannels(safe);
    }

    getMorphology() { return this.morphology; }

    /**
     * Установить каналы, совместимые с экстремальными методами кодирования.
     *
     * При использовании экстремальных методов (case-ladder, zero-width-ext,
     * cyrillic-latin) некоторые стандартные каналы могут сломаться.
     * Этот метод отключает несовместимые каналы.
     *
     * @param {string[]} disabledChannels - Список каналов, которые нужно отключить
     */
    setExtremeCompatibleChannels(disabledChannels = []) {
        const disabledSet = new Set(disabledChannels);
        const safe = [
            'punctuation', 'dates', 'typos', 'duplets',
            'abbreviations', 'synonyms',
            'phones', 'emails', 'urls', 'fio',
            'spaces',
            'pc-parts', 'auto-parts', 'gadgets',
            'parasites',
            'letter-stego',
            'recipes',
            'addresses', 'playlist', 'code-stego', 'json-config',
            'categorized-words',
            'smiles',
            'emoji-stego',
        ].filter(name => this.channels[name] && !disabledSet.has(name));
        this.setActiveChannels(safe);
    }

    /**
     * Активировать экстремальные каналы и автоматически отключить несовместимые.
     * @param {string[]} extremeMethodNames - ['case-ladder', 'zero-width-ext', 'cyrillic-latin']
     */
    setActiveExtremeChannels(extremeMethodNames = []) {
        this._extremeActiveChannels = this.extremeManager.getActiveChannels(extremeMethodNames);
        
        // Get standard channels that are compatible
        const disabledChannels = new Set();
        for (const name of extremeMethodNames) {
            const disabled = ExtremeChannelManager.COMPAT_MAP[name] || [];
            disabled.forEach(ch => disabledChannels.add(ch));
        }
        
        // Build active list: compatible standard + extreme
        const allStandard = [
            'punctuation', 'dates', 'typos', 'duplets',
            'abbreviations', 'synonyms',
            'phones', 'emails', 'urls', 'fio',
            'spaces', 'pc-parts', 'auto-parts', 'gadgets',
            'parasites', 'letter-stego',
            'recipes', 'addresses', 'playlist', 'code-stego', 'json-config',
            'categorized-words', 'smiles', 'emoji-stego',
        ];
        
        const compatibleStandard = allStandard.filter(
            name => this.channels[name] && !disabledChannels.has(name)
        );
        
        // CRITICAL: Set activeChannels DIRECTLY — do NOT call setActiveChannels()
        // because it clears _extremeActiveChannels, which would kill all extreme
        // encoding. setActiveChannels is for standard (non-extreme) mode only.
        this.activeChannels = compatibleStandard
            .map(name => this.channels[name])
            .filter(Boolean);
    }

    /**
     * Анализ ёмкости текста-носителя.
     *
     * Все каналы анализируют ОДИН И ТОТ ЖЕ текст.
     * Это гарантирует что bases = f(text) — детерминированная функция.
     */
    analyzeCarrier(text) {
        let totalBits = 0;
        const allBases = [];
        const channelStats = {};

        for (const channel of this.activeChannels) {
            try {
                const analysis = channel.analyzeCapacity(text);
                totalBits += analysis.totalBits;
                allBases.push(...analysis.bases);
                channelStats[channel.name] = {
                    bits:      analysis.totalBits,
                    positions: analysis.positions ? analysis.positions.length : analysis.bases.length
                };
            } catch (e) {
                console.warn(`Channel ${channel.name} analyzeCapacity error:`, e);
            }
        }

        this.mixedRadix.setBases(allBases);
        return { totalBits, capacityBytes: Math.floor(totalBits / 8), channels: channelStats, bases: allBases };
    }

    /**
     * Кодирование сообщения через Mixed-Radix Numeral System.
     *
     * Алгоритм (трёхфазный для совместимости теговых и не-теговых каналов):
     *
     * Фаза 1: Кодируем теговые каналы с нулевыми индексами → промежуточный текст.
     *          Это даёт текст, идентичный тому, что будет при decode.
     * Фаза 2: Анализируем НЕ-теговые каналы на промежуточном тексте → otherBases.
     *          Bases НЕ-теговых каналов теперь совпадают с decode.
     * Фаза 3: M → indices → кодируем теговые с правильными индексами,
     *          затем не-теговые, затем letter-stego.
     *
     * КЛЮЧЕВОЕ: bases НЕ-теговых каналов вычисляются на тексте с
     * сгенерированными блоками (а не с тегами), что гарантирует
     * совпадение с decode, где текст уже содержит блоки.
     */
    async encodeMessage(secretMessage, carrierText, password) {
        const startTime = Date.now();

        try {

        // 0. КРИТИЧЕСКО: очищаем _excludedSpans и _abbrWordsExcl от предыдущих
        // вызовов decodeMessage/_autoRoundtrip. Без очистки stale _excludedSpans
        // от предыдущего decode (через _autoRoundtrip в live preview) вызывают
        // неправильный анализ в Phase 1b (abbreviations) и Phase 2 (non-tag),
        // что приводит к рассинхронизации bases → конвергенция не достигается.
        for (const ch of Object.values(this.channels)) {
            ch._excludedSpans = null;
            ch._abbrWordsExcl = null;
        }

        // 0.1. Если синонимы в режиме backend — prefetch синсетов
        const synCh = this.channels['synonyms'];
        if (synCh && synCh.mode === 'backend') {
            await synCh.prefetchSynsets(carrierText);
        }

        // 1. Шифруем
        const msgBytes  = this.crypto.stringToBytes(secretMessage);
        const encrypted = await this.crypto.encrypt(msgBytes, password);

        // 1.5. letter-stego lookup
        const lsCh = this.activeChannels.find(c => c.name === 'letter-stego');
        const otherChannels = this.activeChannels.filter(c => c.name !== 'letter-stego');

        // 1.6. Разделяем каналы на теговые и не-теговые
        const tagChannels = otherChannels.filter(ch => ch._isTagBased);
        const nonTagChannels = otherChannels.filter(ch => !ch._isTagBased);

        // ─── ФАЗА 1: Пробное кодирование теговых каналов с нулевыми индексами ───
        let phase1Result = carrierText;
        for (const channel of tagChannels) {
            try {
                const analysis = channel.analyzeCapacity(carrierText);
                const zeros = new Array(analysis.bases.length).fill(0);
                phase1Result = channel.encode(phase1Result, zeros);
            } catch (e) {
                console.warn(`[encode] Tag channel ${channel.name} phase-1 error:`, e);
            }
        }

        // ─── ФАЗА 1b: Предварительное расширение аббревиатур (нормализация) ───
        // КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: расширяем ВСЕ аббревиатуры до полной формы
        // ДО анализа ёмкости. Это гарантирует что:
        // 1. Все каналы анализируют ОДИН И ТОТ ЖЕ текст (с расширениями)
        // 2. КонвергенцияLoop видит стабильные bases
        // 3. Decode видит те же bases
        // Без этого: «РФ»→«Российская Федерация» создаёт новые слова
        // → синонимы/LS находят больше позиций → bases не совпадают →
        // конвергенция не достигается или decode даёт другие bases.
        const abbrCh = nonTagChannels.find(ch => ch.name === 'abbreviations');
        if (abbrCh) {
            try {
                const abbrAnalysis = abbrCh.analyzeCapacity(phase1Result);
                if (abbrAnalysis.bases.length > 0) {
                    // Расширяем ВСЕ аббревиатуры: index=1 = полная форма
                    const abbrIndices = new Array(abbrAnalysis.bases.length).fill(1);
                    phase1Result = abbrCh.encode(phase1Result, abbrIndices);
                }
            } catch (e) {
                console.warn(`[encode] Abbr phase-1b error:`, e);
            }
        }

        // ─── ФАЗА 1.3: Вычисляем начальные спаны ДО нормализации ──────
        // Спаны нужны чтобы LS-нормализация не меняла буквы внутри
        // сгенерированных блоков (ФИО, комплектующие и т.д.).
        const initialSpansMap = new Map();
        const initialAllSpans = [];
        for (const ch of this.activeChannels) {
            if (ch.getSpans && ch !== lsCh) {
                try {
                    const spans = ch.getSpans(phase1Result);
                    initialSpansMap.set(ch.name, spans);
                    initialAllSpans.push(...spans);
                } catch (e) {}
            }
        }
        // Устанавливаем _excludedSpans для LS-нормализации
        if (lsCh) {
            const own = initialSpansMap.get(lsCh.name) || [];
            lsCh._excludedSpans = initialAllSpans.filter(s =>
                !own.some(os => os.start === s.start && os.end === s.end)
            );
        }

        // ─── ФАЗА 1.5: LS-нормализация текста ──────────────────────
        // LS может менять буквы внутри слов (восстанавливая "правильные"
        // формы). Если текст-носитель содержит слова с "неправильными"
        // буквами на LS-позициях, encode поместит туда правильную букву,
        // а restore её оставит. Чтобы не-LS каналы видели один и тот же
        // текст при encode и decode, нормализуем текст ДО конвергенции.
        if (lsCh) {
            try {
                phase1Result = lsCh.normalizeText(phase1Result);
            } catch (e) {
                console.warn('[encode] LS normalize phase-1.5 error:', e);
            }
            lsCh._excludedSpans = null; // очистка после нормализации
        }

        // ─── ФАЗА 1.6: Extreme normalization ──────────────────────
        // Extreme channels modify text in ways that break other channels.
        // Normalize carrier text before capacity analysis so all channels
        // see the same text they'll see during decode.
        if (this._extremeActiveChannels.length > 0) {
            for (const extremeCh of this._extremeActiveChannels) {
                try {
                    phase1Result = extremeCh.normalizeText(phase1Result);
                } catch (e) {
                    console.warn(`[encode] Extreme normalize ${extremeCh.name} error:`, e);
                }
            }
        }

        // ─── ФАЗА 2: Начальные bases ───

        // Теговые каналы: bases зависят только от количества тегов (анализируем на carrierText)
        const tagChannelData = [];
        const tagBases = [];
        for (const channel of tagChannels) {
            try {
                const analysis = channel.analyzeCapacity(carrierText);
                tagBases.push(...analysis.bases);
                tagChannelData.push({ channel, analysis });
            } catch (e) {
                console.warn(`Channel ${channel.name} analyzeCapacity error:`, e);
                tagChannelData.push({ channel, analysis: null });
            }
        }

        // НЕ-теговые: начальные bases на тексте с нулевыми тегами (phase1Result)
        const nonTagChannelData = [];
        let nonTagBases = [];
        for (const channel of nonTagChannels) {
            try {
                const analysis = channel.analyzeCapacity(phase1Result);
                nonTagBases.push(...analysis.bases);
                nonTagChannelData.push({ channel, analysis });
            } catch (e) {
                console.warn(`Channel ${channel.name} analyzeCapacity error:`, e);
                nonTagChannelData.push({ channel, analysis: null });
            }
        }

        // letter-stego: начальные bases
        // КРИТИЧЕСКО: Устанавливаем _excludedSpans для LS перед вычислением bases.
        // Без этого LS видит текст без exclusion (phase1Result содержит «РФ»,
        // а не «Российская Федерация»). Seed chain LS идёт через «РФ» → seed
        // отличается от decode (где seed chain идёт через «Российская»/«Федерация»).
        // С _excludedSpans LS пропускает слова внутри abbreviation/parasite spans
        // и НЕ обновляет seed chain (см. fix в letter-stego.js).
        // Это гарантирует что seed chain Konsistentно «перепрыгивает» excluded-регион.
        let lsBases = [];
        if (lsCh) {
            try {
                const lsPhaseExcl = [];
                for (const ch of this.activeChannels) {
                    if (ch.getSpans && ch !== lsCh) {
                        try {
                            const spans = ch.getSpans(phase1Result);
                            lsPhaseExcl.push(...spans);
                        } catch (e) {}
                    }
                }
                lsCh._excludedSpans = lsPhaseExcl.length > 0 ? lsPhaseExcl : null;
                lsBases = lsCh.analyzeCapacity(phase1Result).bases;
                lsCh._excludedSpans = null;
            } catch (e) {
                console.warn('letter-stego analyzeCapacity error:', e);
            }
        }

        // Extreme channels: bases pre-computed on normalized text for the capacity
        // PRE-CHECK only. The actual encoding uses dynamically computed bases in the
        // convergence loop (step 3e), which may differ because extreme channels modify
        // text sequentially (CL changes case → affects CYR positions, etc.).
        // The pre-check estimate is conservative: if it passes, convergence will succeed.
        // If it fails but actual capacity would suffice, the convergence loop's
        // capacity check (iter 0 restart) will handle it.
        let extremeBases = [];
        if (this._extremeActiveChannels.length > 0) {
            for (const extremeCh of this._extremeActiveChannels) {
                try {
                    const analysis = extremeCh.analyzeCapacity(phase1Result);
                    extremeBases.push(...analysis.bases);
                } catch (e) {
                    console.warn(`Extreme pre-check capacity error:`, e);
                }
            }
        }

        let allBases = [...tagBases, ...nonTagBases, ...lsBases, ...extremeBases];
        this.mixedRadix.setBases(allBases);

        if (this.mixedRadix.maxValue === 0n) {
            const channelInfo = this.activeChannels.map(c => {
                try {
                    const a = c.analyzeCapacity(phase1Result);
                    return `${c.name}:${a.bases.length}позиций`;
                } catch(e) { return `${c.name}:ошибка`; }
            }).join(', ');
            throw new Error(`Нет ёмкости для кодирования.\nАктивные каналы: ${channelInfo || 'нет'}\nПопробуйте более длинный текст-носитель или включите больше каналов.`);
        }

        // M = BigInt(encrypted)
        const M = this.mixedRadix.bytesToBigInt(encrypted);

        if (M >= this.mixedRadix.maxValue) {
            const needed    = Math.ceil(encrypted.length * 8);
            const available = this.mixedRadix.getCapacityBits();
            throw new Error(
                `Текст-носитель слишком мал.\nНужно: ~${needed} бит, доступно: ${available} бит.\n` +
                `Используйте более длинный текст-носитель.`
            );
        }

        // ─── ФАЗА 3: Convergence loop с полной симуляцией decode ───
        //
        // Проблема: при encode не-теговые каналы модифицируют текст
        // ПОСЛЕДОВАТЕЛЬНО. Каждый следующий канал видит текст,
        // изменённый предыдущими каналами. Поэтому фактическое количество
        // позиций может отличаться от начального анализа (Phase 2).
        // Индексы, нарезанные по Phase 2 counts, смещаются → roundtrip ломается.
        //
        // Решение: после каждого раунда кодирования симулируем полный decode
        // и проверяем, что извлечённые indices СОВПАДАЮТ с вложенными.
        // Если нет — обновляем allBases по результатам симуляции и повторяем.
        //
        // Конвергенция обычно достигается за 1-3 итерации.

        let indices = this.mixedRadix.encode(M);
        let result;
        let converged = false;

        // Simulation variables (let — accessible after loop for diagnostics)
        let simAllBases = [], simAllIndices = [];
        let simTagBases = [], simTagIndices = [];
        let simNonTagBases = [], simNonTagIndices = [];
        let simLsBases = [], simLsIndices = [];
        let prevPostSpansMap = undefined; // Unused after recompute fix

        const MAX_CONVERGE = 12;
        for (let iter = 0; iter < MAX_CONVERGE; iter++) {
            // ── Encode ──────────────────────────────────────────
            // КРИТИЧЕСКОЕ: начинаем с carrierText (теги на месте),
            // а НЕ с phase1Result (где Phase 1 уже заменила теги на
            // zero-recipes). Иначе tag-encode ничего не кодирует —
            // тегов в тексте нет, а encode() пропускает generated blocks.
            result = carrierText;
            let offset = 0;

            // 3a. Теговые каналы (анализ на carrierText, стабильны)
            for (const { channel, analysis } of tagChannelData) {
                if (!analysis) continue;
                try {
                    const count = analysis.bases.length;
                    result = channel.encode(result, indices.slice(offset, offset + count));
                    offset += count;
                } catch (e) {
                    console.warn(`[encode] Tag ${channel.name}:`, e);
                    offset += analysis.bases.length;
                }
            }

            // 3b. Спаны после тегового кодирования (начальное значение)
            // Для итерации 0 используем пустые спаны (без исключений),
            // для последующих — спаны с предыдущей итерации.
            // КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: _excludedSpans пересчитываются
            // перед КАЖДЫМ не-теговым каналом, т.к. предыдущие каналы
            // меняют длину текста → символьные позиции спанов сдвигаются.
            // Использование устаревших спанов приводит к тому, что канал
            // некорректно исключает/включает позиции → bases не совпадают
            // с decode.

            // 3c. Не-теговые каналы: ПОСЛЕДОВАТЕЛЬНЫЙ пересчёт bases.
            // Перед каждым каналом пересчитываем _excludedSpans по
            // ТЕКУЩЕМУ тексту (после модификаций предыдущих каналов).
            for (let ci = 0; ci < nonTagChannels.length; ci++) {
                const channel = nonTagChannels[ci];

                // КРИТИЧЕСКО: очищаем _excludedSpans перед getSpans.
                // getSpans должен возвращать ВСЕ спаны канала (для объявления
                // владения регионом), а не фильтровать по устаревшим
                // _excludedSpans от предыдущего канала. Без очистки при
                // расширении аббревиатур (РФ→Российская Федерация)
                // устаревшие спаны вызывают потерю матчей → roundtrip ломается.
                for (const ch of this.activeChannels) {
                    ch._excludedSpans = null;
                }

                // Пересчитываем спаны по текущему тексту
                const curSpansMap = new Map();
                const curAllSpans = [];
                for (const ch of this.activeChannels) {
                    if (ch.getSpans && ch !== lsCh) {
                        try {
                            const spans = ch.getSpans(result);
                            curSpansMap.set(ch.name, spans);
                            curAllSpans.push(...spans);
                        } catch (e) {}
                    }
                }
                for (const ch of this.activeChannels) {
                    const own = curSpansMap.get(ch.name) || [];
                    ch._excludedSpans = curAllSpans.filter(s =>
                        !own.some(os => os.start === s.start && os.end === s.end)
                    );
                }

                // Build abbreviation words exclusion set
                const abbrWordsExcl = new Set();
                const abbrCh = this.channels['abbreviations'];
                if (abbrCh && abbrCh.getAllFullFormWords) {
                    for (const w of abbrCh.getAllFullFormWords()) {
                        abbrWordsExcl.add(w);
                        abbrWordsExcl.add(w.replace(/ё/g, 'е'));
                    }
                }
                if (this.channels['synonyms']) {
                    this.channels['synonyms']._abbrWordsExcl = abbrWordsExcl;
                }

                try {
                    const analysis = channel.analyzeCapacity(result);
                    const count = analysis.bases.length;
                    result = channel.encode(result, indices.slice(offset, offset + count));
                    offset += count;
                } catch (e) {
                    console.warn(`[encode] NonTag ${channel.name}:`, e);
                }
            }

            // 3d. Кодируем letter-stego ПОСЛЕДНИМ
            if (lsCh) {
                try {
                    result = lsCh.encode(result, indices.slice(offset));
                } catch (e) {
                    console.warn('[encode] letter-stego:', e);
                }
            }

            // 3e. Extreme channels encode LAST (after letter-stego)
            // Bases computed dynamically on current text (after CL/CYR encode)
            if (this._extremeActiveChannels.length > 0) {
                const dynamicExtremeBases = [];
                for (const extremeCh of this._extremeActiveChannels) {
                    try {
                        const analysis = extremeCh.analyzeCapacity(result);
                        dynamicExtremeBases.push(...analysis.bases);
                        const count = analysis.bases.length;
                        result = extremeCh.encode(result, indices.slice(offset, offset + count));
                        offset += count;
                    } catch (e) {
                        console.warn(`[encode] Extreme ${extremeCh.name}:`, e);
                    }
                }
                // Update allBases with dynamically computed extreme bases for next simulation
                if (dynamicExtremeBases.length !== extremeBases.length ||
                    !dynamicExtremeBases.every((b, i) => b === extremeBases[i])) {
                    // Extreme bases changed — need another convergence iteration
                    // (this is similar to how non-tag channels are handled)
                }
                extremeBases = dynamicExtremeBases;
                allBases = [...tagBases, ...nonTagBases, ...lsBases, ...extremeBases];
                if (iter === 0) {
                    // On first iteration, update mixedRadix with correct extreme bases
                    // and re-encode indices from the start
                    this.mixedRadix.setBases(allBases);
                    if (M >= this.mixedRadix.maxValue) {
                        const needed    = Math.ceil(encrypted.length * 8);
                        const available = this.mixedRadix.getCapacityBits();
                        throw new Error(
                            `Недостаточно ёмкости для кодирования.
Нужно: ~${needed} бит, доступно: ${available} бит.
` +
                            `Используйте более длинный текст-носитель.`
                        );
                    }
                    indices = this.mixedRadix.encode(M);
                    // Reset convergence — restart with correct bases
                    converged = false;
                    continue;
                }
            }

            // ── Post-encoding спаны (для decode-подобных _excludedSpans) ──
            // КРИТИЧЕСКО: очищаем _excludedSpans перед getSpans.
            // В реальном decodeMessage _excludedSpans = null при вызове getSpans
            // (из-за finally-блока). Симуляция должна совпадать с decode.
            // Без очистки stale _excludedSpans от encoding loop вызывают
            // потерю спанов → неточное вычисление _excludedSpans для decode →
            // ложная конвергенция → roundtrip ломается при расширении аббревиатур.
            for (const ch of this.activeChannels) {
                ch._excludedSpans = null;
            }
            const postSpansMap = new Map();
            const postAllSpans = [];
            for (const ch of this.activeChannels) {
                if (ch.getSpans && ch !== lsCh) {
                    try {
                        const spans = ch.getSpans(result);
                        postSpansMap.set(ch.name, spans);
                        postAllSpans.push(...spans);
                    } catch (e) {}
                }
            }

            // ── 3e. Симуляция decode (проверка конвергенции) ──────
            // Устанавливаем decode-подобные _excludedSpans
            for (const ch of this.activeChannels) {
                const own = postSpansMap.get(ch.name) || [];
                ch._excludedSpans = postAllSpans.filter(s =>
                    !own.some(os => os.start === s.start && os.end === s.end)
                );
            }

            // КРИТИЧЕСКО: Устанавливаем _abbrWordsExcl для synonyms,
            // ТОЧНО так же как в decodeMessage. Без этого симуляция
            // может найти больше/меньше синоним-матчей (слова из расширений
            // аббревиатур не фильтруются), что вызывает расхождение bases
            // между симуляцией и реальным decode → ложная неконвергенция
            // или ложная конвергенция → roundtrip ломается.
            if (abbrCh && abbrCh.getAllFullFormWords && this.channels['synonyms']) {
                const simAbbrWordsExcl = new Set();
                for (const w of abbrCh.getAllFullFormWords()) {
                    simAbbrWordsExcl.add(w);
                    simAbbrWordsExcl.add(w.replace(/ё/g, 'е'));
                }
                this.channels['synonyms']._abbrWordsExcl = simAbbrWordsExcl;
            }

            // Extreme decode + restore (before LS in decode order)
            // CRITICAL FIX: Bases/indices must be in ENCODING order (case-ladder → cyrillic-latin → zero-width-ext)
            // to match the encoding path. Decode/restore happens in reverse order for correct text
            // manipulation, but the resulting bases/indices arrays are reversed to encoding order.
            let simTextAfterExtremeRestore = result;
            const _simExtremeBases = [], _simExtremeIndices = [];
            if (this._extremeActiveChannels.length > 0) {
                // Decode in reverse encoding order for correct text manipulation
                const reversedExtreme = [...this._extremeActiveChannels].reverse();
                // Collect per-channel data (in decode/reverse order)
                const simExtremeChannelData = [];
                for (const extremeCh of reversedExtreme) {
                    try {
                        simExtremeChannelData.push({
                            bases: extremeCh.analyzeCapacity(simTextAfterExtremeRestore).bases,
                            indices: extremeCh.decode(simTextAfterExtremeRestore),
                        });
                        simTextAfterExtremeRestore = extremeCh.restore(simTextAfterExtremeRestore);
                    } catch (e) {
                        simExtremeChannelData.push({ bases: [], indices: [] });
                    }
                }
                // Concatenate in ENCODING order (reverse of decode order)
                for (let i = simExtremeChannelData.length - 1; i >= 0; i--) {
                    _simExtremeBases.push(...simExtremeChannelData[i].bases);
                    _simExtremeIndices.push(...simExtremeChannelData[i].indices);
                }
            }

            // LS decode + restore (use text after extreme restore)
            let simTextAfterRestore = simTextAfterExtremeRestore;
            const _simLsBases = [], _simLsIndices = [];
            if (lsCh) {
                try {
                    _simLsBases.push(...lsCh.analyzeCapacity(simTextAfterRestore).bases);
                    _simLsIndices.push(...lsCh.decode(simTextAfterRestore));
                    simTextAfterRestore = lsCh.restore(simTextAfterRestore);
                } catch (e) {}
            }

            // Tag decode
            const _simTagBases = [], _simTagIndices = [];
            for (const channel of tagChannels) {
                try {
                    const a = channel.analyzeCapacity(simTextAfterRestore);
                    _simTagBases.push(...a.bases);
                    _simTagIndices.push(...channel.decode(simTextAfterRestore));
                } catch (e) {}
            }

            // Non-tag decode
            const _simNonTagBases = [], _simNonTagIndices = [];
            for (const channel of nonTagChannels) {
                try {
                    const a = channel.analyzeCapacity(simTextAfterRestore);
                    _simNonTagBases.push(...a.bases);
                    _simNonTagIndices.push(...channel.decode(simTextAfterRestore));
                } catch (e) {}
            }

            // Update simulation variables (accessible after loop for diagnostics)
            simAllBases      = [..._simTagBases, ..._simNonTagBases, ..._simLsBases, ..._simExtremeBases];
            simAllIndices    = [..._simTagIndices, ..._simNonTagIndices, ..._simLsIndices, ..._simExtremeIndices];
            simTagBases      = _simTagBases;
            simNonTagBases   = _simNonTagBases;
            simLsBases       = _simLsBases;
            simTagIndices    = _simTagIndices;
            simNonTagIndices = _simNonTagIndices;
            simLsIndices     = _simLsIndices;

            // ── Проверка конвергенции: bases И indices ──
            const basesOk = simAllBases.length === allBases.length &&
                simAllBases.every((b, i) => b === allBases[i]);
            const indicesOk = basesOk &&
                simAllIndices.length === indices.length &&
                simAllIndices.every((v, i) => v === indices[i]);

            // ── ДИАГНОСТИКА: расширенное логирование для рецептов ──
            if (!basesOk || !indicesOk) {
                // DETAIL: show per-element mismatch
                if (basesOk) {
                    // bases match but indices don't — find first index mismatch
                    for (let bi = 0; bi < simAllIndices.length && bi < indices.length; bi++) {
                        if (simAllIndices[bi] !== indices[bi]) {
                            const section = bi < simTagBases.length ? 'TAG' :
                                bi < simTagBases.length + simNonTagBases.length ? 'NONTAG' : 'LS';
                            console.warn(`[CONV-IDX-MISMATCH iter=${iter}] idx=${bi} section=${section} enc=${indices[bi]} sim=${simAllIndices[bi]} base=${allBases[bi]}`);
                            if (bi > 3) { console.warn(`  ... (more mismatches)`); break; }
                        }
                    }
                } else {
                    // bases mismatch — find first base difference
                    for (let bi = 0; bi < simAllBases.length && bi < allBases.length; bi++) {
                        if (simAllBases[bi] !== allBases[bi]) {
                            console.warn(`[CONV-BASE-MISMATCH iter=${iter}] idx=${bi} encBase=${allBases[bi]} simBase=${simAllBases[bi]}`);
                            if (bi > 3) { console.warn(`  ... (more mismatches)`); break; }
                        }
                    }
                }

                const recipeCh = tagChannels.find(ch => ch.name === 'recipes');
                if (recipeCh) {
                    // Сколько рецептов найдено в carrier vs в simulation text
                    const carrierMatches = recipeCh._findMatches(carrierText);
                    const simMatches = recipeCh._findMatches(simTextAfterRestore);
                    console.warn(`[CONV-DIAG iter=${iter}] recipeCarrierMatches=${carrierMatches.length} (tags=${carrierMatches.filter(m=>m.isTag).length}, blocks=${carrierMatches.filter(m=>!m.isTag).length}) recipeSimMatches=${simMatches.length} (tags=${simMatches.filter(m=>m.isTag).length}, blocks=${simMatches.filter(m=>!m.isTag).length}) simTextLen=${simTextAfterRestore.length}`);
                    if (simMatches.length === 0 && carrierMatches.length > 0) {
                        // Show what headers are in the text
                        console.warn(`  simText preview: "${simTextAfterRestore.slice(0, 200)}"`);
                    }
                }
                console.warn(`[CONV-DIAG iter=${iter}] bases: all=${allBases.length} sim=${simAllBases.length} tag=${tagBases.length} simTag=${simTagBases.length} nonTag=${nonTagBases.length} simNonTag=${simNonTagBases.length} ls=${lsBases.length} simLs=${simLsBases.length}`);
            }

            // ── ДИАГНОСТИКА: логируем пер-канальное сравнение ──
            if (this._diagMode || window._stegoDiag) {
                const encTotal = tagBases.length + nonTagBases.length + lsBases.length;
                const simTotal = simTagBases.length + simNonTagBases.length + simLsBases.length;
                const tagMatch = tagBases.length === simTagBases.length;
                const ntMatch = nonTagBases.length === simNonTagBases.length &&
                    nonTagBases.every((b, i) => b === simNonTagBases[i]);
                const lsMatch = lsBases.length === simLsBases.length &&
                    lsBases.every((b, i) => b === simLsBases[i]);
                // Извлекаем nonTag-индексы из полного массива indices
                const encNonTagIndices = indices.slice(tagBases.length, tagBases.length + nonTagBases.length);
                const ntIdxMatch = encNonTagIndices.length === simNonTagIndices.length &&
                    encNonTagIndices.every((v, i) => v === simNonTagIndices[i]);

                console.warn(`[CONV iter=${iter}] encBases=${encTotal} simBases=${simTotal} tag=[${tagBases.length}/${simTagBases.length}] nt=[${nonTagBases.length}/${simNonTagBases.length}]${ntMatch?' ✓':' ✗'} ls=[${lsBases.length}/${simLsBases.length}]${lsMatch?' ✓':' ✗'} idxMatch=${ntIdxMatch?'✓':'✗'} basesOk=${basesOk} indicesOk=${indicesOk}`);

                // Per-channel detail for non-tag
                if (!ntMatch || !ntIdxMatch) {
                    let encOff = tagBases.length;
                    let simOff = simTagBases.length;
                    for (const ch of nonTagChannels) {
                        const encCount = nonTagChannelData.find(d => d.channel === ch)?.analysis?.bases.length || 0;
                        // Get sim count by accumulating
                        const simCount = simNonTagBases.slice(simOff).length;
                        // Rough: just log channel name and counts
                        console.warn(`  ${ch.name}: encBases=${nonTagBases.slice(encOff).length} simBases=${simCount}`);
                        encOff += encCount;
                        simOff += simCount;
                    }
                }
            }

            if (basesOk && indicesOk) {
                converged = true;
                nonTagBases = simNonTagBases;
                lsBases = simLsBases;
                allBases = simAllBases;
                this._convergenceIters = iter + 1;
                break;
            }

            // Не сошлось — обновляем allBases по результатам симуляции
            nonTagBases = simNonTagBases;
            lsBases = simLsBases;
            allBases = simAllBases;
            this.mixedRadix.setBases(allBases);

            // Проверяем ёмкость ДО переиндексации (иначе encode бросит сырую ошибку)
            if (this.mixedRadix.maxValue === 0n || M >= this.mixedRadix.maxValue) {
                const needed    = Math.ceil(encrypted.length * 8);
                const available = this.mixedRadix.getCapacityBits();
                throw new Error(
                    `Недостаточно ёмкости после корректировки bases.\nНужно: ~${needed} бит, доступно: ${available} бит.\n` +
                    `Используйте более длинный текст-носитель.`
                );
            }

            // КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: переиндексируем M с новыми bases.
            // Без этого indices остаются от старого setBases — slicing
            // в следующей итерации будет по неправильным смещениям.
            indices = this.mixedRadix.encode(M);

            // Сохраняем post-encoding спаны (для отладки)
            prevPostSpansMap = postSpansMap;
        }

        if (!converged) {
            console.warn(`[encode] Конвергенция не достигнута за ${MAX_CONVERGE} итераций`);
            this._convergenceIters = MAX_CONVERGE;
            // Store detailed diagnostic info for the test page
            this._lastConvDiag = {
                maxIter: MAX_CONVERGE,
                encBases: allBases.length,
                simBases: simAllBases.length,
                basesOk: false,
                indicesOk: false,
                tagBases: tagBases.length,
                simTagBases: simTagBases.length,
                nonTagBases: nonTagBases.length,
                simNonTagBases: simNonTagBases.length,
                lsBases: lsBases.length,
                simLsBases: simLsBases.length,
                perChannel: nonTagChannels.map(ch => {
                    const encCount = nonTagChannelData.find(d => d.channel === ch)?.analysis?.bases.length || 0;
                    return { name: ch.name, encBases: encCount };
                }),
                timestamp: new Date().toISOString(),
            };
        } else {
            this._lastConvDiag = null;
        }

        // Очищаем _excludedSpans и _abbrWordsExcl перед расчётом статистики
        for (const ch of Object.values(this.channels)) {
            ch._excludedSpans = null;
            ch._abbrWordsExcl = null;
        }

        const endTime = Date.now();
        // НЕ вызываем analyzeCarrier здесь — он вызывает setBases и перезаписывает
        // правильные bases, используемые при кодировании. Вместо этого вычисляем
        // статистику напрямую без побочного эффекта на mixedRadix.
        let usedBits = encrypted.length * 8;
        let capacityBits = 0;
        let channelPositions = {};
        for (const channel of this.activeChannels) {
            try {
                const analysis = channel.analyzeCapacity(result);
                capacityBits += analysis.totalBits;
                channelPositions[channel.name] = {
                    bits: analysis.totalBits,
                    positions: analysis.positions ? analysis.positions.length : analysis.bases.length
                };
            } catch (e) {}
        }
        this.stats = {
            channels:   this.activeChannels.length,
            bits:       capacityBits,
            usedBits:   usedBits,
            efficiency: capacityBits > 0
                ? (usedBits / capacityBits * 100).toFixed(1) : 0,
            time: Math.round(endTime - startTime),
            convergence: converged ? 'ok' : 'fail',
            convergenceIters: this._convergenceIters || 0,
        };

        // ─── Встраивание маркера экстремального кодирования ───
        // Когда экстремальные каналы активны, встраиваем 3 невидимых символа
        // в начало текста как надёжный сигнал для декодера:
        //   [0] U+FEFF — магический маркер (никогда не встречается в естественном тексте)
        //   [1] U+200D (ZWJ) = case-ladder вкл, U+200C (ZWNJ) = выкл
        //   [2] U+200D = cyrillic-latin вкл, U+200C = выкл
        // ZW-ext управляется своим чекбоксом — НЕ принудительно включается.
        // Если ZW-ext был выбран, он участвует в кодировании (bases + indices),
        // и декодер определяет его наличие по количеству найденных ZW-символов.
        // Маркер не влияет на позиции каналов (zero-width символы не являются буквами/пробелами).
        if (this._extremeActiveChannels.length > 0) {
            const clActive = this._extremeActiveChannels.some(ch => ch.name === 'case-ladder');
            const cyrActive = this._extremeActiveChannels.some(ch => ch.name === 'cyrillic-latin');
            result = '\uFEFF' + (clActive ? '\u200D' : '\u200C') + (cyrActive ? '\u200D' : '\u200C') + result;
        }

        return result;

        } finally {
            // ГАРАНТИРОВАННАЯ очистка _excludedSpans и _abbrWordsExcl для ВСЕХ каналов
            for (const ch of Object.values(this.channels)) {
                ch._excludedSpans = null;
                ch._abbrWordsExcl = null;
            }
        }
    }

    /**
     * Декодирование сообщения только по стего-тексту (без оригинала).
     *
     * Порядок: letter-stego ПЕРВЫМ (restore) → остальные каналы
     *
     * Это гарантирует что bases совпадают с encode:
     * - letter-stego анализирует стего-текст (синонимы + мутации)
     *   _getOriginal разрешает мутации → targetOrigNorm = синоним (как при encode)
     *   position-based seed → valid mutations совпадают с encode
     * - restore убирает мутации → textAfterRestore = carrierText + другие_каналы
     * - другие каналы анализируют textAfterRestore (синонимы на месте)
     *   canonical synsets → bases те же что при encode
     */
    async decodeMessage(stegoText, password) {
        const startTime = Date.now();

        try {
        // 0. КРИТИЧЕСКО: очищаем stale _excludedSpans и _abbrWordsExcl
        // от предыдущих вызовов encode/decode. Без очисткиChannels
        // leftover state corrupts span calculations.
        for (const ch of Object.values(this.channels)) {
            ch._excludedSpans = null;
            ch._abbrWordsExcl = null;
        }

        // 0.1. Если синонимы в режиме backend — prefetch синсетов стего-текста
        const synCh = this.channels['synonyms'];
        if (synCh && synCh.mode === 'backend') {
            await synCh.prefetchSynsets(stegoText);
        }

        // 0.5. Вычисляем спаны для эксклюзии при декодировании
        // ВАЖНО: каждый канал видит спаны ДРУГИХ каналов, но НЕ свои собственные!
        const decodeSpansMap = new Map();
        const decodeExcludedSpans = [];
        const lsCh = this.activeChannels.find(c => c.name === 'letter-stego');
        for (const ch of this.activeChannels) {
            if (ch.getSpans && ch !== lsCh) {
                try {
                    const spans = ch.getSpans(stegoText);
                    decodeSpansMap.set(ch.name, spans);
                    decodeExcludedSpans.push(...spans);
                } catch (e) {}
            }
        }
        for (const ch of this.activeChannels) {
            const ownSpans = decodeSpansMap.get(ch.name) || [];
            ch._excludedSpans = decodeExcludedSpans.filter(s =>
                !ownSpans.some(os => os.start === s.start && os.end === s.end)
            );
        }

        // КРИТИЧЕСКО: Устанавливаем _abbrWordsExcl для synonyms, чтобы
        // decode находил те же матчи что и simulation внутри encodeMessage.
        // Без этого synonym-канал может найти больше матчей (без фильтрации
        // слов из аббревиатурных расширений), что вызывает расхождение
        // bases между simulation и actual decode → roundtrip ломается.
        const abbrCh = this.channels['abbreviations'];
        if (abbrCh && abbrCh.getAllFullFormWords && this.channels['synonyms']) {
            const abbrWordsExcl = new Set();
            for (const w of abbrCh.getAllFullFormWords()) {
                abbrWordsExcl.add(w);
                abbrWordsExcl.add(w.replace(/ё/g, 'е'));
            }
            this.channels['synonyms']._abbrWordsExcl = abbrWordsExcl;
        }

        // 0.2. Detect extreme methods: marker-based (reliable) + heuristic fallback
        //
        // MARKER FORMAT (embedded by encodeMessage when extreme channels are active):
        //   [0] U+FEFF — magic marker (never in natural text)
        //   [1] U+200D (ZWJ) = case-ladder on, U+200C (ZWNJ) = off
        //   [2] U+200D = cyrillic-latin on, U+200C = off
        //   ZW-ext is NOT indicated by marker — detected by analyzing the text
        //   for non-natural ZW characters (U+200B/U+200C/U+200D between words)
        //
        // If the marker was stripped (e.g., by messenger), fall back to heuristic detection.
        let detectedExtremeMethods = [];
        let textForStandardDecode = stegoText;
        const extremeIndices = [];
        const extremeBases = [];
        let usedMarker = false;

        // Try marker-based detection first
        if (stegoText.length >= 3 && stegoText[0] === '\uFEFF') {
            const clFlag = stegoText[1] === '\u200D';
            const cyrFlag = stegoText[2] === '\u200D';
            // Valid flag chars: only U+200D or U+200C
            const validFlags = (stegoText[1] === '\u200D' || stegoText[1] === '\u200C') &&
                               (stegoText[2] === '\u200D' || stegoText[2] === '\u200C');

            if (validFlags) {
                if (clFlag) detectedExtremeMethods.push('case-ladder');
                if (cyrFlag) detectedExtremeMethods.push('cyrillic-latin');
                textForStandardDecode = stegoText.slice(3);
                usedMarker = true;
                console.warn(`[DECODE] Extreme marker found: ${detectedExtremeMethods.join(', ')}`);
            }
        }

        // Detect ZW-ext channel: NOT indicated by marker (marker only has CL/CYR flags).
        // ZW-ext is detected by checking for non-marker ZW characters in the text.
        // This must run AFTER marker parsing (textForStandardDecode = text minus marker).
        if (usedMarker) {
            const zwCh = this.extremeManager.zeroWidthExt;
            if (zwCh && zwCh.detect(stegoText)) {
                detectedExtremeMethods.push('zero-width-ext');
                console.warn(`[DECODE] ZW-ext detected via analyze: ${detectedExtremeMethods.join(', ')}`);
            }
        }

        // Fallback: heuristic detection (when marker was stripped)
        if (detectedExtremeMethods.length === 0) {
            detectedExtremeMethods = this.extremeManager.detectExtremeMethods(stegoText);
            if (detectedExtremeMethods.length > 0) {
                console.warn(`[DECODE] Extreme methods detected by heuristics: ${detectedExtremeMethods.join(', ')}`);
            }
        }
        
        if (detectedExtremeMethods.length > 0) {
            // Activate detected extreme channels
            const detectedChannels = this.extremeManager.getActiveChannels(detectedExtremeMethods);
            
            // Get disabled standard channels
            const disabledChannels = new Set();
            for (const name of detectedExtremeMethods) {
                (ExtremeChannelManager.COMPAT_MAP[name] || []).forEach(ch => disabledChannels.add(ch));
            }
            
            // Set extreme active channels
            this._extremeActiveChannels = detectedChannels;
            
            // Filter active channels to exclude incompatible ones BEFORE span computation
            this.activeChannels = this.activeChannels.filter(ch => !disabledChannels.has(ch.name));
            
            // Recompute spans after filtering (removed channels' spans should not be exclusions)
            const filteredSpansMap = new Map();
            const filteredAllSpans = [];
            const filteredLsCh = this.activeChannels.find(c => c.name === 'letter-stego');
            for (const ch of this.activeChannels) {
                if (ch.getSpans && ch !== filteredLsCh) {
                    try {
                        const spans = ch.getSpans(textForStandardDecode);
                        filteredSpansMap.set(ch.name, spans);
                        filteredAllSpans.push(...spans);
                    } catch (e) {}
                }
            }
            for (const ch of this.activeChannels) {
                const ownSpans = filteredSpansMap.get(ch.name) || [];
                ch._excludedSpans = filteredAllSpans.filter(s =>
                    !ownSpans.some(os => os.start === s.start && os.end === s.end)
                );
            }
            
            // CRITICAL: Decode extreme channels in reverse order (last encoded → first decoded)
            // but collect bases/indices in ENCODING order to match the mixed-radix encoding.
            const reversedDetected = [...detectedChannels].reverse();
            const extremeChannelData = [];
            for (const extremeCh of reversedDetected) {
                try {
                    extremeChannelData.push({
                        bases: extremeCh.analyzeCapacity(textForStandardDecode).bases,
                        indices: extremeCh.decode(textForStandardDecode),
                    });
                    textForStandardDecode = extremeCh.restore(textForStandardDecode);
                } catch (e) {
                    console.warn(`Extreme decode ${extremeCh.name} error:`, e);
                    extremeChannelData.push({ bases: [], indices: [] });
                }
            }
            // Concatenate in ENCODING order (reverse of decode order)
            for (let i = extremeChannelData.length - 1; i >= 0; i--) {
                extremeBases.push(...extremeChannelData[i].bases);
                extremeIndices.push(...extremeChannelData[i].indices);
            }
        }

        const otherChannels = this.activeChannels.filter(c => c.name !== 'letter-stego' && !c._isExtreme);
        const tagChannels = otherChannels.filter(ch => ch._isTagBased);
        const nonTagChannels = otherChannels.filter(ch => !ch._isTagBased);

        // 1. letter-stego декодируется ПЕРВЫМ из стего-текста (after extreme restore)
        let lsIndices = [];
        let lsBasesFromStego = [];
        let textAfterRestore = textForStandardDecode;

        if (lsCh) {
            try {
                // Анализируем текст после extreme restore для letter-stego
                const lsAnalysis = lsCh.analyzeCapacity(textForStandardDecode);
                lsBasesFromStego = lsAnalysis.bases;
                // Декодируем индексы
                lsIndices = lsCh.decode(textForStandardDecode);
                // Восстанавливаем текст (убираем мутации)
                textAfterRestore = lsCh.restore(textForStandardDecode);
            } catch (e) {
                console.warn('letter-stego decode error:', e);
            }
        }

        // 2. Анализируем восстановленный текст для остальных каналов
        //    Порядок: tagChannels → nonTagChannels (как при encode)
        const tagBases = [];
        const tagIndices = [];
        for (const channel of tagChannels) {
            try {
                const analysis = channel.analyzeCapacity(textAfterRestore);
                tagBases.push(...analysis.bases);
                tagIndices.push(...channel.decode(textAfterRestore));
            } catch (e) {
                console.warn(`Channel ${channel.name} decode error:`, e);
            }
        }

        const nonTagBases = [];
        const nonTagIndices = [];
        for (const channel of nonTagChannels) {
            try {
                const analysis = channel.analyzeCapacity(textAfterRestore);
                nonTagBases.push(...analysis.bases);
                nonTagIndices.push(...channel.decode(textAfterRestore));
            } catch (e) {
                console.warn(`Channel ${channel.name} decode error:`, e);
            }
        }

        // ── ДИАГНОСТИКА: per-channel decode bases (всегда логируем) ──
        console.warn(`[DECODE] tag=[${tagBases.length}] nonTag=[${nonTagBases.length}] ls=[${lsBasesFromStego.length}] total=[${tagBases.length + nonTagBases.length + lsBasesFromStego.length}] indices=[${tagIndices.length + nonTagIndices.length + lsIndices.length}]`);
        // Per-channel non-tag breakdown
        {
            let off = 0;
            for (const ch of nonTagChannels) {
                try {
                    const a = ch.analyzeCapacity(textAfterRestore);
                    console.warn(`  [DECODE] ${ch.name}: bases=${a.bases.length}`);
                    off += a.bases.length;
                } catch (e) {
                    console.warn(`  [DECODE] ${ch.name}: bases=ERROR (${e.message})`);
                }
            }
        }
        if (this._diagMode || window._stegoDiag) {
            for (const ch of nonTagChannels) {
                const ci = nonTagChannels.indexOf(ch);
                const prevTotal = [...tagBases, ...nonTagBases.slice(0, ci)].length;
                const count = nonTagBases.length - prevTotal + tagBases.length;
                console.warn(`  ${ch.name}: ${count} bases (accumulated)`);
            }
            console.warn(`[DECODE] _abbrWordsExcl set: ${this.channels['synonyms']?._abbrWordsExcl ? 'YES (' + this.channels['synonyms']._abbrWordsExcl.size + ' words)' : 'NO'}`);
        }

        // 3. Объединяем bases и indices В ТОМ ЖЕ порядке что при encode:
        //    tag → nonTag → letter-stego → extreme
        const allBases = [...tagBases, ...nonTagBases, ...lsBasesFromStego, ...extremeBases];
        const allIndices = [...tagIndices, ...nonTagIndices, ...lsIndices, ...extremeIndices];

        this.mixedRadix.setBases(allBases);

        // Выравниваем длину (pad — безопасно, truncate — НЕЛЬЗЯ)
        const expectedLen = this.mixedRadix.bases.length;
        while (allIndices.length < expectedLen) allIndices.push(0);
        if (allIndices.length > expectedLen) {
            const extra = allIndices.length - expectedLen;
            // Per-channel breakdown of the excess indices
            const tagCount = tagIndices.length;
            const ntCount = nonTagIndices.length;
            const lsCount = lsIndices.length;
            throw new Error(
                `[DECODE] Index/base length mismatch: ${allIndices.length} indices vs ${expectedLen} bases (excess=${extra}). ` +
                `Per-channel indices: tag=${tagCount} nonTag=${ntCount} ls=${lsCount}. ` +
                `Per-channel bases: tag=${tagBases.length} nonTag=${nonTagBases.length} ls=${lsBasesFromStego.length}. ` +
                `This means decode found more positions than encode — check channel determinism.`
            );
        }

        // 4. Mixed-radix decode → BigInt M
        const M = this.mixedRadix.decode(allIndices);

        // 5. BigInt → байты: перебираем размеры пока crypto.decrypt не вернёт валидные данные
        const maxBytes  = Math.ceil(this.mixedRadix.getCapacityBits() / 8);
        const rawBytes  = this.mixedRadix.bigIntToBytes(M);
        let decrypted   = null;

        for (let trySize = Math.max(2, rawBytes.length); trySize <= maxBytes; trySize++) {
            const padded = new Uint8Array(trySize);
            // Вставляем rawBytes в конец (ведущие нули слева)
            const srcStart = rawBytes.length > trySize ? rawBytes.length - trySize : 0;
            const dstStart = trySize > rawBytes.length ? trySize - rawBytes.length : 0;
            padded.set(rawBytes.slice(srcStart), dstStart);
            try {
                decrypted = await this.crypto.decrypt(padded, password);
                break;
            } catch(e) { /* попробуем следующий размер */ }
        }

        if (!decrypted) throw new Error('Неверный пароль или повреждённые данные.');
        const message = this.crypto.bytesToString(decrypted);

        const endTime = Date.now();
        this.stats = {
            channels: this.activeChannels.length,
            bits:     this.mixedRadix.getCapacityBits(),
            time:     Math.round(endTime - startTime)
        };

        return message;

        } finally {
            // ГАРАНТИРОВАННАЯ очистка _excludedSpans и _abbrWordsExcl для ВСЕХ каналов
            // Даже если decodeMessage выбросил исключение
            for (const ch of Object.values(this.channels)) {
                ch._excludedSpans = null;
                ch._abbrWordsExcl = null;
            }
        }
    }

    getChannelInfo() {
        return Object.entries(this.channels).map(([name, channel]) => ({
            name,
            active: this.activeChannels.includes(channel),
            safe:   ['synonyms','yo','punctuation','dates','typos','duplets','spaces','phones','emails','urls','fio','parasites','abbreviations','letter-stego'].includes(name),
            stats:  channel.getStats ? channel.getStats() : {}
        }));
    }

    getStats() { return this.stats; }
}

export default StegoEngine;
