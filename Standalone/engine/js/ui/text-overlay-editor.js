/**
 * TextOverlay Editor — Interactive visual editor for text overlay steganography
 *
 * Opens as a full-screen modal with:
 * - Canvas showing the image with live text preview
 * - Drag-to-position text (mouse + touch)
 * - Settings panel: font, size, color, opacity, distortion effects
 * - Responsive layout (desktop: side-by-side, mobile: stacked)
 * - Mobile-friendly: no auto-focus keyboard on slider interaction
 *
 * Usage:
 *   const editor = new TextOverlayEditor();
 *   editor.open(imageElement, text, currentOptions, callback);
 */

class TextOverlayEditor {
    constructor() {
        this._el = null;
        this._canvas = null;
        this._ctx = null;
        this._image = null;
        this._text = '';
        this._options = {};
        this._callback = null;
        this._isOpen = false;

        // Drag state
        this._dragging = false;
        this._dragStartX = 0;
        this._dragStartY = 0;
        this._dragStartPosX = 0;
        this._dragStartPosY = 0;

        // Preview render throttle
        this._renderRAF = null;

        // Bound handlers (for proper remove)
        this._boundCanvasMouseDown = null;
        this._boundCanvasTouchStart = null;
        this._boundDragMove = null;
        this._boundDragEnd = null;
        this._boundTouchMove = null;
        this._boundTouchEnd = null;
        this._boundEscHandler = null;
    }

    open(imageElement, text, currentOptions, callback) {
        this._image = imageElement;
        this._text = text || '';
        this._options = { ...(window.TextOverlay && window.TextOverlay.DEFAULT_OPTIONS ? window.TextOverlay.DEFAULT_OPTIONS : {}), ...currentOptions };
        this._callback = callback;
        this._isOpen = true;
        this._ensureDOM();
        this._populateFromOptions();
        this._setupCanvas();
        this._renderPreview();
        this._show();

        // Bind esc handler
        this._boundEscHandler = (e) => {
            if (e.key === 'Escape') this.close();
        };
        document.addEventListener('keydown', this._boundEscHandler);
    }

    close() {
        if (!this._isOpen) return;
        this._isOpen = false;

        if (this._renderRAF) cancelAnimationFrame(this._renderRAF);
        this._cleanupDragListeners();
        if (this._boundEscHandler) {
            document.removeEventListener('keydown', this._boundEscHandler);
            this._boundEscHandler = null;
        }

        this._hide();

        // Notify parent with current options
        if (this._callback) {
            this._callback(this._options);
        }
    }

    apply() {
        // Read text from textarea before closing
        const textEl = this._els && this._els.text;
        if (textEl) this._text = textEl.value;

        this._isOpen = false;
        if (this._renderRAF) cancelAnimationFrame(this._renderRAF);
        this._cleanupDragListeners();
        if (this._boundEscHandler) {
            document.removeEventListener('keydown', this._boundEscHandler);
            this._boundEscHandler = null;
        }

        this._hide();

        if (this._callback) {
            this._callback({ ...this._options, _editorText: this._text });
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  DOM CREATION
    // ═══════════════════════════════════════════════════════════

    _ensureDOM() {
        if (this._el) {
            // If already created, just make sure event listeners are bound
            return;
        }

        const overlay = document.createElement('div');
        overlay.className = 'cm-toe-overlay';
        overlay.id = 'textOverlayEditorOverlay';
        overlay.innerHTML = `
            <div class="cm-toe-backdrop" id="toeBackdrop"></div>
            <div class="cm-toe-modal" id="toeModal">
                <!-- Header -->
                <div class="cm-toe-header">
                    <span class="cm-toe-title">
                        <svg class="cm-icon cm-icon--sm"><use href="#icon-type"/></svg>
                        Редактор Text Overlay
                    </span>
                    <div class="cm-toe-header-actions">
                        <button class="cm-btn cm-btn--secondary cm-btn--compact" id="toeResetBtn" type="button">
                            <svg class="cm-icon cm-icon--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
                            Сброс
                        </button>
                        <button class="cm-btn cm-btn--secondary cm-btn--compact" id="toeRandomBtn" type="button" title="Случайные искажения (как каптча)">
                            <svg class="cm-icon cm-icon--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="4" width="22" height="16" rx="2" ry="2"/><line x1="1" y1="10" x2="23" y2="10"/><line x1="12" y1="10" x2="12" y2="20"/></svg>
                            Случайно
                        </button>
                        <button class="cm-btn cm-btn--primary cm-btn--compact" id="toeApplyBtn" type="button">
                            <svg class="cm-icon cm-icon--sm"><use href="#icon-check"/></svg>
                            Применить
                        </button>
                        <button class="cm-toe-close" id="toeCloseBtn" type="button" aria-label="Закрыть">
                            <svg class="cm-icon cm-icon--sm"><use href="#icon-x"/></svg>
                        </button>
                    </div>
                </div>

                <!-- Body -->
                <div class="cm-toe-body">
                    <!-- Canvas area -->
                    <div class="cm-toe-canvas-area" id="toeCanvasArea">
                        <div class="cm-toe-canvas-wrapper" id="toeCanvasWrapper">
                            <canvas id="toeCanvas" style="touch-action:none"></canvas>
                        </div>
                        <div class="cm-toe-drag-hint" id="toeDragHint">
                            <svg class="cm-icon cm-icon--sm"><use href="#icon-sliders"/></svg>
                            Перетащите текст для изменения позиции
                        </div>
                        <div class="cm-toe-canvas-info" id="toeCanvasInfo"></div>
                    </div>

                    <!-- Settings panel -->
                    <div class="cm-toe-settings" id="toeSettings">
                        <div class="cm-toe-settings-scroll">

                            <!-- Text section -->
                            <div class="cm-toe-section">
                                <div class="cm-toe-section-title" data-section="text">Текст</div>
                                <div class="cm-toe-section-body">
                                    <div class="cm-toe-field">
                                        <label class="cm-toe-label" for="toeText">Содержимое</label>
                                        <textarea class="cm-toe-textarea" id="toeText" rows="3" placeholder="Введите текст…" autocomplete="off" autocorrect="off" spellcheck="false"></textarea>
                                    </div>
                                </div>
                            </div>

                            <!-- Font section -->
                            <div class="cm-toe-section" id="toeFontSection">
                                <div class="cm-toe-section-title" data-section="font">Шрифт и размер</div>
                                <div class="cm-toe-section-body">
                                    <div class="cm-toe-row">
                                        <div class="cm-toe-field" style="flex:2">
                                            <label class="cm-toe-label" for="toeFont">Шрифт</label>
                                            <select class="cm-input cm-toe-select" id="toeFont">
                                                <option value="Arial, sans-serif" selected>Arial</option>
                                                <option value="Georgia, serif">Georgia</option>
                                                <option value="Courier New, monospace">Courier New</option>
                                                <option value="Times New Roman, serif">Times New Roman</option>
                                                <option value="Verdana, sans-serif">Verdana</option>
                                                <option value="Impact, sans-serif">Impact</option>
                                                <option value="Comic Sans MS, cursive">Comic Sans MS</option>
                                                <option value="Trebuchet MS, sans-serif">Trebuchet MS</option>
                                                <option value="Tahoma, sans-serif">Tahoma</option>
                                                <option value="Lucida Console, monospace">Lucida Console</option>
                                                <option value="Palatino Linotype, serif">Palatino</option>
                                            </select>
                                        </div>
                                        <div class="cm-toe-field" style="flex:1">
                                            <label class="cm-toe-label" for="toeSize">Размер</label>
                                            <input type="number" id="toeSize" value="24" min="6" max="300" class="cm-input cm-toe-input" inputmode="numeric">
                                        </div>
                                    </div>
                                    <div class="cm-toe-field">
                                        <label class="cm-toe-label">Межстрочный интервал: <span id="toeLineSpacingVal">1.4</span></label>
                                        <input type="range" id="toeLineSpacing" min="0.8" max="3" step="0.1" value="1.4" class="cm-toe-range" inputmode="none">
                                    </div>
                                </div>
                            </div>

                            <!-- Color section -->
                            <div class="cm-toe-section" id="toeColorSection">
                                <div class="cm-toe-section-title" data-section="color">Цвет и прозрачность</div>
                                <div class="cm-toe-section-body">
                                    <div class="cm-toe-field">
                                        <label class="cm-toe-label">Цвет текста</label>
                                        <div class="cm-toe-color-row">
                                            <input type="color" id="toeColor" value="#ffffff" class="cm-toe-color-picker">
                                            <input type="text" id="toeColorText" value="#ffffff" class="cm-input cm-toe-input cm-toe-color-hex" inputmode="none">
                                        </div>
                                    </div>
                                    <div class="cm-toe-field">
                                        <label class="cm-toe-label">Непрозрачность: <span id="toeOpacityVal">15</span>%</label>
                                        <input type="range" id="toeOpacity" min="5" max="100" value="15" class="cm-toe-range" inputmode="none">
                                        <div class="cm-toe-hint">Ниже — менее заметно, выше — легче прочитать</div>
                                    </div>
                                    <div class="cm-toe-field">
                                        <label class="cm-toe-checkbox-label">
                                            <input type="checkbox" id="toeRandomColor">
                                            Случайный цвет каждой буквы
                                        </label>
                                        <div class="cm-toe-hint">Разные оттенки от текущего цвета затрудняют распознавание OCR</div>
                                    </div>
                                </div>
                            </div>

                            <!-- Position section -->
                            <div class="cm-toe-section" id="toePositionSection">
                                <div class="cm-toe-section-title" data-section="position">Позиция</div>
                                <div class="cm-toe-section-body">
                                    <div class="cm-toe-field">
                                        <label class="cm-toe-label" for="toePosition">Расположение</label>
                                        <select class="cm-input cm-toe-select" id="toePosition">
                                            <option value="tile">Мозаика (тайл)</option>
                                            <option value="center">Центр</option>
                                            <option value="top">Сверху</option>
                                            <option value="bottom">Снизу</option>
                                            <option value="top-left">Вверху-слева</option>
                                            <option value="top-right">Вверху-справа</option>
                                            <option value="bottom-left">Внизу-слева</option>
                                            <option value="bottom-right">Внизу-справа</option>
                                            <option value="custom">Произвольная</option>
                                        </select>
                                    </div>
                                    <div class="cm-toe-field" id="toeRotationField">
                                        <label class="cm-toe-label" for="toeRotation">Поворот: <span id="toeRotationVal">0</span>°</label>
                                        <input type="range" id="toeRotation" min="-180" max="180" value="0" class="cm-toe-range" inputmode="none">
                                    </div>
                                    <div class="cm-toe-hint">Перетащите текст на холсте для произвольного позиционирования</div>
                                </div>
                            </div>

                            <!-- Distortion section -->
                            <div class="cm-toe-section">
                                <div class="cm-toe-section-title" data-section="distortion">
                                    Искажения (защита от OCR)
                                    <span class="cm-toe-section-badge" id="toeEffectCount">0 активных</span>
                                </div>
                                <div class="cm-toe-section-body">
                                    <div class="cm-toe-field">
                                        <label class="cm-toe-label">Волна: <span id="toeWaveVal">0</span>px</label>
                                        <input type="range" id="toeWaveAmplitude" min="0" max="8" step="0.5" value="0" class="cm-toe-range" inputmode="none">
                                        <div class="cm-toe-hint">Посимвольное волнообразное смещение (малые значения = мягкая волна)</div>
                                    </div>
                                    <div class="cm-toe-field">
                                        <label class="cm-toe-label">Частота волны: <span id="toeWaveFreqVal">1</span></label>
                                        <input type="range" id="toeWaveFrequency" min="0.1" max="5" step="0.1" value="1" class="cm-toe-range" inputmode="none">
                                        <div class="cm-toe-hint">Частота волнообразного смещения (выше = более частая волна)</div>
                                    </div>
                                    <div class="cm-toe-field">
                                        <label class="cm-toe-label">Поворот букв: <span id="toeLetterRotVal">0</span>°</label>
                                        <input type="range" id="toePerLetterRotation" min="0" max="45" value="0" class="cm-toe-range" inputmode="none">
                                        <div class="cm-toe-hint">Случайный поворот каждой буквы</div>
                                    </div>
                                    <div class="cm-toe-field">
                                        <label class="cm-toe-label">Размер букв: <span id="toeLetterSizeVal">0</span>px</label>
                                        <input type="range" id="toePerLetterSize" min="0" max="20" value="0" class="cm-toe-range" inputmode="none">
                                        <div class="cm-toe-hint">Случайное изменение размера каждой буквы</div>
                                    </div>
                                    <div class="cm-toe-field">
                                        <label class="cm-toe-label">Сдвиг букв: <span id="toeLetterOffsetVal">0</span>px</label>
                                        <input type="range" id="toePerLetterOffset" min="0" max="15" value="0" class="cm-toe-range" inputmode="none">
                                        <div class="cm-toe-hint">Случайное смещение каждой буквы</div>
                                    </div>
                                    <div class="cm-toe-field">
                                        <label class="cm-toe-label">Скос: <span id="toeSkewVal">0</span></label>
                                        <input type="range" id="toePerLetterSkew" min="0" max="0.5" step="0.01" value="0" class="cm-toe-range" inputmode="none">
                                        <div class="cm-toe-hint">Горизонтальный наклон букв</div>
                                    </div>
                                    <div class="cm-toe-field">
                                        <label class="cm-toe-label">Межбуквенный интервал: <span id="toeSpacingVal">0</span>px</label>
                                        <input type="range" id="toePerLetterSpacing" min="0" max="10" value="0" class="cm-toe-range" inputmode="none">
                                        <div class="cm-toe-hint">Случайное дополнительное расстояние между буквами</div>
                                    </div>
                                    <div class="cm-toe-field">
                                        <label class="cm-toe-checkbox-label">
                                            <input type="checkbox" id="toeBoldRandom">
                                            Случайный жирный шрифт
                                        </label>
                                    </div>
                                    <div class="cm-toe-field">
                                        <label class="cm-toe-label">Шум: <span id="toeNoiseVal">0</span></label>
                                        <input type="range" id="toeNoise" min="0" max="50" value="0" class="cm-toe-range" inputmode="none">
                                        <div class="cm-toe-hint">Шум накладывается поверх всего изображения. Влияет на видимость текста.</div>
                                    </div>
                                    <div class="cm-toe-field">
                                        <button class="cm-btn cm-btn--secondary cm-btn--compact cm-btn--full" id="toeResetDistortion" type="button">
                                            Сбросить все искажения
                                        </button>
                                    </div>
                                </div>
                            </div>

                        </div>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);
        this._el = overlay;
        this._cacheElements();
        this._bindEditorEvents();
        this._setupDragEvents();
        this._preventSliderKeyboardStealing();
    }

    _cacheElements() {
        const q = (sel) => this._el.querySelector(sel);
        this._els = {
            backdrop: q('#toeBackdrop'),
            modal: q('#toeModal'),
            canvas: q('#toeCanvas'),
            canvasArea: q('#toeCanvasArea'),
            canvasWrapper: q('#toeCanvasWrapper'),
            canvasInfo: q('#toeCanvasInfo'),
            dragHint: q('#toeDragHint'),
            settings: q('#toeSettings'),
            closeBtn: q('#toeCloseBtn'),
            applyBtn: q('#toeApplyBtn'),
            resetBtn: q('#toeResetBtn'),
            resetDistortionBtn: q('#toeResetDistortion'),
            randomBtn: q('#toeRandomBtn'),
            // Text
            text: q('#toeText'),
            // Distortion
            waveFrequency: q('#toeWaveFrequency'),
            waveFreqVal: q('#toeWaveFreqVal'),
            // Font
            font: q('#toeFont'),
            size: q('#toeSize'),
            lineSpacing: q('#toeLineSpacing'),
            lineSpacingVal: q('#toeLineSpacingVal'),
            // Color
            color: q('#toeColor'),
            colorText: q('#toeColorText'),
            opacity: q('#toeOpacity'),
            opacityVal: q('#toeOpacityVal'),
            randomColor: q('#toeRandomColor'),
            // Position
            position: q('#toePosition'),
            rotation: q('#toeRotation'),
            rotationVal: q('#toeRotationVal'),
            // Distortion
            waveAmplitude: q('#toeWaveAmplitude'),
            waveVal: q('#toeWaveVal'),
            perLetterRotation: q('#toePerLetterRotation'),
            letterRotVal: q('#toeLetterRotVal'),
            perLetterSize: q('#toePerLetterSize'),
            letterSizeVal: q('#toeLetterSizeVal'),
            perLetterOffset: q('#toePerLetterOffset'),
            letterOffsetVal: q('#toeLetterOffsetVal'),
            perLetterSkew: q('#toePerLetterSkew'),
            skewVal: q('#toeSkewVal'),
            perLetterSpacing: q('#toePerLetterSpacing'),
            spacingVal: q('#toeSpacingVal'),
            boldRandom: q('#toeBoldRandom'),
            noise: q('#toeNoise'),
            noiseVal: q('#toeNoiseVal'),
            effectCount: q('#toeEffectCount'),
        };
    }

    /**
     * Fix mobile keyboard stealing: when user touches a range slider,
     * blur any active text input so keyboard doesn't pop up.
     */
    _preventSliderKeyboardStealing() {
        if (!this._el) return;

        // All range inputs inside the editor
        const ranges = this._el.querySelectorAll('.cm-toe-range');
        for (const range of ranges) {
            // On touchstart on a range, blur the textarea
            range.addEventListener('touchstart', () => {
                const active = document.activeElement;
                if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')) {
                    active.blur();
                }
            }, { passive: true });

            // On mousedown (desktop), blur textarea
            range.addEventListener('mousedown', () => {
                const active = document.activeElement;
                if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')) {
                    active.blur();
                }
            }, { passive: true });
        }

        // Also prevent checkbox clicks from focusing textarea
        const checkboxes = this._el.querySelectorAll('.cm-toe-checkbox-label input[type="checkbox"]');
        for (const cb of checkboxes) {
            cb.addEventListener('change', () => {
                // No-op, just prevent propagation to textarea
            });
        }
    }

    _bindEditorEvents() {
        const e = this._els;

        e.backdrop?.addEventListener('click', () => this.close());
        e.closeBtn?.addEventListener('click', () => this.close());
        e.applyBtn?.addEventListener('click', () => this.apply());
        e.resetBtn?.addEventListener('click', () => this._resetAll());
        e.resetDistortionBtn?.addEventListener('click', () => this._resetDistortion());
        e.randomBtn?.addEventListener('click', () => this._randomize());

        // Text input — CRITICAL: must work reliably
        if (e.text) {
            e.text.addEventListener('input', () => {
                this._text = e.text.value;
                this._scheduleRender();
            });
            // Also handle keyup for IME input methods (Chinese, Japanese, Korean)
            e.text.addEventListener('keyup', () => {
                this._text = e.text.value;
            });
        }

        // Font & size
        e.font?.addEventListener('change', () => { this._options.fontFamily = e.font.value; this._scheduleRender(); });
        e.size?.addEventListener('input', () => { this._options.fontSize = parseInt(e.size.value) || 24; this._scheduleRender(); });
        e.lineSpacing?.addEventListener('input', () => {
            this._options.lineSpacing = parseFloat(e.lineSpacing.value) || 1.4;
            if (e.lineSpacingVal) e.lineSpacingVal.textContent = this._options.lineSpacing.toFixed(1);
            this._scheduleRender();
        });

        // Color
        e.color?.addEventListener('input', () => {
            this._options.color = e.color.value;
            if (e.colorText) e.colorText.value = e.color.value;
            this._scheduleRender();
        });
        e.colorText?.addEventListener('input', () => {
            this._options.color = e.colorText.value;
            if (e.color && /^#[0-9a-f]{6}$/i.test(e.colorText.value)) e.color.value = e.colorText.value;
            this._scheduleRender();
        });
        e.opacity?.addEventListener('input', () => {
            this._options.opacity = parseInt(e.opacity.value) || 15;
            if (e.opacityVal) e.opacityVal.textContent = this._options.opacity;
            this._scheduleRender();
        });
        e.randomColor?.addEventListener('change', () => {
            this._options.randomColorPerLetter = e.randomColor.checked;
            this._updateEffectCount();
            this._scheduleRender();
        });

        // Position
        e.position?.addEventListener('change', () => {
            const val = e.position.value;
            if (val !== 'custom') {
                this._options.position = val;
            } else {
                this._options.position = 'custom';
                if (!this._options.posX) this._options.posX = 10;
                if (!this._options.posY) this._options.posY = 10;
            }
            this._scheduleRender();
        });
        e.rotation?.addEventListener('input', () => {
            this._options.rotation = parseInt(e.rotation.value) || 0;
            if (e.rotationVal) e.rotationVal.textContent = this._options.rotation;
            this._scheduleRender();
        });

        // Distortion sliders
        const distortionBindings = [
            { el: e.waveAmplitude, display: e.waveVal, key: 'waveAmplitude', parse: parseFloat },
            { el: e.waveFrequency, display: e.waveFreqVal, key: 'waveFrequency', parse: parseFloat },
            { el: e.perLetterRotation, display: e.letterRotVal, key: 'perLetterRotation', parse: parseInt },
            { el: e.perLetterSize, display: e.letterSizeVal, key: 'perLetterSizeVariation', parse: parseInt },
            { el: e.perLetterOffset, display: e.letterOffsetVal, key: 'perLetterRandomOffset', parse: parseInt },
            { el: e.perLetterSkew, display: e.skewVal, key: 'perLetterSkewX', parse: parseFloat },
            { el: e.perLetterSpacing, display: e.spacingVal, key: 'perLetterSpacingVariation', parse: parseInt },
            { el: e.noise, display: e.noiseVal, key: 'noiseIntensity', parse: parseInt },
        ];

        for (const binding of distortionBindings) {
            binding.el?.addEventListener('input', () => {
                this._options[binding.key] = binding.parse(binding.el.value) || 0;
                if (binding.display) binding.display.textContent = this._options[binding.key];
                this._updateEffectCount();
                this._scheduleRender();
            });
        }

        e.boldRandom?.addEventListener('change', () => {
            this._options.perLetterBoldRandom = e.boldRandom.checked;
            this._updateEffectCount();
            this._scheduleRender();
        });

        // Prevent canvas drag from interfering with settings panel
        e.settings?.addEventListener('touchmove', (ev) => {
            ev.stopPropagation();
        }, { passive: true });
    }

    // ═══════════════════════════════════════════════════════════
    //  DRAG TO POSITION
    // ═══════════════════════════════════════════════════════════

    _setupDragEvents() {
        const canvas = this._els.canvas;
        if (!canvas) return;

        // Clean up existing listeners
        this._cleanupDragListeners();

        // Create bound handlers
        this._boundDragMove = (e) => this._onDragMove(e.clientX, e.clientY);
        this._boundDragEnd = () => this._onDragEnd();
        this._boundTouchMove = (e) => {
            if (!this._dragging) return;
            e.preventDefault();
            e.stopPropagation();
            const t = e.touches[0];
            this._onDragMove(t.clientX, t.clientY);
        };
        this._boundTouchEnd = () => this._onDragEnd();

        // Mouse — store reference for proper cleanup
        this._boundCanvasMouseDown = (e) => {
            e.preventDefault();
            this._onDragStart(e.clientX, e.clientY);
        };
        canvas.addEventListener('mousedown', this._boundCanvasMouseDown);
        document.addEventListener('mousemove', this._boundDragMove);
        document.addEventListener('mouseup', this._boundDragEnd);

        // Touch — store reference for proper cleanup
        this._boundCanvasTouchStart = (e) => {
            e.preventDefault();
            e.stopPropagation();
            const t = e.touches[0];
            this._onDragStart(t.clientX, t.clientY);
        };
        canvas.addEventListener('touchstart', this._boundCanvasTouchStart, { passive: false });
        document.addEventListener('touchmove', this._boundTouchMove, { passive: false });
        document.addEventListener('touchend', this._boundTouchEnd);
    }

    _cleanupDragListeners() {
        // Remove canvas-level listeners
        if (this._boundCanvasMouseDown && this._els && this._els.canvas) {
            this._els.canvas.removeEventListener('mousedown', this._boundCanvasMouseDown);
            this._boundCanvasMouseDown = null;
        }
        if (this._boundCanvasTouchStart && this._els && this._els.canvas) {
            this._els.canvas.removeEventListener('touchstart', this._boundCanvasTouchStart);
            this._boundCanvasTouchStart = null;
        }
        // Remove document-level listeners
        if (this._boundDragMove) {
            document.removeEventListener('mousemove', this._boundDragMove);
            this._boundDragMove = null;
        }
        if (this._boundDragEnd) {
            document.removeEventListener('mouseup', this._boundDragEnd);
            this._boundDragEnd = null;
        }
        if (this._boundTouchMove) {
            document.removeEventListener('touchmove', this._boundTouchMove);
            this._boundTouchMove = null;
        }
        if (this._boundTouchEnd) {
            document.removeEventListener('touchend', this._boundTouchEnd);
            this._boundTouchEnd = null;
        }
    }

    _onDragStart(clientX, clientY) {
        if (!this._isOpen) return;

        this._dragging = true;
        this._dragStartX = clientX;
        this._dragStartY = clientY;

        // Calculate initial text position from current rendering mode
        const canvas = this._canvas;
        const w = canvas.width;
        const h = canvas.height;
        const TO = window.TextOverlay;

        // If already in custom mode, use stored posX/posY
        if (this._options.position === 'custom') {
            this._dragStartPosX = this._options.posX ?? 10;
            this._dragStartPosY = this._options.posY ?? 10;
        } else {
            // Calculate where the text currently is based on position mode
            let textPixelX, textPixelY;
            const fontSize = this._options.fontSize || 24;
            const fontFamily = this._options.fontFamily || 'Arial, sans-serif';
            const lineSpacing = this._options.lineSpacing || 1.4;
            const padding = this._options.padding || 20;
            const ctx = canvas.getContext('2d');

            ctx.font = `${fontSize}px ${fontFamily}`;
            const lines = TO ? TO.wrapText(ctx, this._text, w - padding * 2, fontSize, fontFamily) : [this._text];
            const lineHeight = fontSize * lineSpacing;
            const totalHeight = lines.length * lineHeight;
            const maxLineWidth = Math.max(...lines.map(l => ctx.measureText(l).width), 0);

            const pos = this._options.position || 'tile';

            if (pos === 'center') {
                textPixelX = (w - maxLineWidth) / 2;
                textPixelY = (h - totalHeight) / 2;
            } else if (pos === 'top') {
                textPixelX = (w - maxLineWidth) / 2;
                textPixelY = padding;
            } else if (pos === 'bottom') {
                textPixelX = (w - maxLineWidth) / 2;
                textPixelY = h - totalHeight - padding;
            } else if (pos === 'top-right') {
                textPixelX = w - maxLineWidth - padding;
                textPixelY = padding;
            } else if (pos === 'bottom-right') {
                textPixelX = w - maxLineWidth - padding;
                textPixelY = h - totalHeight - padding;
            } else if (pos === 'top-left') {
                textPixelX = padding;
                textPixelY = padding;
            } else if (pos === 'bottom-left') {
                textPixelX = padding;
                textPixelY = h - totalHeight - padding;
            } else {
                // tile or unknown: default to top-left of text area
                textPixelX = padding;
                textPixelY = 0;
            }

            // Convert pixel position to percentage
            this._dragStartPosX = w > 0 ? (textPixelX / w) * 100 : 10;
            this._dragStartPosY = h > 0 ? (textPixelY / h) * 100 : 10;
        }

        // Auto-switch to custom position when dragging
        this._options.position = 'custom';
        // Store the calculated position so render uses it
        this._options.posX = this._dragStartPosX;
        this._options.posY = this._dragStartPosY;

        const posEl = this._els.position;
        if (posEl) posEl.value = 'custom';

        if (this._els.dragHint) this._els.dragHint.style.display = 'none';
    }

    _onDragMove(clientX, clientY) {
        if (!this._dragging || !this._isOpen) return;

        const rect = this._els.canvas.getBoundingClientRect();
        const scaleX = this._els.canvas.width / rect.width;
        const scaleY = this._els.canvas.height / rect.height;

        const dx = (clientX - this._dragStartX) * scaleX;
        const dy = (clientY - this._dragStartY) * scaleY;

        const canvasW = this._els.canvas.width;
        const canvasH = this._els.canvas.height;

        const dPosX = (dx / canvasW) * 100;
        const dPosY = (dy / canvasH) * 100;

        this._options.posX = Math.max(0, Math.min(95, this._dragStartPosX + dPosX));
        this._options.posY = Math.max(0, Math.min(95, this._dragStartPosY + dPosY));

        this._scheduleRender();
    }

    _onDragEnd() {
        this._dragging = false;
    }

    // ═══════════════════════════════════════════════════════════
    //  CANVAS & RENDERING
    // ═══════════════════════════════════════════════════════════

    _setupCanvas() {
        const canvas = this._els.canvas;
        if (!canvas || !this._image) return;

        const imgW = this._image.naturalWidth || this._image.width;
        const imgH = this._image.naturalHeight || this._image.height;

        // Limit canvas size for performance (max 1200px on longest side)
        const maxDim = 1200;
        let scale = 1;
        if (imgW > maxDim || imgH > maxDim) {
            scale = maxDim / Math.max(imgW, imgH);
        }

        canvas.width = Math.round(imgW * scale);
        canvas.height = Math.round(imgH * scale);

        const ctx = canvas.getContext('2d');
        ctx.drawImage(this._image, 0, 0, canvas.width, canvas.height);

        this._canvas = canvas;
        this._ctx = ctx;

        // Show canvas info
        if (this._els.canvasInfo) {
            this._els.canvasInfo.textContent = `${imgW} × ${imgH} px` + (scale < 1 ? ` (предпросмотр ${Math.round(scale * 100)}%)` : '');
        }
    }

    _scheduleRender() {
        if (this._renderRAF) cancelAnimationFrame(this._renderRAF);
        this._renderRAF = requestAnimationFrame(() => this._renderPreview());
    }

    _renderPreview() {
        if (!this._canvas || !this._image || !this._isOpen) return;

        const canvas = this._canvas;
        const ctx = this._ctx;

        // Redraw original image
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(this._image, 0, 0, canvas.width, canvas.height);

        // Apply text overlay
        if (this._text.trim()) {
            try {
                const TO = window.TextOverlay;
                if (!TO) {
                    console.error('TextOverlay library not loaded');
                    return;
                }

                // Check if bubble preset mode is active
                const isBubble = !!this._options.bubblePreset;

                if (isBubble && typeof TO.renderBubble === 'function') {
                    // Bubble preset mode: render text inside bubble shape
                    // renderBubble supports all distortion effects natively
                    TO.renderBubble(canvas, this._text, this._options);
                } else {
                    // Standard overlay mode
                    const hasEffects = this._options.waveAmplitude > 0 ||
                        this._options.perLetterRotation > 0 ||
                        this._options.perLetterSizeVariation > 0 ||
                        this._options.perLetterSkewX > 0 ||
                        this._options.noiseIntensity > 0 ||
                        this._options.perLetterRandomOffset > 0 ||
                        this._options.perLetterBoldRandom ||
                        this._options.perLetterSpacingVariation > 0 ||
                        this._options.randomColorPerLetter;

                    if (hasEffects) {
                        TO.renderWithEffects(canvas, this._text, this._options);
                    } else {
                        TO.render(canvas, this._text, this._options);
                    }
                }
            } catch (err) {
                console.error('TextOverlay render error:', err);
            }
        }

        // Draw drag indicator (skip in bubble mode — positioning is handled by bubble layout)
        if (this._text.trim() && !this._options.bubblePreset) {
            this._drawDragIndicator(ctx, canvas.width, canvas.height);
        }

        this._renderRAF = null;
    }

    _drawDragIndicator(ctx, w, h) {
        try {
            const TO = window.TextOverlay;
            if (!TO || !TO.getTextBounds) return;

            const bounds = TO.getTextBounds(ctx, this._text, {
                ...this._options,
                canvasWidth: w,
                canvasHeight: h,
            });

            const pad = 6;
            ctx.save();
            ctx.strokeStyle = 'rgba(34, 197, 94, 0.6)';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([6, 4]);
            ctx.strokeRect(
                bounds.x - pad,
                bounds.y - pad,
                bounds.w + pad * 2,
                bounds.h + pad * 2
            );
            ctx.restore();
        } catch (e) {
            // Silently skip indicator on error
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  OPTIONS SYNC
    // ═══════════════════════════════════════════════════════════

    _populateFromOptions() {
        const e = this._els;
        const o = this._options;

        if (e.text) e.text.value = this._text;
        if (e.font) e.font.value = o.fontFamily || 'Arial, sans-serif';
        if (e.size) e.size.value = o.fontSize || 24;
        if (e.lineSpacing) e.lineSpacing.value = o.lineSpacing || 1.4;
        if (e.lineSpacingVal) e.lineSpacingVal.textContent = (o.lineSpacing || 1.4).toFixed(1);
        if (e.color) e.color.value = o.color || '#ffffff';
        if (e.colorText) e.colorText.value = o.color || '#ffffff';
        if (e.opacity) e.opacity.value = o.opacity || 15;
        if (e.opacityVal) e.opacityVal.textContent = o.opacity || 15;
        if (e.randomColor) e.randomColor.checked = !!o.randomColorPerLetter;
        if (e.position) e.position.value = o.position || 'tile';
        if (e.rotation) e.rotation.value = o.rotation || 0;
        if (e.rotationVal) e.rotationVal.textContent = o.rotation || 0;

        // Distortion
        if (e.waveAmplitude) e.waveAmplitude.value = o.waveAmplitude || 0;
        if (e.waveVal) e.waveVal.textContent = o.waveAmplitude || 0;
        if (e.waveFrequency) e.waveFrequency.value = o.waveFrequency ?? 1;
        if (e.waveFreqVal) e.waveFreqVal.textContent = o.waveFrequency ?? 1;
        if (e.perLetterRotation) e.perLetterRotation.value = o.perLetterRotation || 0;
        if (e.letterRotVal) e.letterRotVal.textContent = o.perLetterRotation || 0;
        if (e.perLetterSize) e.perLetterSize.value = o.perLetterSizeVariation || 0;
        if (e.letterSizeVal) e.letterSizeVal.textContent = o.perLetterSizeVariation || 0;
        if (e.perLetterOffset) e.perLetterOffset.value = o.perLetterRandomOffset || 0;
        if (e.letterOffsetVal) e.letterOffsetVal.textContent = o.perLetterRandomOffset || 0;
        if (e.perLetterSkew) e.perLetterSkew.value = o.perLetterSkewX || 0;
        if (e.skewVal) e.skewVal.textContent = (o.perLetterSkewX || 0).toFixed(2);
        if (e.perLetterSpacing) e.perLetterSpacing.value = o.perLetterSpacingVariation || 0;
        if (e.spacingVal) e.spacingVal.textContent = o.perLetterSpacingVariation || 0;
        if (e.boldRandom) e.boldRandom.checked = !!o.perLetterBoldRandom;
        if (e.noise) e.noise.value = o.noiseIntensity || 0;
        if (e.noiseVal) e.noiseVal.textContent = o.noiseIntensity || 0;

        this._updateEffectCount();
    }

    _updateEffectCount() {
        const e = this._els;
        if (!e.effectCount) return;

        let count = 0;
        if (this._options.waveAmplitude > 0) count++;
        if (this._options.perLetterRotation > 0) count++;
        if (this._options.perLetterSizeVariation > 0) count++;
        if (this._options.perLetterRandomOffset > 0) count++;
        if (this._options.perLetterSkewX > 0) count++;
        if (this._options.perLetterSpacingVariation > 0) count++;
        if (this._options.perLetterBoldRandom) count++;
        if (this._options.noiseIntensity > 0) count++;
        if (this._options.randomColorPerLetter) count++;

        e.effectCount.textContent = count > 0 ? `${count} активн.` : '0 активных';
        if (count > 0) {
            e.effectCount.style.color = 'var(--toe-accent)';
            e.effectCount.style.background = 'var(--toe-accent-dim)';
        } else {
            e.effectCount.style.color = '';
            e.effectCount.style.background = '';
        }
    }

    _resetAll() {
        const TO = window.TextOverlay;
        this._options = { ...(TO && TO.DEFAULT_OPTIONS ? TO.DEFAULT_OPTIONS : {}) };
        this._populateFromOptions();
        this._scheduleRender();
    }

    _resetDistortion() {
        const o = this._options;
        o.waveAmplitude = 0;
        o.waveFrequency = 1;
        o.perLetterRotation = 0;
        o.perLetterSizeVariation = 0;
        o.perLetterSkewX = 0;
        o.perLetterRandomOffset = 0;
        o.perLetterSpacingVariation = 0;
        o.perLetterBoldRandom = false;
        o.noiseIntensity = 0;
        o.randomColorPerLetter = false;
        this._populateFromOptions();
        this._scheduleRender();
    }

    _randomize() {
        const rng = () => Math.random();
        const o = this._options;

        // Random distortion values
        o.waveAmplitude = Math.round((rng() * 3 + 1) * 2) / 2; // 0.5 to 4, step 0.5
        o.waveFrequency = Math.round((rng() * 2 + 0.5) * 10) / 10; // 0.5 to 2.5
        o.perLetterRotation = Math.round(rng() * 15); // 0-15 degrees
        o.perLetterSizeVariation = Math.round(rng() * 6); // 0-6 px
        o.perLetterRandomOffset = Math.round(rng() * 5); // 0-5 px
        o.perLetterSkewX = Math.round(rng() * 0.2 * 100) / 100; // 0-0.2
        o.perLetterSpacingVariation = Math.round(rng() * 3); // 0-3 px
        o.perLetterBoldRandom = rng() > 0.6;

        // Random color 50% of the time
        o.randomColorPerLetter = rng() > 0.5;

        // Random opacity between 10-30%
        o.opacity = Math.round(rng() * 20 + 10);

        // Small noise 30% of the time
        o.noiseIntensity = rng() > 0.7 ? Math.round(rng() * 10) : 0;

        this._populateFromOptions();
        this._scheduleRender();
    }

    // ═══════════════════════════════════════════════════════════
    //  SHOW / HIDE
    // ═══════════════════════════════════════════════════════════

    _show() {
        if (this._el) {
            this._el.style.display = 'flex';
            document.body.style.overflow = 'hidden';

            // Force focus on the textarea for immediate text input
            requestAnimationFrame(() => {
                const textEl = this._els?.text;
                if (textEl) {
                    textEl.focus();
                    textEl.setSelectionRange(textEl.value.length, textEl.value.length);
                }
            });
        }
    }

    _hide() {
        if (this._el) {
            this._el.style.display = 'none';
            document.body.style.overflow = '';
            // Blur any focused input to close mobile keyboard
            const active = document.activeElement;
            if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')) {
                active.blur();
            }
        }
    }
}

// Export for both module and global usage
if (typeof module !== 'undefined' && module.exports) {
    module.exports = TextOverlayEditor;
}
window.TextOverlayEditor = TextOverlayEditor;
export { TextOverlayEditor };
