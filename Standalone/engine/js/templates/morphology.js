// ==========================================
// RUSSIAN MORPHOLOGY MODULE
// Converts ingredient names to accusative case (винительный падеж):
// нарезать (что?) капусту, морковь, огурец свежий
// ==========================================

const ACCUSATIVE_OVERRIDES = {
    'куриные бедра': 'куриные бедра',
    'куриные крылья': 'куриные крылья',
    'овсяные хлопья': 'овсяные хлопья',
    'опята': 'опята',
    'семена льна': 'семена льна',
    'семена чиа': 'семена чиа',
    'киноа': 'киноа',
    'маскарпоне': 'маскарпоне',
    'киви': 'киви',
    'манго': 'манго',
    'кешью': 'кешью',
    'кролик': 'кролика',
    'морковь': 'морковь',
    'щавель': 'щавель',
    'вермишель': 'вермишель',
    'говядина лопатка': 'говядину лопатку',
    'говядина вырезка': 'говядину вырезку',
    'свинина шея': 'свинину шею',
    'свинина корейка': 'свинину корейку',
    'бедра': 'бедра',
    'крылья': 'крылья',
    'хлопья': 'хлопья',
    'семена': 'семена',
    'сухари': 'сухари',
    'бобы': 'бобы',
};

function wordToAccusative(word, prevWord) {
    if (/^[\d.,%°]+$/.test(word)) return word;
    if (word.includes('-')) return word;
    if (word.length <= 2) return word;

    if (word.endsWith('ая')) return word.slice(0, -2) + 'ую';
    if (word.endsWith('яя')) return word.slice(0, -2) + 'юю';

    const isAfterPluralAdj = prevWord.length > 0 && /[ые]$/.test(prevWord);
    if (isAfterPluralAdj) return word;

    if (word.endsWith('а')) return word.slice(0, -1) + 'у';
    if (word.endsWith('я')) return word.slice(0, -1) + 'ю';

    return word;
}

export function toAccusative(name) {
    if (ACCUSATIVE_OVERRIDES[name]) return ACCUSATIVE_OVERRIDES[name];

    const words = name.split(' ');
    return words.map((word, i) => {
        const prevWord = i > 0 ? words[i - 1] : '';
        return wordToAccusative(word, prevWord);
    }).join(' ');
}

export function getIngredientPronoun(name) {
    const words = name.split(' ');
    const lastWord = words[words.length - 1].toLowerCase();

    if (lastWord.endsWith('ы') || lastWord.endsWith('и')) return 'их';
    if (['бедра', 'крылья', 'хлопья', 'сухари', 'бобы', 'семена', 'опята', 'сосиски'].includes(lastWord)) return 'их';

    if (lastWord.endsWith('а') || lastWord.endsWith('я')) return 'её';

    const FEMININE_SOFT_SIGN = [
        'форель', 'морковь', 'вермишель', 'печень', 'соль',
    ];
    if (lastWord.endsWith('ь') && FEMININE_SOFT_SIGN.includes(lastWord)) return 'её';

    if (['свёкла', 'капуста', 'ветчина', 'колбаса', 'грудка'].some(w => name.toLowerCase().includes(w))) return 'её';

    return 'его';
}

const SHORT_NAME_OVERRIDES = {
    'куриное филе': 'филе',
    'куриные бедра': 'бедра',
    'куриные крылья': 'крылья',
    'панировочные сухари': 'сухари',
    'овсяные хлопья': 'хлопья',
    'соевые бобы': 'бобы',
    'сгущённое молоко': 'сгущёнка',
    'томатная паста': 'томатная паста',
    'творожная масса': 'творожная масса',
    'паста мисо': 'паста мисо',
    'паста тахини': 'паста тахини',
    'грибы шампиньоны': 'шампиньоны',
    'грибы вешенки': 'вешенки',
    'грибы белые сушёные': 'грибы',
    'рыба белая филе': 'рыба',
    'лосось филе': 'лосось',
    'индейка филе': 'индейка',
    'креветки очищенные': 'креветки',
};

export function getShortName(name) {
    if (SHORT_NAME_OVERRIDES[name]) return SHORT_NAME_OVERRIDES[name];

    const words = name.split(' ');
    if (words.length === 1) return name;
    if (name.includes('-')) return name;

    const first = words[0];
    if (/(ый|ий|ой|ая|яя|ое|ее|ые|ие)$/.test(first)) {
        return words.slice(1).join(' ');
    }

    return first;
}
