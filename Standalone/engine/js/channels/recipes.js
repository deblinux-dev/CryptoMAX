/**
 * Канал кодирования через кулинарные рецепты — v2
 *
 * Принцип: находим теги [steg-recipe-*] в тексте и заменяем на процедурно
 * сгенерированные рецепты. Данные кодируются в ингредиентах и шагах
 * приготовления через RecipeSteganography.
 *
 * Обнаружение сгенерированных блоков — по ключевым словам:
 *   - Начало: RECIPE_STARTS (фразы-вступления)
 *   - Конец: RECIPE_ENDS (фразы-завершения)
 *   - Между ними: RECIPE_INSTRUCTION_HEADERS (заголовок инструкций)
 *
 * Канал использует динамическое количество строк ингредиентов (4-20),
 * что позволяет кодировать больше данных без переполнения.
 *
 * Типы рецептов (алиасы):
 *   [steg-recipe-universal]  — Универсальный
 *   [steg-recipe-meat]       — Мясные блюда
 *   [steg-recipe-dessert]    — Десерты
 *   [steg-recipe-salad]      — Салаты
 *   [steg-recipe-soup]       — Супы
 */

import RecipeSteganography, {
    RECIPE_STARTS,
    RECIPE_ENDS,
    RECIPE_INSTRUCTION_HEADERS,
    INGREDIENTS_FLAT,
    ACTIONS_BASE,
    FORMAT_BASE,
    RECIPE_CONTEXTS,
} from '../templates/recipes.js';

import MixedRadixEncoder from '../core/mixed-radix.js';

// ─── Типы рецептов ────────────────────────────────────────────
const RECIPE_TYPES = Object.keys(RECIPE_CONTEXTS);

// Количество байт, которое канал может закодировать в один тег
// Рецептный движок с 20 строками ингредиентов гарантированно справляется
// с этим объёмом данных (worst-case capacity ≈ 34 байта)
const BYTES_PER_TAG = 30;

export class RecipesChannel {
    constructor() {
        this.name = 'recipes';
        this.loaded = true;
        this._isTagBased = true;

        // Regex для поиска тегов
        this.TAG_REGEX = new RegExp(
            '\\[steg-recipe-(' + RECIPE_TYPES.join('|') + ')\\]', 'g'
        );

        // Прекомпилированные regex для обнаружения рецептов по ключевым словам
        this._buildDetectionRegexes();

        // Создаём генератор рецептов для каждого типа контекста
        // min=4, max=20 — динамическое количество строк ингредиентов
        this._engines = {};
        for (const typeKey of RECIPE_TYPES) {
            this._engines[typeKey] = new RecipeSteganography({
                contextType: typeKey,
                maxIngredientLines: 20,
                minIngredientLines: 4,
            });
        }
        this._defaultEngine = this._engines['universal'];

        // Фиксированные bases: каждый тег — это BYTES_PER_TAG байтов
        // base 256 для каждой позиции (ровно 1 байт на позицию)
        this._bases = new Array(BYTES_PER_TAG).fill(256);

        // Внутренний mixed-radix для конвертации indices ↔ bytes
        this._encoder = new MixedRadixEncoder();
        this._encoder.setBases(this._bases);
    }

    _buildDetectionRegexes() {
        // Первые строки RECIPE_STARTS — уникальные фразы-вступления рецептов
        const startFirstLines = RECIPE_STARTS.map(s => {
            const firstLine = s.split('\n')[0];
            return firstLine.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        });
        this.START_REGEX = new RegExp('(?:' + startFirstLines.join('|') + ')', 'gi');

        // RECIPE_ENDS — фразы завершения рецепта (уникальны)
        const endEscaped = RECIPE_ENDS.map(e => e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        this.END_REGEX = new RegExp('(?:' + endEscaped.join('|') + ')', 'gi');

        // RECIPE_INSTRUCTION_HEADERS — заголовок перехода к инструкциям
        const headerEscaped = RECIPE_INSTRUCTION_HEADERS.map(h => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        this.HEADER_REGEX = new RegExp('(?:' + headerEscaped.join('|') + ')', 'gi');
    }

    // ─── Поиск тегов и сгенерированных блоков ──────────────────
    _findMatches(text) {
        const matches = [];

        // 1. Теги [steg-recipe-*]
        this.TAG_REGEX.lastIndex = 0;
        let m;
        while ((m = this.TAG_REGEX.exec(text)) !== null) {
            matches.push({
                index: m.index,
                length: m[0].length,
                typeKey: m[1],
                full: m[0],
                isTag: true,
            });
        }

        // 2. Сгенерированные блоки (по ключевым словам)
        // Ищем заголовки инструкций — они уникальны и всегда есть в рецепте
        this.HEADER_REGEX.lastIndex = 0;
        while ((m = this.HEADER_REGEX.exec(text)) !== null) {
            const headerStart = m.index;
            const headerEnd = m.index + m[0].length;

            // Ищем начало рецепта: сканируем назад от заголовка
            let blockStart = -1;
            const textBeforeHeader = text.slice(0, headerStart);
            this.START_REGEX.lastIndex = 0;
            let sm;
            while ((sm = this.START_REGEX.exec(textBeforeHeader)) !== null) {
                const absIndex = sm.index;
                if (absIndex === 0 || textBeforeHeader[absIndex - 1] === '\n') {
                    blockStart = absIndex;
                }
            }
            // Fallback: если не нашли начало на границе строки, берём последнее совпадение
            if (blockStart === -1) {
                this.START_REGEX.lastIndex = 0;
                const lastMatch = this.START_REGEX.exec(textBeforeHeader);
                if (lastMatch) blockStart = lastMatch.index;
            }
            if (blockStart === -1) continue;

            // Ищем конец рецепта: сканируем вперёд от заголовка
            let blockEnd = -1;
            const textAfterHeader = text.slice(headerEnd);
            this.END_REGEX.lastIndex = 0;
            let em;
            while ((em = this.END_REGEX.exec(textAfterHeader)) !== null) {
                const absEnd = headerEnd + em.index + em[0].length;
                // Конец рецепта — конец строки
                const nextNewline = text.indexOf('\n', absEnd);
                blockEnd = nextNewline === -1 ? text.length : nextNewline;
                break; // берём первое совпадение после заголовка
            }

            if (blockEnd === -1) {
                blockEnd = text.length;
            }

            // Пропускаем если внутри тега [steg-recipe-...]
            if (blockStart > 0 && text[blockStart - 1] === '[') continue;

            // Пропускаем если совпадает с уже найденным тегом
            const overlapsTag = matches.some(
                tm => tm.isTag && blockStart >= tm.index && blockEnd <= tm.index + tm.length
            );
            if (overlapsTag) continue;

            // Пропускаем если перекрывается с другим найденным блоком
            const overlapsBlock = matches.some(
                tm => !tm.isTag && blockStart < tm.index + tm.length && blockEnd > tm.index
            );
            if (overlapsBlock) continue;

            matches.push({
                index: blockStart,
                length: blockEnd - blockStart,
                typeKey: 'universal',
                full: text.slice(blockStart, blockEnd),
                isTag: false,
            });
        }

        matches.sort((a, b) => a.index - b.index);
        return matches;
    }

    // ─── Конвертация indices ↔ bytes ──────────────────────────
    _indicesToBytes(indices) {
        const bigInt = this._encoder.decode(indices);
        return this._encoder.bigIntToBytes(bigInt);
    }

    _bytesToIndices(bytes) {
        if (!bytes || bytes.length === 0) {
            return new Array(this._bases.length).fill(0);
        }
        const bigInt = this._encoder.bytesToBigInt(new Uint8Array(bytes));
        return this._encoder.encode(bigInt);
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
                type: 'recipe',
                recipeType: match.typeKey,
                word: match.isTag ? match.full : `[рецепт: ${match.typeKey}]`,
            });
            bases.push(...this._bases);
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
        const basesPerTag = this._bases.length;

        for (const match of matches) {
            if (!match.isTag) continue; // Только теги кодируем
            if (idx + basesPerTag > indices.length) break;

            const tagIndices = indices.slice(idx, idx + basesPerTag);

            // Конвертируем indices → bytes
            const bytes = this._indicesToBytes(tagIndices);

            // Выбираем движок по типу рецепта
            const engine = this._engines[match.typeKey] || this._defaultEngine;

            // Генерируем текст рецепта из bytes
            let recipeText;
            try {
                recipeText = engine.generateProceduralText(
                    new Uint8Array(bytes.length > 0 ? bytes : [0])
                );
            } catch (e) {
                console.warn('[recipes] generateProceduralText error:', e);
                // Fallback: минимальный рецепт с 0 байтами данных
                recipeText = engine.generateProceduralText(new Uint8Array([0]));
            }

            // Ensure recipe block is properly separated (preceded by \n\n)
            let prefix = '';
            if (match.index > 0 && text[match.index - 1] !== '\n') {
                prefix = '\n';
            }
            // Ensure recipe block ends with \n for clean separation
            let suffix = '';
            if (recipeText[recipeText.length - 1] !== '\n') {
                suffix = '\n';
            }
            replacements.push({
                index: match.index,
                length: match.length,
                replacement: prefix + recipeText + suffix,
            });
            idx += basesPerTag;
        }

        // Применяем замены в обратном порядке для сохранения индексов
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
        const allIndices = [];

        for (const match of matches) {
            if (match.isTag) continue; // Теги при decode не обрабатываем

            // Извлекаем текст рецепта
            const recipeText = stegoText.slice(match.index, match.index + match.length).trim();

            // Пробуем извлечь bytes из текста рецепта
            // extractData автоматически пробует все контексты
            let bytes = null;
            const engine = this._defaultEngine;
            try {
                bytes = engine.extractData(recipeText);
            } catch (e) {
                console.warn('[recipes] extractData error:', e);
            }

            if (bytes && bytes.length > 0) {
                const tagIndices = this._bytesToIndices(bytes);
                allIndices.push(...tagIndices);
            } else {
                allIndices.push(...new Array(this._bases.length).fill(0));
            }
        }

        return allIndices;
    }

    getSpans(text) {
        const spans = [];

        // 1. Спаны для тегов
        this.TAG_REGEX.lastIndex = 0;
        let m;
        while ((m = this.TAG_REGEX.exec(text)) !== null) {
            spans.push({ start: m.index, end: m.index + m[0].length });
        }

        // 2. Спаны для сгенерированных блоков (по ключевым словам)
        this.HEADER_REGEX.lastIndex = 0;
        while ((m = this.HEADER_REGEX.exec(text)) !== null) {
            const headerStart = m.index;
            const headerEnd = m.index + m[0].length;

            // Ищем начало рецепта назад
            let blockStart = -1;
            const textBeforeHeader = text.slice(0, headerStart);
            this.START_REGEX.lastIndex = 0;
            let sm;
            while ((sm = this.START_REGEX.exec(textBeforeHeader)) !== null) {
                const absIndex = sm.index;
                if (absIndex === 0 || textBeforeHeader[absIndex - 1] === '\n') {
                    blockStart = absIndex;
                }
            }
            // Fallback: если не нашли начало на границе строки, берём последнее совпадение
            if (blockStart === -1) {
                this.START_REGEX.lastIndex = 0;
                const lastMatch = this.START_REGEX.exec(textBeforeHeader);
                if (lastMatch) blockStart = lastMatch.index;
            }
            if (blockStart === -1) continue;

            // Ищем конец рецепта вперёд
            let blockEnd = -1;
            const textAfterHeader = text.slice(headerEnd);
            this.END_REGEX.lastIndex = 0;
            let em;
            while ((em = this.END_REGEX.exec(textAfterHeader)) !== null) {
                const absEnd = headerEnd + em.index + em[0].length;
                const nextNewline = text.indexOf('\n', absEnd);
                blockEnd = nextNewline === -1 ? text.length : nextNewline;
                break;
            }

            if (blockEnd === -1) blockEnd = text.length;

            // Пропускаем если внутри тега
            if (blockStart > 0 && text[blockStart - 1] === '[') continue;

            const overlapsTag = spans.some(
                s => blockStart >= s.start && blockEnd <= s.end
            );
            if (overlapsTag) continue;

            const overlapsBlock = spans.some(
                s => blockStart < s.end && blockEnd > s.start
            );
            if (overlapsBlock) continue;

            spans.push({ start: blockStart, end: blockEnd });
        }

        return spans;
    }

    getStats() {
        const ingCount = this._defaultEngine.getIngredients().length;
        const totalBits = this._bases.reduce((s, b) => s + Math.log2(b), 0);
        return {
            name: this.name,
            loaded: this.loaded,
            types: RECIPE_TYPES,
            basesPerTag: this._bases.length,
            ingredientCount: ingCount,
            actionsBase: ACTIONS_BASE,
            formatBase: FORMAT_BASE,
            bytesPerTag: BYTES_PER_TAG,
            bitsPerTag: totalBits.toFixed(1),
        };
    }
}

export default RecipesChannel;
