/**
 * Канал кодирования через смайлики/эмодзи
 * Выбирает один из нескольких семантически близких вариантов
 *
 * Каждая группа содержит 8 семантически схожих эмодзи → 3 бита на позицию.
 * Группы выбраны так, чтобы замена внутри группы выглядела естественно:
 * радость, грусть, смех, одобрение, сердечки, праздник, энергия,
 * раздумье, гнев, удивление, страх, любовь, природа, животные,
 * еда/напитки, транспорт, жесты, небо/погода, звёзды/спецэффекты.
 */

export class SmilesChannel {
    constructor() {
        this.name = 'smiles';
        // Группы взаимозаменяемых эмодзи (8 вариантов = 3 бита на позицию)
        this.groups = [
            // ── Радость / счастье ───────────────────────
            ['😊', '🙂', '😀', '😄', '😁', '😃', '😇', '🥰'],
            // ── Грусть / печаль ─────────────────────────
            ['😔', '😞', '🙁', '😢', '😭', '😩', '😿', '☹️'],
            // ── Смех ─────────────────────────────────────
            ['😂', '🤣', '😹', '😆', '😅', '😜', '😝', '🤪'],
            // ── Одобрение / лайк ─────────────────────────
            ['👍', '👌', '✅', '💯', '🤝', '👏', '🙌', '🫶'],
            // ── Сердечки (цвета) ─────────────────────────
            ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍'],
            // ── Праздник / фейерверк ─────────────────────
            ['🎉', '🎊', '🥳', '🎈', '🎀', '🎁', '🍾', '🎎'],
            // ── Энергия / сила ───────────────────────────
            ['🔥', '⚡', '💥', '☄️', '💪', '🏆', '🚀', '💎'],
            // ── Раздумье / вопрос ────────────────────────
            ['🤔', '🧐', '💭', '❓', '❔', '🤷', '🤷‍♀️', '🤷‍♂️'],
            // ── Гнев / раздражение ────────────────────────
            ['😡', '😠', '🤬', '😤', '💢', '👿', '💀', '☠️'],
            // ── Удивление / шок ──────────────────────────
            ['😮', '😲', '😳', '🫢', '😱', '😨', '😰', '😬'],
            // ── Приветствие / прощание ───────────────────
            ['👋', '🤚', '🖐️', '✋', '🫱', '🫲', '🫳', '🫴'],
            // ── Природа / погода ─────────────────────────
            ['🌈', '☀️', '🌤️', '⛅', '🌥️', '☁️', '🌧️', '❄️'],
            // ── Животные ─────────────────────────────────
            ['🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼'],
            // ── Еда ──────────────────────────────────────
            ['🍕', '🍔', '🍟', '🌮', '🍣', '🍦', '🍰', '🍩'],
            // ── Напитки ──────────────────────────────────
            ['☕', '🍵', '🧋', '🍺', '🍷', '🥤', '🧃', '🥛'],
            // ── Транспорт ────────────────────────────────
            ['🚗', '🚕', '🚙', '🏎️', '🚌', '🚎', '🚐', '🛻'],
            // ── Музыка / искусство ───────────────────────
            ['🎵', '🎶', '🎼', '🎤', '🎧', '🎸', '🎹', '🥁'],
            // ── Спорт / активность ───────────────────────
            ['⚽', '🏀', '🏈', '⚾', '🎾', '🏐', '🎱', '🏓'],
            // ── Спецэффекты ──────────────────────────────
            ['✨', '💫', '⭐', '🌟', '🌠', '🌀', '💤', '💨'],
            // ── Номера / символы ─────────────────────────
            ['🔴', '🟠', '🟡', '🟢', '🔵', '🟣', '⚫', '⚪'],
        ];

        this._buildPattern();
    }

    _buildPattern() {
        const allSmiles = this.groups.flat();
        this.allSmilesSet = new Set(allSmiles);
    }

    _findMatches(text) {
        const matches = [];
        const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter
            ? new Intl.Segmenter('ru', { granularity: 'grapheme' })
            : null;

        /** Skip graphemes that contain stego VS data:
         *  - IVS (E0100-E01EF) — definitive stego marker
         *  - FE00-FE0E (VS1-VS15) — stego data for byte values 0-15
         *  FE0F (VS16 / text-presentation) is NOT stego (common in normal emoji)
         */
        const isStegoEmoji = (seg) => {
            for (const ch of seg) {
                const cp = ch.codePointAt(0);
                if (cp >= 0xE0100 && cp <= 0xE01EF) return true;
                if (cp >= 0xFE00 && cp <= 0xFE0E) return true;
            }
            return false;
        };

        if (segmenter) {
            let offset = 0;
            for (const { segment } of segmenter.segment(text)) {
                if (isStegoEmoji(segment)) { offset += segment.length; continue; }
                if (this.allSmilesSet.has(segment)) {
                    for (let gi = 0; gi < this.groups.length; gi++) {
                        if (this.groups[gi].includes(segment)) {
                            matches.push({ index: offset, length: segment.length, groupIndex: gi, currentVariant: this.groups[gi].indexOf(segment) });
                            break;
                        }
                    }
                }
                offset += segment.length;
            }
        } else {
            for (let gi = 0; gi < this.groups.length; gi++) {
                for (let vi = 0; vi < this.groups[gi].length; vi++) {
                    const smile = this.groups[gi][vi];
                    let idx = text.indexOf(smile);
                    while (idx !== -1) {
                        matches.push({ index: idx, length: smile.length, groupIndex: gi, currentVariant: vi });
                        idx = text.indexOf(smile, idx + smile.length);
                    }
                }
            }
            matches.sort((a, b) => a.index - b.index);
        }

        // Remove overlaps (keep first occurrence)
        const filtered = []; let lastEnd = -1;
        for (const m of matches) {
            if (m.index >= lastEnd) { filtered.push(m); lastEnd = m.index + m.length; }
        }
        return filtered;
    }

    analyzeCapacity(text) {
        const matches = this._findMatches(text);
        const positions = matches.map(m => ({ index: m.index, length: m.length, groupIndex: m.groupIndex, variants: this.groups[m.groupIndex].length }));
        const totalBits = positions.reduce((s, p) => s + Math.log2(p.variants), 0);
        return { totalBits, positions, bases: positions.map(p => p.variants) };
    }

    encode(text, indices) {
        if (indices.length === 0) return text;
        const matches = this._findMatches(text);
        const toReplace = [];
        for (let i = 0; i < Math.min(matches.length, indices.length); i++) {
            const m = matches[i];
            const vi = indices[i] % this.groups[m.groupIndex].length;
            const replacement = this.groups[m.groupIndex][vi];
            if (replacement !== text.slice(m.index, m.index + m.length)) {
                toReplace.push({ index: m.index, length: m.length, replacement });
            }
        }
        // Replace from end to start to preserve indices
        toReplace.sort((a, b) => b.index - a.index);
        let result = text;
        for (const r of toReplace)
            result = result.slice(0, r.index) + r.replacement + result.slice(r.index + r.length);
        return result;
    }

    /** Decode: find which variant of each group is present → its index */
    decode(stegoText) {
        return this._findMatches(stegoText).map(m => m.currentVariant);
    }

    getStats() { return { name: this.name, loaded: true, groups: this.groups.length }; }
}

export default SmilesChannel;
