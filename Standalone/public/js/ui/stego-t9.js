/**
 * Stego-T9: умные подсказки при наборе текста-носителя
 * Предлагает слова с высокой ёмкостью (много синонимов) для увеличения пропускной способности
 * Поддерживает автодополнение алиасов [steg-*]
 */

// Все доступные стего-алиасы для автодополнения
const STEG_ALIASES = [
    // ФИО
    { tag: '[steg-fio]', label: 'ФИО', channel: 'fio', bits: '~33' },
    // ПК-комплектующие
    { tag: '[steg-pc-proc]', label: 'Процессор (CPU)', channel: 'pc-parts', bits: '~16' },
    { tag: '[steg-pc-vdcard]', label: 'Видеокарта (GPU)', channel: 'pc-parts', bits: '~14' },
    { tag: '[steg-pc-ram]', label: 'Оперативная память', channel: 'pc-parts', bits: '~18' },
    { tag: '[steg-pc-drive]', label: 'Накопитель (SSD/HDD)', channel: 'pc-parts', bits: '~18' },
    { tag: '[steg-pc-mouse]', label: 'Мышь', channel: 'pc-parts', bits: '~14' },
    { tag: '[steg-pc-display]', label: 'Монитор', channel: 'pc-parts', bits: '~18' },
    { tag: '[steg-pc-motherboard]', label: 'Материнская плата', channel: 'pc-parts', bits: '~29' },
    { tag: '[steg-pc-keyboard]', label: 'Клавиатура', channel: 'pc-parts', bits: '~29' },
    // Автозапчасти
    { tag: '[steg-auto-engine]', label: 'Двигатель', channel: 'auto-parts', bits: '~18' },
    { tag: '[steg-auto-spark]', label: 'Свеча зажигания', channel: 'auto-parts', bits: '~18' },
    { tag: '[steg-auto-filter]', label: 'Фильтр', channel: 'auto-parts', bits: '~25' },
    { tag: '[steg-auto-paint]', label: 'Автокраска', channel: 'auto-parts', bits: '~20' },
    { tag: '[steg-auto-tire]', label: 'Шина', channel: 'auto-parts', bits: '~16' },
    { tag: '[steg-auto-battery]', label: 'Аккумулятор', channel: 'auto-parts', bits: '~15' },
    // Гаджеты
    { tag: '[steg-gadget-phone]', label: 'Смартфон', channel: 'gadgets', bits: '~17' },
    { tag: '[steg-gadget-tablet]', label: 'Планшет', channel: 'gadgets', bits: '~14' },
    { tag: '[steg-gadget-laptop]', label: 'Ноутбук', channel: 'gadgets', bits: '~17' },
    { tag: '[steg-gadget-headphones]', label: 'Наушники', channel: 'gadgets', bits: '~15' },
    { tag: '[steg-gadget-watch]', label: 'Умные часы', channel: 'gadgets', bits: '~14' },
    { tag: '[steg-gadget-camera]', label: 'Камера', channel: 'gadgets', bits: '~16' },
    // Рецепты
    { tag: '[steg-recipe-universal]', label: 'Универсальный рецепт', channel: 'recipes', bits: '~117' },
    { tag: '[steg-recipe-meat]', label: 'Мясное блюдо', channel: 'recipes', bits: '~117' },
    { tag: '[steg-recipe-fish]', label: 'Рыбное блюдо', channel: 'recipes', bits: '~117' },
    { tag: '[steg-recipe-vegetarian]', label: 'Вегетарианское', channel: 'recipes', bits: '~117' },
    { tag: '[steg-recipe-dessert]', label: 'Десерт', channel: 'recipes', bits: '~117' },
    { tag: '[steg-recipe-salad]', label: 'Салат', channel: 'recipes', bits: '~117' },
    { tag: '[steg-recipe-soup]', label: 'Суп', channel: 'recipes', bits: '~117' },
    { tag: '[steg-recipe-baking]', label: 'Выпечка', channel: 'recipes', bits: '~117' },
    { tag: '[steg-recipe-breakfast]', label: 'Завтрак', channel: 'recipes', bits: '~117' },
    { tag: '[steg-recipe-snack]', label: 'Перекус', channel: 'recipes', bits: '~117' },
    // Адреса РФ
    { tag: '[steg-address]', label: 'Адрес (РФ)', channel: 'addresses', bits: '~52' },
    // Музыка
    { tag: '[stego-music]', label: 'Музыкальный трек', channel: 'playlist', bits: '~26' },
    // Код
    { tag: '[steg-code-python]', label: 'Код (Python)', channel: 'code-stego', bits: '~256' },
    { tag: '[steg-code-typescript]', label: 'Код (TypeScript)', channel: 'code-stego', bits: '~256' },
    { tag: '[steg-code-go]', label: 'Код (Go)', channel: 'code-stego', bits: '~256' },
    { tag: '[steg-code-rust]', label: 'Код (Rust)', channel: 'code-stego', bits: '~256' },
    { tag: '[steg-code-css]', label: 'Код (CSS)', channel: 'code-stego', bits: '~256' },
    // JSON конфиги
    { tag: '[steg-json]', label: 'JSON конфиг (UUID)', channel: 'json-config', bits: '~128' },
    // Категоризированные слова
    { tag: '[steg-movie]', label: 'Фильм', channel: 'categorized-words', bits: '~15' },
    { tag: '[steg-videogame]', label: 'Видеоигра', channel: 'categorized-words', bits: '~10' },
    { tag: '[steg-dog]', label: 'Порода собак', channel: 'categorized-words', bits: '~9' },
    { tag: '[steg-cat]', label: 'Порода кошек', channel: 'categorized-words', bits: '~7' },
];

// Цвета каналов для подсветки в T9
const CHANNEL_COLORS = {
    'fio': '#a6e3a1',
    'pc-parts': '#f9e2af',
    'auto-parts': '#fab387',
    'gadgets': '#89b4fa',
    'recipes': '#f38ba8',
    'addresses': '#a6e3a1',
    'playlist': '#fab387',
    'code-stego': '#89b4fa',
    'json-config': '#f9e2af',
    'categorized-words': '#a6e3a1',
};

export class StegoT9 {
    constructor(textarea, engine) {
        this.textarea = textarea;
        this.engine   = engine;
        this.synonyms = {}; // будет заполнен из engine после loadChannels
        this.overlay  = null;
        this._composing = false; // IME composition state (mobile keyboards)
        this._loadSynonyms();
        this._initOverlay();
        this.textarea.addEventListener('input', (e) => this._onInput(e));
        this.textarea.addEventListener('keydown', (e) => this._onKeyDown(e));
        this.textarea.addEventListener('blur', () => this._hide());
        // Reposition on scroll/resize when overlay is visible
        // IMPORTANT: ignore scroll events that originate from within the overlay
        // itself — otherwise scrolling the suggestion list triggers repositioning,
        // which causes a rapid jump/feedback loop.
        this._onReposition = (e) => {
            if (e && e.target && this.overlay && e.target instanceof Node && this.overlay.contains(e.target)) return;
            if (this.overlay && this.overlay.style.display !== 'none') {
                this._positionOverlay();
            }
        };
        window.addEventListener('scroll', this._onReposition, true);
        window.addEventListener('resize', this._onReposition);
        // Track IME composition on mobile — suppress T9 during composition
        this.textarea.addEventListener('compositionstart', () => { this._composing = true; });
        this.textarea.addEventListener('compositionend',   () => { this._composing = false; });
    }

    _loadSynonyms() {
        // Берём словарь синонимов из канала движка, если он уже загружен
        try {
            const engine = this.engine;
            if (engine && engine.channels && engine.channels['synonyms']) {
                const synChannel = engine.channels['synonyms'];
                if (synChannel && synChannel.synonyms) {
                    this.synonyms = synChannel.synonyms;
                }
            }
        } catch (e) { /* ignore */ }
    }

    /**
     * Обновить ссылку на engine (вызывается после загрузки движка)
     */
    setEngine(engine) {
        this.engine = engine;
        this._loadSynonyms();
    }

    _initOverlay() {
        this.overlay = document.createElement('div');
        this.overlay.className = 't9-overlay';
        this.overlay.style.cssText = [
            'position:fixed', 'z-index:9999', 'background:#1e1e2e',
            'border:1px solid #6c5dd3', 'border-radius:8px', 'padding:4px 0',
            'box-shadow:0 4px 16px rgba(0,0,0,.5)', 'display:none',
            'max-height:240px', 'overflow-y:auto', 'overflow-x:hidden',
            'min-width:280px', 'touch-action:pan-y',
            'scrollbar-width:thin', 'scrollbar-color:#6c5dd3 #1e1e2e',
            '-webkit-overflow-scrolling:touch'
        ].join(';');
        // WebKit scrollbar styles in <head> (not inside overlay, so innerHTML
        // replacements don't destroy the styles)
        if (!document.getElementById('t9-overlay-scroll-style')) {
            const style = document.createElement('style');
            style.id = 't9-overlay-scroll-style';
            style.textContent = `
                .t9-overlay::-webkit-scrollbar { width: 6px; }
                .t9-overlay::-webkit-scrollbar-track { background: #1e1e2e; border-radius: 3px; }
                .t9-overlay::-webkit-scrollbar-thumb { background: #6c5dd3; border-radius: 3px; }
                .t9-overlay::-webkit-scrollbar-thumb:hover { background: #8b7de8; }
            `;
            document.head.appendChild(style);
        }
        document.body.appendChild(this.overlay);
    }

    _onInput(e) {
        // Skip during IME composition (mobile keyboards)
        if (e.isComposing || this._composing) return;

        const text   = this.textarea.value;
        const cursor = this.textarea.selectionStart;
        const before = text.slice(0, cursor);

        // 1. Проверяем, не начинаем ли мы вводить алиас [steg-...
        // Оптимизация: также срабатывает на «[s» для экономии ввода
        const aliasMatch = before.match(/\[(?:steg-([^\]]*)|s([^\]"a-zA-Z0-9]*))$/);
        if (aliasMatch) {
            const typed = aliasMatch[0].toLowerCase(); // "[steg-pc" or "[s"
            const suggestions = this._getAliasSuggestions(typed);
            if (suggestions.length > 0) {
                this._showAlias(suggestions, typed);
                return;
            }
        }

        // 2. Стандартные подсказки по синонимам
        const wordMatch = before.match(/[а-яёА-ЯЁa-zA-Z]+$/);
        if (!wordMatch || wordMatch[0].length < 2) { this._hide(); return; }

        const prefix   = wordMatch[0].toLowerCase();
        const suggestions = this._getSuggestions(prefix);
        if (suggestions.length > 0) {
            this._show(suggestions, prefix);
        } else {
            this._hide();
        }
    }

    _onKeyDown(e) {
        if (e.key === 'Escape') this._hide();
    }

    /**
     * Найти алиасы, начинающиеся с набранного префикса
     */
    _getAliasSuggestions(typed) {
        const results = [];
        for (const alias of STEG_ALIASES) {
            if (alias.tag.startsWith(typed)) {
                results.push({
                    word: alias.tag,
                    label: alias.label,
                    bits: alias.bits,
                    color: CHANNEL_COLORS[alias.channel] || '#cdd6f4'
                });
            }
        }
        // Сортируем: сначала более специфичные (длиннее)
        results.sort((a, b) => a.word.length - b.word.length);
        return results.slice(0, 8);
    }

    /**
     * Найти слова, начинающиеся с prefix, у которых много синонимов (высокая ёмкость)
     */
    _getSuggestions(prefix) {
        const results = [];
        for (const [word, syns] of Object.entries(this.synonyms)) {
            if (!word.startsWith(prefix)) continue;
            if (word.includes(' ')) continue; // только одиночные слова
            const bits = Math.log2(syns.length);
            if (bits >= 1) { // минимум 2 синонима → 1 бит
                results.push({ word, bits: bits.toFixed(1), count: syns.length });
            }
            if (results.length >= 8) break;
        }
        // Сортируем по убыванию ёмкости
        results.sort((a, b) => b.bits - a.bits);
        return results.slice(0, 6);
    }

    _show(suggestions, prefix) {
        this.overlay.innerHTML = suggestions.map(s => `
            <div class="t9-item" data-word="${s.word}" style="
                padding:6px 12px; cursor:pointer; display:flex;
                justify-content:space-between; gap:16px; font-size:14px;
                color:#cdd6f4; transition:background .15s">
                <span>${s.word}</span>
                <span style="color:#6c5dd3;font-size:12px">+${s.bits} бит</span>
            </div>
        `).join('');

        this.overlay.querySelectorAll('.t9-item').forEach(item => {
            item.addEventListener('mousedown', (e) => {
                e.preventDefault(); // prevent blur on textarea
                this._insert(item.dataset.word, prefix);
            });
            item.addEventListener('mouseenter', () => item.style.background = '#313244');
            item.addEventListener('mouseleave', () => item.style.background = '');
        });

        this.overlay.style.display = 'block';
        // Delay positioning by one frame to ensure layout is computed
        // after innerHTML replacement. Without this, offsetHeight may return
        // stale values on some browsers, causing incorrect max-height calculation.
        requestAnimationFrame(() => this._positionOverlay());
    }

    _showAlias(suggestions, typed) {
        // Заголовок секции
        const headerHtml = `<div style="
            padding:5px 12px; font-size:11px; color:#6c7086;
            border-bottom:1px solid #313244; text-transform:uppercase;
            letter-spacing:0.5px; margin-bottom:2px">
            Стего-алиасы
        </div>`;

        const itemsHtml = suggestions.map(s => `
            <div class="t9-item" data-word="${s.word}" style="
                padding:6px 12px; cursor:pointer; display:flex;
                justify-content:space-between; align-items:center; gap:12px;
                font-size:13px; color:#cdd6f4; transition:background .15s">
                <span style="font-family:monospace; color:${s.color}">${s.word}</span>
                <span style="color:#6c7086;font-size:12px">${s.label}</span>
                <span style="color:#6c5dd3;font-size:11px">${s.bits}</span>
            </div>
        `).join('');

        this.overlay.innerHTML = headerHtml + itemsHtml;

        this.overlay.querySelectorAll('.t9-item').forEach(item => {
            item.addEventListener('mousedown', (e) => {
                e.preventDefault();
                this._insert(item.dataset.word, typed);
            });
            item.addEventListener('mouseenter', () => item.style.background = '#313244');
            item.addEventListener('mouseleave', () => item.style.background = '');
        });

        this.overlay.style.display = 'block';
        // Delay positioning by one frame (same fix as _show)
        requestAnimationFrame(() => this._positionOverlay());
    }

    /**
     * Insert a T9 suggestion word, replacing the typed prefix.
     * Uses execCommand('insertText') for reliable mobile cursor handling.
     * Falls back to direct .value assignment if execCommand fails.
     */
    _insert(word, prefix) {
        this.textarea.focus();

        const cursor = this.textarea.selectionStart;
        // Select the prefix text so execCommand replaces it
        const selStart = cursor - prefix.length;
        if (selStart < 0) {
            this._hide();
            return;
        }

        // Try execCommand first — preserves native cursor & undo on mobile
        try {
            this.textarea.setSelectionRange(selStart, cursor);
            // execCommand returns false if command is not supported/enabled
            if (document.execCommand('insertText', false, word)) {
                this._hide();
                return;
            }
        } catch (e) {
            // execCommand not available — fall through to manual approach
        }

        // Fallback: direct .value assignment with cursor restoration
        const text   = this.textarea.value;
        const before = text.slice(0, selStart);
        const after  = text.slice(cursor);
        this.textarea.value = before + word + after;
        const newCursor = before.length + word.length;
        this.textarea.setSelectionRange(newCursor, newCursor);

        // Dispatch input event so other listeners (analysis, stats) update
        try {
            this.textarea.dispatchEvent(new Event('input', { bubbles: true }));
        } catch (e) { /* ignore */ }

        this._hide();
    }

    _hide() {
        if (this.overlay) this.overlay.style.display = 'none';
    }

    /**
     * Position overlay relative to viewport, flipping above textarea if no room below.
     * Uses position:fixed so no scroll offset needed.
     */
    _positionOverlay() {
        const rect = this.textarea.getBoundingClientRect();
        // Use visualViewport for mobile (accounts for virtual keyboard)
        const viewH = (window.visualViewport && window.visualViewport.height)
            ? window.visualViewport.height
            : window.innerHeight;
        const gap = 4;
        const overlayH = this.overlay.offsetHeight || 240;
        const spaceBelow = viewH - rect.bottom - gap;
        const spaceAbove = rect.top - gap;

        // Prefer placing above textarea — safer on mobile (keyboard often
        // reduces spaceBelow) and avoids issues with bottom-of-screen clipping.
        // Only place below if there's genuinely more room.
        const aboveCapacity = Math.min(240, spaceAbove);
        const belowCapacity = Math.min(240, spaceBelow);

        this.overlay.style.left = rect.left + 'px';

        if (aboveCapacity >= overlayH && aboveCapacity >= belowCapacity) {
            // Place above — preferred
            this.overlay.style.top = '';
            this.overlay.style.bottom = (viewH - rect.top + gap) + 'px';
            this.overlay.style.maxHeight = aboveCapacity + 'px';
        } else if (belowCapacity >= 100) {
            // Place below — enough room
            this.overlay.style.top = (rect.bottom + gap) + 'px';
            this.overlay.style.bottom = '';
            this.overlay.style.maxHeight = belowCapacity + 'px';
        } else {
            // Fallback: above, even if tight
            this.overlay.style.top = '';
            this.overlay.style.bottom = (viewH - rect.top + gap) + 'px';
            this.overlay.style.maxHeight = Math.max(80, aboveCapacity) + 'px';
        }

        // Ensure overlay doesn't overflow right edge
        const overlayW = this.overlay.offsetWidth || 280;
        if (rect.left + overlayW > window.innerWidth - 8) {
            this.overlay.style.left = Math.max(8, window.innerWidth - overlayW - 8) + 'px';
        }

        // Ensure overlay doesn't overflow left edge
        if (rect.left < 8) {
            this.overlay.style.left = '8px';
        }
    }
}

export default StegoT9;
