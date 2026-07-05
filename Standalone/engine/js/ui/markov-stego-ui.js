/**
 * Markov Text Steganography UI Module — Стегонатор
 *
 * Provides a UI for hiding messages inside natural-looking text generated
 * by a Markov chain n-gram model. The hidden data is encoded via arithmetic
 * coding using word selection probabilities.
 *
 * Features:
 *   - Load corpus from .zip archives (using JSZip)
 *   - Load/save precompiled models (.json) to disk and localStorage
 *   - Async corpus processing with progress bar
 *   - Encode: secret message → stego text (looks like natural language)
 *   - Decode: stego text → extracted hidden message
 *   - Multiple named corpora management
 *   - Automatic corpus identification during decoding
 *
 * Exported: MarkovStegoUI class with init() method.
 * Global deps: window.MarkovTextStego (markov-text-stego.js), showToast(msg, type)
 * Optional: JSZip (loaded dynamically from CDN when needed)
 */

export class MarkovStegoUI {

    // ═══════════════════════════════════════════════════════════════
    //  CONSTANTS
    // ═══════════════════════════════════════════════════════════════

    static get JSZIP_CDN() {
        return 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
    }

    static get STORAGE_PREFIX() {
        return 'markov_model_';
    }

    static get STORAGE_SIZE_LIMIT() {
        return 5 * 1024 * 1024; // 5 MB
    }

    static get STORAGE_WARN_THRESHOLD() {
        return 0.8; // warn when > 80% used
    }

    // ═══════════════════════════════════════════════════════════════
    //  CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════

    constructor() {
        // ── Internal state ────────────────────────────────────
        /** @type {Object<string, {model: NGramModel, codec: Codec, corpusSize: number, n: number}>} */
        this._models = {};
        /** @type {string|null} Name of the currently selected corpus */
        this._currentCorpus = null;
        /** @type {boolean} */
        this._encoding = false;
        /** @type {boolean} */
        this._decoding = false;
        /** @type {boolean} */
        this._jszipLoaded = false;
        /** @type {Promise|null} Pending JSZip load */
        this._jszipLoadPromise = null;

        // ── DOM references ────────────────────────────────────
        this._els = {};
        this._root = null;
    }

    // ═══════════════════════════════════════════════════════════════
    //  PUBLIC API
    // ═══════════════════════════════════════════════════════════════

    init() {
        this._cacheDom();
        this._bindEvents();
        this._loadFromLocalStorage();
        this._updateCorpusSelect();
        this._updateCorpusList();
        this._updateCorpusInfo();
        this._setDirection('encode');
    }

    // ═══════════════════════════════════════════════════════════════
    //  DOM CACHING
    // ═══════════════════════════════════════════════════════════════

    _cacheDom() {
        const $ = (sel) => document.querySelector(sel);
        this._root = $('#panelMarkovStego');
        if (!this._root) {
            console.warn('MarkovStegoUI: #panelMarkovStego не найден в DOM');
            return;
        }

        // Tab / subtabs (outside panel, so query from document)
        this._els.subtabsMarkov = document.querySelector('[data-category-subtabs="markov"]');

        // Encode section
        this._els.encodeSection = $('#markovEncodeSection');
        this._els.secretInput = $('#markovSecretInput');
        this._els.corpusSelect = $('#markovCorpusSelect');
        this._els.loadCorpusBtn = $('#markovLoadCorpusBtn');
        this._els.loadPrecompiledBtn = this._root.querySelector('[data-action="load-precompiled"]');
        this._els.saveModelBtn = this._root.querySelector('[data-action="save-model"]');
        this._els.nGramOrder = $('#markovNGramOrder');
        this._els.encodeBtn = $('#markovEncodeBtn');
        this._els.encodeProgress = $('#markovEncodeProgress');
        this._els.encodeProgressText = $('#markovEncodeProgressText');
        this._els.encodeResult = $('#markovEncodeResult');
        this._els.encodeCopyBtn = this._root.querySelector('[data-action="copy-encode-result"]');
        this._els.corpusInfo = $('#markovCorpusInfo');
        this._els.corpusList = $('#markovCorpusList');
        this._els.unloadCorpusBtn = $('#markovUnloadCorpusBtn');

        // Decode section
        this._els.decodeSection = $('#markovDecodeSection');
        this._els.decodeInput = $('#markovDecodeInput');
        this._els.decodeCorpusSelect = $('#markovDecodeCorpusSelect');
        this._els.decodeBtn = $('#markovDecodeBtn');
        this._els.decodeResult = $('#markovDecodeResult');
        this._els.decodeProgress = $('#markovDecodeProgress');
        this._els.decodeCopyBtn = this._root.querySelector('[data-action="copy-decode-result"]');

        // Hidden file inputs (created dynamically)
        this._els.zipFileInput = null;
        this._els.jsonFileInput = null;
        this._els.saveJsonInput = null;

        // Subtab buttons (encode / decode) — outside panel, query from document
        this._els.subtabEncode = document.querySelector('[data-mode="markov-encode"]');
        this._els.subtabDecode = document.querySelector('[data-mode="markov-decode"]');
    }

    // ═══════════════════════════════════════════════════════════════
    //  EVENT BINDING
    // ═══════════════════════════════════════════════════════════════

    _bindEvents() {
        const e = this._els;

        // ── Subtabs: encode / decode ──────────────────────────
        e.subtabEncode?.addEventListener('click', () => this._setDirection('encode'));
        e.subtabDecode?.addEventListener('click', () => this._setDirection('decode'));

        // Also handle subtab buttons inside subtabsMarkov container
        e.subtabsMarkov?.querySelectorAll('[data-mode]').forEach(btn => {
            btn.addEventListener('click', () => {
                const mode = btn.dataset.mode;
                if (mode === 'markov-encode') this._setDirection('encode');
                else if (mode === 'markov-decode') this._setDirection('decode');
            });
        });

        // ── Corpus management ────────────────────────────────
        e.corpusSelect?.addEventListener('change', () => {
            this._currentCorpus = e.corpusSelect.value || null;
            this._updateCorpusInfo();
            this._updateCorpusList();
            this._updateDecodeCorpusSelect();
        });

        e.decodeCorpusSelect?.addEventListener('change', () => {
            // Allow overriding corpus for decode
        });

        e.loadCorpusBtn?.addEventListener('click', () => this._loadCorpusFromFile());

        e.loadPrecompiledBtn?.addEventListener('click', () => this._loadPrecompiledFromFile());

        e.saveModelBtn?.addEventListener('click', () => this._saveModelToFile());

        e.unloadCorpusBtn?.addEventListener('click', () => this._unloadCurrentCorpus());

        // ── Encode ────────────────────────────────────────────
        e.encodeBtn?.addEventListener('click', () => this._encode());

        e.encodeCopyBtn?.addEventListener('click', () => {
            this._copyToClipboard(e.encodeResult);
        });

        // ── Decode ────────────────────────────────────────────
        e.decodeBtn?.addEventListener('click', () => this._decode());

        e.decodeCopyBtn?.addEventListener('click', () => {
            this._copyToClipboard(e.decodeResult);
        });

        // ── N-gram order change ───────────────────────────────
        e.nGramOrder?.addEventListener('change', () => {
            this._updateCorpusInfo();
        });
    }

    // ═══════════════════════════════════════════════════════════════
    //  DIRECTION / SUBTABS
    // ═══════════════════════════════════════════════════════════════

    _setDirection(dir) {
        const e = this._els;

        // Toggle subtab active state
        e.subtabEncode?.classList.toggle('active', dir === 'encode');
        e.subtabDecode?.classList.toggle('active', dir === 'decode');

        // Toggle subtab buttons inside container
        e.subtabsMarkov?.querySelectorAll('[data-mode]').forEach(btn => {
            const isActive = (dir === 'encode' && btn.dataset.mode === 'markov-encode') ||
                              (dir === 'decode' && btn.dataset.mode === 'markov-decode');
            btn.classList.toggle('active', isActive);
        });

        // Show/hide sections
        if (e.encodeSection) e.encodeSection.style.display = dir === 'encode' ? '' : 'none';
        if (e.decodeSection) e.decodeSection.style.display = dir === 'decode' ? '' : 'none';
    }

    // ═══════════════════════════════════════════════════════════════
    //  JSZip DYNAMIC LOADING
    // ═══════════════════════════════════════════════════════════════

    /**
     * Ensure JSZip is loaded, loading it from CDN if necessary.
     * @returns {Promise<boolean>}
     */
    async _ensureJSZip() {
        if (this._jszipLoaded && window.JSZip) return true;

        if (this._jszipLoadPromise) {
            return this._jszipLoadPromise;
        }

        this._jszipLoadPromise = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = MarkovStegoUI.JSZIP_CDN;
            script.async = true;
            script.onload = () => {
                this._jszipLoaded = true;
                this._jszipLoadPromise = null;
                resolve(true);
            };
            script.onerror = () => {
                this._jszipLoadPromise = null;
                reject(new Error('Не удалось загрузить JSZip с CDN'));
            };
            document.head.appendChild(script);
        });

        return this._jszipLoadPromise;
    }

    // ═══════════════════════════════════════════════════════════════
    //  CORPUS LOADING
    // ═══════════════════════════════════════════════════════════════

    /**
     * Open file picker for .zip corpus archive.
     */
    async _loadCorpusFromFile() {
        if (!this._els.zipFileInput) {
            this._els.zipFileInput = document.createElement('input');
            this._els.zipFileInput.type = 'file';
            this._els.zipFileInput.accept = '.zip';
            this._els.zipFileInput.style.display = 'none';
            document.body.appendChild(this._els.zipFileInput);

            this._els.zipFileInput.addEventListener('change', async (ev) => {
                const file = ev.target.files?.[0];
                if (file) {
                    await this._processZipFile(file);
                }
                this._els.zipFileInput.value = '';
            });
        }
        this._els.zipFileInput.click();
    }

    /**
     * Open file picker for precompiled .json model.
     */
    async _loadPrecompiledFromFile() {
        if (!this._els.jsonFileInput) {
            this._els.jsonFileInput = document.createElement('input');
            this._els.jsonFileInput.type = 'file';
            this._els.jsonFileInput.accept = '.json';
            this._els.jsonFileInput.style.display = 'none';
            document.body.appendChild(this._els.jsonFileInput);

            this._els.jsonFileInput.addEventListener('change', async (ev) => {
                const file = ev.target.files?.[0];
                if (file) {
                    await this._processPrecompiledFile(file);
                }
                this._els.jsonFileInput.value = '';
            });
        }
        this._els.jsonFileInput.click();
    }

    /**
     * Save current model to .json file.
     */
    async _saveModelToFile() {
        const name = this._currentCorpus;
        if (!name || !this._models[name]) {
            this._showToast('Нет загруженного корпуса для сохранения', 'warning');
            return;
        }

        const entry = this._models[name];
        try {
            const exported = entry.model.exportModel();
            const json = JSON.stringify(exported);
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `markov_model_${name}_${entry.n}gram.json`;
            a.click();
            URL.revokeObjectURL(url);
            this._showToast(`Модель «${name}» сохранена в файл`, 'success');
        } catch (err) {
            console.error('MarkovStegoUI: ошибка сохранения модели', err);
            this._showToast('Ошибка сохранения модели: ' + err.message, 'error');
        }
    }

    /**
     * Process a .zip archive containing .txt corpus files.
     * @param {File} file
     */
    async _processZipFile(file) {
        try {
            await this._ensureJSZip();
        } catch (err) {
            this._showToast(err.message, 'error');
            return;
        }

        this._showEncodeProgress(0, 'Чтение архива…');

        try {
            const zip = await JSZip.loadAsync(file);

            // Collect all .txt file contents
            const messages = [];
            const txtFiles = [];

            zip.forEach((relativePath, zipEntry) => {
                if (!zipEntry.dir && relativePath.toLowerCase().endsWith('.txt')) {
                    txtFiles.push(zipEntry);
                }
            });

            if (txtFiles.length === 0) {
                this._hideEncodeProgress();
                this._showToast('В архиве не найдено .txt файлов', 'warning');
                return;
            }

            this._showEncodeProgress(0.05, `Чтение ${txtFiles.length} файл(ов)…`);

            // Read all .txt files
            for (let i = 0; i < txtFiles.length; i++) {
                const text = await txtFiles[i].async('string');
                // Split by newlines — each line is a separate message
                const lines = text.split(/\r?\n/);
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (trimmed.length > 0) {
                        messages.push(trimmed);
                    }
                }
            }

            if (messages.length === 0) {
                this._hideEncodeProgress();
                this._showToast('В файлах не найдено сообщений', 'warning');
                return;
            }

            this._showEncodeProgress(0.1, `${messages.length} сообщений, построение модели…`);

            // Determine corpus name from filename (strip .zip extension)
            let corpusName = file.name.replace(/\.zip$/i, '').replace(/[^a-zA-Zа-яА-ЯёЁ0-9_\-]/g, '_');

            // Check if name already exists
            if (this._models[corpusName]) {
                corpusName = corpusName + '_' + Date.now();
            }

            // Get n-gram order from UI
            const n = parseInt(this._els.nGramOrder?.value || '3', 10);

            await this._buildModel(corpusName, messages, n);

        } catch (err) {
            this._hideEncodeProgress();
            console.error('MarkovStegoUI: ошибка обработки архива', err);
            this._showToast('Ошибка обработки архива: ' + err.message, 'error');
        }
    }

    /**
     * Process a precompiled .json model file.
     * @param {File} file
     */
    async _processPrecompiledFile(file) {
        try {
            const text = await file.text();
            const exported = JSON.parse(text);

            if (!exported || !exported.model) {
                this._showToast('Некорректный формат файла модели', 'error');
                return;
            }

            // Name from filename
            let corpusName = file.name.replace(/\.json$/i, '').replace(/[^a-zA-Zа-яА-ЯёЁ0-9_\-]/g, '_');
            if (this._models[corpusName]) {
                corpusName = corpusName + '_' + Date.now();
            }

            const n = exported.n || 3;
            const corpusSize = exported.corpusSize || 0;

            // Create model and import precompiled data
            const model = new MarkovTextStego.NGramModel(n);
            model.importPrecompiled(exported);

            // Create codec (reset singleton first)
            this._resetCodecSingleton();
            const codec = new MarkovTextStego.Codec(model);

            // Store
            this._models[corpusName] = {
                model,
                codec,
                corpusSize,
                n
            };

            // Save to localStorage
            try {
                this._saveToLocalStorage(corpusName, exported);
            } catch (err) {
                console.warn('MarkovStegoUI: не удалось сохранить в localStorage:', err.message);
            }

            // Select the new corpus
            this._currentCorpus = corpusName;
            this._updateCorpusSelect();
            this._updateCorpusList();
            this._updateCorpusInfo();
            this._updateDecodeCorpusSelect();

            this._showToast(`Модель «${corpusName}» загружена (${corpusSize} сообщений, n=${n})`, 'success');

        } catch (err) {
            console.error('MarkovStegoUI: ошибка загрузки модели', err);
            this._showToast('Ошибка загрузки модели: ' + err.message, 'error');
        }
    }

    /**
     * Build an n-gram model from an array of messages with async progress.
     * @param {string} name
     * @param {string[]} messages
     * @param {number} n
     */
    _buildModel(name, messages, n) {
        return new Promise((resolve, reject) => {
            const model = new MarkovTextStego.NGramModel(n);

            model.importChunked(
                messages,
                // onProgress
                (progress, stage) => {
                    // Scale progress: 10% (after file reading) → 100%
                    const pct = 0.1 + progress * 0.9;
                    this._showEncodeProgress(pct, stage);
                },
                // onComplete
                (ngrams) => {
                    // Create codec
                    this._resetCodecSingleton();
                    const codec = new MarkovTextStego.Codec(model);

                    // Store
                    this._models[name] = {
                        model,
                        codec,
                        corpusSize: messages.length,
                        n
                    };

                    // Export and save to localStorage
                    try {
                        const exported = model.exportModel();
                        this._saveToLocalStorage(name, exported);
                    } catch (err) {
                        console.warn('MarkovStegoUI: не удалось сохранить в localStorage:', err.message);
                    }

                    // Select the new corpus
                    this._currentCorpus = name;
                    this._updateCorpusSelect();
                    this._updateCorpusList();
                    this._updateCorpusInfo();
                    this._updateDecodeCorpusSelect();

                    this._hideEncodeProgress();
                    this._showToast(
                        `Корпус «${name}» загружен (${messages.length} сообщений, n=${n})`,
                        'success'
                    );
                    resolve();
                },
                // onError
                (error) => {
                    this._hideEncodeProgress();
                    const msg = error && error.message ? error.message : String(error);
                    if (msg.includes('No n-grams') || msg.includes('only one outcome')) {
                        this._showToast(
                            'Недостаточно данных для построения модели. Попробуйте увеличить объём корпуса или уменьшить порядок n.',
                            'warning'
                        );
                    } else {
                        this._showToast('Ошибка построения модели: ' + msg, 'error');
                    }
                    reject(error);
                }
            );
        });
    }

    // ═══════════════════════════════════════════════════════════════
    //  UNLOAD / REMOVE CORPUS
    // ═══════════════════════════════════════════════════════════════

    _unloadCurrentCorpus() {
        const name = this._currentCorpus;
        if (!name || !this._models[name]) {
            this._showToast('Нет выбранного корпуса', 'warning');
            return;
        }

        this._removeCorpus(name);
        this._showToast(`Корпус «${name}» выгружен`, 'success');
    }

    _removeCorpus(name) {
        const entry = this._models[name];
        if (entry) {
            // Destroy model to free memory
            try {
                entry.model.destroy();
            } catch (e) { /* ignore */ }
        }

        delete this._models[name];

        // Remove from localStorage
        try {
            localStorage.removeItem(MarkovStegoUI.STORAGE_PREFIX + name);
        } catch (e) { /* ignore */ }

        if (this._currentCorpus === name) {
            const keys = Object.keys(this._models);
            this._currentCorpus = keys.length > 0 ? keys[0] : null;
        }

        this._updateCorpusSelect();
        this._updateCorpusList();
        this._updateCorpusInfo();
        this._updateDecodeCorpusSelect();
    }

    // ═══════════════════════════════════════════════════════════════
    //  LOCALSTORAGE
    // ═══════════════════════════════════════════════════════════════

    _saveToLocalStorage(name, exportedModel) {
        const key = MarkovStegoUI.STORAGE_PREFIX + name;
        const json = JSON.stringify(exportedModel);

        // Check size limit
        try {
            const totalSize = this._getLocalStorageUsage();
            const newSize = new Blob([json]).size;

            if (totalSize + newSize > MarkovStegoUI.STORAGE_SIZE_LIMIT) {
                this._showToast(
                    'localStorage почти заполнен. Модель не сохранена в кэш браузера. Сохраните её в файл.',
                    'warning'
                );
                return;
            }

            if (totalSize + newSize > MarkovStegoUI.STORAGE_SIZE_LIMIT * MarkovStegoUI.STORAGE_WARN_THRESHOLD) {
                this._showToast(
                    'localStorage заполнен более чем на 80%. Рекомендуется сохранить модели в файл.',
                    'warning'
                );
            }

            localStorage.setItem(key, json);
        } catch (err) {
            if (err.name === 'QuotaExceededError' || err.code === 22) {
                this._showToast(
                    'localStorage переполнен. Модель не сохранена в кэш. Сохраните её в файл.',
                    'warning'
                );
            } else {
                console.warn('MarkovStegoUI: ошибка localStorage:', err);
            }
        }
    }

    _loadFromLocalStorage() {
        const prefix = MarkovStegoUI.STORAGE_PREFIX;
        let loaded = 0;

        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (!key || !key.startsWith(prefix)) continue;

            try {
                const json = localStorage.getItem(key);
                if (!json) continue;
                const exported = JSON.parse(json);

                if (!exported || !exported.model) {
                    localStorage.removeItem(key);
                    continue;
                }

                const name = key.slice(prefix.length);
                const n = exported.n || 3;
                const corpusSize = exported.corpusSize || 0;

                const model = new MarkovTextStego.NGramModel(n);
                model.importPrecompiled(exported);

                this._resetCodecSingleton();
                const codec = new MarkovTextStego.Codec(model);

                this._models[name] = { model, codec, corpusSize, n };
                loaded++;
            } catch (err) {
                console.warn('MarkovStegoUI: не удалось загрузить модель из localStorage:', key, err);
                try { localStorage.removeItem(key); } catch (e) { /* ignore */ }
            }
        }

        // Select first loaded corpus
        const keys = Object.keys(this._models);
        if (keys.length > 0 && !this._currentCorpus) {
            this._currentCorpus = keys[0];
        }

        if (loaded > 0) {
            console.log(`MarkovStegoUI: загружено ${loaded} моделей из localStorage`);
        }
    }

    _getLocalStorageUsage() {
        let total = 0;
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            const val = localStorage.getItem(key);
            total += (key?.length || 0) + (val?.length || 0);
        }
        // UTF-16 encoding: each char = 2 bytes
        return total * 2;
    }

    // ═══════════════════════════════════════════════════════════════
    //  UI UPDATES
    // ═══════════════════════════════════════════════════════════════

    _updateCorpusSelect() {
        const sel = this._els.corpusSelect;
        if (!sel) return;

        const currentValue = sel.value;
        const keys = Object.keys(this._models);

        sel.innerHTML = '';

        if (keys.length === 0) {
            const opt = document.createElement('option');
            opt.value = '';
            opt.textContent = 'russian_chats (загрузите .zip файл)';
            opt.disabled = true;
            opt.selected = true;
            sel.appendChild(opt);
            return;
        }

        for (const name of keys) {
            const entry = this._models[name];
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = `${name} (n=${entry.n}, ${this._formatCorpusSize(entry.corpusSize)})`;
            opt.selected = name === this._currentCorpus;
            sel.appendChild(opt);
        }

        // Ensure currentCorpus is valid
        if (!this._models[this._currentCorpus]) {
            this._currentCorpus = keys[0] || null;
        }
        if (this._currentCorpus) {
            sel.value = this._currentCorpus;
        }
    }

    _updateDecodeCorpusSelect() {
        const sel = this._els.decodeCorpusSelect;
        if (!sel) return;

        const keys = Object.keys(this._models);

        sel.innerHTML = '';

        // Add "auto-detect" option
        const autoOpt = document.createElement('option');
        autoOpt.value = '__auto__';
        autoOpt.textContent = 'Автоопределение корпуса';
        sel.appendChild(autoOpt);

        for (const name of keys) {
            const entry = this._models[name];
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = `${name} (n=${entry.n})`;
            opt.selected = name === this._currentCorpus;
            sel.appendChild(opt);
        }
    }

    _updateCorpusList() {
        const container = this._els.corpusList;
        if (!container) return;

        const keys = Object.keys(this._models);

        if (keys.length === 0) {
            container.innerHTML = '<span style="color:var(--cm-text-muted,#9ca3af);font-size:12px;">Нет загруженных корпусов</span>';
            return;
        }

        container.innerHTML = keys.map(name => {
            const entry = this._models[name];
            const isActive = name === this._currentCorpus;
            const ngramCount = Object.keys(entry.model.getModel()).length;
            const bitsPerWord = this._estimateBitsPerWord(entry.model);

            return `
                <div class="cm-markov-corpus-item${isActive ? ' cm-markov-corpus-item--active' : ''}"
                     data-corpus-name="${name}"
                     style="display:flex;align-items:center;justify-content:space-between;
                            padding:6px 10px;border-radius:6px;margin-bottom:4px;
                            background:${isActive ? 'var(--cm-bg2,#1e1e2e)' : 'transparent'};
                            border:1px solid ${isActive ? 'var(--cm-accent,#6366f1)' : 'transparent'};
                            cursor:pointer;transition:background .15s,border-color .15s;">
                    <div>
                        <div style="font-size:13px;color:var(--cm-text,#e0e0e0);font-weight:${isActive ? 600 : 400}">
                            ${name}
                        </div>
                        <div style="font-size:11px;color:var(--cm-text-muted,#9ca3af);margin-top:2px">
                            ${this._formatCorpusSize(entry.corpusSize)} сообщений · n=${entry.n} ·
                            ~${ngramCount} n-грамм · ~${bitsPerWord.toFixed(1)} бит/слово
                        </div>
                    </div>
                    <button data-action="remove-corpus" data-corpus="${name}"
                            title="Удалить корпус"
                            style="background:none;border:none;color:var(--cm-text-muted,#9ca3af);
                                   cursor:pointer;padding:4px 6px;border-radius:4px;
                                   transition:color .15s,background .15s;font-size:14px;">✕</button>
                </div>
            `;
        }).join('');

        // Bind click to select corpus
        container.querySelectorAll('.cm-markov-corpus-item').forEach(item => {
            item.addEventListener('click', (ev) => {
                // Don't select if clicking remove button
                if (ev.target.dataset.action === 'remove-corpus') return;
                const name = item.dataset.corpusName;
                if (name && this._models[name]) {
                    this._currentCorpus = name;
                    if (this._els.corpusSelect) this._els.corpusSelect.value = name;
                    this._updateCorpusSelect();
                    this._updateCorpusList();
                    this._updateCorpusInfo();
                    this._updateDecodeCorpusSelect();
                }
            });

            // Hover effect
            item.addEventListener('mouseenter', () => {
                if (item.dataset.corpusName !== this._currentCorpus) {
                    item.style.background = 'var(--cm-bg2,#1e1e2e)';
                }
            });
            item.addEventListener('mouseleave', () => {
                if (item.dataset.corpusName !== this._currentCorpus) {
                    item.style.background = 'transparent';
                }
            });
        });

        // Bind remove buttons
        container.querySelectorAll('[data-action="remove-corpus"]').forEach(btn => {
            btn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                const name = btn.dataset.corpus;
                if (name) {
                    this._removeCorpus(name);
                    this._showToast(`Корпус «${name}» удалён`, 'success');
                }
            });
            btn.addEventListener('mouseenter', () => {
                btn.style.color = 'var(--cm-accent,#6366f1)';
                btn.style.background = 'rgba(99,102,241,0.1)';
            });
            btn.addEventListener('mouseleave', () => {
                btn.style.color = 'var(--cm-text-muted,#9ca3af)';
                btn.style.background = 'none';
            });
        });
    }

    _updateCorpusInfo() {
        const info = this._els.corpusInfo;
        if (!info) return;

        const name = this._currentCorpus;
        if (!name || !this._models[name]) {
            info.textContent = 'Корпус не загружен';
            info.style.color = 'var(--cm-text-muted, #9ca3af)';
            return;
        }

        const entry = this._models[name];
        const ngramCount = Object.keys(entry.model.getModel()).length;
        const bitsPerWord = this._estimateBitsPerWord(entry.model);

        info.textContent = `${this._formatCorpusSize(entry.corpusSize)} сообщений, n=${entry.n}, ~${ngramCount} n-грамм, ~${bitsPerWord.toFixed(1)} бит/слово`;
        info.style.color = 'var(--cm-text-secondary, #a0a0a0)';
    }

    /**
     * Estimate average bits per word for a model (capacity indicator).
     * @param {NGramModel} model
     * @returns {number}
     */
    _estimateBitsPerWord(model) {
        const mdl = model.getModel();
        const keys = Object.keys(mdl);
        if (keys.length === 0) return 0;

        let totalLog2 = 0;
        let count = 0;

        // Sample up to 500 n-gram keys for performance
        const sampleSize = Math.min(keys.length, 500);
        const step = keys.length / sampleSize;

        for (let i = 0; i < sampleSize; i++) {
            const key = keys[Math.floor(i * step)];
            const probs = mdl[key];
            if (probs && probs.length > 1) {
                totalLog2 += Math.log2(probs.length);
                count++;
            }
        }

        return count > 0 ? totalLog2 / count : 0;
    }

    // ═══════════════════════════════════════════════════════════════
    //  ENCODE
    // ═══════════════════════════════════════════════════════════════

    async _encode() {
        if (this._encoding) return;

        const secret = this._els.secretInput?.value?.trim();
        if (!secret) {
            this._showToast('Введите секретное сообщение', 'warning');
            return;
        }

        const name = this._currentCorpus;
        if (!name || !this._models[name]) {
            this._showToast('Загрузите корпус перед кодированием', 'warning');
            return;
        }

        const entry = this._models[name];
        if (!entry.model || !entry.codec) {
            this._showToast('Модель повреждена, перезагрузите корпус', 'error');
            return;
        }

        // Reset codec singleton and create fresh codec for encoding
        this._resetCodecSingleton();
        const codec = new MarkovTextStego.Codec(entry.model);
        entry.codec = codec;

        this._encoding = true;
        this._showEncodeProgress(0, 'Кодирование…');
        this._setBtnLoading(this._els.encodeBtn, true, 'Кодирование…');

        // Use setTimeout to allow UI to update before heavy computation
        await new Promise(resolve => setTimeout(resolve, 50));

        try {
            const startTime = performance.now();
            const result = codec.encode(secret);
            const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);

            // Show result
            if (this._els.encodeResult) {
                this._els.encodeResult.value = result;
            }

            this._hideEncodeProgress();
            this._showToast(
                `Сообщение закодировано за ${elapsed} с (${result.length} символов)`,
                'success'
            );
        } catch (err) {
            this._hideEncodeProgress();
            const msg = err && err.message ? err.message : String(err);

            if (msg.includes('No n-grams') || msg.includes('invalid n-gram')) {
                this._showToast(
                    'Ошибка кодирования: текст слишком короткий или модель слишком мала. Попробуйте увеличить корпус.',
                    'error'
                );
            } else {
                this._showToast('Ошибка кодирования: ' + msg, 'error');
            }
            console.error('MarkovStegoUI: ошибка кодирования', err);
        } finally {
            this._encoding = false;
            this._setBtnLoading(this._els.encodeBtn, false);
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  DECODE
    // ═══════════════════════════════════════════════════════════════

    async _decode() {
        if (this._decoding) return;

        const stegoText = this._els.decodeInput?.value?.trim();
        if (!stegoText) {
            this._showToast('Введите стего-текст для декодирования', 'warning');
            return;
        }

        // Determine which corpus to use
        let corpusName = this._els.decodeCorpusSelect?.value;
        if (corpusName === '__auto__' || !corpusName) {
            corpusName = this._autoDetectCorpus(stegoText);
        }

        if (!corpusName || !this._models[corpusName]) {
            this._showToast('Не удалось определить корпус. Выберите вручную.', 'warning');
            return;
        }

        const entry = this._models[corpusName];
        if (!entry.model || !entry.codec) {
            this._showToast('Модель повреждена, перезагрузите корпус', 'error');
            return;
        }

        // Reset codec singleton and create fresh codec for decoding
        this._resetCodecSingleton();
        const codec = new MarkovTextStego.Codec(entry.model);
        entry.codec = codec;

        this._decoding = true;
        this._showDecodeProgress(true, 'Декодирование…');
        this._setBtnLoading(this._els.decodeBtn, true, 'Декодирование…');

        await new Promise(resolve => setTimeout(resolve, 50));

        try {
            const startTime = performance.now();
            const result = codec.decode(stegoText);
            const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);

            if (this._els.decodeResult) {
                this._els.decodeResult.value = result;
            }

            this._hideDecodeProgress();
            this._showToast(
                `Сообщение декодировано за ${elapsed} с (корпус: ${corpusName})`,
                'success'
            );
        } catch (err) {
            this._hideDecodeProgress();
            const msg = err && err.message ? err.message : String(err);

            if (msg.includes('invalid n-gram') || msg.includes('is an invalid n-gram')) {
                this._showToast(
                    'Ошибка декодирования: текст не совпадает с моделью. Убедитесь, что используется тот же корпус.',
                    'error'
                );
            } else {
                this._showToast('Ошибка декодирования: ' + msg, 'error');
            }
            console.error('MarkovStegoUI: ошибка декодирования', err);
        } finally {
            this._decoding = false;
            this._setBtnLoading(this._els.decodeBtn, false);
        }
    }

    /**
     * Try to auto-detect which corpus was used for the stego text.
     * Uses the Codec.identifyCorpus method if available.
     * @param {string} text
     * @returns {string|null}
     */
    _autoDetectCorpus(text) {
        const keys = Object.keys(this._models);
        if (keys.length === 0) return null;
        if (keys.length === 1) return keys[0];

        // If there's a currently selected corpus, use it
        if (this._currentCorpus && this._models[this._currentCorpus]) {
            return this._currentCorpus;
        }

        // Try using identifyCorpus on the first available codec
        for (const name of keys) {
            const entry = this._models[name];
            if (entry.codec && typeof entry.codec.identifyCorpus === 'function') {
                try {
                    // Build a map of model name → model
                    const modelsMap = {};
                    for (const k of keys) {
                        modelsMap[k] = this._models[k].model;
                    }

                    const result = entry.codec.identifyCorpus(text, modelsMap);
                    if (result && result.key) {
                        console.log(`MarkovStegoUI: автоопределение корпуса → ${result.key} (score: ${result.score.toFixed(2)})`);
                        return result.key;
                    }
                } catch (err) {
                    console.warn('MarkovStegoUI: ошибка автоопределения:', err);
                }
            }
        }

        // Fallback: use current corpus
        return this._currentCorpus;
    }

    // ═══════════════════════════════════════════════════════════════
    //  PROGRESS BAR
    // ═══════════════════════════════════════════════════════════════

    _showEncodeProgress(pct, text) {
        const bar = this._els.encodeProgress;
        const label = this._els.encodeProgressText;

        if (bar) {
            bar.style.display = '';
            // Ensure progress bar inner element exists
            let inner = bar.querySelector('.cm-progress-bar-inner');
            if (!inner) {
                bar.innerHTML = '<div class="cm-progress-bar-inner" style="height:100%;border-radius:inherit;transition:width .2s;background:var(--cm-accent,#6366f1);"></div>';
                inner = bar.querySelector('.cm-progress-bar-inner');
            }
            inner.style.width = Math.min(100, Math.max(0, pct * 100)) + '%';
        }
        if (label) {
            label.textContent = text || '';
            label.style.display = '';
        }
    }

    _hideEncodeProgress() {
        const bar = this._els.encodeProgress;
        const label = this._els.encodeProgressText;
        if (bar) bar.style.display = 'none';
        if (label) label.style.display = 'none';
    }

    _showDecodeProgress(show, text) {
        const bar = this._els.decodeProgress;
        if (!bar) return;

        if (show) {
            bar.style.display = '';
            let inner = bar.querySelector('.cm-progress-bar-inner');
            if (!inner) {
                bar.innerHTML = '<div class="cm-progress-bar-inner" style="height:100%;border-radius:inherit;transition:width .2s;background:var(--cm-accent,#6366f1);width:100%;"></div>';
            }
        } else {
            bar.style.display = 'none';
        }
    }

    _hideDecodeProgress() {
        const bar = this._els.decodeProgress;
        if (bar) bar.style.display = 'none';
    }

    // ═══════════════════════════════════════════════════════════════
    //  CLIPBOARD
    // ═══════════════════════════════════════════════════════════════

    async _copyToClipboard(textarea) {
        if (!textarea || !textarea.value) {
            this._showToast('Нечего копировать', 'warning');
            return;
        }

        try {
            await navigator.clipboard.writeText(textarea.value);
            this._showToast('Скопировано в буфер обмена', 'success');
        } catch (err) {
            // Fallback for older browsers / non-HTTPS
            try {
                textarea.select();
                textarea.setSelectionRange(0, textarea.value.length);
                document.execCommand('copy');
                this._showToast('Скопировано в буфер обмена', 'success');
            } catch (e) {
                this._showToast('Не удалось скопировать', 'error');
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  CODEC SINGLETON
    // ═══════════════════════════════════════════════════════════════

    /**
     * Reset the Codec singleton so we can create a new instance for a different model.
     */
    _resetCodecSingleton() {
        try {
            if (MarkovTextStego.Codec && MarkovTextStego.Codec._singletonInstance) {
                delete MarkovTextStego.Codec._singletonInstance;
            }
        } catch (e) {
            // Fallback: in strict mode, delete on a function may not work.
            // Try via the constructor property.
            try {
                const Ctor = MarkovTextStego.Codec;
                if (Ctor._singletonInstance !== undefined) {
                    // Can't delete in strict mode, set to null
                    Ctor._singletonInstance = null;
                }
            } catch (e2) {
                console.warn('MarkovStegoUI: не удалось сбросить Codec singleton');
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  HELPERS
    // ═══════════════════════════════════════════════════════════════

    /**
     * Show a toast notification via the global showToast function.
     * @param {string} msg
     * @param {string} type — 'success' | 'error' | 'warning' | 'info'
     */
    _showToast(msg, type = 'info') {
        if (typeof window.showToast === 'function') {
            window.showToast(msg, type);
        } else {
            console.log(`[Toast ${type}] ${msg}`);
        }
    }

    /**
     * Set button loading state.
     * @param {HTMLButtonElement|null} btn
     * @param {boolean} loading
     * @param {string} loadingText
     */
    _setBtnLoading(btn, loading, loadingText = 'Обработка…') {
        if (!btn) return;

        if (loading) {
            btn.disabled = true;
            btn.dataset.originalHtml = btn.innerHTML;
            btn.dataset.originalDisabled = btn.disabled;
            btn.innerHTML = `<span class="cm-spinner" style="display:inline-block;width:14px;height:14px;border:2px solid rgba(255,255,255,0.3);border-top-color:#fff;border-radius:50%;animation:cm-spin .6s linear infinite;vertical-align:middle;margin-right:6px;"></span>${loadingText}`;
        } else {
            btn.disabled = false;
            if (btn.dataset.originalHtml) {
                btn.innerHTML = btn.dataset.originalHtml;
                delete btn.dataset.originalHtml;
            }
            delete btn.dataset.originalDisabled;
        }
    }

    /**
     * Format corpus size for display.
     * @param {number} count
     * @returns {string}
     */
    _formatCorpusSize(count) {
        if (count >= 1000000) return (count / 1000000).toFixed(1) + 'М';
        if (count >= 1000) return (count / 1000).toFixed(1) + 'К';
        return String(count);
    }

    /**
     * Sanitize a string for use as a corpus name.
     * @param {string} name
     * @returns {string}
     */
    _sanitizeName(name) {
        return name
            .trim()
            .replace(/[^a-zA-Zа-яА-ЯёЁ0-9_\-]/g, '_')
            .substring(0, 50);
    }
}
