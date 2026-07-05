/**
 * Image Steganography UI Module — Stegonator
 *
 * Provides a UI for hiding messages inside images using
 * multiple algorithms:
 *   1. ST3GG DCT/F5 (JPEG, compression-resistant) — RECOMMENDED
 *   2. CryptoStego (neural-network-based, via ONNX Runtime)
 *   3. PassLok F5 (pure JS, LSB + DCT, PNG/JPEG)
 *
 * Exported: ImageStegoUI class with init() method.
 *
 * CSS namespace: cm-imgstego-*
 * Icons: all SVG via sprite.svg (no emoji)
 * Global deps: showToast(message, type) from main.js
 *
 * This class operates on the existing #panelImageStego DOM in index.html.
 * It does NOT create any DOM elements — it only caches references and
 * binds event handlers.
 */

export class ImageStegoUI {
    constructor() {
        // ── Internal state ────────────────────────────────────
        this.state = {
            algorithm: 'dct-qim',     // 'dct-qim' | 'dsss' | 'text-overlay' | 'cryptostego' | 'passlok' | 'spectra-steg' | 'image-scrambler'
            subMode: 'encode',          // 'encode' | 'decode'
            direction: 'encode',        // same as subMode (kept for clarity)
            cryptoStegoSub: 'visual',   // 'visual' | 'robust'

            _lastImageStegoDataUrl: null,
            _lastImageStegoBlob: null,

            _originalImageEl: null,
            _originalDataUrl: null,
            _resultDataUrl: null,
            _resultBlob: null,
            _resultRawBytes: null,     // Raw bytes for binary operations

            _cryptostegoModule: null,
            _cryptostegoReady: false,
            _cryptostegoLoading: false,
            _passlokReady: false,
            _st3ggReady: false,
            _spectraStegReady: false,
            _imageScramblerReady: false,
            _dctQimReady: false,
            _dsssReady: false,
            _textOverlayReady: false,
            _scramblerSafeMode: true, // default: normalization on

            _encoding: false,
            _imageWidth: 0,
            _imageHeight: 0,
            _encodingAlgo: null,        // Which algo was used for encoding (for auto-detect)
            _st3ggPassword: null,       // Stored password from ST3GG encoding
            _passlokEncodingFormat: null, // 'png' or 'jpg' — which PassLok encoder was used
            _cryptostegoModelType: null, // 0=visual, 1=robust — which CryptoStego model was used

            _binaryFile: null,
            _binaryFileBytes: null,

            // TextOverlay distortion options (from editor)
            _textOverlayDistortion: {
                randomColorPerLetter: false,
                waveAmplitude: 0,
                waveFrequency: 1,
                perLetterRotation: 0,
                perLetterSizeVariation: 0,
                perLetterSkewX: 0,
                noiseIntensity: 0,
                perLetterRandomOffset: 0,
                perLetterBoldRandom: false,
                perLetterSpacingVariation: 0,
            },
        };

        // ── Constants ─────────────────────────────────────────
        this.CRYPTOSTEGO_MAX_SIZE = 600;
        this.CRYPTOSTEGO_MIN_SIZE = 300;
        this.CRYPTOSTEGO_CAPACITY = 8192;

        this.PASSLOK_SCRIPTS = [
            'prng.js', 'scrypt-async.js', 'bodyscript.js',
            'jsstegencoder.js', 'jsstegdecoder.js', 'jssteg.js',
            'plstego.js', 'lz-string.js',
        ];

        // ── DOM references ────────────────────────────────────
        this._els = {};
        this._root = null;

        // Algo info strings
        this._algoInfoTexts = {
            'dct-qim': 'DCT-QIM: стеганография в DCT-коэффициентах с квантованием. Устойчив к JPEG-перекодированию. Без пароля или с паролем.',
            'dsss': 'DSSS: рассеивание спектра с псевдослучайным выбором пикселей. Пароль ОБЯЗАТЕЛЕН. Устойчив к повреждениям.',
            'text-overlay': 'Text Overlay: текст внедряется поверх изображения с низкой непрозрачностью. Не зашифрован — защита от автоматического анализа.',
            'cryptostego-similarity': 'Нейросетевая стеганография с высоким визуальным качеством. Модели встроены в приложение.',
            'cryptostego-robustness': 'Нейросетевая стеганография с повышенной устойчивостью к сжатию. Модели встроены в приложение.',
            'passlok-f5': 'Классический F5 стеганографический алгоритм (LSB + DCT). Поддерживает PNG и JPEG. Быстро.',
            'spectra-steg': 'Спектральная стеганография в DCT-коэффициентах с повторением данных. Крайне устойчив к JPEG-сжатию. Ползунок устойчивости.',
            'image-scrambler': 'Шифрование самого изображения (без скрытого текста). Восстановление только с паролем. Маркер для автоопределения.',
        };

        // ── Stress test expectations ───────────────────────────
        // Maps algorithm + test type → expected survival (true = should survive)
        this._stressExpectations = {
            'dct-qim': {
                'jpeg-95': true, 'jpeg-90': true, 'jpeg-75': true, 'jpeg-50': 'maybe',
                'resize-50': false, 'resize-75': false, 'png-recompress': true, 'crop-10': false,
            },
            'dsss': {
                'jpeg-95': 'maybe', 'jpeg-90': false, 'jpeg-75': false, 'jpeg-50': false,
                'resize-50': false, 'resize-75': false, 'png-recompress': true, 'crop-10': false,
            },
            'cryptostego': {
                'jpeg-95': false, 'jpeg-90': false, 'jpeg-75': false, 'jpeg-50': false,
                'resize-50': false, 'resize-75': false, 'png-recompress': true, 'crop-10': false,
            },
            'passlok': {
                'jpeg-95': 'maybe', 'jpeg-90': 'maybe', 'jpeg-75': false, 'jpeg-50': false,
                'resize-50': false, 'resize-75': false, 'png-recompress': true, 'crop-10': false,
            },
            'spectra-steg': {
                'jpeg-95': true, 'jpeg-90': true, 'jpeg-75': true, 'jpeg-50': true,
                'resize-50': false, 'resize-75': false, 'png-recompress': true, 'crop-10': false,
            },
            'image-scrambler': {
                'jpeg-95': true, 'jpeg-90': true, 'jpeg-75': true, 'jpeg-50': true,
                'resize-50': false, 'resize-75': false, 'png-recompress': true, 'crop-10': false,
            },
        };
    }

    // ═══════════════════════════════════════════════════════════════
    //  PUBLIC API
    // ═══════════════════════════════════════════════════════════════

    init() {
        this._cacheDom();
        this._bindEvents();
        if (this._els.algorithmSelect) {
            this._onAlgorithmSelectChange(this._els.algorithmSelect.value);
        }
        this._updateDirectionUI();
        this._updateCapacity();
        // Pre-load all stego libraries in background so they're ready instantly
        this._preloadLibraries();
    }

    // ═══════════════════════════════════════════════════════════════
    //  DOM CACHING
    // ═══════════════════════════════════════════════════════════════

    _cacheDom() {
        const $ = (sel) => document.querySelector(sel);
        this._root = $('#panelImageStego');
        if (!this._root) {
            console.error('ImageStegoUI: #panelImageStego not found in DOM');
            return;
        }

        this._els = {
            algorithmSelect: $('#imgAlgorithm'),
            decodeAlgorithmSelect: $('#imgDecodeAlgorithm'),
            algoInfo: $('#imgAlgoInfo'),

            directionToggle: $('#imgDirection'),
            dirEncode: $('#imgDirection [data-direction="encode"]'),
            dirDecode: $('#imgDirection [data-direction="decode"]'),

            encodeSection: $('#imgEncodeSection'),
            decodeSection: $('#imgDecodeSection'),

            dropZone: $('#imgDropzone'),
            fileInput: $('#imgFileInput'),
            canvas: $('#imgCanvas'),
            imageInfo: $('#imgInfo'),

            decodeDropZone: $('#imgDecodeDropzone'),
            decodeFileInput: $('#imgDecodeFileInput'),
            decodeCanvas: $('#imgDecodeCanvas'),

            secretText: $('#imgSecret'),
            capacityInfo: $('#imgCapacity'),
            fileAttachBtn: $('#imgFileAttachBtn'),
            fileInputBinary: $('#imgFileAttach'),
            fileInfo: $('#imgFileInfo'),

            passwordInput: $('#imgPassword'),
            passwordToggle: $('#btnToggleImgPw'),
            passwordHint: this._root.querySelector('.cm-imgstego-password-hint'),

            decodePasswordInput: $('#imgDecodePassword'),
            decodePasswordToggle: $('#btnToggleImgDecPw'),

            encodeBtn: $('#imgEncodeBtn'),
            decodeBtn: $('#imgDecodeBtn'),

            resultSection: $('#imgResultSection'),
            roundtripBadge: $('#imgRoundtripBadge'),
            resultOriginalWrapper: $('#imgResultOriginal'),
            resultOriginalCanvas: $('#imgResultOriginalCanvas'),
            resultStegoCanvas: $('#imgResultStegoCanvas'),
            btnDownload: $('#imgResultDownload'),
            btnCopyImage: $('#imgResultCopy'),

            decodedResult: $('#imgDecodedResult'),
            decodedText: $('#imgDecodedText'),
            decodedCopyBtn: $('#imgDecodedCopy'),
            decodedFileSection: $('#imgDecodedFile'),
            decodedFileInfo: $('#imgDecodedFileInfo'),
            decodedFileSaveBtn: $('#imgDecodedFileSave'),

            stressResults: $('#imgStressResults'),
            hiddenCanvas: $('#imgHiddenCanvas'),

            searchBtn: $('#imgSearchBtn'),
            searchPopup: $('#imgSearchPopup'),
            searchBackdrop: $('#imgSearchBackdrop'),
            searchCloseBtn: $('#imgSearchPopupClose'),
            searchUrlInput: $('#imgSearchUrlInput'),
            searchUrlLoadBtn: $('#imgSearchUrlLoad'),

            spectraStegOptions: this._root.querySelector('#imgSpectraStegOptions'),
            spectraAlpha: $('#imgSpectraAlpha'),
            spectraAlphaVal: $('#imgSpectraAlphaVal'),
            scramblerOptions: this._root.querySelector('#imgScramblerOptions'),
            scramblerSafeMode: $('#imgScramblerSafeMode'),
            scramblerWarn: this._root.querySelector('#imgScramblerWarn'),
            dctQimOptions: this._root.querySelector('#imgDctQimOptions'),
            dctQimRobustness: $('#imgDctQimRobustness'),
            dsssOptions: this._root.querySelector('#imgDsssOptions'),
            dsssFactor: $('#imgDsssFactor'),
            dsssFactorVal: $('#imgDsssFactorVal'),
            textOverlayOptions: this._root.querySelector('#imgTextOverlayOptions'),
            textOverlayEditorArea: this._root.querySelector('#imgTextOverlayEditorArea'),
            textOverlayFont: $('#imgTextOverlayFont'),
            textOverlayColor: $('#imgTextOverlayColor'),
            textOverlayColorText: $('#imgTextOverlayColorText'),
            textOverlaySize: $('#imgTextOverlaySize'),
            textOverlayOpacity: $('#imgTextOverlayOpacity'),
            textOverlayOpacityVal: $('#imgTextOverlayOpacityVal'),
            textOverlayPosition: $('#imgTextOverlayPosition'),
            textOverlayRotation: $('#imgTextOverlayRotation'),
            textOverlayLineSpacing: $('#imgTextOverlayLineSpacing'),
            textOverlayCustomPos: this._root.querySelector('#imgTextOverlayCustomPos'),
            textOverlayPosX: $('#imgTextOverlayPosX'),
            textOverlayPosY: $('#imgTextOverlayPosY'),
            textOverlayRevealBtn: $('#imgTextOverlayRevealBtn'),

            // Background generator & random button
            bgGeneratorSection: this._root.querySelector('#imgBgGeneratorSection'),
            randomGenSection: this._root.querySelector('#imgRandomGenSection'),
            randomGenBtn: $('#imgRandomGenBtn'),
            quickApiBtn: $('#imgQuickApiBtn'),
        };
    }

    // ═══════════════════════════════════════════════════════════════
    //  EVENT BINDING
    // ═══════════════════════════════════════════════════════════════

    _bindEvents() {
        const e = this._els;

        e.algorithmSelect?.addEventListener('change', () => {
            this._onAlgorithmSelectChange(e.algorithmSelect.value);
        });

        // SpectraSteg alpha slider
        e.spectraAlpha?.addEventListener('input', () => {
            if (e.spectraAlphaVal) e.spectraAlphaVal.textContent = e.spectraAlpha.value;
        });

        // ImageScrambler safe mode toggle
        e.scramblerSafeMode?.addEventListener('change', () => {
            this.state._scramblerSafeMode = e.scramblerSafeMode.checked;
            if (e.scramblerWarn) e.scramblerWarn.style.display = e.scramblerSafeMode.checked ? 'none' : '';
        });

        // DCT-QIM robustness selector
        e.dctQimRobustness?.addEventListener('change', () => {
            this._syncAlgorithmUI();
            this._updateCapacity();
        });

        // DSSS factor selector
        e.dsssFactor?.addEventListener('change', () => {
            if (e.dsssFactorVal) e.dsssFactorVal.textContent = e.dsssFactor.value + 'x';
            this._updateCapacity();
        });

        // TextOverlay hidden inputs are updated by editor callback — no manual listeners needed

        // TextOverlay reveal button
        e.textOverlayRevealBtn?.addEventListener('click', () => this._revealTextOverlay());

        // TextOverlay editor button
        const btnOpenEditor = document.getElementById('btnOpenTextOverlayEditor');
        btnOpenEditor?.addEventListener('click', () => this._openTextOverlayEditor());

        // Background generator buttons
        this._root?.querySelectorAll('[data-bggen]')?.forEach(btn => {
            btn.addEventListener('click', () => this._generateBackground(btn.dataset.bggen));
        });

        // Random generate button
        e.randomGenBtn?.addEventListener('click', () => this._handleRandomGenerate());

        // Quick API button (generate OCR-resistant image from text via server API)
        e.quickApiBtn?.addEventListener('click', () => this._handleQuickApiGenerate());

        // Clipboard paste support (Ctrl+V)
        document.addEventListener('paste', (ev) => this._handleClipboardPaste(ev));

        e.decodeAlgorithmSelect?.addEventListener('change', () => {
            const val = e.decodeAlgorithmSelect.value;
            // Don't change internal algorithm for 'auto' — keep current
            if (val !== 'auto') {
                this.state.algorithm = val;
                if (val === 'cryptostego') {
                    this._ensureCryptoStegoLoaded();
                }
            }
        });

        e.dirEncode?.addEventListener('click', () => this._setDirection('encode'));
        e.dirDecode?.addEventListener('click', () => this._setDirection('decode'));

        const subtabsImages = document.querySelectorAll('#subtabsImages .cm-subtab');
        subtabsImages.forEach(subtab => {
            subtab.addEventListener('click', () => {
                const mode = subtab.dataset.mode;
                if (mode === 'img-encode') this._setDirection('encode');
                else if (mode === 'img-decode') this._setDirection('decode');
            });
        });

        e.dropZone?.addEventListener('dragover', (ev) => this._onDragOver(ev, e.dropZone));
        e.dropZone?.addEventListener('dragleave', (ev) => this._onDragLeave(ev, e.dropZone));
        e.dropZone?.addEventListener('drop', (ev) => this._onDrop(ev, e.dropZone, 'encode'));
        e.dropZone?.addEventListener('click', (ev) => {
            if (e.dropZone.classList.contains('has-image')) return;
            e.fileInput?.click();
        });
        e.fileInput?.addEventListener('change', (ev) => {
            if (ev.target.files?.[0]) this._loadImageFile(ev.target.files[0], 'encode');
        });

        e.decodeDropZone?.addEventListener('dragover', (ev) => this._onDragOver(ev, e.decodeDropZone));
        e.decodeDropZone?.addEventListener('dragleave', (ev) => this._onDragLeave(ev, e.decodeDropZone));
        e.decodeDropZone?.addEventListener('drop', (ev) => this._onDrop(ev, e.decodeDropZone, 'decode'));
        e.decodeDropZone?.addEventListener('click', (ev) => {
            if (e.decodeDropZone.classList.contains('has-image')) return;
            e.decodeFileInput?.click();
        });
        e.decodeFileInput?.addEventListener('change', (ev) => {
            if (ev.target.files?.[0]) this._loadImageFile(ev.target.files[0], 'decode');
        });

        e.secretText?.addEventListener('input', () => this._onSecretInput());

        e.fileAttachBtn?.addEventListener('click', () => e.fileInputBinary?.click());
        e.fileInputBinary?.addEventListener('change', (ev) => {
            if (ev.target.files?.[0]) this._loadBinaryFile(ev.target.files[0]);
        });

        e.passwordToggle?.addEventListener('click', () => this._togglePassword('encode'));
        e.decodePasswordToggle?.addEventListener('click', () => this._togglePassword('decode'));
        e.passwordInput?.addEventListener('input', () => this._updatePasswordHint());

        e.encodeBtn?.addEventListener('click', () => this._handleAction());
        e.decodeBtn?.addEventListener('click', () => this._handleAction());

        e.btnDownload?.addEventListener('click', () => this._downloadResult());
        e.btnCopyImage?.addEventListener('click', () => this._copyResultToClipboard());

        e.decodedCopyBtn?.addEventListener('click', () => this._copyDecodedText());
        e.decodedFileSaveBtn?.addEventListener('click', () => this._saveDecodedFile());

        // ── Stress test buttons ──
        this._root?.querySelectorAll('.cm-imgstego-stress-grid [data-stress]').forEach(btn => {
            btn.addEventListener('click', () => this._runIndividualStress(btn.dataset.stress));
        });

        // ── Image search modal ──
        e.searchBtn?.addEventListener('click', () => this._toggleSearchPopup());
        e.searchCloseBtn?.addEventListener('click', () => this._toggleSearchPopup(false));
        e.searchBackdrop?.addEventListener('click', () => this._toggleSearchPopup(false));
        e.searchUrlLoadBtn?.addEventListener('click', () => {
            const url = e.searchUrlInput?.value?.trim();
            if (!url) {
                this._showToast('Введите URL изображения', 'warning');
                return;
            }
            this._loadImageFromUrl(url);
            this._toggleSearchPopup(false);
        });
        e.searchUrlInput?.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter') {
                ev.preventDefault();
                e.searchUrlLoadBtn?.click();
            }
        });

        // ── Public API ──
        window.Stegonator = window.Stegonator || {};
        window.Stegonator.load_image = (dataUrl) => this.receiveImageFromSearch(dataUrl);
        window.Stegonator.receiveImageFromSearch = (blobOrUrl) => this.receiveImageFromSearch(blobOrUrl);
    }

    // ═══════════════════════════════════════════════════════════════
    //  ALGORITHM & DIRECTION
    // ═══════════════════════════════════════════════════════════════

    _onAlgorithmSelectChange(value) {
        if (value.startsWith('cryptostego')) {
            this.state.algorithm = 'cryptostego';
            this.state.cryptoStegoSub = value.includes('robustness') ? 'robust' : 'visual';
        } else if (value === 'dct-qim') {
            this.state.algorithm = 'dct-qim';
        } else if (value === 'dsss') {
            this.state.algorithm = 'dsss';
        } else if (value === 'text-overlay') {
            this.state.algorithm = 'text-overlay';
        } else if (value === 'spectra-steg') {
            this.state.algorithm = 'spectra-steg';
        } else if (value === 'image-scrambler') {
            this.state.algorithm = 'image-scrambler';
        } else {
            this.state.algorithm = 'passlok';
        }

        this._syncAlgorithmUI();
        this._clearResult();
        this._updateCapacity();
        this._updatePasswordHint();

        if (this.state.algorithm === 'cryptostego') {
            this._ensureCryptoStegoLoaded();
        }
    }

    _syncAlgorithmUI() {
        const e = this._els;
        if (e.algoInfo && e.algorithmSelect) {
            e.algoInfo.textContent = this._algoInfoTexts[e.algorithmSelect.value] || '';
        }

        // Show/hide algorithm-specific options
        if (e.spectraStegOptions) e.spectraStegOptions.style.display = this.state.algorithm === 'spectra-steg' ? '' : 'none';
        if (e.scramblerOptions) e.scramblerOptions.style.display = this.state.algorithm === 'image-scrambler' ? '' : 'none';
        if (e.dctQimOptions) e.dctQimOptions.style.display = this.state.algorithm === 'dct-qim' ? '' : 'none';
        if (e.dsssOptions) e.dsssOptions.style.display = this.state.algorithm === 'dsss' ? '' : 'none';
        if (e.textOverlayOptions) e.textOverlayOptions.style.display = this.state.algorithm === 'text-overlay' ? '' : 'none';
        if (e.textOverlayEditorArea) e.textOverlayEditorArea.style.display = this.state.algorithm === 'text-overlay' ? '' : 'none';

        // Background generator & random button: show only for text-overlay
        if (e.bgGeneratorSection) e.bgGeneratorSection.style.display = this.state.algorithm === 'text-overlay' ? '' : 'none';
        if (e.randomGenSection) e.randomGenSection.style.display = this.state.algorithm === 'text-overlay' ? '' : 'none';

        // TextOverlay: show reveal button in decode mode, hide password hint relevance
        // Show/hide secret message field based on algorithm
        const secretSection = this._root?.querySelector('.cm-imgstego-secret-header')?.closest('.cm-field-group');
        if (secretSection) {
            secretSection.style.display = this.state.algorithm === 'image-scrambler' ? 'none' : '';
        }
    }

    _setDirection(dir) {
        this.state.direction = dir;
        this.state.subMode = dir;

        const e = this._els;
        e.dirEncode?.classList.toggle('active', dir === 'encode');
        e.dirDecode?.classList.toggle('active', dir === 'decode');

        const targetMode = dir === 'encode' ? 'img-encode' : 'img-decode';
        document.querySelectorAll('#subtabsImages .cm-subtab').forEach(s => {
            s.classList.toggle('active', s.dataset.mode === targetMode);
        });

        this._updateDirectionUI();
        this._clearResult();
    }

    _updateDirectionUI() {
        const dir = this.state.direction;
        const e = this._els;

        if (e.encodeSection) e.encodeSection.style.display = dir === 'encode' ? '' : 'none';
        if (e.decodeSection) e.decodeSection.style.display = dir === 'decode' ? '' : 'none';

        // When switching to decode, reset to 'auto'
        if (dir === 'decode' && e.decodeAlgorithmSelect) {
            e.decodeAlgorithmSelect.value = 'auto';
        }

        this._updatePasswordHint();

        if (dir === 'encode' && e.decodedResult) e.decodedResult.style.display = 'none';
        if (dir === 'encode' && e.decodedFileSection) e.decodedFileSection.style.display = 'none';
        if (e.textOverlayRevealBtn) e.textOverlayRevealBtn.style.display = dir === 'decode' ? '' : 'none';
    }

    // ═══════════════════════════════════════════════════════════════
    //  IMAGE LOADING
    // ═══════════════════════════════════════════════════════════════

    _onDragOver(ev, dropZone) {
        ev.preventDefault();
        ev.stopPropagation();
        dropZone?.classList.add('drag-over');
    }

    _onDragLeave(ev, dropZone) {
        ev.preventDefault();
        ev.stopPropagation();
        dropZone?.classList.remove('drag-over');
    }

    _onDrop(ev, dropZone, mode) {
        ev.preventDefault();
        ev.stopPropagation();
        dropZone?.classList.remove('drag-over');
        const file = ev.dataTransfer?.files?.[0];
        if (file && file.type.startsWith('image/')) {
            this._loadImageFile(file, mode);
        } else {
            this._showToast('Пожалуйста, перетащите изображение (PNG/JPG)', 'warning');
        }
    }

    _loadImageFile(file, mode = 'encode') {
        const algo = this.state.algorithm;

        if (algo === 'cryptostego' && !file.type.match(/image\/png|image\/jpeg|image\/webp/)) {
            this._showToast('CryptoStego поддерживает PNG, JPG, WebP', 'warning');
            return;
        }

        const reader = new FileReader();
        reader.onload = (ev) => {
            const dataUrl = ev.target.result;
            this.state._originalDataUrl = dataUrl;

            const img = new Image();
            img.onload = () => {
                this.state._originalImageEl = img;
                this.state._imageWidth = img.naturalWidth;
                this.state._imageHeight = img.naturalHeight;

                if (algo === 'cryptostego') {
                    if (img.naturalWidth < this.CRYPTOSTEGO_MIN_SIZE || img.naturalHeight < this.CRYPTOSTEGO_MIN_SIZE) {
                        this._showToast(
                            `CryptoStego требует минимум ${this.CRYPTOSTEGO_MIN_SIZE}x${this.CRYPTOSTEGO_MIN_SIZE} px`,
                            'warning'
                        );
                    }
                }

                this._renderImagePreview(img, dataUrl, mode);
                this._updateCapacity();
            };
            img.onerror = () => {
                this._showToast('Не удалось загрузить изображение', 'error');
            };
            img.src = dataUrl;
        };
        reader.onerror = () => {
            this._showToast('Не удалось прочитать файл', 'error');
        };
        reader.readAsDataURL(file);
    }

    _renderImagePreview(img, dataUrl, mode = 'encode') {
        const e = this._els;

        if (mode === 'encode') {
            const canvas = e.canvas;
            if (canvas) {
                canvas.width = img.naturalWidth;
                canvas.height = img.naturalHeight;
                canvas.getContext('2d').drawImage(img, 0, 0);
                canvas.style.display = '';
            }
            if (e.imageInfo) {
                const sizeKB = Math.round((dataUrl.length * 3) / 4 / 1024);
                e.imageInfo.textContent = `${img.naturalWidth} × ${img.naturalHeight} px ≈ ${sizeKB} КБ`;
                e.imageInfo.style.display = '';
            }
            e.dropZone?.classList.add('has-image');
            if (e.encodeBtn) e.encodeBtn.disabled = false;
        } else {
            const canvas = e.decodeCanvas;
            if (canvas) {
                canvas.width = img.naturalWidth;
                canvas.height = img.naturalHeight;
                canvas.getContext('2d').drawImage(img, 0, 0);
                canvas.style.display = '';
            }
            e.decodeDropZone?.classList.add('has-image');
            if (e.decodeBtn) e.decodeBtn.disabled = false;
        }
    }

    _clearImage(mode = 'encode') {
        this.state._originalImageEl = null;
        this.state._originalDataUrl = null;
        this.state._imageWidth = 0;
        this.state._imageHeight = 0;
        this._clearResult();

        const e = this._els;
        if (mode === 'encode') {
            if (e.canvas) e.canvas.style.display = 'none';
            if (e.imageInfo) { e.imageInfo.style.display = 'none'; e.imageInfo.textContent = ''; }
            if (e.fileInput) e.fileInput.value = '';
            e.dropZone?.classList.remove('has-image');
            if (e.encodeBtn) e.encodeBtn.disabled = true;
        } else {
            if (e.decodeCanvas) e.decodeCanvas.style.display = 'none';
            if (e.decodeFileInput) e.decodeFileInput.value = '';
            e.decodeDropZone?.classList.remove('has-image');
            if (e.decodeBtn) e.decodeBtn.disabled = true;
        }

        this._updateCapacity();
    }

    // ═══════════════════════════════════════════════════════════════
    //  SECRET INPUT
    // ═══════════════════════════════════════════════════════════════

    _onSecretInput() {
        this._updateCapacity();
    }

    _loadBinaryFile(file) {
        if (file.size > 10 * 1024 * 1024) {
            this._showToast('Файл слишком большой (максимум 10 МБ)', 'warning');
            return;
        }
        this.state._binaryFile = file;
        this.state._binaryFileBytes = null;

        const e = this._els;
        if (e.fileInfo) {
            e.fileInfo.textContent = `${file.name} (${this._formatBytes(file.size)})`;
            e.fileInfo.style.display = '';
        }
        if (e.secretText) {
            e.secretText.value = '';
            e.secretText.disabled = true;
            e.secretText.placeholder = 'Файл выбран — текст вводить не нужно';
        }
        this._onSecretInput();
    }

    _clearBinaryFile() {
        this.state._binaryFile = null;
        this.state._binaryFileBytes = null;
        const e = this._els;
        if (e.fileInfo) { e.fileInfo.style.display = 'none'; e.fileInfo.textContent = ''; }
        if (e.fileInputBinary) e.fileInputBinary.value = '';
        if (e.secretText) {
            e.secretText.disabled = false;
            e.secretText.placeholder = 'Секретное сообщение…';
        }
    }

    async _getBinaryFileBytes() {
        if (!this.state._binaryFile) return null;
        if (this.state._binaryFileBytes) return this.state._binaryFileBytes;
        const buf = await this.state._binaryFile.arrayBuffer();
        this.state._binaryFileBytes = new Uint8Array(buf);
        return this.state._binaryFileBytes;
    }

    // ═══════════════════════════════════════════════════════════════
    //  CAPACITY CALCULATION
    // ═══════════════════════════════════════════════════════════════

    _getCapacityBytes() {
        const w = this.state._imageWidth;
        const h = this.state._imageHeight;
        if (!w || !h) return 0;

        const algo = this.state.algorithm;

        if (algo === 'image-scrambler') {
            // ImageScrambler doesn't embed data — capacity doesn't apply
            return 0;
        }

        if (algo === 'dct-qim') {
            const blockSize = 8;
            const blocksX = Math.floor(w / blockSize);
            const blocksY = Math.floor(h / blockSize);
            const totalBits = blocksX * blocksY;
            const headerBits = 9 * 8; // 9-byte header
            return Math.floor(Math.max(0, (totalBits - headerBits)) / 8);
        }

        if (algo === 'dsss') {
            const factor = parseInt(this._els.dsssFactor?.value || '16', 10);
            const totalPixels = w * h;
            const totalBits = Math.floor(totalPixels / factor);
            const headerBits = 8 * 8; // 8-byte header
            return Math.floor(Math.max(0, (totalBits - headerBits)) / 8);
        }

        if (algo === 'text-overlay') {
            // TextOverlay has no capacity limit - just returns a large number
            return 100000;
        }

        if (algo === 'cryptostego') {
            const area = w * h;
            const refArea = this.CRYPTOSTEGO_MAX_SIZE * this.CRYPTOSTEGO_MAX_SIZE;
            return Math.floor(this.CRYPTOSTEGO_CAPACITY * (area / refArea));
        }

        // PassLok
        const pngBits = w * h * 3;
        const pngBytes = Math.floor(pngBits / 8 * 0.45);
        return pngBytes;
    }

    _updateCapacity() {
        const e = this._els;
        if (!e.capacityInfo) return;

        const cap = this._getCapacityBytes();
        if (cap <= 0) {
            e.capacityInfo.textContent = '—';
            e.capacityInfo.className = 'cm-imgstego-capacity-badge';
            return;
        }

        const capStr = this._formatBytes(cap);
        const algo = this.state.algorithm;
        let hint = '';
        if (algo === 'passlok') {
            hint = ' (JPG ниже)';
        }

        const secretBytes = this._getSecretBytes();
        if (secretBytes > 0) {
            if (secretBytes <= cap) {
                e.capacityInfo.textContent = `✓ ${capStr}${hint}`;
                e.capacityInfo.className = 'cm-imgstego-capacity-badge cm-imgstego-capacity-badge--ok';
            } else {
                e.capacityInfo.textContent = `✗ ${capStr}${hint}`;
                e.capacityInfo.className = 'cm-imgstego-capacity-badge cm-imgstego-capacity-badge--low';
            }
        } else {
            e.capacityInfo.textContent = capStr + hint;
            e.capacityInfo.className = 'cm-imgstego-capacity-badge';
        }
    }

    _getSecretBytes() {
        if (this.state._binaryFile) return this.state._binaryFile.size;
        const text = this._els.secretText?.value || '';
        if (!text) return 0;
        return new TextEncoder().encode(text).length;
    }

    // ═══════════════════════════════════════════════════════════════
    //  PASSWORD
    // ═══════════════════════════════════════════════════════════════

    _togglePassword(mode = 'encode') {
        const e = this._els;
        const input = mode === 'encode' ? e.passwordInput : e.decodePasswordInput;
        const toggle = mode === 'encode' ? e.passwordToggle : e.decodePasswordToggle;
        if (!input || !toggle) return;

        const isPassword = input.type === 'password';
        input.type = isPassword ? 'text' : 'password';
        toggle.innerHTML = isPassword
            ? '<svg class="cm-icon cm-icon--sm"><use href="#icon-eye-off"/></svg>'
            : '<svg class="cm-icon cm-icon--sm"><use href="#icon-eye"/></svg>';
    }

    _updatePasswordHint() {
        const e = this._els;
        if (!e.passwordHint) return;
        if (this.state.direction !== 'encode') {
            e.passwordHint.style.display = 'none';
            return;
        }
        e.passwordHint.style.display = '';
        const pw = e.passwordInput?.value || '';
        if (pw.length > 0) {
            e.passwordHint.textContent = 'Пароль установлен — данные зашифрованы';
            e.passwordHint.style.color = 'var(--cm-accent, #6366f1)';
        } else if (this.state.algorithm === 'cryptostego') {
            e.passwordHint.textContent = 'Пароль не установлен — используется пустой пароль';
            e.passwordHint.style.color = 'var(--cm-text-muted, #9ca3af)';
        } else {
            e.passwordHint.textContent = 'Без пароля данные не зашифрованы';
            e.passwordHint.style.color = 'var(--cm-text-muted, #9ca3af)';
        }
    }

    _getPassword() {
        const e = this._els;
        if (this.state.direction === 'decode') {
            return e.decodePasswordInput?.value || '';
        }
        return e.passwordInput?.value || '';
    }

    // ═══════════════════════════════════════════════════════════════
    //  LOADING STATE
    // ═══════════════════════════════════════════════════════════════

    _showLoading(text = 'Обработка…') {
        const e = this._els;
        const btn = this.state.direction === 'encode' ? e.encodeBtn : e.decodeBtn;
        if (btn) {
            btn.disabled = true;
            btn.dataset.originalHtml = btn.innerHTML;
            btn.innerHTML = `<svg class="cm-icon cm-icon--sm" style="animation:cm-spin .8s linear infinite"><use href="#icon-sliders"/></svg> ${text}`;
        }
    }

    _hideLoading() {
        const e = this._els;
        const btn = this.state.direction === 'encode' ? e.encodeBtn : e.decodeBtn;
        if (btn) {
            btn.disabled = false;
            if (btn.dataset.originalHtml) {
                btn.innerHTML = btn.dataset.originalHtml;
                delete btn.dataset.originalHtml;
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  LIBRARY LOADERS
    // ═══════════════════════════════════════════════════════════════

    async _ensureCryptoStegoLoaded() {
        if (this.state._cryptostegoReady) return true;
        if (this.state._cryptostegoLoading) {
            while (this.state._cryptostegoLoading) {
                await new Promise(r => setTimeout(r, 200));
            }
            return this.state._cryptostegoReady;
        }

        this.state._cryptostegoLoading = true;
        const silent = this._silentCryptoStegoPreload;
        if (!silent) this._showLoading('Загрузка моделей…');

        try {
            const stego = await import('/lib/cryptostego/stego.js');
            this.state._cryptostegoModule = stego;

            if (!stego.isCodecsReady()) {
                const loadPromise = stego.initCodecs();
                const timeoutPromise = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Таймаут загрузки моделей (60 сек)')), 60000)
                );
                await Promise.race([loadPromise, timeoutPromise]);
            }

            this.state._cryptostegoReady = true;
            if (!silent) this._showToast('CryptoStego: модели загружены', 'success');
            return true;
        } catch (err) {
            console.error('CryptoStego load error:', err);
            if (!silent) this._showToast('CryptoStego: ошибка загрузки — ' + err.message, 'error');
            this.state._cryptostegoReady = false;
            return false;
        } finally {
            this.state._cryptostegoLoading = false;
            if (!silent) this._hideLoading();
        }
    }

    async _ensurePassLokLoaded() {
        if (this.state._passlokReady) return;
        if (typeof encodePNG === 'function' && typeof decodePNG === 'function') {
            this.state._passlokReady = true;
            return;
        }

        const silent = this._silentPreload;
        if (!silent) this._showLoading('Загрузка библиотеки PassLok…');

        try {
            const basePath = '/lib/passlok-stego/';
            for (const script of this.PASSLOK_SCRIPTS) {
                await this._loadScript(basePath + script);
            }
            this.state._passlokReady = true;
        } catch (err) {
            console.error('PassLok load error:', err);
            if (!silent) this._showToast('Не удалось загрузить PassLok: ' + err.message, 'error');
            throw err;
        } finally {
            if (!silent) this._hideLoading();
        }
    }

    async _ensureSpectraStegLoaded() {
        if (this.state._spectraStegReady) return;
        if (typeof SpectraSteg !== 'undefined' && SpectraSteg.embedData) {
            this.state._spectraStegReady = true;
            return;
        }
        const silent = this._silentPreload;
        if (!silent) this._showLoading('Загрузка SpectraSteg…');
        try {
            await this._loadScript('/lib/spectra-steg/spectra-steg.js');
            this.state._spectraStegReady = true;
        } catch (err) {
            console.error('SpectraSteg load error:', err);
            if (!silent) this._showToast('Не удалось загрузить SpectraStego: ' + err.message, 'error');
            throw err;
        } finally {
            if (!silent) this._hideLoading();
        }
    }

    async _ensureImageScramblerLoaded() {
        if (this.state._imageScramblerReady) return;
        if (typeof ImageScrambler !== 'undefined' && ImageScrambler.processCryptoImage) {
            this.state._imageScramblerReady = true;
            return;
        }
        const silent = this._silentPreload;
        if (!silent) this._showLoading('Загрузка ImageScrambler…');
        try {
            await this._loadScript('/lib/image-scrambler/crypto-image.js');
            this.state._imageScramblerReady = true;
        } catch (err) {
            console.error('ImageScrambler load error:', err);
            if (!silent) this._showToast('Не удалось загрузить ImageScrambler: ' + err.message, 'error');
            throw err;
        } finally {
            if (!silent) this._hideLoading();
        }
    }

    async _ensureDCTQIMLoaded() {
        if (this.state._dctQimReady) return;
        if (typeof DCTQIM !== 'undefined' && DCTQIM.encode) {
            this.state._dctQimReady = true;
            return;
        }
        const silent = this._silentPreload;
        if (!silent) this._showLoading('Загрузка DCT-QIM…');
        try {
            await this._loadScript('/lib/st3gg/dct-qim-dsss.js');
            if (typeof DCTQIM !== 'undefined' && DCTQIM.encode) {
                this.state._dctQimReady = true;
                this.state._dsssReady = typeof DSSS !== 'undefined' && DSSS.encode;
            }
        } catch (err) {
            console.error('DCT-QIM load error:', err);
            if (!silent) this._showToast('Не удалось загрузить DCT-QIM: ' + err.message, 'error');
            throw err;
        } finally {
            if (!silent) this._hideLoading();
        }
    }

    async _ensureDSSSLoaded() {
        // DSSS is in the same file as DCT-QIM
        if (this.state._dsssReady) return;
        await this._ensureDCTQIMLoaded();
        this.state._dsssReady = typeof DSSS !== 'undefined' && DSSS.encode;
    }

    async _ensureTextOverlayLoaded() {
        if (this.state._textOverlayReady) return;
        if (typeof TextOverlay !== 'undefined' && TextOverlay.render) {
            this.state._textOverlayReady = true;
            return;
        }
        const silent = this._silentPreload;
        if (!silent) this._showLoading('Загрузка TextOverlay…');
        try {
            await this._loadScript('/lib/st3gg/text-overlay.js');
            if (typeof TextOverlay !== 'undefined' && TextOverlay.render) {
                this.state._textOverlayReady = true;
            }
        } catch (err) {
            console.error('TextOverlay load error:', err);
            if (!silent) this._showToast('Не удалось загрузить TextOverlay: ' + err.message, 'error');
            throw err;
        } finally {
            if (!silent) this._hideLoading();
        }
    }

    // Pre-load all stego libraries silently (no loading UI) so they are ready when needed
    _preloadLibraries() {
        this._silentPreload = true;
        this._silentCryptoStegoPreload = true;

        // DCT-QIM and DSSS (same file) — lightweight
        this._ensureDCTQIMLoaded().then(() => {
            console.log('[ImageStego] DCT-QIM/DSSS pre-loaded');
        }).catch(err => {
            console.warn('[ImageStego] DCT-QIM pre-load failed:', err);
        });

        // TextOverlay — lightweight
        this._ensureTextOverlayLoaded().then(() => {
            console.log('[ImageStego] TextOverlay pre-loaded');
        }).catch(err => {
            console.warn('[ImageStego] TextOverlay pre-load failed:', err);
        });

        // PassLok — load all scripts
        this._ensurePassLokLoaded().then(() => {
            console.log('[ImageStego] PassLok pre-loaded');
        }).catch(err => {
            console.warn('[ImageStego] PassLok pre-load failed:', err);
        });

        this._ensureSpectraStegLoaded().then(() => { console.log('[ImageStego] SpectraSteg pre-loaded'); }).catch(() => {});
        this._ensureImageScramblerLoaded().then(() => { console.log('[ImageStego] ImageScrambler pre-loaded'); }).catch(() => {});

        // CryptoStego — heavier (ONNX models), start in background but don't block
        this._ensureCryptoStegoLoaded().then(() => {
            console.log('[ImageStego] CryptoStego pre-loaded');
        }).catch(err => {
            console.warn('[ImageStego] CryptoStego pre-load failed:', err);
        }).finally(() => {
            this._silentPreload = false;
            this._silentCryptoStegoPreload = false;
        });
    }

    _loadScript(src) {
        return new Promise((resolve, reject) => {
            const existing = document.querySelector(`script[src="${src}"]`);
            if (existing && existing.dataset.loaded) { resolve(); return; }
            if (existing) {
                // Script tag exists but didn't load properly — remove and retry
                existing.remove();
            }

            const script = document.createElement('script');
            script.src = src;
            script.onload = () => { script.dataset.loaded = '1'; resolve(); };
            script.onerror = () => reject(new Error('Failed to load: ' + src));
            document.head.appendChild(script);
        });
    }

    // ═══════════════════════════════════════════════════════════════
    //  MAIN ACTION (ENCODE / DECODE)
    // ═══════════════════════════════════════════════════════════════

    async _handleAction() {
        if (this.state._encoding) {
            this._showToast('Подождите завершения текущей операции…', 'warning');
            return;
        }

        if (this.state.direction === 'encode') {
            await this._handleEncode();
        } else {
            await this._handleDecode();
        }
    }

    // ─── ENCODE ─────────────────────────────────────────────────

    async _handleEncode() {
        const e = this._els;

        if (!this.state._originalImageEl) {
            this._showToast('Загрузите изображение', 'warning');
            return;
        }

        const password = this._getPassword();
        const algo = this.state.algorithm;

        // TextOverlay doesn't need secret data from input - uses secret text directly
        if (algo === 'text-overlay') {
            const text = this._els.secretText?.value || '';
            if (!text.trim()) {
                this._showToast('Введите текст для внедрения', 'warning');
                return;
            }
            this.state._encoding = true;
            try {
                await this._encodeTextOverlay(text);
            } catch (err) {
                console.error('Encode error:', err);
                this._showToast('Ошибка: ' + err.message, 'error');
            } finally {
                this.state._encoding = false;
                this._hideLoading();
            }
            return;
        }

        // ImageScrambler encrypts the image itself — no secret data needed
        if (algo === 'image-scrambler') {
            this.state._encoding = true;
            try {
                await this._encodeImageScrambler(password);
            } catch (err) {
                console.error('Encode error:', err);
                this._showToast('Ошибка кодирования: ' + err.message, 'error');
            } finally {
                this.state._encoding = false;
                this._hideLoading();
            }
            return;
        }

        const secretBytes = await this._getSecretData();
        if (!secretBytes || secretBytes.length === 0) {
            this._showToast('Введите сообщение или вложите файл', 'warning');
            return;
        }

        const cap = this._getCapacityBytes();
        if (secretBytes.length > cap) {
            this._showToast(
                `Сообщение слишком большое (${this._formatBytes(secretBytes.length)}) для ёмкости (${this._formatBytes(cap)})`,
                'error'
            );
            return;
        }

        this.state._encoding = true;

        try {
            if (algo === 'dct-qim') {
                await this._encodeDCTQIM(secretBytes, password);
            } else if (algo === 'dsss') {
                await this._encodeDSSS(secretBytes, password);
            } else if (algo === 'spectra-steg') {
                await this._encodeSpectraSteg(secretBytes, password);
            } else if (algo === 'cryptostego') {
                await this._encodeCryptoStego(secretBytes, password);
            } else {
                await this._encodePassLok(secretBytes, password);
            }
        } catch (err) {
            console.error('Encode error:', err);
            this._showToast('Ошибка кодирования: ' + err.message, 'error');
        } finally {
            this.state._encoding = false;
            this._hideLoading();
        }
    }

    async _getSecretData() {
        if (this.state._binaryFile) {
            return await this._getBinaryFileBytes();
        }
        const text = this._els.secretText?.value || '';
        if (!text) return null;
        return new TextEncoder().encode(text);
    }

    async _imageToJPEGBytes(img, quality = 0.95) {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext('2d').drawImage(img, 0, 0);
        const dataUrl = canvas.toDataURL('image/jpeg', quality);
        return this._dataURLToBytes(dataUrl);
    }

    _dataURLToBytes(dataUrl) {
        const base64 = dataUrl.split(',')[1];
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
    }

    _bytesToDataURL(bytes, type = 'image/jpeg') {
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return `data:${type};base64,` + btoa(binary);
    }

    // ─── CRYPTOSTEGO ENCODE ───────────────────────────────────

    async _encodeCryptoStego(secretBytes, password) {
        const loaded = await this._ensureCryptoStegoLoaded();
        this._showLoading('Кодирование (CryptoStego)…');

        if (!loaded) {
            throw new Error('CryptoStego не загружен');
        }

        const stego = this.state._cryptostegoModule;
        const canvas = this._els.hiddenCanvas;
        if (!canvas) throw new Error('Canvas не найден');

        const img = this.state._originalImageEl;
        const maxSize = this.CRYPTOSTEGO_MAX_SIZE;
        let w = img.naturalWidth;
        let h = img.naturalHeight;

        if (w > maxSize || h > maxSize) {
            if (w > h) { h = Math.round(h * maxSize / w); w = maxSize; }
            else { w = Math.round(w * maxSize / h); h = maxSize; }
        }

        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);

        // model_type: 0 = visual similarity, 1 = robustness
        const modelType = this.state.cryptoStegoSub === 'robust' ? 1 : 0;
        const msg = new TextDecoder().decode(secretBytes);

        this.state._cryptostegoModelType = modelType;

        const ok = await stego.writeMsgToCanvas('imgHiddenCanvas', msg, password, modelType, false);

        if (!ok) {
            throw new Error('Кодирование не удалось — проверьте сообщение и пароль');
        }

        const resultDataUrl = canvas.toDataURL('image/png');
        this.state._encodingAlgo = 'cryptostego';
        this._displayResultFromUrl(resultDataUrl);
        this._showToast('CryptoStego: сообщение закодировано', 'success');

        // Verify by reading back
        try {
            const verifyMsg = await stego.readMsgFromCanvas('imgHiddenCanvas', password, modelType);
            if (verifyMsg === msg) {
                this._showRoundtripBadge('success', 'Roundtrip OK');
            } else {
                this._showRoundtripBadge('warning', 'Кодирование OK, верификация: различаются данные');
            }
        } catch (e) {
            this._showRoundtripBadge('warning', 'Кодирование OK, верификация: ' + e.message);
        }
    }

    // ─── PASSLOK ENCODE ───────────────────────────────────────

    async _encodePassLok(secretBytes, password) {
        await this._ensurePassLokLoaded();
        this._showLoading('Кодирование (PassLok F5)…');

        const img = new Image();
        img.src = this.state._originalDataUrl;
        await new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = reject;
        });

        const pw = password || '';
        const isPng = this.state._originalDataUrl?.startsWith('data:image/png') || false;

        let resultDataUrl;

        try {
            if (isPng) {
                resultDataUrl = await encodePNG({
                    image: img, data: secretBytes, password: pw,
                    skipEncrypt: false, iterations: 1,
                });
            } else {
                resultDataUrl = await encodeJPG({
                    image: img, data: secretBytes, password: pw,
                    skipEncrypt: false, iterations: 1,
                });
            }
        } catch (err) {
            if (!isPng) throw err;
            console.warn('PassLok encode failed, retrying without noise:', err);
            const retryImg = new Image();
            retryImg.src = this.state._originalDataUrl;
            await new Promise((resolve, reject) => {
                retryImg.onload = resolve;
                retryImg.onerror = reject;
            });
            this._showLoading('Кодирование (PassLok F5, повтор)…');
            resultDataUrl = await encodePNG({
                image: retryImg, data: secretBytes, password: pw,
                skipEncrypt: true, iterations: 1,
            });
        }

        this.state._encodingAlgo = 'passlok';
        this.state._passlokEncodingFormat = isPng ? 'png' : 'jpg';
        this._displayResultFromUrl(resultDataUrl);
        this._showToast('PassLok F5: сообщение закодировано', 'success');
    }

    // ─── SPECTRASTEG ENCODE ───────────────────────────────────

    async _encodeSpectraSteg(secretBytes, password) {
        await this._ensureSpectraStegLoaded();
        this._showLoading('Кодирование (SpectraSteg)…');

        const alpha = parseInt(this._els.spectraAlpha?.value || '50', 10);
        const msg = new TextDecoder().decode(secretBytes);

        const img = this.state._originalImageEl;
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext('2d').drawImage(img, 0, 0);
        const imageData = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);

        const newImageData = await SpectraSteg.embedData(imageData, msg, { alpha, password });
        canvas.getContext('2d').putImageData(newImageData, 0, 0);

        const resultDataUrl = canvas.toDataURL('image/png');
        this.state._encodingAlgo = 'spectra-steg';
        this.state._spectraAlpha = alpha;
        this._displayResultFromUrl(resultDataUrl);
        this._showToast('SpectraSteg: сообщение закодировано', 'success');

        // Roundtrip verification
        try {
            const verifyImageData = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
            const verifyResult = await SpectraSteg.extractData(verifyImageData, { password });
            if (verifyResult === msg) {
                this._showRoundtripBadge('success', 'Roundtrip OK');
            } else {
                this._showRoundtripBadge('warning', 'Кодирование OK, верификация: различаются данные');
            }
        } catch (e) {
            this._showRoundtripBadge('warning', 'Кодирование OK, верификация: ' + e.message);
        }
    }

    // ─── DCT-QIM ENCODE ───────────────────────────────────

    async _encodeDCTQIM(secretBytes, password) {
        await this._ensureDCTQIMLoaded();
        this._showLoading('Кодирование (DCT-QIM)…');

        const robustness = this._els.dctQimRobustness?.value || 'medium';

        const img = this.state._originalImageEl;
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext('2d').drawImage(img, 0, 0);

        DCTQIM.encode(canvas, secretBytes, { robustness });

        const resultDataUrl = canvas.toDataURL('image/png');
        this.state._encodingAlgo = 'dct-qim';
        this.state._resultDataUrl = resultDataUrl;
        this.state._lastImageStegoDataUrl = resultDataUrl;
        this._displayResultFromUrl(resultDataUrl);
        this._showToast('DCT-QIM: сообщение закодировано', 'success');

        // Roundtrip verification
        try {
            const verifyCanvas = document.createElement('canvas');
            verifyCanvas.width = canvas.width;
            verifyCanvas.height = canvas.height;
            verifyCanvas.getContext('2d').drawImage(canvas, 0, 0);
            const extracted = DCTQIM.decode(verifyCanvas);
            if (extracted && this._arraysEqual(extracted, secretBytes)) {
                this._showRoundtripBadge('success', 'Roundtrip OK');
            } else {
                this._showRoundtripBadge('warning', 'Кодирование OK, верификация: различаются');
            }
        } catch (e) {
            this._showRoundtripBadge('warning', 'Кодирование OK, верификация: ' + e.message);
        }
    }

    // ─── DSSS ENCODE ─────────────────────────────────────

    async _encodeDSSS(secretBytes, password) {
        await this._ensureDSSSLoaded();
        this._showLoading('Кодирование (DSSS)…');

        if (!password) {
            throw new Error('DSSS требует пароль');
        }

        const spreadFactor = parseInt(this._els.dsssFactor?.value || '16', 10);

        const img = this.state._originalImageEl;
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext('2d').drawImage(img, 0, 0);

        DSSS.encode(canvas, secretBytes, password, { spreadFactor });

        const resultDataUrl = canvas.toDataURL('image/png');
        this.state._encodingAlgo = 'dsss';
        this.state._resultDataUrl = resultDataUrl;
        this.state._lastImageStegoDataUrl = resultDataUrl;
        this._displayResultFromUrl(resultDataUrl);
        this._showToast('DSSS: сообщение закодировано', 'success');

        // Roundtrip verification
        try {
            const verifyCanvas = document.createElement('canvas');
            verifyCanvas.width = canvas.width;
            verifyCanvas.height = canvas.height;
            verifyCanvas.getContext('2d').drawImage(canvas, 0, 0);
            const extracted = DSSS.decode(verifyCanvas, password, { spreadFactor });
            if (extracted && this._arraysEqual(extracted, secretBytes)) {
                this._showRoundtripBadge('success', 'Roundtrip OK');
            } else {
                this._showRoundtripBadge('warning', 'Кодирование OK, верификация: различаются');
            }
        } catch (e) {
            this._showRoundtripBadge('warning', 'Кодирование OK, верификация: ' + e.message);
        }
    }

    // ─── TEXT OVERLAY ENCODE ──────────────────────────────

    async _encodeTextOverlay(text) {
        await this._ensureTextOverlayLoaded();
        this._showLoading('Наложение текста…');

        const img = this.state._originalImageEl;
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext('2d').drawImage(img, 0, 0);

        // Read ALL settings from hidden inputs (synced by editor)
        const position = this._els.textOverlayPosition?.value || 'tile';
        const options = {
            fontSize: parseInt(this._els.textOverlaySize?.value || '24', 10),
            fontFamily: this._els.textOverlayFont?.value || 'Arial, sans-serif',
            color: this._els.textOverlayColor?.value || '#ffffff',
            opacity: parseInt(this._els.textOverlayOpacity?.value || '15', 10),
            position: position,
            rotation: parseInt(this._els.textOverlayRotation?.value || '0', 10),
            padding: 20,
            lineSpacing: parseFloat(this._els.textOverlayLineSpacing?.value || '1.4'),
        };

        // CRITICAL: Always include posX/posY — they are set by editor's drag callback
        // Use raw value from hidden input (default 10 only if truly empty)
        const posXRaw = this._els.textOverlayPosX?.value;
        const posYRaw = this._els.textOverlayPosY?.value;
        if (posXRaw !== undefined && posXRaw !== '') {
            options.posX = parseInt(posXRaw, 10) || 0;
        }
        if (posYRaw !== undefined && posYRaw !== '') {
            options.posY = parseInt(posYRaw, 10) || 0;
        }

        // When position is custom, ensure posX/posY are always present
        if (position === 'custom') {
            options.posX = options.posX ?? 10;
            options.posY = options.posY ?? 10;
        }

        // Apply distortion effects if any are active
        const distortion = this.state._textOverlayDistortion || {};
        const hasDistortion = distortion.waveAmplitude > 0 ||
            distortion.perLetterRotation > 0 ||
            distortion.perLetterSizeVariation > 0 ||
            distortion.perLetterSkewX > 0 ||
            distortion.noiseIntensity > 0 ||
            distortion.perLetterRandomOffset > 0 ||
            distortion.perLetterBoldRandom ||
            distortion.perLetterSpacingVariation > 0 ||
            distortion.randomColorPerLetter;

        // Include bubble preset if present in distortion state
        if (distortion.bubblePreset) {
            options.bubblePreset = distortion.bubblePreset;
        }
        if (distortion.bubbleBgColor) options.bubbleBgColor = distortion.bubbleBgColor;
        if (distortion.bubbleBorderRadius) options.bubbleBorderRadius = distortion.bubbleBorderRadius;
        if (distortion.bubblePadding) options.bubblePadding = distortion.bubblePadding;
        if (distortion.bubbleMaxWidth) options.bubbleMaxWidth = distortion.bubbleMaxWidth;
        if (distortion.bubbleAlign) options.bubbleAlign = distortion.bubbleAlign;
        if (distortion.bubbleTail !== undefined) options.bubbleTail = distortion.bubbleTail;

        const fullOptions = { ...options, ...distortion };

        // Choose rendering method
        if (fullOptions.bubblePreset && typeof TextOverlay.renderBubble === 'function') {
            // Bubble preset rendering
            TextOverlay.renderBubble(canvas, text, fullOptions);
        } else if (hasDistortion && typeof TextOverlay.renderWithEffects === 'function') {
            TextOverlay.renderWithEffects(canvas, text, fullOptions);
        } else {
            TextOverlay.render(canvas, text, fullOptions);
        }

        const resultDataUrl = canvas.toDataURL('image/png');
        this.state._encodingAlgo = 'text-overlay';
        this.state._resultDataUrl = resultDataUrl;
        this.state._lastImageStegoDataUrl = resultDataUrl;
        this._displayResultFromUrl(resultDataUrl);
        this._showToast('Text Overlay: текст наложен', 'success');
    }

    // ─── TEXT OVERLAY EDITOR ──────────────────────────────

    async _openTextOverlayEditor() {
        // Ensure TextOverlay library is loaded
        await this._ensureTextOverlayLoaded();

        // Verify TextOverlay is available
        if (typeof window.TextOverlay === 'undefined' || !window.TextOverlay.render) {
            console.error('TextOverlay library not available after loading');
            this._showToast('Библиотека TextOverlay не загружена', 'error');
            return;
        }

        // Load the editor class — prefer cached version, otherwise dynamic import
        let Editor = window.TextOverlayEditor;
        if (!Editor) {
            try {
                const mod = await import('/js/ui/text-overlay-editor.js');
                Editor = mod.TextOverlayEditor;
                window.TextOverlayEditor = Editor; // cache for next time
            } catch (err) {
                console.error('Failed to load TextOverlayEditor:', err);
                this._showToast('Не удалось загрузить редактор: ' + err.message, 'error');
                return;
            }
        }

        if (typeof Editor !== 'function') {
            console.error('TextOverlayEditor is not a constructor:', typeof Editor);
            this._showToast('Редактор не доступен', 'error');
            return;
        }

        const img = this.state._originalImageEl;
        const text = this._els.secretText?.value || '';

        if (!img) {
            this._showToast('Сначала загрузите изображение', 'warning');
            return;
        }

        // Build current options from UI
        const position = this._els.textOverlayPosition?.value || 'tile';
        const distortion = this.state._textOverlayDistortion || {};

        const currentOptions = {
            fontSize: parseInt(this._els.textOverlaySize?.value || '24', 10),
            fontFamily: this._els.textOverlayFont?.value || 'Arial, sans-serif',
            color: this._els.textOverlayColor?.value || '#ffffff',
            opacity: parseInt(this._els.textOverlayOpacity?.value || '15', 10),
            position: position,
            rotation: parseInt(this._els.textOverlayRotation?.value || '0', 10),
            padding: 20,
            lineSpacing: parseFloat(this._els.textOverlayLineSpacing?.value || '1.4'),
            posX: parseInt(this._els.textOverlayPosX?.value || '10', 10),
            posY: parseInt(this._els.textOverlayPosY?.value || '10', 10),
            // Include ALL distortion options (including bubblePreset if set)
            ...distortion,
        };

        // Create editor instance and open
        if (!this._textOverlayEditorInstance) {
            this._textOverlayEditorInstance = new Editor();
        }

        this._textOverlayEditorInstance.open(img, text, currentOptions, (newOptions) => {
            // Callback: apply editor settings back to UI
            this._applyEditorOptions(newOptions);
        });
    }

    _applyEditorOptions(options) {
        const e = this._els;

        // Sync basic settings back to the hidden inputs (used by encoder)
        if (e.textOverlayFont && options.fontFamily) e.textOverlayFont.value = options.fontFamily;
        if (e.textOverlaySize && options.fontSize) e.textOverlaySize.value = options.fontSize;
        if (e.textOverlayColor && options.color) e.textOverlayColor.value = options.color;
        if (e.textOverlayColorText && options.color) e.textOverlayColorText.value = options.color;
        if (e.textOverlayOpacity && options.opacity !== undefined) e.textOverlayOpacity.value = options.opacity;
        if (e.textOverlayPosition && options.position) e.textOverlayPosition.value = options.position;
        if (e.textOverlayRotation && options.rotation !== undefined) e.textOverlayRotation.value = options.rotation;
        if (e.textOverlayLineSpacing && options.lineSpacing) e.textOverlayLineSpacing.value = options.lineSpacing;
        if (e.textOverlayPosX && options.posX !== undefined) e.textOverlayPosX.value = Math.round(options.posX);
        if (e.textOverlayPosY && options.posY !== undefined) e.textOverlayPosY.value = Math.round(options.posY);

        // Update secret text if changed in editor (prefer _editorText from callback)
        const editorText = options._editorText || this._textOverlayEditorInstance?._text;
        if (e.secretText && editorText !== undefined) {
            e.secretText.value = editorText;
        }

        // Store distortion options (including bubble preset data)
        this.state._textOverlayDistortion = {
            randomColorPerLetter: !!options.randomColorPerLetter,
            waveAmplitude: options.waveAmplitude || 0,
            waveFrequency: options.waveFrequency || 1,
            perLetterRotation: options.perLetterRotation || 0,
            perLetterSizeVariation: options.perLetterSizeVariation || 0,
            perLetterSkewX: options.perLetterSkewX || 0,
            noiseIntensity: options.noiseIntensity || 0,
            perLetterRandomOffset: options.perLetterRandomOffset || 0,
            perLetterBoldRandom: !!options.perLetterBoldRandom,
            perLetterSpacingVariation: options.perLetterSpacingVariation || 0,
            // Bubble preset fields
            bubblePreset: options.bubblePreset || null,
            bubbleBgColor: options.bubbleBgColor || null,
            bubbleBorderColor: options.bubbleBorderColor || null,
            bubbleBorderRadius: options.bubbleBorderRadius || null,
            bubblePadding: options.bubblePadding || null,
            bubbleMaxWidth: options.bubbleMaxWidth || null,
            bubbleAlign: options.bubbleAlign || null,
            bubbleTail: options.bubbleTail !== undefined ? options.bubbleTail : true,
        };

        this._showToast('Настройки Text Overlay обновлены', 'success');
    }

    // ─── IMAGE SCRAMBLER ENCODE ──────────────────────────────

    async _encodeImageScrambler(password) {
        await this._ensureImageScramblerLoaded();
        this._showLoading('Шифрование изображения…');

        if (!password) throw new Error('ImageScrambler требует пароль');

        const img = this.state._originalImageEl;
        const safeMode = this.state._scramblerSafeMode !== false;

        const resultDataUrl = await ImageScrambler.processCryptoImage(img, {
            password,
            mode: 'encrypt',
            useMagicMarker: true,
            safeModeResize: safeMode,
        });

        this.state._encodingAlgo = 'image-scrambler';
        this._displayResultFromUrl(resultDataUrl);
        this._showToast('ImageScrambler: изображение зашифровано', 'success');
    }

    // ─── DECODE ───────────────────────────────────────────────

    async _handleDecode() {
        const e = this._els;

        if (!this.state._originalImageEl) {
            this._showToast('Загрузите стего-изображение', 'warning');
            return;
        }

        const password = this._getPassword();
        const decodeAlgo = e.decodeAlgorithmSelect?.value || 'auto';

        this.state._encoding = true;

        try {
            if (decodeAlgo === 'auto') {
                await this._autoDetectAndDecode(password);
            } else if (decodeAlgo === 'dct-qim') {
                await this._decodeDCTQIM();
            } else if (decodeAlgo === 'dsss') {
                await this._decodeDSSS(password);
            } else if (decodeAlgo === 'cryptostego') {
                await this._decodeCryptoStego(password);
            } else if (decodeAlgo === 'spectra-steg') {
                await this._decodeSpectraSteg(password);
            } else if (decodeAlgo === 'image-scrambler') {
                await this._decodeImageScrambler(password);
            } else {
                await this._decodePassLok(password);
            }
        } catch (err) {
            console.error('Decode error:', err);
            this._showToast('Ошибка декодирования: ' + err.message, 'error');
        } finally {
            this.state._encoding = false;
            this._hideLoading();
        }
    }

    // ─── AUTO-DETECT & DECODE ─────────────────────────────────

    async _autoDetectAndDecode(password) {
        this._showLoading('Автоопределение алгоритма…');

        const img = this.state._originalImageEl;
        const dataUrl = this.state._originalDataUrl;
        const pw = password || '';
        const errors = [];

        // Try PassLok decode (JPEG)
        if (dataUrl && !dataUrl.startsWith('data:image/png')) {
            try {
                await this._ensurePassLokLoaded();
                const result = await decodeJPG({ image: img, password: pw, iterations: 1 });
                const decoded = result.primary;
                if (decoded && decoded.length > 0) {
                    const text = new TextDecoder('utf-8', { fatal: false }).decode(decoded);
                    if (this._isValidDecodedText(text, decoded)) {
                        this._displayDecodedText(text, decoded);
                        this._showToast(`Автоопределение: PassLok JPEG`, 'success');
                        return;
                    }
                }
            } catch (err) {
                errors.push({ algo: 'PassLok JPEG', error: err.message });
            }
        }

        // Try PassLok decode (PNG)
        try {
            await this._ensurePassLokLoaded();
            const result = await decodePNG({ image: img, password: pw, iterations: 1 });
            const decoded = result.primary;
            if (decoded && decoded.length > 0) {
                const text = new TextDecoder('utf-8', { fatal: false }).decode(decoded);
                if (this._isValidDecodedText(text, decoded)) {
                    this._displayDecodedText(text, decoded);
                    this._showToast(`Автоопределение: PassLok PNG`, 'success');
                    return;
                }
            }
        } catch (err) {
            errors.push({ algo: 'PassLok PNG', error: err.message });
        }

        // Try CryptoStego
        try {
            const loaded = await this._ensureCryptoStegoLoaded();
            if (loaded) {
                const canvas = this._els.hiddenCanvas;
                const maxSize = this.CRYPTOSTEGO_MAX_SIZE;
                let w = img.naturalWidth;
                let h = img.naturalHeight;
                if (w > maxSize || h > maxSize) {
                    if (w > h) { h = Math.round(h * maxSize / w); w = maxSize; }
                    else { w = Math.round(w * maxSize / h); h = maxSize; }
                }
                canvas.width = w;
                canvas.height = h;
                canvas.getContext('2d').drawImage(img, 0, 0, w, h);

                const stego = this.state._cryptostegoModule;
                // Try visual model first, then robust
                for (const mt of [0, 1]) {
                    try {
                        const msg = await stego.readMsgFromCanvas('imgHiddenCanvas', pw, mt);
                        if (msg && msg.length > 0) {
                            this._displayDecodedText(msg);
                            this._showToast(`Автоопределение: CryptoStego (${mt === 0 ? 'Схожесть' : 'Устойчивый'})`, 'success');
                            return;
                        }
                    } catch (e) {
                        // try next model type
                    }
                }
            }
        } catch (err) {
            errors.push({ algo: 'CryptoStego', error: err.message });
        }

        // Try SpectraSteg
        try {
            await this._ensureSpectraStegLoaded();
            const specCanvas = document.createElement('canvas');
            specCanvas.width = img.naturalWidth;
            specCanvas.height = img.naturalHeight;
            specCanvas.getContext('2d').drawImage(img, 0, 0);
            const specImageData = specCanvas.getContext('2d').getImageData(0, 0, specCanvas.width, specCanvas.height);
            // Try with password first, then without
            for (const tryPw of [pw, '']) {
                const specResult = await SpectraSteg.extractData(specImageData, { password: tryPw });
                if (specResult && specResult.length > 0) {
                    this._displayDecodedText(specResult);
                    this._showToast('Автоопределение: SpectraSteg', 'success');
                    return;
                }
            }
        } catch (err) {
            errors.push({ algo: 'SpectraSteg', error: err.message });
        }

        // Try ImageScrambler (check for marker first)
        try {
            await this._ensureImageScramblerLoaded();
            if (ImageScrambler.hasCryptoMarker(img) && pw) {
                await this._decodeImageScrambler(pw);
                return;
            }
        } catch (err) {
            errors.push({ algo: 'ImageScrambler', error: err.message });
        }

        // Try DCT-QIM (no password needed, very robust header)
        try {
            await this._ensureDCTQIMLoaded();
            const dqCanvas = document.createElement('canvas');
            dqCanvas.width = img.naturalWidth;
            dqCanvas.height = img.naturalHeight;
            dqCanvas.getContext('2d').drawImage(img, 0, 0);
            const dqResult = DCTQIM.decode(dqCanvas);
            if (dqResult && dqResult.length > 0) {
                const text = new TextDecoder('utf-8', { fatal: false }).decode(dqResult);
                if (this._isValidDecodedText(text, dqResult)) {
                    this._displayDecodedText(text, dqResult);
                    this._showToast('Автоопределение: DCT-QIM', 'success');
                    return;
                }
            }
        } catch (err) {
            errors.push({ algo: 'DCT-QIM', error: err.message });
        }

        // Try DSSS (needs password)
        if (pw) {
            try {
                await this._ensureDSSSLoaded();
                const dsCanvas = document.createElement('canvas');
                dsCanvas.width = img.naturalWidth;
                dsCanvas.height = img.naturalHeight;
                dsCanvas.getContext('2d').drawImage(img, 0, 0);
                const dsResult = DSSS.decode(dsCanvas, pw);
                if (dsResult && dsResult.length > 0) {
                    const text = new TextDecoder('utf-8', { fatal: false }).decode(dsResult);
                    if (this._isValidDecodedText(text, dsResult)) {
                        this._displayDecodedText(text, dsResult);
                        this._showToast('Автоопределение: DSSS', 'success');
                        return;
                    }
                }
            } catch (err) {
                errors.push({ algo: 'DSSS', error: err.message });
            }
        }

        // Nothing worked
        const errList = errors.map(e => `${e.algo}: ${e.error.substring(0, 50)}`).join('\n');
        this._showToast('Не удалось определить алгоритм. Попробуйте указать вручную или проверьте пароль.', 'error');
        console.warn('[Auto-detect] All algorithms failed:\n' + errList);
    }

    _isValidDecodedText(text, rawBytes) {
        if (!text || text.length === 0) return false;
        // Check if text is mostly printable
        if (rawBytes && rawBytes.length > 0) {
            const printable = [...rawBytes].filter(b => b >= 32 && b <= 126 || b === 10 || b === 13 || b === 9 || b >= 128).length;
            if (printable / rawBytes.length < 0.6) return false;
        }
        // Check for excessive garbage characters
        const garbageCount = (text.match(/[\x00-\x08\x0E-\x1F]/g) || []).length;
        if (garbageCount / text.length > 0.3) return false;
        return true;
    }

    // ─── CRYPTOSTEGO DECODE ───────────────────────────────────

    async _decodeCryptoStego(password) {
        this._showLoading('Декодирование (CryptoStego)…');
        const loaded = await this._ensureCryptoStegoLoaded();

        if (!loaded) {
            throw new Error('CryptoStego не загружен');
        }

        const stego = this.state._cryptostegoModule;
        const canvas = this._els.hiddenCanvas;
        if (!canvas) throw new Error('Canvas не найден');

        const img = this.state._originalImageEl;
        const maxSize = this.CRYPTOSTEGO_MAX_SIZE;
        let w = img.naturalWidth;
        let h = img.naturalHeight;

        if (w > maxSize || h > maxSize) {
            if (w > h) { h = Math.round(h * maxSize / w); w = maxSize; }
            else { w = Math.round(w * maxSize / h); h = maxSize; }
        }

        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);

        // Use stored model_type from encoding, or current UI selection
        const modelType = this.state._cryptostegoModelType ?? (this.state.cryptoStegoSub === 'robust' ? 1 : 0);
        const msg = await stego.readMsgFromCanvas('imgHiddenCanvas', password, modelType);
        this._displayDecodedText(msg);
        this._showToast('CryptoStego: сообщение декодировано', 'success');
    }

    // ─── PASSLOK DECODE ──────────────────────────────────────

    async _decodePassLok(password) {
        this._showLoading('Декодирование (PassLok F5)…');
        await this._ensurePassLokLoaded();

        const img = this.state._originalImageEl;
        const pw = password || '';
        const isPng = this.state._originalDataUrl?.startsWith('data:image/png') || false;

        let result;
        if (isPng) {
            result = await decodePNG({ image: img, password: pw, iterations: 1 });
        } else {
            result = await decodeJPG({ image: img, password: pw, iterations: 1 });
        }

        const decoded = result.primary;
        if (!decoded || decoded.length === 0) {
            throw new Error('Неверный пароль или в изображении нет данных');
        }

        const text = new TextDecoder('utf-8', { fatal: false }).decode(decoded);
        this._displayDecodedText(text, decoded);
        this._showToast('PassLok F5: сообщение декодировано', 'success');
    }

    // ─── SPECTRASTEG DECODE ───────────────────────────────────

    async _decodeSpectraSteg(password) {
        this._showLoading('Декодирование (SpectraSteg)…');
        await this._ensureSpectraStegLoaded();

        const img = this.state._originalImageEl;
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext('2d').drawImage(img, 0, 0);
        const imageData = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);

        const result = await SpectraSteg.extractData(imageData, { password });
        if (!result) {
            throw new Error('Данные не найдены, неверный пароль или сильное искажение');
        }
        this._displayDecodedText(result);
        this._showToast('SpectraSteg: сообщение декодировано', 'success');
    }

    // ─── DCT-QIM DECODE ───────────────────────────────────

    async _decodeDCTQIM() {
        this._showLoading('Декодирование (DCT-QIM)…');
        await this._ensureDCTQIMLoaded();

        const img = this.state._originalImageEl;
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext('2d').drawImage(img, 0, 0);

        const extracted = DCTQIM.decode(canvas);
        if (!extracted || extracted.length === 0) {
            throw new Error('В изображении нет данных DCT-QIM');
        }

        const text = new TextDecoder('utf-8', { fatal: false }).decode(extracted);
        this._displayDecodedText(text, extracted);
        this._showToast('DCT-QIM: сообщение декодировано', 'success');
    }

    // ─── DSSS DECODE ──────────────────────────────────────

    async _decodeDSSS(password) {
        this._showLoading('Декодирование (DSSS)…');
        await this._ensureDSSSLoaded();

        if (!password) throw new Error('DSSS: пароль обязателен для декодирования');

        const spreadFactor = parseInt(this._els.dsssFactor?.value || '16', 10);
        const img = this.state._originalImageEl;
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext('2d').drawImage(img, 0, 0);

        const extracted = DSSS.decode(canvas, password, { spreadFactor });
        if (!extracted || extracted.length === 0) {
            throw new Error('Неверный пароль или в изображении нет данных DSSS');
        }

        const text = new TextDecoder('utf-8', { fatal: false }).decode(extracted);
        this._displayDecodedText(text, extracted);
        this._showToast('DSSS: сообщение декодировано', 'success');
    }

    // ─── IMAGE SCRAMBLER DECODE ──────────────────────────────

    async _decodeImageScrambler(password) {
        this._showLoading('Расшифровка изображения…');
        await this._ensureImageScramblerLoaded();

        if (!password) throw new Error('ImageScrambler требует пароль для расшифровки');

        const img = this.state._originalImageEl;
        const resultDataUrl = await ImageScrambler.processCryptoImage(img, {
            password,
            mode: 'decrypt',
        });

        this._displayResultFromUrl(resultDataUrl);
        this._showToast('ImageScrambler: изображение расшифровано', 'success');
    }

    // ═══════════════════════════════════════════════════════════════
    //  RESULT DISPLAY
    // ═══════════════════════════════════════════════════════════════

    _displayResultFromUrl(dataUrl) {
        this.state._lastImageStegoDataUrl = dataUrl;
        this.state._resultDataUrl = dataUrl;

        // Create blob
        fetch(dataUrl)
            .then(r => r.blob())
            .then(blob => {
                this.state._resultBlob = blob;
                this.state._lastImageStegoBlob = blob;
            })
            .catch(() => {});

        const e = this._els;
        if (e.resultSection) e.resultSection.style.display = '';

        // Draw original
        const origCanvas = e.resultOriginalCanvas;
        if (origCanvas && this.state._originalDataUrl) {
            const origImg = new Image();
            origImg.onload = () => {
                origCanvas.width = origImg.naturalWidth;
                origCanvas.height = origImg.naturalHeight;
                origCanvas.getContext('2d').drawImage(origImg, 0, 0);
            };
            origImg.src = this.state._originalDataUrl;
            if (e.resultOriginalWrapper) e.resultOriginalWrapper.style.display = '';
        }

        // Draw stego result
        const stegoCanvas = e.resultStegoCanvas;
        if (stegoCanvas) {
            const resultImg = new Image();
            resultImg.onload = () => {
                stegoCanvas.width = resultImg.naturalWidth;
                stegoCanvas.height = resultImg.naturalHeight;
                stegoCanvas.getContext('2d').drawImage(resultImg, 0, 0);
            };
            resultImg.src = dataUrl;
        }
    }

    _displayResult(dataUrl, sourceCanvas) {
        this._displayResultFromUrl(dataUrl);
    }

    _displayDecodedText(text, rawBytes) {
        const e = this._els;
        if (e.decodedResult) e.decodedResult.style.display = '';
        if (e.decodedText) e.decodedText.textContent = text;

        this._decodedRawBytes = null;
        if (rawBytes) {
            const printable = [...rawBytes].filter(b => b >= 32 && b <= 126 || b === 10 || b === 13 || b === 9).length;
            if (printable / rawBytes.length < 0.8) {
                this._decodedRawBytes = rawBytes;
                if (e.decodedFileSection) {
                    e.decodedFileSection.style.display = '';
                    if (e.decodedFileInfo) {
                        e.decodedFileInfo.textContent = `Файл: ${this._formatBytes(rawBytes.length)}`;
                    }
                }
            } else {
                if (e.decodedFileSection) e.decodedFileSection.style.display = 'none';
            }
        }
    }

    _clearResult() {
        const e = this._els;
        this.state._lastImageStegoDataUrl = null;
        this.state._lastImageStegoBlob = null;
        this.state._resultDataUrl = null;
        this.state._resultBlob = null;
        this.state._resultRawBytes = null;

        if (e.resultSection) e.resultSection.style.display = 'none';
        if (e.resultOriginalWrapper) e.resultOriginalWrapper.style.display = 'none';
        if (e.decodedResult) e.decodedResult.style.display = 'none';
        if (e.decodedText) e.decodedText.textContent = '';
        if (e.decodedFileSection) e.decodedFileSection.style.display = 'none';
        if (e.stressResults) e.stressResults.innerHTML = '';
        if (e.roundtripBadge) e.roundtripBadge.style.display = 'none';
    }

    // ═══════════════════════════════════════════════════════════════
    //  RESULT ACTIONS
    // ═══════════════════════════════════════════════════════════════

    _downloadResult() {
        if (this.state._resultDataUrl) {
            const link = document.createElement('a');
            link.download = 'stegonator-' + Date.now() + '.png';
            link.href = this.state._resultDataUrl;
            link.click();
        } else {
            this._showToast('Нет результата для скачивания', 'warning');
            return;
        }
        this._showToast('Изображение скачано', 'success');
    }

    async _copyResultToClipboard() {
        if (!this.state._resultBlob) {
            this._showToast('Нет результата для копирования', 'warning');
            return;
        }

        try {
            if (navigator.clipboard && window.ClipboardItem) {
                await navigator.clipboard.write([
                    new ClipboardItem({ 'image/png': this.state._resultBlob }),
                ]);
                this._showToast('Изображение скопировано в буфер', 'success');
            } else {
                await navigator.clipboard.writeText(this.state._resultDataUrl || '');
                this._showToast('Data URL скопирован', 'info');
            }
        } catch (err) {
            this._showToast('Не удалось скопировать: ' + err.message, 'error');
        }
    }

    _copyDecodedText() {
        const text = this._els.decodedText?.textContent || '';
        if (!text) {
            this._showToast('Нет текста для копирования', 'warning');
            return;
        }
        navigator.clipboard.writeText(text)
            .then(() => this._showToast('Текст скопирован', 'success'))
            .catch(() => this._showToast('Не удалось скопировать', 'error'));
    }

    _saveDecodedFile() {
        if (!this._decodedRawBytes) {
            this._showToast('Нет файла для сохранения', 'warning');
            return;
        }
        const blob = new Blob([this._decodedRawBytes]);
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.download = 'stegonator-file-' + Date.now();
        link.href = url;
        link.click();
        URL.revokeObjectURL(url);
        this._showToast('Файл сохранён', 'success');
    }

    // ═══════════════════════════════════════════════════════════════
    //  AUTO ROUNDTRIP VERIFICATION
    // ═══════════════════════════════════════════════════════════════

    _arraysEqual(a, b) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) return false;
        }
        return true;
    }

    _showRoundtripBadge(status, text) {
        const badge = this._els.roundtripBadge;
        if (!badge) return;
        badge.style.display = '';
        badge.textContent = text;
        badge.className = 'cm-imgstego-roundtrip-badge cm-imgstego-roundtrip-badge--' + status;
    }

    // ═══════════════════════════════════════════════════════════════
    //  STRESS TESTS (IMPROVED)
    // ═══════════════════════════════════════════════════════════════

    async _runIndividualStress(stressType) {
        const e = this._els;
        if (!this.state._resultDataUrl && !this.state._resultRawBytes) {
            this._showToast('Сначала закодируйте сообщение', 'warning');
            return;
        }

        // "Run All" button
        if (stressType === 'run-all') {
            await this._runAllStressTests();
            return;
        }

        const password = this._getPassword() || this.state._st3ggPassword || '';
        const algo = this.state._encodingAlgo || this.state.algorithm;

        const testMap = {
            'jpeg-95': { name: 'JPEG 95%', type: 'jpeg', quality: 0.95 },
            'jpeg-90': { name: 'JPEG 90%', type: 'jpeg', quality: 0.9 },
            'jpeg-75': { name: 'JPEG 75%', type: 'jpeg', quality: 0.75 },
            'jpeg-50': { name: 'JPEG 50%', type: 'jpeg', quality: 0.5 },
            'resize-50': { name: 'Рескейл 50%', type: 'resize', scale: 0.5 },
            'resize-75': { name: 'Рескейл 75%', type: 'resize', scale: 0.75 },
            'png-recompress': { name: 'PNG рекомпрессия', type: 'png-recode' },
            'crop-10': { name: 'Обрезка 10%', type: 'crop', cropPercent: 0.1 },
        };

        const test = testMap[stressType];
        if (!test) return;

        try {
            const result = await this._runSingleStressTest(test, password, algo);
            this._renderStressResults([{ ...test, ...result }]);
        } catch (err) {
            this._renderStressResults([{ ...test, success: false, error: err.message }]);
        }
    }

    async _runAllStressTests() {
        const e = this._els;
        if (e.stressResults) e.stressResults.innerHTML = '<div style="font-size:12px;color:var(--cm-text-muted)">Запуск всех тестов…</div>';

        let password = this._getPassword();
        // Use stored password from encoding if user password is empty (e.g. auto-generated)
        if (!password) {
            password = this.state._st3ggPassword || '';
        }
        const algo = this.state._encodingAlgo || this.state.algorithm;

        const tests = [
            { name: 'JPEG 95%', type: 'jpeg', quality: 0.95 },
            { name: 'JPEG 90%', type: 'jpeg', quality: 0.9 },
            { name: 'JPEG 75%', type: 'jpeg', quality: 0.75 },
            { name: 'JPEG 50%', type: 'jpeg', quality: 0.5 },
            { name: 'Рескейл 50%', type: 'resize', scale: 0.5 },
            { name: 'Рескейл 75%', type: 'resize', scale: 0.75 },
            { name: 'PNG рекомпрессия', type: 'png-recode' },
            { name: 'Обрезка 10%', type: 'crop', cropPercent: 0.1 },
        ];

        const results = [];
        for (const test of tests) {
            try {
                const result = await this._runSingleStressTest(test, password, algo);
                results.push({ ...test, ...result });
            } catch (err) {
                results.push({ ...test, success: false, error: err.message });
            }
        }

        this._renderStressResults(results, true);
    }

    async _runSingleStressTest(test, password, algo) {
        // Transform the result image
        const transformedBytes = await this._transformImage(this.state._resultDataUrl, this.state._resultRawBytes, test);

        if (!transformedBytes) {
            return { success: false, error: 'Transformation failed' };
        }

        let decoded = null;
        let usedAlgo = algo;

        try {
            if (algo === 'dct-qim') {
                await this._ensureDCTQIMLoaded();
                const dqImg = await this._bytesToImage(transformedBytes);
                const dqCanvas = document.createElement('canvas');
                dqCanvas.width = dqImg.naturalWidth;
                dqCanvas.height = dqImg.naturalHeight;
                dqCanvas.getContext('2d').drawImage(dqImg, 0, 0);
                try {
                    const dqResult = DCTQIM.decode(dqCanvas);
                    if (dqResult && dqResult.length > 0) {
                        decoded = new TextDecoder('utf-8', { fatal: false }).decode(dqResult);
                    }
                } catch (e) { /* decode failed */ }
            } else if (algo === 'dsss') {
                await this._ensureDSSSLoaded();
                if (password) {
                    const dsImg = await this._bytesToImage(transformedBytes);
                    const dsCanvas = document.createElement('canvas');
                    dsCanvas.width = dsImg.naturalWidth;
                    dsCanvas.height = dsImg.naturalHeight;
                    dsCanvas.getContext('2d').drawImage(dsImg, 0, 0);
                    try {
                        const dsResult = DSSS.decode(dsCanvas, password);
                        if (dsResult && dsResult.length > 0) decoded = new TextDecoder('utf-8', { fatal: false }).decode(dsResult);
                    } catch (e) { /* decode failed */ }
                }
            } else if (algo === 'cryptostego') {
                const stego = this.state._cryptostegoModule;
                if (!stego || !this.state._cryptostegoReady) {
                    return { success: false, error: 'CryptoStego не загружен' };
                }
                const img = await this._bytesToImage(transformedBytes);
                const canvas = this._els.hiddenCanvas;
                const maxSize = this.CRYPTOSTEGO_MAX_SIZE;
                let w = img.naturalWidth;
                let h = img.naturalHeight;
                if (w > maxSize || h > maxSize) {
                    if (w > h) { h = Math.round(h * maxSize / w); w = maxSize; }
                    else { w = Math.round(w * maxSize / h); h = maxSize; }
                }
                canvas.width = w;
                canvas.height = h;
                canvas.getContext('2d').drawImage(img, 0, 0, w, h);
                const csModelType = this.state._cryptostegoModelType ?? 0;
                decoded = await stego.readMsgFromCanvas('imgHiddenCanvas', password, csModelType);
            } else if (algo === 'spectra-steg') {
                await this._ensureSpectraStegLoaded();
                const specImg = await this._bytesToImage(transformedBytes);
                const specCanvas = document.createElement('canvas');
                specCanvas.width = specImg.naturalWidth;
                specCanvas.height = specImg.naturalHeight;
                specCanvas.getContext('2d').drawImage(specImg, 0, 0);
                const specImageData = specCanvas.getContext('2d').getImageData(0, 0, specCanvas.width, specCanvas.height);
                try {
                    const result = await SpectraSteg.extractData(specImageData, { password: password || '' });
                    if (result && result.length > 0) decoded = result;
                } catch (e) {
                    // extract failed
                }
            } else if (algo === 'image-scrambler') {
                // ImageScrambler can't be verified by text extraction
                // Just check if marker is still present
                await this._ensureImageScramblerLoaded();
                const scrImg = await this._bytesToImage(transformedBytes);
                if (ImageScrambler.hasCryptoMarker(scrImg)) {
                    decoded = '[marker-present]';
                }
            } else {
                // PassLok — use the format that was used during encoding, not the transformed format
                await this._ensurePassLokLoaded();
                const pw = password || '';
                const img = await this._bytesToImage(transformedBytes);
                const encodedFormat = this.state._passlokEncodingFormat || 'jpg';

                try {
                    let result;
                    if (encodedFormat === 'png') {
                        result = await decodePNG({ image: img, password: pw, iterations: 1 });
                    } else {
                        result = await decodeJPG({ image: img, password: pw, iterations: 1 });
                    }
                    decoded = result?.primary;
                    if (decoded) decoded = new TextDecoder('utf-8', { fatal: false }).decode(decoded);
                } catch (e) {
                    // decode failed
                }
            }
        } catch (err) {
            return { success: false, error: err.message };
        }

        const success = !!decoded && decoded.length > 0;
        const expected = this._getStressExpectation(algo, test);

        return {
            success,
            expected,
            decoded: success ? decoded.substring(0, 100) : null,
        };
    }

    _getStressExpectation(algo, test) {
        const expectations = this._stressExpectations[algo] || this._stressExpectations['passlok'];
        return expectations[test.type] || false;
    }

    _isJPEGBytes(bytes) {
        return bytes && bytes.length > 2 && bytes[0] === 0xFF && bytes[1] === 0xD8;
    }

    _isPNGBytes(bytes) {
        return bytes && bytes.length > 4 && bytes[0] === 0x89 && bytes[1] === 0x50;
    }

    async _bytesToImage(bytes) {
        const blob = new Blob([bytes]);
        const url = URL.createObjectURL(blob);
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
            img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image load failed')); };
            img.src = url;
        });
    }

    async _imageToJPEGBytesFromBytes(bytes, quality = 0.95) {
        const img = await this._bytesToImage(bytes);
        return this._imageToJPEGBytes(img, quality);
    }

    async _transformImage(dataUrl, rawBytes, test) {
        try {
            if (test.type === 'jpeg') {
                // JPEG recompression — for raw bytes (ST3GG), re-encode via canvas
                const img = await this._bytesToImage(rawBytes || this._dataURLToBytes(dataUrl));
                const canvas = document.createElement('canvas');
                canvas.width = img.naturalWidth;
                canvas.height = img.naturalHeight;
                canvas.getContext('2d').drawImage(img, 0, 0);
                const jpegDataUrl = canvas.toDataURL('image/jpeg', test.quality);
                return this._dataURLToBytes(jpegDataUrl);
            } else if (test.type === 'resize') {
                const bytes = rawBytes || this._dataURLToBytes(dataUrl);
                const img = await this._bytesToImage(bytes);
                const canvas = document.createElement('canvas');
                const scale = test.scale;
                canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
                canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
                canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
                // Output as JPEG to match the source format
                const resizedUrl = canvas.toDataURL('image/jpeg', 0.95);
                return this._dataURLToBytes(resizedUrl);
            } else if (test.type === 'png-recode') {
                const bytes = rawBytes || this._dataURLToBytes(dataUrl);
                const img = await this._bytesToImage(bytes);
                const canvas = document.createElement('canvas');
                canvas.width = img.naturalWidth;
                canvas.height = img.naturalHeight;
                canvas.getContext('2d').drawImage(img, 0, 0);
                const pngUrl = canvas.toDataURL('image/png');
                return this._dataURLToBytes(pngUrl);
            } else if (test.type === 'crop') {
                const bytes = rawBytes || this._dataURLToBytes(dataUrl);
                const img = await this._bytesToImage(bytes);
                const crop = test.cropPercent;
                const cropW = Math.round(img.naturalWidth * (1 - crop));
                const cropH = Math.round(img.naturalHeight * (1 - crop));
                const offsetX = Math.round(img.naturalWidth * crop / 2);
                const offsetY = Math.round(img.naturalHeight * crop / 2);
                const canvas = document.createElement('canvas');
                canvas.width = cropW;
                canvas.height = cropH;
                canvas.getContext('2d').drawImage(img, offsetX, offsetY, cropW, cropH, 0, 0, cropW, cropH);
                const cropUrl = canvas.toDataURL('image/jpeg', 0.95);
                return this._dataURLToBytes(cropUrl);
            } else {
                return null;
            }
        } catch (err) {
            console.error('Transform error:', err);
            return null;
        }
    }

    _renderStressResults(results, showSummary = false) {
        const container = this._els.stressResults;
        if (!container) return;

        let html = '<div style="display:flex;flex-wrap:wrap;gap:8px;">';

        let passCount = 0;
        let failExpected = 0;
        let failUnexpected = 0;

        for (const r of results) {
            const pass = r.success;
            const expected = r.expected;
            const isExpectedFail = !pass && (expected === false || expected === 'maybe');

            if (pass) passCount++;
            else if (isExpectedFail) failExpected++;
            else failUnexpected++;

            // Determine status class
            let statusClass, statusText;
            if (pass) {
                statusClass = 'cm-imgstego-stress-status--pass';
                statusText = 'OK';
            } else if (isExpectedFail) {
                statusClass = 'cm-imgstego-stress-status--expected-fail';
                statusText = expected === false ? 'ОЖИД.' : 'МОЖЕТ';
            } else {
                statusClass = 'cm-imgstego-stress-status--fail';
                statusText = 'FAIL';
            }

            const itemClass = isExpectedFail ? 'cm-imgstego-stress-item cm-imgstego-stress-item--expected-fail' : 'cm-imgstego-stress-item';

            html += `<div class="${itemClass}">
                <div style="display:flex;align-items:center;gap:4px;">
                    <svg class="cm-icon cm-icon--sm" style="color:${pass ? 'var(--cm-accent)' : isExpectedFail ? 'var(--cm-text-muted)' : 'var(--cm-danger)'}"><use href="#${pass ? 'icon-check' : 'icon-x'}"/></svg>
                    <span style="font-weight:600">${r.name}</span>
                </div>
                <span class="cm-imgstego-stress-status ${statusClass}">${statusText}${r.error && !isExpectedFail ? ' — ' + r.error : ''}</span>
            </div>`;
        }

        html += '</div>';

        if (showSummary) {
            html += `<div class="cm-imgstego-stress-summary">
                <strong>Итого:</strong> ${passCount} пройдено, ${failExpected} ожидаемый отказ, ${failUnexpected} неожидаемый отказ`;
                if (failUnexpected === 0 && passCount > 0) {
                    html += '<br><span style="color:var(--cm-accent)">Все критические тесты пройдены!</span>';
                } else if (failUnexpected > 0) {
                    html += '<br><span style="color:var(--cm-danger)">Есть неожиданные отказы — проверьте настройки.</span>';
                }
                const algoName = this.state._encodingAlgo || this.state.algorithm;
                if (algoName === 'dct-qim') {
                    html += '<br><span style="color:var(--cm-text-muted)">DCT-QIM устойчив к JPEG-перекодированию. Рескейл и обрезка разрушают данные.</span>';
                } else if (algoName === 'passlok') {
                    html += '<br><span style="color:var(--cm-text-muted)">PassLok LSB (PNG) не устойчив к JPEG. PassLok F5 (JPEG) может пережить перекодирование.</span>';
                }
            html += '</div>';
        }

        container.innerHTML = html;
    }

    // ═══════════════════════════════════════════════════════════════
    //  PUBLIC API: receive image from external source
    // ═══════════════════════════════════════════════════════════════

    receiveImageFromSearch(blobOrUrl) {
        const loadImage = (src) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => {
                this._setDirection('encode');
                this.state._originalImageEl = img;
                this.state._imageWidth = img.naturalWidth;
                this.state._imageHeight = img.naturalHeight;
                const tempCanvas = document.createElement('canvas');
                tempCanvas.width = img.naturalWidth;
                tempCanvas.height = img.naturalHeight;
                tempCanvas.getContext('2d').drawImage(img, 0, 0);
                const dataUrl = tempCanvas.toDataURL('image/png');
                this.state._originalDataUrl = dataUrl;
                this._renderImagePreview(img, dataUrl, 'encode');
                this._updateCapacity();
                this._toggleSearchPopup(false);
                this._showToast('Изображение загружено из поиска', 'success');
            };
            img.onerror = () => {
                this._showToast('Не удалось загрузить изображение из поиска', 'error');
            };
            img.src = src;
        };

        if (blobOrUrl instanceof Blob) {
            const reader = new FileReader();
            reader.onload = (ev) => loadImage(ev.target.result);
            reader.onerror = () => this._showToast('Не удалось прочитать файл', 'error');
            reader.readAsDataURL(blobOrUrl);
        } else if (typeof blobOrUrl === 'string') {
            loadImage(blobOrUrl);
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  IMAGE SEARCH POPUP
    // ═══════════════════════════════════════════════════════════════

    _toggleSearchPopup(show) {
        const popup = this._els.searchPopup;
        const backdrop = this._els.searchBackdrop;
        if (!popup || !backdrop) return;

        const shouldOpen = typeof show === 'boolean' ? show : !popup.classList.contains('open');

        if (shouldOpen) {
            popup.style.display = '';
            requestAnimationFrame(() => {
                popup.classList.add('open');
                backdrop.classList.add('open');
            });
        } else {
            popup.classList.remove('open');
            backdrop.classList.remove('open');
            setTimeout(() => { popup.style.display = 'none'; }, 260);
        }
    }

    async _loadImageFromUrl(url) {
        try {
            this._showToast('Загрузка изображения…', 'info');
            const response = await fetch(url);
            if (!response.ok) throw new Error('HTTP ' + response.status);
            const blob = await response.blob();
            if (!blob.type.startsWith('image/')) throw new Error('URL не является изображением');
            const file = new File([blob], 'image.' + blob.type.split('/')[1] || 'png', { type: blob.type });
            this._loadImageFile(file, 'encode');
        } catch (err) {
            console.error('Load image from URL error:', err);
            this._showToast('Не удалось загрузить: ' + err.message, 'error');
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  HELPERS
    // ═══════════════════════════════════════════════════════════════

    _showToast(message, type = 'info') {
        if (typeof showToast === 'function') {
            showToast(message, type);
        }
    }

    _formatBytes(bytes) {
        if (bytes === 0) return '0 Б';
        const units = ['Б', 'КБ', 'МБ', 'ГБ'];
        const k = 1024;
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        const val = (bytes / Math.pow(k, i)).toFixed(i > 0 ? 1 : 0);
        return val + ' ' + units[i];
    }

    // ═══════════════════════════════════════════════════════════════
    //  CLIPBOARD PASTE (Ctrl+V)
    // ═══════════════════════════════════════════════════════════════

    _handleClipboardPaste(ev) {
        const panel = this._root;
        if (!panel || panel.style.display === 'none') return;
        const items = ev.clipboardData?.items;
        if (!items) return;
        for (const item of items) {
            if (item.type.startsWith('image/')) {
                ev.preventDefault();
                const file = item.getAsFile();
                if (file) {
                    const mode = this.state.direction || 'encode';
                    this._loadImageFile(file, mode);
                    this._showToast('Изображение вставлено из буфера обмена', 'success');
                }
                return;
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  TEXT OVERLAY REVEAL
    // ═══════════════════════════════════════════════════════════════

    async _revealTextOverlay() {
        const img = this.state._originalImageEl;
        if (!img) {
            this._showToast('Загрузите изображение', 'warning');
            return;
        }
        await this._ensureTextOverlayLoaded();
        this._showLoading('Усиление видимости текста…');
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext('2d').drawImage(img, 0, 0);
        TextOverlay.reveal(canvas);
        const resultDataUrl = canvas.toDataURL('image/png');
        this._displayResultFromUrl(resultDataUrl);
        this._showToast('Text Overlay: видимость текста усилена', 'success');
        this._hideLoading();
    }

    // ═══════════════════════════════════════════════════════════════
    //  BACKGROUND GENERATOR (for text-overlay when no carrier image)
    // ═══════════════════════════════════════════════════════════════

    async _generateBackground(type) {
        await this._ensureTextOverlayLoaded();

        const W = 800, H = 600;
        const canvas = document.createElement('canvas');
        canvas.width = W;
        canvas.height = H;
        const ctx = canvas.getContext('2d');

        if (type.startsWith('bubble-')) {
            // ── Bubble preset: create messenger screenshot background (NO text) ──
            const presetName = type.replace('bubble-', ''); // telegram, whatsapp, etc.
            const presets = TextOverlay.BUBBLE_PRESETS || {};
            const preset = presets[presetName];
            if (!preset) {
                this._showToast(`Неизвестный пресет: ${presetName}`, 'error');
                return;
            }

            // Create messenger screenshot UI (header, background, avatar — NO text, NO bubble)
            if (typeof TextOverlay.renderMessengerScreenshot === 'function') {
                TextOverlay.renderMessengerScreenshot(canvas, presetName);
            } else {
                // Fallback: simple colored background
                const bgColors = {
                    telegram: '#0E1621', whatsapp: '#0B141A', imessage: '#F2F2F7',
                    discord: '#313338', sms: '#F2F2F7',
                };
                ctx.fillStyle = bgColors[presetName] || '#1a1a2e';
                ctx.fillRect(0, 0, W, H);
            }

            const dataUrl = canvas.toDataURL('image/png');

            // Store bubblePreset in distortion state so encoder and editor know to use bubble mode
            this.state._textOverlayDistortion = {
                ...this.state._textOverlayDistortion,
                bubblePreset: presetName,
                // Apply preset styling from BUBBLE_PRESETS so encoder uses correct colors
                bubbleBgColor: preset.bubbleBgColor,
                bubbleBorderRadius: preset.bubbleBorderRadius,
                bubblePadding: preset.bubblePadding,
                bubbleMaxWidth: preset.bubbleMaxWidth,
                bubbleAlign: preset.bubbleAlign,
                bubbleTail: preset.bubbleTail,
                // Set text color/font/size from preset for consistent look
                color: preset.color,
                fontFamily: preset.fontFamily,
                fontSize: 44,
                lineSpacing: preset.lineSpacing,
                opacity: preset.opacity,
            };

            // Also update the hidden UI inputs so the editor reflects preset styling
            if (this._els.textOverlayColor) this._els.textOverlayColor.value = preset.color || '#ffffff';
            if (this._els.textOverlayColorText) this._els.textOverlayColorText.value = preset.color || '#ffffff';
            if (this._els.textOverlayFont) this._els.textOverlayFont.value = preset.fontFamily || 'Arial, sans-serif';
            if (this._els.textOverlaySize) this._els.textOverlaySize.value = 44;
            if (this._els.textOverlayOpacity) this._els.textOverlayOpacity.value = preset.opacity || 100;
            if (this._els.textOverlayOpacityVal) this._els.textOverlayOpacityVal.textContent = preset.opacity || 100;
            if (this._els.textOverlayLineSpacing) this._els.textOverlayLineSpacing.value = preset.lineSpacing || 1.35;

            this._setGeneratedImage(dataUrl, W, H);
            // For bubble backgrounds, use center position
            if (this._els.textOverlayPosition) this._els.textOverlayPosition.value = 'center';
            this._showToast(`Подложка «${presetName.charAt(0).toUpperCase() + presetName.slice(1)}» создана`, 'success');

            // Auto-open editor so user can type text and adjust filters
            setTimeout(() => this._openTextOverlayEditor(), 300);

        } else if (type.startsWith('noise-')) {
            // ── Noise background generator ──
            const noiseType = type.replace('noise-', ''); // gaussian, uniform, salt

            // Dark background base
            ctx.fillStyle = '#1a1a2e';
            ctx.fillRect(0, 0, W, H);

            // Generate noise pattern
            const imageData = ctx.getImageData(0, 0, W, H);
            const data = imageData.data;

            if (noiseType === 'gaussian') {
                // Gaussian noise using Box-Muller transform
                for (let i = 0; i < data.length; i += 4) {
                    const u1 = Math.random();
                    const u2 = Math.random();
                    const z0 = Math.sqrt(-2 * Math.log(Math.max(u1, 1e-10))) * Math.cos(2 * Math.PI * u2);
                    const noise = z0 * 40; // std dev = 40
                    data[i]     = Math.max(0, Math.min(255, 26 + noise)); // R
                    data[i + 1] = Math.max(0, Math.min(255, 26 + noise)); // G
                    data[i + 2] = Math.max(0, Math.min(255, 46 + noise)); // B
                    data[i + 3] = 255;
                }
            } else if (noiseType === 'uniform') {
                // Uniform random noise
                for (let i = 0; i < data.length; i += 4) {
                    const noise = Math.random() * 80 - 40;
                    data[i]     = Math.max(0, Math.min(255, 40 + noise));
                    data[i + 1] = Math.max(0, Math.min(255, 40 + noise));
                    data[i + 2] = Math.max(0, Math.min(255, 55 + noise));
                    data[i + 3] = 255;
                }
            } else if (noiseType === 'salt') {
                // Salt & pepper noise
                for (let i = 0; i < data.length; i += 4) {
                    const r = Math.random();
                    if (r < 0.03) {
                        // Salt (white)
                        data[i] = data[i + 1] = data[i + 2] = 220;
                    } else if (r < 0.06) {
                        // Pepper (black)
                        data[i] = data[i + 1] = data[i + 2] = 10;
                    } else {
                        // Normal dark pixel with slight variation
                        const noise = Math.random() * 20 - 10;
                        data[i]     = Math.max(0, Math.min(255, 30 + noise));
                        data[i + 1] = Math.max(0, Math.min(255, 30 + noise));
                        data[i + 2] = Math.max(0, Math.min(255, 45 + noise));
                    }
                    data[i + 3] = 255;
                }
            }

            ctx.putImageData(imageData, 0, 0);

            const dataUrl = canvas.toDataURL('image/png');

            // Clear any bubble preset from state (noise is not a bubble)
            this.state._textOverlayDistortion = {
                ...this.state._textOverlayDistortion,
                bubblePreset: null,
                bubbleBgColor: null,
                bubbleBorderRadius: null,
                bubblePadding: null,
                bubbleMaxWidth: null,
                bubbleAlign: null,
                bubbleTail: true,
            };

            this._setGeneratedImage(dataUrl, W, H);
            // For noise backgrounds, use center position (tile mode makes drag difficult)
            if (this._els.textOverlayPosition) this._els.textOverlayPosition.value = 'center';
            this._showToast(`Шумовая подложка (${noiseType}) создана`, 'success');

            // Auto-open editor
            setTimeout(() => this._openTextOverlayEditor(), 300);
        }
    }

    /**
     * Add subtle texture to background to make it look like a messenger screenshot.
     */
    _addBackgroundTexture(ctx, w, h, baseColor) {
        // Parse base color brightness
        ctx.save();
        ctx.globalAlpha = 0.03;

        // Add subtle diagonal lines
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1;
        for (let i = -h; i < w + h; i += 4) {
            ctx.beginPath();
            ctx.moveTo(i, 0);
            ctx.lineTo(i - h, h);
            ctx.stroke();
        }

        // Add some random dim circles for texture
        ctx.globalAlpha = 0.02;
        ctx.fillStyle = '#ffffff';
        for (let i = 0; i < 30; i++) {
            const cx = Math.random() * w;
            const cy = Math.random() * h;
            const r = Math.random() * 100 + 30;
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.fill();
        }

        ctx.restore();
    }

    /**
     * Set a generated image as the carrier image for text-overlay encoding.
     */
    _setGeneratedImage(dataUrl, w, h) {
        const img = new Image();
        img.onload = () => {
            this.state._originalImageEl = img;
            this.state._originalDataUrl = dataUrl;
            this.state._imageWidth = w;
            this.state._imageHeight = h;
            this._renderImagePreview(img, dataUrl, 'encode');
            this._updateCapacity();
        };
        img.src = dataUrl;
    }

    // ═══════════════════════════════════════════════════════════════
    //  RANDOM GENERATE QUICK BUTTON
    // ═══════════════════════════════════════════════════════════════

    /**
     * Quick API generate: calls the server API to get a ready OCR-resistant image.
     * No carrier image needed — just text input.
     */
    async _handleQuickApiGenerate() {
        const text = this._els.secretText?.value?.trim();
        if (!text) {
            this._showToast('Введите текст для быстрой генерации', 'warning');
            return;
        }

        this._showLoading('Генерация изображения…');

        try {
            // Use client-side generation (no server API call)
            const result = await this._quickGenerate(text, {
                width: 800,
                height: 600,
            });

            if (!result || !result.dataUrl) {
                throw new Error('Generation returned no image');
            }

            // Convert data URL to image element and set as carrier
            const img = new Image();
            img.onload = () => {
                const W = img.naturalWidth;
                const H = img.naturalHeight;

                this.state._originalImageEl = img;
                this.state._originalDataUrl = result.dataUrl;
                this.state._imageWidth = W;
                this.state._imageHeight = H;

                // Also store as last result for FAB/external use
                if (window.StegonatorAPI) {
                    // Access via StegonatorAPI to check it's valid, store result
                    try { state._lastImageStegoDataUrl = result.dataUrl; } catch { /* ignore */ }
                }

                // Draw on canvas
                const canvas = this._els.canvas;
                if (canvas) {
                    canvas.width = W;
                    canvas.height = H;
                    canvas.getContext('2d').drawImage(img, 0, 0);
                    canvas.style.display = '';
                }
                if (this._els.imageInfo) {
                    const sizeKB = Math.round(result.dataUrl.length * 3 / 4 / 1024);
                    this._els.imageInfo.textContent = `${W} × ${H} px ≈ ${sizeKB} КБ`;
                    this._els.imageInfo.style.display = '';
                }
                this._els.dropZone?.classList.add('has-image');
                if (this._els.encodeBtn) this._els.encodeBtn.disabled = false;

                this._updateCapacity();
                _updateFabState();
                this._showToast('OCR-устойчивое изображение сгенерировано', 'success');
            };
            img.onerror = () => {
                this._showToast('Ошибка отображения изображения', 'error');
            };
            img.src = result.dataUrl;
        } catch (err) {
            this._showToast('Ошибка генерации: ' + (err.message || err), 'error');
        } finally {
            this._hideLoading();
        }
    }

    async _handleRandomGenerate() {
        await this._ensureTextOverlayLoaded();

        const hasImage = !!this.state._originalImageEl;
        const text = this._els.secretText?.value?.trim();

        if (hasImage && text) {
            // ── WITH carrier image + text: apply random captcha-like distortion ──
            this._showLoading('Генерация случайных искажений…');

            // Generate random distortion parameters (captcha-like)
            const randomDistortion = {
                randomColorPerLetter: Math.random() > 0.5,
                waveAmplitude: Math.round((Math.random() * 5 + 1) * 10) / 10,   // 1-6 px
                waveFrequency: Math.round((Math.random() * 2 + 0.5) * 10) / 10, // 0.5-2.5
                perLetterRotation: Math.floor(Math.random() * 20 + 5),           // 5-25°
                perLetterSizeVariation: Math.floor(Math.random() * 8 + 2),        // 2-10 px
                perLetterSkewX: Math.round((Math.random() * 0.3 + 0.05) * 100) / 100, // 0.05-0.35
                noiseIntensity: Math.floor(Math.random() * 15 + 5),              // 5-20
                perLetterRandomOffset: Math.floor(Math.random() * 8 + 2),        // 2-10 px
                perLetterBoldRandom: Math.random() > 0.6,
                perLetterSpacingVariation: Math.floor(Math.random() * 5 + 1),    // 1-6 px
                bubblePreset: null,
            };

            // Also randomize font and color
            const fonts = ['Arial, sans-serif', 'Georgia, serif', 'Courier New, monospace',
                           'Impact, sans-serif', 'Verdana, sans-serif', 'Tahoma, sans-serif'];
            const colors = ['#ffffff', '#e0e0e0', '#c0c0c0', '#ffcc00', '#ff6666',
                           '#66ff66', '#66ccff', '#ff99cc', '#ccccff'];
            const randomFont = fonts[Math.floor(Math.random() * fonts.length)];
            const randomColor = colors[Math.floor(Math.random() * colors.length)];
            const randomOpacity = Math.floor(Math.random() * 25 + 10); // 10-35%
            const positions = ['center', 'tile', 'top', 'bottom'];
            const randomPos = positions[Math.floor(Math.random() * positions.length)];

            // Store the random settings
            this.state._textOverlayDistortion = randomDistortion;

            // Update hidden inputs
            if (this._els.textOverlayFont) this._els.textOverlayFont.value = randomFont;
            if (this._els.textOverlayColor) this._els.textOverlayColor.value = randomColor;
            if (this._els.textOverlayColorText) this._els.textOverlayColorText.value = randomColor;
            if (this._els.textOverlaySize) this._els.textOverlaySize.value = Math.floor(Math.random() * 20 + 16); // 16-36
            if (this._els.textOverlayOpacity) this._els.textOverlayOpacity.value = randomOpacity;
            if (this._els.textOverlayPosition) this._els.textOverlayPosition.value = randomPos;

            try {
                await this._encodeTextOverlay(text);
                this._showToast('Случайные искажения + кодирование выполнены', 'success');
            } catch (err) {
                this._showToast('Ошибка: ' + err.message, 'error');
            } finally {
                this._hideLoading();
            }

        } else if (!hasImage) {
            // ── WITHOUT carrier image: random bubble preset + light deformation ──
            const bubbleTypes = ['telegram', 'whatsapp', 'imessage', 'discord', 'sms'];
            const randomBubble = bubbleTypes[Math.floor(Math.random() * bubbleTypes.length)];

            // Set text if empty
            if (!text) {
                const defaultTexts = [
                    'Привет! Как дела?',
                    'Секретное сообщение.',
                    'Встретимся в 18:00 у входа.',
                    'Это зашифрованное сообщение. Прочти внимательно.',
                    'Документы готовы. Проверь почту.',
                ];
                if (this._els.secretText) {
                    this._els.secretText.value = defaultTexts[Math.floor(Math.random() * defaultTexts.length)];
                }
            }

            // Generate the bubble background
            await this._generateBackground(`bubble-${randomBubble}`);

        } else {
            // Has image but no text
            this._showToast('Введите текст для генерации', 'warning');
        }
    }

    /**
     * Quick API-like generation: create an OCR-resistant image from text.
     * Generates a random bubble background, applies light distortion,
     * renders text, and returns the result as dataURL.
     * Used by the quick API endpoint and the "Quick Generate" button.
     */
    async _quickGenerate(text, options = {}) {
        await this._ensureTextOverlayLoaded();

        if (!text || text.trim().length === 0) {
            throw new Error('No text provided');
        }

        const W = options.width || 800;
        const H = options.height || 600;
        const bubbleTypes = ['telegram', 'whatsapp', 'imessage', 'discord', 'sms'];
        const bubbleType = options.bubbleType || bubbleTypes[Math.floor(Math.random() * bubbleTypes.length)];

        // Create canvas
        const canvas = document.createElement('canvas');
        canvas.width = W;
        canvas.height = H;

        // Draw messenger screenshot background
        if (typeof TextOverlay.renderMessengerScreenshot === 'function') {
            TextOverlay.renderMessengerScreenshot(canvas, bubbleType);
        }

        // Get preset for text styling
        const presets = TextOverlay.BUBBLE_PRESETS || {};
        const preset = presets[bubbleType] || presets.telegram;

        // Light captcha-like distortion for OCR resistance
        const distortion = {
            bubblePreset: bubbleType,
            bubbleBgColor: preset.bubbleBgColor,
            bubbleBorderRadius: preset.bubbleBorderRadius,
            bubblePadding: preset.bubblePadding,
            bubbleMaxWidth: preset.bubbleMaxWidth,
            bubbleAlign: preset.bubbleAlign,
            bubbleTail: preset.bubbleTail,
            // Override text settings with larger font
            fontSize: 44,
            color: preset.color,
            fontFamily: preset.fontFamily,
            lineSpacing: preset.lineSpacing || 1.35,
            opacity: 100,
            // Light distortion for OCR resistance
            waveAmplitude: options.waveAmplitude || 2,
            waveFrequency: options.waveFrequency || 1.5,
            perLetterRotation: options.perLetterRotation || 5,
            perLetterSizeVariation: options.perLetterSizeVariation || 3,
            perLetterSkewX: options.perLetterSkewX || 0.1,
            perLetterRandomOffset: options.perLetterRandomOffset || 2,
            perLetterSpacingVariation: options.perLetterSpacingVariation || 2,
            randomColorPerLetter: false,
            perLetterBoldRandom: false,
            noiseIntensity: options.noiseIntensity || 0,
            position: 'center',
            padding: 20,
        };

        // Render bubble with text
        TextOverlay.renderBubble(canvas, text, distortion);

        const dataUrl = canvas.toDataURL('image/png');
        return { dataUrl, width: W, height: H, bubbleType };
    }
}

export default ImageStegoUI;
