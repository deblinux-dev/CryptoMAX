// ==========================================
// LINGUISTIC ENGINE v5.0 — STEGANOGRAPHY CORE
// ==========================================

import {
    MEASURES, INGREDIENT_CATEGORIES, RECIPE_STARTS, RECIPE_ENDS,
    INGREDIENT_TEMPLATES, RECIPE_CONTEXTS, ACTIONS, RECIPE_INSTRUCTION_HEADERS,
    QTY_RANGES, INSTRUCTION_FORMATS, FORMAT_BASE, MIXED_SECTION_HEADERS,
    PROSE_CONJUNCTIONS, ACTION_CATEGORY, TIME_VALUES, FRY_TIME_VALUES, BAKE_TEMP_VALUES, ORDER_VERBS,
    VERB_1P_MAP, PROSE_FRAMES, CAT_BACKWARD_TRANSITIONS,
} from './dictionaries.js';
import { toAccusative, getShortName, getIngredientPronoun } from './morphology.js';

function getPlural(number, forms) {
    const n10 = number % 10, n100 = number % 100;
    if (n10 === 1 && n100 !== 11) return forms[0];
    if ([2, 3, 4].includes(n10) && ![12, 13, 14].includes(n100)) return forms[1];
    return forms[2];
}

function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
}

function getRandomFromSeed(seed, arr) {
    return arr[(seed + Math.floor(seed * 0.6180339887)) % arr.length];
}

const MINUTE_FORMS = ['минута', 'минуты', 'минут'];

// Build flat ingredient list (interleaved by category)
const INGREDIENTS_BY_CAT = {};
for (const [category, items] of Object.entries(INGREDIENT_CATEGORIES)) {
    if (!INGREDIENTS_BY_CAT[category]) INGREDIENTS_BY_CAT[category] = [];
    items.forEach(ing => INGREDIENTS_BY_CAT[category].push({ ...ing, category }));
}

const INGREDIENTS_FLAT = [];
const catKeys = Object.keys(INGREDIENTS_BY_CAT);
const maxIngLen = Math.max(...catKeys.map(k => INGREDIENTS_BY_CAT[k].length));
for (let i = 0; i < maxIngLen; i++) {
    for (const cat of catKeys) {
        if (i < INGREDIENTS_BY_CAT[cat].length) {
            INGREDIENTS_FLAT.push(INGREDIENTS_BY_CAT[cat][i]);
        }
    }
}

// Build ACTION_MAP
const FILLERS_DRY = [];         // Только после dryHeat:true (жарка, выпекание — корочка)
const FILLERS_WET = [];         // Только после wet heat (варка, тушение — без корочки)
const FILLERS_COOK_GENERAL = []; // После любого COOK-действия
const FILLERS_SEASON = [];
const FILLERS_NEUTRAL = [];
const FILLER_EXCLUDE_MAP = {}; // filler text → categories to exclude

const ACTIONS_NO_PARAM = [];
const ACTIONS_TIME = [];
const ACTIONS_FRY_TIME = [];
const ACTIONS_TIME_TEMP = [];
const ACTIONS_ORDER = [];

ACTIONS.forEach(a => {
    if (a.filler) {
        if (a.fillerCat === 'cookDry') FILLERS_DRY.push(a.text);
        else if (a.fillerCat === 'cookWet') FILLERS_WET.push(a.text);
        else if (a.fillerCat === 'cookGeneral') FILLERS_COOK_GENERAL.push(a.text);
        else if (a.fillerCat === 'cookHeat') {
            // Backward compat: 'cookHeat' now maps to both dry and wet
            FILLERS_DRY.push(a.text);
            FILLERS_WET.push(a.text);
        }
        else if (a.fillerCat === 'season') FILLERS_SEASON.push(a.text);
        else FILLERS_NEUTRAL.push(a.text);
        // Build filler exclude map
        if (a.fillerExcludeCats && a.fillerExcludeCats.length > 0) {
            FILLER_EXCLUDE_MAP[a.text] = a.fillerExcludeCats;
        }
        return;
    }
    const isHeat = a.heatAction || false;
    const isDry = a.dryHeat || false;
    const targets = a.ingredientTargets;
    const excludes = a.ingredientExclude;
    const shape = a.shapeTag;
    if (!a.hasParam) {
        ACTIONS_NO_PARAM.push({ text: a.text, cat: a.cat, heatAction: isHeat, dryHeat: isDry, ingredientTargets: targets, ingredientExclude: excludes, shapeTag: shape });
    } else if (a.paramType === 'time') {
        for (let i = 0; i < a.paramBase; i++) {
            const minutes = TIME_VALUES[i];
            const minForm = getPlural(minutes, MINUTE_FORMS);
            ACTIONS_TIME.push({ text: a.text.replace('{0}', `${minutes} ${minForm}`), cat: a.cat, heatAction: isHeat, dryHeat: isDry, ingredientTargets: targets, ingredientExclude: excludes, shapeTag: shape });
        }
    } else if (a.paramType === 'frytime') {
        for (let i = 0; i < a.paramBase; i++) {
            const minutes = FRY_TIME_VALUES[i];
            const minForm = getPlural(minutes, MINUTE_FORMS);
            ACTIONS_FRY_TIME.push({ text: a.text.replace('{0}', `${minutes} ${minForm}`), cat: a.cat, heatAction: isHeat, dryHeat: isDry, ingredientTargets: targets, ingredientExclude: excludes, shapeTag: shape });
        }
    } else if (a.paramType === 'timeTemp') {
        // Двойной индекс: i = timeIdx * BAKE_TEMP_VALUES.length + tempIdx
        for (let i = 0; i < a.paramBase; i++) {
            const timeIdx = Math.floor(i / BAKE_TEMP_VALUES.length);
            const tempIdx = i % BAKE_TEMP_VALUES.length;
            const minutes = TIME_VALUES[timeIdx];
            const minForm = getPlural(minutes, MINUTE_FORMS);
            const temp = BAKE_TEMP_VALUES[tempIdx];
            const text = a.text.replace('{0}', `${minutes} ${minForm}`).replace('{1}', String(temp));
            ACTIONS_TIME_TEMP.push({ text, cat: a.cat, heatAction: true, dryHeat: isDry, ingredientTargets: targets, ingredientExclude: excludes, shapeTag: shape });
        }
    } else if (a.paramType === 'order') {
        ORDER_VERBS.forEach(v => ACTIONS_ORDER.push({ text: a.text.replace('{0}', v), cat: a.cat, heatAction: isHeat, dryHeat: isDry, ingredientTargets: targets, ingredientExclude: excludes, shapeTag: shape }));
    }
    // NOTE: 'temp' standalone type removed — temperature is now part of timeTemp
});

// Interleave action types
const ACTION_MAP_RAW = [];
const maxActionLen = Math.max(
    ACTIONS_NO_PARAM.length, ACTIONS_TIME.length,
    ACTIONS_FRY_TIME.length, ACTIONS_TIME_TEMP.length, ACTIONS_ORDER.length
);
for (let i = 0; i < maxActionLen; i++) {
    if (i < ACTIONS_NO_PARAM.length) ACTION_MAP_RAW.push(ACTIONS_NO_PARAM[i]);
    if (i < ACTIONS_TIME.length) ACTION_MAP_RAW.push(ACTIONS_TIME[i]);
    if (i < ACTIONS_FRY_TIME.length) ACTION_MAP_RAW.push(ACTIONS_FRY_TIME[i]);
    if (i < ACTIONS_TIME_TEMP.length) ACTION_MAP_RAW.push(ACTIONS_TIME_TEMP[i]);
    if (i < ACTIONS_ORDER.length) ACTION_MAP_RAW.push(ACTIONS_ORDER[i]);
}

const ACTION_MAP = ACTION_MAP_RAW.map(a => a.text);
const ACTION_CATS = ACTION_MAP_RAW.map(a => a.cat);
const ACTION_HEAT_MAP = ACTION_MAP_RAW.map(a => a.heatAction);
const ACTION_DRY_HEAT_MAP = ACTION_MAP_RAW.map(a => a.dryHeat);
const ACTION_TARGETS = ACTION_MAP_RAW.map(a => a.ingredientTargets);
const ACTION_EXCLUDES = ACTION_MAP_RAW.map(a => a.ingredientExclude);
const ACTION_SHAPE_TAGS = ACTION_MAP_RAW.map(a => a.shapeTag);
const ACTION_MAP_SORTED = [...ACTION_MAP].sort((a, b) => b.length - a.length);

const ACTIONS_BASE = ACTION_MAP.length;
const INSTRUCTION_STEPS = 10;

// ==========================================
// MIXED-RADIX ENCODER
// ==========================================
class MixedRadixEncoder {
    constructor() {
        this.bases = [];
    }
    setBases(bases) { this.bases = bases; }
    get maxValue() { return this.bases.reduce((prod, base) => prod * BigInt(base), 1n); }

    bytesToBigInt(bytes) {
        return bytes.reduce((acc, byte) => (acc << 8n) | BigInt(byte), 0n);
    }

    bigIntToBytes(bigint, length = null) {
        const bytes = [];
        let num = bigint;
        while (num > 0n) { bytes.unshift(Number(num & 0xFFn)); num >>= 8n; }
        if (length && bytes.length < length) return new Array(length - bytes.length).fill(0).concat(bytes);
        return bytes;
    }

    encode(bigint) {
        const indices = [];
        let num = bigint;
        for (let i = this.bases.length - 1; i >= 0; i--) {
            const base = BigInt(this.bases[i]);
            indices.unshift(Number(num % base));
            num = num / base;
        }
        return indices;
    }

    decode(indices) {
        let result = 0n;
        for (let i = 0; i < indices.length; i++) {
            result = result * BigInt(this.bases[i]) + BigInt(indices[i]);
        }
        return result;
    }
}

// ==========================================
// MAIN CLASS
// ==========================================

export class RecipeSteganography {
    constructor(options = {}) {
        this.options = {
            contextType: 'universal',
            maxIngredientLines: 50,
            minIngredientLines: 4,
            ...options
        };
        this.encoder = new MixedRadixEncoder();
    }

    getIngredients() {
        const ctx = RECIPE_CONTEXTS[this.options.contextType] || RECIPE_CONTEXTS.universal;
        const allowed = new Set(ctx.categories);
        const ings = INGREDIENTS_FLAT.filter(ing => allowed.has(ing.category));
        return ings.length > 0 ? ings : INGREDIENTS_FLAT;
    }

    _calculateLinesCount(payloadBytes) {
        if (!payloadBytes || payloadBytes.length === 0) return this.options.minIngredientLines;

        const fullPayload = new Uint8Array([payloadBytes.length, ...payloadBytes]);
        const bigIntData = this.encoder.bytesToBigInt(fullPayload);
        const availableIngs = this.getIngredients();
        const minQtyBase = Math.min(...Object.values(QTY_RANGES).map(r => r.base));

        let lines = this.options.minIngredientLines;
        while (lines <= this.options.maxIngredientLines) {
            const capacity = this._estimateCapacity(lines, availableIngs.length, minQtyBase);
            if (capacity > bigIntData) break;
            lines++;
        }
        return clamp(lines, this.options.minIngredientLines, this.options.maxIngredientLines);
    }

    _estimateCapacity(numLines, ingBase, qtyBase) {
        const bases = [FORMAT_BASE];
        for (let i = 0; i < INSTRUCTION_STEPS; i++) bases.push(ACTIONS_BASE);
        for (let i = 0; i < numLines; i++) bases.push(qtyBase);
        for (let i = 0; i < numLines; i++) bases.push(ingBase);
        this.encoder.setBases(bases);
        return this.encoder.maxValue;
    }

    _encodeDynamic(bigIntData, numLines, availableIngs) {
        const ingBase = availableIngs.length;
        let num = bigIntData;

        const formatIdx = Number(num % BigInt(FORMAT_BASE));
        num = num / BigInt(FORMAT_BASE);

        const actionIndices = [];
        for (let i = 0; i < INSTRUCTION_STEPS; i++) {
            actionIndices.unshift(Number(num % BigInt(ACTIONS_BASE)));
            num = num / BigInt(ACTIONS_BASE);
        }

        const ingIndices = [];
        for (let i = 0; i < numLines; i++) {
            ingIndices.unshift(Number(num % BigInt(ingBase)));
            num = num / BigInt(ingBase);
        }

        const qtyBases = ingIndices.map(idx => QTY_RANGES[availableIngs[idx].measure].base);

        const qtyIndices = [];
        for (let i = numLines - 1; i >= 0; i--) {
            const base = BigInt(qtyBases[i]);
            qtyIndices.unshift(Number(num % base));
            num = num / base;
        }

        if (num > 0n) throw new Error('Overflow! Increase maxIngredientLines.');

        return [formatIdx, ...actionIndices, ...qtyIndices, ...ingIndices];
    }

    _decodeDynamic(indices, numLines, availableIngs) {
        const ingBase = availableIngs.length;

        const formatIdx = indices[0];
        const actionIndices = indices.slice(1, 1 + INSTRUCTION_STEPS);
        const qtyIndices = indices.slice(1 + INSTRUCTION_STEPS, 1 + INSTRUCTION_STEPS + numLines);
        const ingIndices = indices.slice(1 + INSTRUCTION_STEPS + numLines);

        const qtyBases = ingIndices.map(idx => QTY_RANGES[availableIngs[idx].measure].base);

        let result = 0n;

        for (let i = 0; i < numLines; i++) {
            result = result * BigInt(qtyBases[i]) + BigInt(qtyIndices[i]);
        }

        for (let i = 0; i < numLines; i++) {
            result = result * BigInt(ingBase) + BigInt(ingIndices[i]);
        }

        for (let i = 0; i < INSTRUCTION_STEPS; i++) {
            result = result * BigInt(ACTIONS_BASE) + BigInt(actionIndices[i]);
        }

        result = result * BigInt(FORMAT_BASE) + BigInt(formatIdx);

        return result;
    }

    // ==========================================
    // TEXT GENERATION
    // ==========================================
    generateProceduralText(payloadBytes) {
        if (!payloadBytes || payloadBytes.length === 0) payloadBytes = new Uint8Array(0);

        const fullPayload = new Uint8Array([payloadBytes.length, ...payloadBytes]);
        const linesCount = this._calculateLinesCount(payloadBytes);
        const availableIngs = this.getIngredients();
        const bigIntData = this.encoder.bytesToBigInt(fullPayload);

        const rawIndices = this._encodeDynamic(bigIntData, linesCount, availableIngs);

        const seed = payloadBytes.length > 0 ? payloadBytes[0] : 42;

        let idxPtr = 0;
        const formatIdx = rawIndices[idxPtr++];
        const actionIndices = [];
        for (let i = 0; i < INSTRUCTION_STEPS; i++) actionIndices.push(rawIndices[idxPtr++]);
        const qtyIndices = [];
        for (let i = 0; i < linesCount; i++) qtyIndices.push(rawIndices[idxPtr++]);
        const ingIndices = [];
        for (let i = 0; i < linesCount; i++) ingIndices.push(rawIndices[idxPtr++]);

        // Header
        let text = getRandomFromSeed(seed, RECIPE_STARTS) + '\n';

        // Ingredient template
        const templateIdx = (seed + 2) % INGREDIENT_TEMPLATES.length;
        const markerTemplate = INGREDIENT_TEMPLATES[templateIdx];

        for (let lineNum = 0; lineNum < linesCount; lineNum++) {
            const ingIndex = ingIndices[lineNum];
            const ingredient = availableIngs[ingIndex % availableIngs.length];
            const qtyIndex = qtyIndices[lineNum];
            const qtyRange = QTY_RANGES[ingredient.measure];
            const safeQtyIndex = qtyIndex % qtyRange.base;
            const realQuantity = qtyRange.display[safeQtyIndex];
            const measureWord = getPlural(realQuantity, MEASURES[ingredient.measure]);

            const line = markerTemplate(ingredient.name, realQuantity, measureWord);
            text += line + '\n';
        }

        // Instruction header
        const header = getRandomFromSeed(seed >> 1, RECIPE_INSTRUCTION_HEADERS);
        text += '\n' + header + '\n';

        // Actions
        const actions = actionIndices.map((ai) => {
            const safeAi = ai % ACTIONS_BASE;
            return {
                text: ACTION_MAP[safeAi],
                cat: ACTION_CATS[safeAi],
                index: safeAi,
                heatAction: ACTION_HEAT_MAP[safeAi],
                dryHeat: ACTION_DRY_HEAT_MAP[safeAi],
                ingredientTargets: ACTION_TARGETS[safeAi],
                ingredientExclude: ACTION_EXCLUDES[safeAi],
                shapeTag: ACTION_SHAPE_TAGS[safeAi],
            };
        });

        // Build recipe ingredient list with categories for compatibility matching
        const recipeIngredients = ingIndices.map((ingIdx, i) => {
            const safeIdx = ingIdx % availableIngs.length;
            const ing = availableIngs[safeIdx];
            // In instruction text, use short informal names ("лук" instead of "лук красный")
            const shortName = getShortName(ing.name);
            return {
                name: ing.name,
                category: ing.category,
                accusative: toAccusative(shortName),
                usageCount: 0,
                shapes: ing.shapes,
            };
        });

        // Track previous ingredient reference for anti-repeat and pronoun logic
        let prevIngredientRef;       // actual accusative name of previously selected ingredient
        let prevWasDryHeat;
        let prevDisplayRef;          // what was displayed (could be pronoun)

        const enrichedActions = actions.map((action, step) => {
            let text = action.text;

            // Check if previous action had the same base action text (not just same verb)
            // "томить на медленном огне 60 минут" and "томить на медленном огне 20 минут"
            // share the same base: "томить на медленном огне"
            const prevBase = step > 0 ? this._extractBaseAction(actions[step - 1].text) : '';
            const currBase = this._extractBaseAction(action.text);
            const sameBaseAsPrev = prevBase.length > 0 && currBase === prevBase;

            // Try to add an ingredient reference if the action supports it
            const ingredientRef = this._selectIngredientRef(
                action.ingredientTargets,
                action.ingredientExclude,
                action.shapeTag,
                recipeIngredients,
                action.index,
                step,
                seed,
                sameBaseAsPrev || step === 0, // boost probability when same base action as previous, or first step
                prevIngredientRef,
                prevWasDryHeat,
                action.dryHeat
            );

            // Determine ingredient category for filler filtering
            let ingredientCat;
            if (ingredientRef) {
                // ingredientRef could be the accusative name or a pronoun
                const matchedIng = recipeIngredients.find(ri => ri.accusative === ingredientRef);
                if (matchedIng) {
                    // Direct ingredient reference — update tracking
                    ingredientCat = matchedIng.category;
                    prevIngredientRef = ingredientRef;
                    prevDisplayRef = ingredientRef;
                    prevWasDryHeat = action.dryHeat;
                } else {
                    // Pronoun reference — keep the actual ingredient name tracked
                    prevDisplayRef = ingredientRef;
                    prevWasDryHeat = action.dryHeat;
                }
                text += ' ' + ingredientRef;
            }

            const filler = this._getContextualFiller(action.cat, seed, step, action.heatAction, action.dryHeat, sameBaseAsPrev, ingredientCat);
            if (filler) text += ', ' + filler;
            return { ...action, enrichedText: text };
        });

        const safeFormatIdx = formatIdx % FORMAT_BASE;
        text += this._formatInstructions(enrichedActions, safeFormatIdx, seed);

        // End
        text += '\n' + getRandomFromSeed(seed >> 4, RECIPE_ENDS);
        return text;
    }

    /**
     * Select an ingredient reference for an action step.
     * Returns the accusative form of the ingredient name, or null if no reference should be added.
     *
     * Rules:
     * - Only actions with ingredientTargets can reference ingredients
     * - The ingredient's category must be in the action's target list
     * - Each ingredient can be referenced at most MAX_ING_REFS_PER_ING times
     * - Selection is deterministic (based on action index, step, and seed)
     */
    _selectIngredientRef(
        ingredientTargets,
        ingredientExclude,
        actionShapeTag,
        recipeIngredients,
        actionIndex,
        step,
        seed,
        forceAdd = false,
        prevIngredientRef,
        prevWasDryHeat,
        currentIsDryHeat
    ) {
        const MAX_ING_REFS_PER_ING = 2;

        // No targets = this action doesn't reference ingredients
        if (!ingredientTargets || ingredientTargets.length === 0) return null;

        // Don't add ingredient refs to every step — only ~60% of eligible steps
        // But if forceAdd is true (same base action as previous), always try to add one
        if (!forceAdd) {
            const refSeed = (seed + step * 7 + actionIndex * 3) % 10;
            if (refSeed >= 6) return null;
        }

        // Filter compatible ingredients
        const compatible = recipeIngredients.filter(ing => {
            if (!ing.category || !ingredientTargets.includes(ing.category)) return false;
            if (ing.usageCount >= MAX_ING_REFS_PER_ING) return false;
            // Check exclusions: ingredient name starts with any exclude prefix
            if (ingredientExclude && ingredientExclude.some(prefix => ing.name.startsWith(prefix))) return false;
            // Check shape compatibility: if action has shapeTag and ingredient has shapes, they must match
            if (actionShapeTag && ing.shapes && !ing.shapes.includes(actionShapeTag)) return false;

            // Improvement 2: Anti-consecutive same-ingredient with similar method
            // If the same ingredient was just referenced with a similar cooking method (both dryHeat or both wetHeat),
            // skip adding this ingredient reference
            if (prevIngredientRef && ing.accusative === prevIngredientRef &&
                prevWasDryHeat !== undefined && currentIsDryHeat !== undefined &&
                prevWasDryHeat === currentIsDryHeat) {
                return false;
            }

            return true;
        });

        if (compatible.length === 0) return null;

        // Deterministic selection: rotate through compatible ingredients
        const idx = (actionIndex + step + seed) % compatible.length;
        const selected = compatible[idx];

        // Mark this ingredient as used
        selected.usageCount++;

        // Improvement 5: Use pronoun if same ingredient as previous step
        if (prevIngredientRef && selected.accusative === prevIngredientRef) {
            return getIngredientPronoun(selected.name);
        }

        return selected.accusative;
    }

    _getContextualFiller(actionCat, seed, step, isHeatAction, isDryHeat, boostProbability = false, ingredientCategory) {
        const fillerSeed = (seed + step * 13) % 20;
        // Normal: 25% chance (fillerSeed 0-4). Boosted: 50% chance (fillerSeed 0-9)
        const threshold = boostProbability ? 10 : 5;
        if (fillerSeed >= threshold) return null;

        // Helper: filter out fillers that exclude the current ingredient category
        const filterByIngredientCat = (fillers) => {
            if (!ingredientCategory) return fillers;
            return fillers.filter(f => {
                const excludedCats = FILLER_EXCLUDE_MAP[f];
                return !excludedCats || !excludedCats.includes(ingredientCategory);
            });
        };

        if (actionCat === ACTION_CATEGORY.COOK) {
            if (isHeatAction && isDryHeat) {
                // Сухой нагрев (жарка, выпекание, запекание): можно корочку + общие филлеры
                const allFillers = filterByIngredientCat([...FILLERS_DRY, ...FILLERS_COOK_GENERAL]);
                if (allFillers.length === 0) return null;
                return allFillers[fillerSeed % allFillers.length];
            } else if (isHeatAction && !isDryHeat) {
                // Влажный нагрев (варка, тушение, томление): корочки НЕ бывает, только влажные + общие филлеры
                const allFillers = filterByIngredientCat([...FILLERS_WET, ...FILLERS_COOK_GENERAL]);
                if (allFillers.length === 0) return null;
                return allFillers[fillerSeed % allFillers.length];
            } else {
                // Нетепловое COOK-действие: только общие филлеры
                const allFillers = filterByIngredientCat([...FILLERS_COOK_GENERAL]);
                if (allFillers.length === 0) return null;
                return allFillers[fillerSeed % allFillers.length];
            }
        } else if (actionCat === ACTION_CATEGORY.SEASON) {
            const allFillers = filterByIngredientCat([...FILLERS_SEASON]);
            if (allFillers.length === 0) return null;
            return allFillers[fillerSeed % allFillers.length];
        } else {
            const allFillers = filterByIngredientCat([...FILLERS_NEUTRAL]);
            if (allFillers.length === 0) return null;
            return allFillers[fillerSeed % allFillers.length];
        }
    }

    _formatInstructions(actions, formatIdx, seed) {
        switch (formatIdx) {
            case INSTRUCTION_FORMATS.NUMBERED: return this._formatNumbered(actions, seed);
            case INSTRUCTION_FORMATS.PROSE: return this._formatProse(actions, seed);
            case INSTRUCTION_FORMATS.MIXED: return this._formatMixed(actions, seed);
            case INSTRUCTION_FORMATS.BULLET: return this._formatBullet(actions, seed);
            default: return this._formatNumbered(actions, seed);
        }
    }

    /**
     * Convert the first verb in an action text to 1st person plural present tense.
     */
    _toFirstPersonPlural(actionText) {
        const words = actionText.split(' ');
        for (let i = 0; i < words.length; i++) {
            // Try matching multi-word verb phrases first (e.g. "слегка остудить")
            if (i + 1 < words.length) {
                const twoWord = words[i] + ' ' + words[i + 1];
                if (VERB_1P_MAP[twoWord]) {
                    words[i] = VERB_1P_MAP[twoWord];
                    words.splice(i + 1, 1);
                    return words.join(' ');
                }
            }
            if (VERB_1P_MAP[words[i]]) {
                words[i] = VERB_1P_MAP[words[i]];
                return words.join(' ');
            }
        }
        return actionText; // fallback: no conjugation found
    }

    /**
     * Apply a frame template to an action text for variety.
     * Frame templates only use {0} = original infinitive text (preserves verb for decoding).
     */
    _applyFrame(actionText, frameIdx) {
        const frame = PROSE_FRAMES[frameIdx % PROSE_FRAMES.length];
        return frame.replace('{0}', actionText);
    }

    _formatNumbered(actions, seed) {
        const style = seed % 3;
        let text = '';
        actions.forEach((action, i) => {
            // Don't apply frame templates in numbered format — it already has its own structure
            const displayText = action.enrichedText;
            const capText = this._cap(displayText);
            if (style === 0) text += `${i + 1}. ${capText}.\n`;
            else if (style === 1) text += `${i + 1}) ${capText}.\n`;
            else text += `Шаг ${i + 1}: ${capText}.\n`;
        });
        return text;
    }

    /**
     * Extract the main verb (first word) from an action text.
     * Used for anti-consecutive-repeat detection.
     */
    _extractVerb(actionText) {
        // Skip leading transition words (Затем, После этого, etc.)
        const text = actionText.replace(/^(затем|после этого|далее|потом)\s+/i, '');
        return text.split(' ')[0].toLowerCase();
    }

    /**
     * Extract the base action text (without time/temp parameters) for anti-phrase-repeat detection.
     * Removes numbers and following time/temperature words to normalize:
     * "томить на медленном огне 60 минут" → "томить на медленном огне"
     * "выпекать 30 минут при 200°C" → "выпекать при"
     * "жарить по 5 минут с каждой стороны" → "жарить с каждой стороны"
     */
    _extractBaseAction(actionText) {
        return actionText
            .replace(/по\s*\d+\s*(минут[аы]?|минут|секунд[аы]?|секунд)/gi, '')
            .replace(/\d+\s*(минут[аы]?|минут|секунд[аы]?|секунд)/gi, '')
            .replace(/\d+\s*°C/gi, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    _formatProse(actions, seed) {
        const sentences = [];
        let current = '';
        let lastBase = '';
        let prevCat;

        // Category order for backward transition detection
        const CAT_ORDER = { prep: 0, cook: 1, finish: 2, season: 3 };

        // Transition words for same-base consecutive actions
        const TRANSITIONS = ['затем ', 'после этого ', 'далее ', 'потом '];

        // Transition words that appear at the start of ORDER actions
        const ACTION_TRANSITIONS = ['затем', 'после этого', 'далее', 'в конце', 'перед подачей', 'сначала'];

        actions.forEach((action, i) => {
            const base = this._extractBaseAction(action.text);
            const sameBase = lastBase.length > 0 && base === lastBase;

            // Improvement 4: Add backward transition when action category jumps backwards
            let backwardTransition = '';
            if (prevCat && action.cat && CAT_ORDER[action.cat] !== undefined && CAT_ORDER[prevCat] !== undefined) {
                if (CAT_ORDER[action.cat] < CAT_ORDER[prevCat]) {
                    const transIdx = (seed + i * 7) % CAT_BACKWARD_TRANSITIONS.length;
                    backwardTransition = CAT_BACKWARD_TRANSITIONS[transIdx];
                }
            }
            prevCat = action.cat;

            // Apply frame template for variety (only at sentence boundaries, not when backward transition is present)
            let displayText = action.enrichedText;
            const isNewSentence = current === '' || sameBase || (i + seed) % 3 === 0;
            if (isNewSentence && !backwardTransition) {
                const frameSeed = (seed + i * 17) % 10;
                if (frameSeed < 3) {
                    const frameIdx = (seed + i * 3) % 8 + 1;
                    displayText = this._applyFrame(action.enrichedText, frameIdx);
                }
            }

            if (current === '') {
                // First sentence — capitalize the beginning
                if (backwardTransition) {
                    current = this._cap(backwardTransition) + this._lower(displayText);
                } else {
                    current = this._cap(displayText);
                }
            } else if (sameBase) {
                // Same base action — force new sentence with transition
                sentences.push(current + '.');
                const transition = TRANSITIONS[(seed + i) % TRANSITIONS.length];
                // transition starts the sentence, displayText follows — lowercase it
                if (backwardTransition) {
                    current = this._cap(backwardTransition) + ' ' + this._lower(transition + displayText);
                } else {
                    current = this._cap(transition + this._lower(displayText));
                }
            } else if (isNewSentence) {
                // Start new sentence
                sentences.push(current + '.');
                if (backwardTransition) {
                    current = this._cap(backwardTransition) + ' ' + this._lower(displayText);
                } else {
                    current = this._cap(displayText);
                }
            } else {
                // Mid-sentence — DO NOT capitalize
                const conj = this._pickConjunction(displayText, seed + i, ACTION_TRANSITIONS);
                if (backwardTransition) {
                    current += conj + this._cap(backwardTransition) + ' ' + this._lower(displayText);
                } else {
                    current += conj + this._lower(displayText);
                }
            }

            lastBase = base;
        });
        if (current) sentences.push(current + '.');
        return sentences.join(' ') + '\n';
    }

    /**
     * Pick a PROSE conjunction that doesn't duplicate the action's leading transition word.
     * Prevents "после этого после этого взбить" or "затем затем перемешать".
     */
    _pickConjunction(actionText, seed, transitions) {
        const actionLower = actionText.toLowerCase();
        // Find which transition the action starts with (if any)
        const matchingTransition = transitions.find(t => actionLower.startsWith(t.toLowerCase()));

        if (!matchingTransition) {
            // No conflict — use any conjunction
            return PROSE_CONJUNCTIONS[seed % PROSE_CONJUNCTIONS.length];
        }

        // Filter out conjunctions that would create a duplicate
        const safeConjunctions = PROSE_CONJUNCTIONS.filter(conj => {
            const conjLower = conj.toLowerCase();
            // Check if the conjunction ends with the same transition word
            return !conjLower.endsWith(matchingTransition.toLowerCase() + ' ') &&
                   !conjLower.endsWith(matchingTransition.toLowerCase());
        });

        if (safeConjunctions.length === 0) {
            // All conjunctions conflict — use a simple comma
            return ', ';
        }

        return safeConjunctions[seed % safeConjunctions.length];
    }

    _formatMixed(actions, _seed) {
        const sections = [
            { header: MIXED_SECTION_HEADERS[0], start: 0, end: 3 },
            { header: MIXED_SECTION_HEADERS[1], start: 3, end: 7 },
            { header: MIXED_SECTION_HEADERS[2], start: 7, end: 10 },
        ];

        let text = '';
        for (const section of sections) {
            const sectionActions = actions.slice(section.start, section.end);
            if (sectionActions.length === 0) continue;
            const parts = sectionActions.map(a => a.enrichedText);
            text += section.header + ' ' + this._cap(parts.join(', ')) + '.\n';
        }
        return text;
    }

    _formatBullet(actions, _seed) {
        let text = '';
        actions.forEach(action => {
            text += `• ${this._cap(action.enrichedText)}.\n`;
        });
        return text;
    }

    _cap(str) {
        if (!str) return str;
        return str.charAt(0).toUpperCase() + str.slice(1);
    }

    _lower(str) {
        if (!str) return str;
        return str.charAt(0).toLowerCase() + str.slice(1);
    }

    // ==========================================
    // DATA EXTRACTION
    // ==========================================
    extractData(fullText) {
        const headerRegex = RECIPE_INSTRUCTION_HEADERS.map(h => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
        const parts = fullText.split(new RegExp(`(?:${headerRegex})`, 'i'));
        if (parts.length < 2) return null;

        const ingBlock = parts[0];
        let instrBlock = parts[1];

        const endRegex = RECIPE_ENDS.map(e => e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
        const endMatch = instrBlock.match(new RegExp(`(?:\\n|\\s)(?:${endRegex})`, 'i'));
        if (endMatch) {
            instrBlock = instrBlock.substring(0, endMatch.index);
        }

        const formatIdx = this._detectInstructionFormat(instrBlock);

        const ingLines = ingBlock.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        if (ingLines.length > 0) ingLines.shift();

        // Try decoding with each context, starting with the options context
        // This handles recipes encoded with non-universal contexts
        const contextOrder = [this.options.contextType];
        for (const ctxKey of Object.keys(RECIPE_CONTEXTS)) {
            if (!contextOrder.includes(ctxKey)) contextOrder.push(ctxKey);
        }

        for (const ctxKey of contextOrder) {
            const result = this._tryDecodeWithContext(ingLines, instrBlock, formatIdx, ctxKey);
            if (result !== null) return result;
        }

        return null;
    }

    /**
     * Try to decode recipe data using a specific context's ingredient list.
     * Returns decoded bytes if successful, null if the context doesn't match.
     */
    _tryDecodeWithContext(ingLines, instrBlock, formatIdx, ctxKey) {
        const ctx = RECIPE_CONTEXTS[ctxKey] || RECIPE_CONTEXTS.universal;
        const allowed = new Set(ctx.categories);
        const availableIngs = INGREDIENTS_FLAT.filter(ing => allowed.has(ing.category));
        const finalIngs = availableIngs.length > 0 ? availableIngs : INGREDIENTS_FLAT;

        const qtyIndices = [];
        const ingOnlyIndices = [];
        let numIngs = 0;

        for (const line of ingLines) {
            const cleanLine = line.replace(/^\s*(\d+[\.\)]\s*|[-*•~]\s*|шаг \d+:\s*)/i, '');
            const lower = cleanLine.toLowerCase();
            let localIngIndex = -1;
            let bestMatchLength = 0;

            for (let i = 0; i < finalIngs.length; i++) {
                const ingName = finalIngs[i].name.toLowerCase();
                if (lower.includes(ingName) && ingName.length > bestMatchLength) {
                    localIngIndex = i;
                    bestMatchLength = ingName.length;
                }
            }
            if (localIngIndex === -1) continue;

            const ingredient = finalIngs[localIngIndex];

            const escapedName = ingredient.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const tempLine = cleanLine.replace(new RegExp(escapedName, 'i'), '');
            const numMatch = tempLine.match(/(\d+)/);

            let qtyIndex = 0;
            if (numMatch) {
                const num = parseInt(numMatch[1]);
                const display = QTY_RANGES[ingredient.measure].display;
                const idx = display.indexOf(num);
                qtyIndex = idx >= 0 ? idx : 0;
            }

            qtyIndices.push(qtyIndex);
            ingOnlyIndices.push(localIngIndex);
            numIngs++;
            if (numIngs >= this.options.maxIngredientLines) break;
        }

        if (numIngs < this.options.minIngredientLines) return null;

        const actionIndicesList = this._extractActionIndices(instrBlock, formatIdx);
        while (actionIndicesList.length < INSTRUCTION_STEPS) actionIndicesList.push(0);
        if (actionIndicesList.length > INSTRUCTION_STEPS) actionIndicesList.length = INSTRUCTION_STEPS;

        const allIndices = [formatIdx, ...actionIndicesList, ...qtyIndices, ...ingOnlyIndices];

        try {
            const decodedBigInt = this._decodeDynamic(allIndices, numIngs, finalIngs);
            const rawBytes = this.encoder.bigIntToBytes(decodedBigInt);

            if (rawBytes.length === 0) return new Uint8Array(0);
            const len = rawBytes[0];
            if (len === 0) return new Uint8Array(0);
            // Validate: length byte must be reasonable (1-50) and we need enough data
            if (len > 50 || len > rawBytes.length - 1) return null;
            if (rawBytes.length > len) return new Uint8Array(rawBytes.slice(1, 1 + len));
            return new Uint8Array(rawBytes.slice(1));
        } catch {
            return null;
        }
    }

    _detectInstructionFormat(instrBlock) {
        const lines = instrBlock.split('\n').map(l => l.trim()).filter(l => l.length > 0);

        const mixedHeaders = MIXED_SECTION_HEADERS.map(h => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        if (mixedHeaders.some(h => new RegExp(h, 'i').test(instrBlock))) {
            return INSTRUCTION_FORMATS.MIXED;
        }

        if (lines.some(l => /^(\d+[\.\)]|шаг \d+)/i.test(l))) {
            return INSTRUCTION_FORMATS.NUMBERED;
        }

        if (lines.some(l => /^[•\-*]\s/.test(l))) {
            return INSTRUCTION_FORMATS.BULLET;
        }

        return INSTRUCTION_FORMATS.PROSE;
    }

    _extractActionIndices(instrBlock, _formatIdx) {
        const indices = [];
        let cleanText = instrBlock;

        MIXED_SECTION_HEADERS.forEach(h => {
            cleanText = cleanText.replace(new RegExp(h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '');
        });

        cleanText = cleanText.replace(/^\s*(\d+[\.\)]\s*|шаг \d+:\s*|[•\-*]\s*)/gim, '');

        // Strip frame template wrapping phrases so the decoder can find the original action verbs
        // These phrases are decorative and not part of the encoded action text
        const FRAME_PREFIXES = [
            'Теперь нужно ', 'Приступаем к следующему этапу — ',
            'Нам необходимо ', 'Остаётся только ', 'Следующий шаг — ',
            'Переходим к ', 'Теперь ', 'Далее нужно ',
        ];
        for (const prefix of FRAME_PREFIXES) {
            // Case-insensitive replacement, keep the rest
            cleanText = cleanText.replace(new RegExp(prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '');
        }

        // Strip backward transition phrases
        for (const trans of CAT_BACKWARD_TRANSITIONS) {
            cleanText = cleanText.replace(new RegExp(trans.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '');
        }

        const lower = cleanText.toLowerCase();
        const foundRanges = [];

        for (const actionText of ACTION_MAP_SORTED) {
            const actionLower = actionText.toLowerCase();
            let startPos = 0;
            while (startPos < lower.length) {
                const idx = lower.indexOf(actionLower, startPos);
                if (idx === -1) break;

                const overlaps = foundRanges.some(r => idx < r.end && idx + actionLower.length > r.start);
                if (!overlaps) {
                    indices.push(ACTION_MAP.indexOf(actionText));
                    foundRanges.push({ start: idx, end: idx + actionLower.length });
                }
                startPos = idx + 1;
            }
        }

        foundRanges.sort((a, b) => a.start - b.start);
        const sortedIndices = foundRanges.map(r => {
            const actionText = lower.substring(r.start, r.end);
            const found = ACTION_MAP.find(a => a.toLowerCase() === actionText);
            return ACTION_MAP.indexOf(found);
        });

        return sortedIndices.filter(i => i >= 0);
    }

    // ==========================================
    // UTILITY: Get format name
    // ==========================================
    getFormatName(formatIdx) {
        const names = ['NUMBERED', 'PROSE', 'MIXED', 'BULLET'];
        return names[formatIdx % names.length];
    }
}

// Singleton for API use
export const recipeEngine = new RecipeSteganography({ maxIngredientLines: 50, minIngredientLines: 4 });

// Named exports
export { RECIPE_STARTS, RECIPE_ENDS, INGREDIENTS_FLAT, ACTIONS_BASE, RECIPE_INSTRUCTION_HEADERS, FORMAT_BASE, RECIPE_CONTEXTS };

export default RecipeSteganography;
