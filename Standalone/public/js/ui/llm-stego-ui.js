/**
 * LLM Stego UI Module — Стегонатор
 *
 * Provides a UI for encoding/decoding secret messages using an
 * external LLM-based steganography Python service (FastAPI).
 *
 * The service runs locally and communicates through a Caddy gateway
 * using relative fetch paths with ?XTransformPort=<port>.
 *
 * Exported: LlmStegoUI class with init() method.
 *
 * Global deps: showToast(message, type) from main.js
 *
 * This class operates on the existing #panelLlmStego DOM in index.html.
 * It does NOT create any DOM elements — it only caches references and
 * binds event handlers.
 */

export class LlmStegoUI {
    constructor() {
        // ── Internal state ────────────────────────────────────
        this._connected = false;
        this._encoding = false;
        this._abortController = null;
        this._endpoint = 'http://localhost:8089';
        this._port = 8089;
        this._statusInfo = null; // last /status response

        // ── DOM references ────────────────────────────────────
        this._els = {};
        this._root = null;
    }

    // ═══════════════════════════════════════════════════════════════
    //  PUBLIC API
    // ═══════════════════════════════════════════════════════════════

    /**
     * Initialize the UI: cache DOM, bind events, try auto-connect.
     */
    init() {
        this._cacheDom();
        this._loadSavedEndpoint();
        this._bindEvents();
        this._updateSubtabs('llm-encode');
        // Attempt auto-connect on init
        this.checkConnection();
    }

    // ═══════════════════════════════════════════════════════════════
    //  DOM CACHING
    // ═══════════════════════════════════════════════════════════════

    _cacheDom() {
        const $ = (sel) => document.querySelector(sel);
        const $$ = (sel) => document.querySelectorAll(sel);

        this._root = $('#panelLlmStego');
        if (!this._root) {
            console.warn('LlmStegoUI: #panelLlmStego not found in DOM — skipping init');
            return;
        }

        // ── Subtabs (outside panel, so query from document) ──
        const subtabsContainer = document.querySelector('[data-category-subtabs="llm"]');
        this._els.subtabsContainer = subtabsContainer;
        this._els.subtabBtns = subtabsContainer
            ? [...subtabsContainer.querySelectorAll('[data-mode^="llm-"]')]
            : [];

        // ── Connection section ──
        this._els.endpointInput = $('#llmEndpointInput');
        this._els.portInput = $('#llmPortInput');
        this._els.connectBtn = $('#llmConnectBtn');
        this._els.statusDot = $('#llmStatusDot');
        this._els.statusText = $('#llmStatusText');

        // ── Encode section ──
        const encSec = $('#llmEncodeSection');
        this._els.encodeSection = encSec;

        this._els.secretInput = $('#llmSecretInput');
        this._els.seedText = $('#llmSeedText');
        this._els.context = $('#llmContext');
        this._els.topK = $('#llmTopK');
        this._els.temperature = $('#llmTemperature');
        this._els.autoAccept = $('#llmAutoAccept');
        this._els.naturalCompletion = $('#llmNaturalCompletion');
        this._els.streamToggle = $('#llmStreamToggle');
        this._els.encodeBtn = $('#llmEncodeBtn');
        this._els.encodeCancelBtn = $('#llmEncodeCancelBtn');
        this._els.encodeProgress = $('#llmEncodeProgress');
        this._els.encodeProgressText = $('#llmEncodeProgressText');
        this._els.encodePartial = $('#llmEncodePartial');
        this._els.encodeResult = $('#llmEncodeResult');
        this._els.encodeStats = $('#llmEncodeStats');
        this._els.capacityBtn = $('#llmCapacityBtn');
        this._els.capacityResult = $('#llmCapacityResult');

        // ── Decode section ──
        const decSec = $('#llmDecodeSection');
        this._els.decodeSection = decSec;

        this._els.decodeInput = $('#llmDecodeInput');
        this._els.decodeContext = $('#llmDecodeContext');
        this._els.decodeTopK = $('#llmDecodeTopK');
        this._els.decodeTemperature = $('#llmDecodeTemperature');
        this._els.decodeBtn = $('#llmDecodeBtn');
        this._els.decodeResult = $('#llmDecodeResult');
        this._els.decodeStats = $('#llmDecodeStats');
        this._els.decodeProgress = $('#llmDecodeProgress');
    }

    // ═══════════════════════════════════════════════════════════════
    //  EVENT BINDING
    // ═══════════════════════════════════════════════════════════════

    _bindEvents() {
        const e = this._els;

        // ── Subtabs ──
        e.subtabBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                this._updateSubtabs(btn.dataset.mode);
            });
        });

        // ── Connection ──
        e.connectBtn?.addEventListener('click', () => this._onConnect());

        // Sync port input → endpoint display and vice versa
        e.endpointInput?.addEventListener('change', () => {
            this._syncPortFromEndpoint();
            this._saveEndpoint();
        });
        e.portInput?.addEventListener('change', () => {
            this._syncEndpointFromPort();
            this._saveEndpoint();
        });

        // ── Encode ──
        e.encodeBtn?.addEventListener('click', () => this._encode());
        e.encodeCancelBtn?.addEventListener('click', () => this._cancelEncoding());
        e.capacityBtn?.addEventListener('click', () => this._checkCapacity());

        // ── Decode ──
        e.decodeBtn?.addEventListener('click', () => this._decode());
    }

    // ═══════════════════════════════════════════════════════════════
    //  SUBTABS
    // ═══════════════════════════════════════════════════════════════

    _updateSubtabs(mode) {
        const e = this._els;

        // Update subtab button active state
        e.subtabBtns.forEach(btn => {
            btn.classList.toggle('active', btn.dataset.mode === mode);
        });

        // Show/hide sections
        if (e.encodeSection) e.encodeSection.style.display = mode === 'llm-encode' ? '' : 'none';
        if (e.decodeSection) e.decodeSection.style.display = mode === 'llm-decode' ? '' : 'none';
    }

    // ═══════════════════════════════════════════════════════════════
    //  ENDPOINT / PORT MANAGEMENT
    // ═══════════════════════════════════════════════════════════════

    _loadSavedEndpoint() {
        const e = this._els;
        try {
            const saved = localStorage.getItem('llm-stego-endpoint');
            if (saved) {
                this._endpoint = saved;
                if (e.endpointInput) e.endpointInput.value = saved;
                const port = this._extractPort(saved);
                if (port && e.portInput) e.portInput.value = port;
                this._port = port || 8089;
            }
        } catch (_) {
            // localStorage unavailable — ignore
        }
    }

    _saveEndpoint() {
        try {
            localStorage.setItem('llm-stego-endpoint', this._endpoint);
        } catch (_) {
            // ignore
        }
    }

    /**
     * Extract port number from a URL string like "http://localhost:8089"
     */
    _extractPort(urlStr) {
        try {
            const u = new URL(urlStr);
            return parseInt(u.port, 10) || 8089;
        } catch (_) {
            return 8089;
        }
    }

    /**
     * When endpoint input changes, sync the port input.
     */
    _syncPortFromEndpoint() {
        const e = this._els;
        const val = e.endpointInput?.value?.trim() || 'http://localhost:8089';
        this._endpoint = val;
        const port = this._extractPort(val);
        this._port = port;
        if (e.portInput) e.portInput.value = port;
    }

    /**
     * When port input changes, sync the endpoint URL.
     */
    _syncEndpointFromPort() {
        const e = this._els;
        const port = parseInt(e.portInput?.value, 10) || 8089;
        this._port = port;
        try {
            const u = new URL(this._endpoint);
            u.port = port;
            this._endpoint = u.toString();
            if (e.endpointInput) e.endpointInput.value = this._endpoint;
        } catch (_) {
            this._endpoint = `http://localhost:${port}`;
            if (e.endpointInput) e.endpointInput.value = this._endpoint;
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  API HELPERS
    // ═══════════════════════════════════════════════════════════════

    /**
     * Build a relative API path with XTransformPort query param.
     * Example: _apiPath('/status') → '/status?XTransformPort=8089'
     */
    _apiPath(path) {
        const sep = path.includes('?') ? '&' : '?';
        return `${path}${sep}XTransformPort=${this._port}`;
    }

    // ═══════════════════════════════════════════════════════════════
    //  CONNECTION MANAGEMENT
    // ═══════════════════════════════════════════════════════════════

    async _onConnect() {
        this._syncPortFromEndpoint();
        this._saveEndpoint();
        await this.checkConnection();
    }

    async checkConnection() {
        const e = this._els;

        // Update button to loading state
        if (e.connectBtn) {
            e.connectBtn.disabled = true;
            const origText = e.connectBtn.textContent;
            e.connectBtn.textContent = 'Подключение…';
            e.connectBtn.dataset.origText = origText;
        }

        this._updateStatus('connecting', 'Подключение…');

        try {
            const resp = await fetch(this._apiPath('/status'), {
                method: 'GET',
                headers: { 'Accept': 'application/json' },
                signal: AbortSignal.timeout(8000),
            });

            if (!resp.ok) {
                throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
            }

            const data = await resp.json();

            if (data.ok !== true) {
                const errMsg = data.error || 'Сервис вернул ошибку';
                throw new Error(errMsg);
            }

            this._connected = true;
            this._statusInfo = data;

            const modelLabel = data.model || 'неизвестная модель';
            const versionLabel = data.version ? ` v${data.version}` : '';
            this._updateStatus('connected', `Подключён: ${modelLabel}${versionLabel}`);

            // Show available features if present
            if (data.features && Array.isArray(data.features) && data.features.length > 0) {
                console.info('LLM Stego features:', data.features.join(', '));
            }

            window.showToast(`Подключено к ${modelLabel}${versionLabel}`, 'success');

        } catch (err) {
            this._connected = false;
            this._statusInfo = null;

            if (err.name === 'TimeoutError' || err.name === 'AbortError') {
                this._updateStatus('error', 'Ошибка: таймаут подключения');
                window.showToast('Таймаут подключения к LLM сервису', 'error');
            } else if (err.message.includes('Failed to fetch') || err.message.includes('NetworkError')) {
                this._updateStatus('error', 'Ошибка: сервис недоступен');
                window.showToast('LLM сервис недоступен — проверьте что он запущен', 'error');
            } else {
                this._updateStatus('error', `Ошибка: ${err.message}`);
                window.showToast('Ошибка подключения: ' + err.message, 'error');
            }

            console.error('LLM Stego connection error:', err);
        } finally {
            if (e.connectBtn) {
                e.connectBtn.disabled = false;
                if (e.connectBtn.dataset.origText) {
                    e.connectBtn.textContent = e.connectBtn.dataset.origText;
                    delete e.connectBtn.dataset.origText;
                }
            }
        }
    }

    /**
     * Update the connection status indicator.
     * @param {'connecting'|'connected'|'error'|'disconnected'} state
     * @param {string} text
     */
    _updateStatus(state, text) {
        const e = this._els;
        if (e.statusText) e.statusText.textContent = text;

        if (!e.statusDot) return;

        e.statusDot.classList.remove('status-dot--connected', 'status-dot--error', 'status-dot--connecting', 'status-dot--disconnected');

        switch (state) {
            case 'connected':
                e.statusDot.classList.add('status-dot--connected');
                break;
            case 'error':
                e.statusDot.classList.add('status-dot--error');
                break;
            case 'connecting':
                e.statusDot.classList.add('status-dot--connecting');
                break;
            default:
                e.statusDot.classList.add('status-dot--disconnected');
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  ENCODE
    // ═══════════════════════════════════════════════════════════════

    async _encode() {
        const e = this._els;

        if (this._encoding) return;
        if (!this._connected) {
            window.showToast('Сначала подключитесь к LLM сервису', 'warning');
            return;
        }

        // Gather parameters
        const message = e.secretInput?.value?.trim();
        if (!message) {
            window.showToast('Введите секретное сообщение', 'warning');
            return;
        }

        const seedText = e.seedText?.value || '';
        if (!seedText) {
            window.showToast('Введите начальный текст (seed)', 'warning');
            return;
        }

        const context = e.context?.value || '';
        const topK = parseInt(e.topK?.value, 10) || 8;
        const temperature = parseFloat(e.temperature?.value) || 0.8;
        const autoAcceptThreshold = parseFloat(e.autoAccept?.value) || 0.50;
        const naturalCompletion = e.naturalCompletion?.checked ?? true;
        const stream = e.streamToggle?.checked ?? true;

        // Validate ranges
        if (topK < 2 || topK > 32) {
            window.showToast('top_k должен быть от 2 до 32', 'warning');
            return;
        }
        if (temperature < 0.1 || temperature > 2.0) {
            window.showToast('temperature должен быть от 0.1 до 2.0', 'warning');
            return;
        }

        const payload = {
            message,
            seed_text: seedText,
            context,
            top_k: topK,
            temperature,
            auto_accept_threshold: autoAcceptThreshold,
            natural_completion: naturalCompletion,
            stream,
        };

        // Set loading state
        this._encoding = true;
        this._abortController = new AbortController();
        this._setEncodeLoading(true);
        this._clearEncodeResults();
        this._showEncodeProgress(true);

        try {
            const resp = await fetch(this._apiPath('/encode'), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': stream ? 'text/event-stream' : 'application/json',
                },
                body: JSON.stringify(payload),
                signal: this._abortController.signal,
            });

            if (!resp.ok) {
                let errMsg = `HTTP ${resp.status}`;
                try {
                    const errBody = await resp.json();
                    errMsg = errBody.detail || errBody.error || errMsg;
                } catch (_) { /* use default */ }
                throw new Error(errMsg);
            }

            if (stream) {
                await this._handleStreamResponse(resp);
            } else {
                await this._handleJsonResponse(resp);
            }

        } catch (err) {
            if (err.name === 'AbortError') {
                this._updateEncodeProgressText('Отменено');
                window.showToast('Кодирование отменено', 'info');
            } else {
                console.error('LLM encode error:', err);
                window.showToast('Ошибка кодирования: ' + err.message, 'error');
                this._updateEncodeProgressText('Ошибка: ' + err.message);
            }
        } finally {
            this._encoding = false;
            this._abortController = null;
            this._setEncodeLoading(false);
        }
    }

    /**
     * Handle non-streaming JSON response from /encode.
     */
    async _handleJsonResponse(resp) {
        const e = this._els;
        const data = await resp.json();

        if (!data.success) {
            const errMsg = data.error || 'Кодирование не удалось';
            throw new Error(errMsg);
        }

        // Show final result
        if (e.encodeResult) {
            e.encodeResult.value = data.full_text || '';
            e.encodeResult.style.display = '';
        }

        // Show stats
        if (data.stats) {
            this._showEncodeStats(data.stats);
        }

        this._showEncodeProgress(false);
        window.showToast('Сообщение закодировано', 'success');
    }

    /**
     * Handle SSE streaming response from /encode.
     * Reads the response body via ReadableStream, parses SSE events,
     * and updates the UI progressively.
     */
    async _handleStreamResponse(resp) {
        const e = this._els;

        if (!resp.body) {
            throw new Error('Ответ не поддерживает потоковую передачу');
        }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';
        let finalData = null;

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });

                // Parse complete SSE events from the buffer.
                // SSE events are delimited by blank lines (\n\n).
                const parts = buffer.split('\n\n');
                // Keep the last (possibly incomplete) part in the buffer
                buffer = parts.pop() || '';

                for (const part of parts) {
                    if (!part.trim()) continue;

                    const parsed = this._parseSSEEvent(part);
                    if (!parsed) continue;

                    switch (parsed.event) {
                        case 'start':
                            this._onSSEStart(parsed.data);
                            break;

                        case 'progress':
                            this._onSSEProgress(parsed.data);
                            break;

                        case 'phase':
                            this._onSSEPhase(parsed.data);
                            break;

                        case 'done':
                            finalData = parsed.data;
                            break;

                        case 'error':
                            throw new Error(parsed.data?.error || parsed.data?.message || 'Ошибка от сервера');

                        default:
                            // Unknown event — ignore
                            break;
                    }
                }
            }

            // Process any remaining buffer
            if (buffer.trim()) {
                const parsed = this._parseSSEEvent(buffer);
                if (parsed) {
                    if (parsed.event === 'done') finalData = parsed.data;
                    else if (parsed.event === 'error') {
                        throw new Error(parsed.data?.error || 'Ошибка от сервера');
                    }
                }
            }

        } finally {
            reader.releaseLock();
        }

        // If we received a 'done' event, show final results
        if (finalData) {
            this._onSSEDone(finalData);
        } else if (!this._abortController) {
            // Stream ended without 'done' event and wasn't cancelled
            throw new Error('Поток завершился без финального события');
        }
    }

    /**
     * Parse a single SSE block into { event, data }.
     * SSE format:
     *   event: <name>\n
     *   data: <json>\n
     */
    _parseSSEEvent(block) {
        let event = '';
        let data = '';

        for (const line of block.split('\n')) {
            if (line.startsWith('event:')) {
                event = line.slice(6).trim();
            } else if (line.startsWith('data:')) {
                data = line.slice(5).trim();
            }
            // Ignore comments (lines starting with ':'), id, retry
        }

        if (!event || !data) return null;

        try {
            return { event, data: JSON.parse(data) };
        } catch (_) {
            // Data might not be JSON — return raw string
            return { event, data };
        }
    }

    // ── SSE Event Handlers ───────────────────────────────────

    _onSSEStart(data) {
        const e = this._els;
        const msgLen = data.message_length || '?';
        const totalBits = data.total_bits || '?';

        this._updateEncodeProgressText(
            `Начало кодирования: ${msgLen} символов, ${totalBits} бит`
        );

        // Clear previous partial text
        if (e.encodePartial) {
            e.encodePartial.value = data.seed || '';
            e.encodePartial.style.display = '';
        }

        this._showEncodeProgress(true);
    }

    _onSSEProgress(data) {
        const e = this._els;

        // Update progress text
        const bitsEncoded = data.bits_encoded ?? 0;
        const bitsTotal = data.bits_total ?? 0;
        const pct = data.progress_pct != null ? data.progress_pct.toFixed(1) : '—';
        const tokens = data.tokens_generated ?? 0;

        this._updateEncodeProgressText(
            `Кодировано: ${bitsEncoded}/${bitsTotal} бит (${pct}%) · ${tokens} токенов`
        );

        // Update partial text (live streaming text)
        if (data.partial_text != null && e.encodePartial) {
            e.encodePartial.value = data.partial_text;
            e.encodePartial.style.display = '';
            // Auto-scroll to bottom
            e.encodePartial.scrollTop = e.encodePartial.scrollHeight;
        }
    }

    _onSSEPhase(data) {
        const phaseText = data.phase || data.name || data.message || '…';
        this._updateEncodePhase(phaseText);
    }

    _onSSEDone(data) {
        const e = this._els;

        if (!data.success) {
            const errMsg = data.error || 'Кодирование не удалось';
            throw new Error(errMsg);
        }

        // Show final full text
        if (e.encodeResult) {
            e.encodeResult.value = data.full_text || '';
            e.encodeResult.style.display = '';
        }

        // Hide partial text — show final result instead
        if (e.encodePartial) e.encodePartial.style.display = 'none';

        // Show stats
        if (data.stats) {
            this._showEncodeStats(data.stats);
        }

        this._showEncodeProgress(false);
        window.showToast('Сообщение закодировано', 'success');
    }

    // ═══════════════════════════════════════════════════════════════
    //  CANCEL
    // ═══════════════════════════════════════════════════════════════

    _cancelEncoding() {
        if (this._abortController) {
            this._abortController.abort();
            this._abortController = null;
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  DECODE
    // ═══════════════════════════════════════════════════════════════

    async _decode() {
        const e = this._els;

        if (!this._connected) {
            window.showToast('Сначала подключитесь к LLM сервису', 'warning');
            return;
        }

        const fullText = e.decodeInput?.value?.trim();
        if (!fullText) {
            window.showToast('Введите текст для декодирования', 'warning');
            return;
        }

        const context = e.decodeContext?.value || '';
        const topK = parseInt(e.decodeTopK?.value, 10) || 8;
        const temperature = parseFloat(e.decodeTemperature?.value) || 0.8;
        const autoAcceptThreshold = parseFloat(e.autoAccept?.value) || 0.50;

        const payload = {
            full_text: fullText,
            context,
            top_k: topK,
            temperature,
            auto_accept_threshold: autoAcceptThreshold,
        };

        // Loading state
        e.decodeBtn.disabled = true;
        const origDecodeText = e.decodeBtn.textContent;
        e.decodeBtn.textContent = 'Декодирование…';

        if (e.decodeProgress) {
            e.decodeProgress.style.display = '';
            e.decodeProgress.textContent = 'Декодирование…';
        }
        if (e.decodeResult) e.decodeResult.value = '';
        if (e.decodeStats) e.decodeStats.textContent = '';

        try {
            const resp = await fetch(this._apiPath('/decode'), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(60000),
            });

            if (!resp.ok) {
                let errMsg = `HTTP ${resp.status}`;
                try {
                    const errBody = await resp.json();
                    errMsg = errBody.detail || errBody.error || errMsg;
                } catch (_) { /* use default */ }
                throw new Error(errMsg);
            }

            const data = await resp.json();

            if (!data.success) {
                const errMsg = data.error || 'Декодирование не удалось';
                throw new Error(errMsg);
            }

            // Show decoded message
            if (e.decodeResult) {
                e.decodeResult.value = data.message || '';
            }

            // Show stats
            if (data.stats) {
                this._showDecodeStats(data.stats);
            }

            window.showToast('Сообщение декодировано', 'success');

        } catch (err) {
            console.error('LLM decode error:', err);
            window.showToast('Ошибка декодирования: ' + err.message, 'error');
            if (e.decodeProgress) {
                e.decodeProgress.textContent = 'Ошибка: ' + err.message;
                e.decodeProgress.style.color = 'var(--cm-text-secondary, #f87171)';
            }
        } finally {
            e.decodeBtn.disabled = false;
            e.decodeBtn.textContent = origDecodeText;
            if (e.decodeProgress) {
                // Keep progress visible briefly, then hide
                setTimeout(() => {
                    if (e.decodeProgress && !e.decodeProgress.textContent.startsWith('Ошибка')) {
                        e.decodeProgress.style.display = 'none';
                    }
                }, 2000);
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  CAPACITY ESTIMATION
    // ═══════════════════════════════════════════════════════════════

    async _checkCapacity() {
        const e = this._els;

        if (!this._connected) {
            window.showToast('Сначала подключитесь к LLM сервису', 'warning');
            return;
        }

        // Estimate based on seed text length (token count approximation)
        const seedText = e.seedText?.value || '';
        // Rough approximation: ~1.3 tokens per character for Russian text
        const estimatedTokens = Math.ceil(seedText.length * 1.3) + 20; // +20 for generated text
        const topK = parseInt(e.topK?.value, 10) || 8;

        const payload = {
            text_length: seedText.length,
            top_k: topK,
        };

        if (e.capacityResult) e.capacityResult.textContent = 'Оценка…';
        e.capacityBtn.disabled = true;

        try {
            const resp = await fetch(this._apiPath('/capacity'), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(10000),
            });

            if (!resp.ok) {
                throw new Error(`HTTP ${resp.status}`);
            }

            const data = await resp.json();

            // Format capacity info
            const capBytes = data.estimated_capacity_bytes ?? 0;
            const bitsPerToken = data.effective_bits_per_token ?? 0;
            const tokens = data.text_length_tokens ?? estimatedTokens;
            const overhead = data.overhead_bytes ?? 0;
            const model = data.model || 'модель';
            const algorithm = data.algorithm || 'алгоритм';

            let capText = '';
            if (capBytes > 0) {
                const charCapacity = Math.floor(capBytes / 2); // rough: 2 bytes per char (UTF-8)
                capText = `≈ ${capBytes} байт (~${charCapacity} символов) · ${bitsPerToken.toFixed(1)} бит/токен · ${tokens} токенов · модель: ${model}`;
            } else {
                capText = 'Недостаточно ёмкости при текущих параметрах';
            }

            if (e.capacityResult) e.capacityResult.textContent = capText;

        } catch (err) {
            console.error('LLM capacity check error:', err);
            if (e.capacityResult) {
                e.capacityResult.textContent = 'Ошибка: ' + err.message;
            }
            window.showToast('Не удалось оценить ёмкость', 'error');
        } finally {
            e.capacityBtn.disabled = false;
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  UI HELPERS — ENCODE
    // ═══════════════════════════════════════════════════════════════

    _setEncodeLoading(isLoading) {
        const e = this._els;

        if (isLoading) {
            e.encodeBtn.disabled = true;
            if (e.encodeCancelBtn) e.encodeCancelBtn.style.display = '';
        } else {
            e.encodeBtn.disabled = false;
            if (e.encodeCancelBtn) e.encodeCancelBtn.style.display = 'none';
        }
    }

    _clearEncodeResults() {
        const e = this._els;
        if (e.encodeResult) e.encodeResult.value = '';
        if (e.encodePartial) e.encodePartial.value = '';
        if (e.encodeStats) e.encodeStats.textContent = '';
        if (e.encodeProgressText) e.encodeProgressText.textContent = '';
    }

    _showEncodeProgress(show) {
        const e = this._els;
        if (e.encodeProgress) {
            e.encodeProgress.style.display = show ? '' : 'none';
            if (show) e.encodeProgress.style.color = '';
        }
    }

    _updateEncodeProgressText(text) {
        const e = this._els;
        if (e.encodeProgressText) e.encodeProgressText.textContent = text;
    }

    _updateEncodePhase(phaseName) {
        // Append or show phase indicator in the progress area
        const e = this._els;
        if (e.encodeProgressText) {
            e.encodeProgressText.textContent = `⏳ ${phaseName}`;
        }
    }

    /**
     * Format and display encoding statistics.
     */
    _showEncodeStats(stats) {
        const e = this._els;
        if (!e.encodeStats) return;

        const parts = [];

        if (stats.tokens_generated != null) {
            parts.push(`Токенов: ${stats.tokens_generated}`);
        }
        if (stats.bits_encoded != null) {
            parts.push(`Бит закодировано: ${stats.bits_encoded}`);
        }
        if (stats.bits_total != null) {
            parts.push(`Всего бит: ${stats.bits_total}`);
        }
        if (stats.auto_accepted != null) {
            parts.push(`Авто-принято: ${stats.auto_accepted}`);
        }
        if (stats.auto_rejected != null) {
            parts.push(`Авто-отклонено: ${stats.auto_rejected}`);
        }
        if (stats.completion_tokens != null) {
            parts.push(`Токенов завершения: ${stats.completion_tokens}`);
        }
        if (stats.encoding_time_ms != null) {
            const sec = (stats.encoding_time_ms / 1000).toFixed(1);
            parts.push(`Время: ${sec} с`);
        }
        if (stats.bits_per_token != null) {
            parts.push(`Бит/токен: ${stats.bits_per_token.toFixed(2)}`);
        }

        e.encodeStats.textContent = parts.length > 0 ? parts.join(' · ') : '';
        e.encodeStats.style.display = parts.length > 0 ? '' : 'none';
    }

    /**
     * Format and display decoding statistics.
     */
    _showDecodeStats(stats) {
        const e = this._els;
        if (!e.decodeStats) return;

        const parts = [];

        if (stats.bits_extracted != null) {
            parts.push(`Бит извлечено: ${stats.bits_extracted}`);
        }
        if (stats.tokens_analyzed != null) {
            parts.push(`Токенов проанализировано: ${stats.tokens_analyzed}`);
        }
        if (stats.message_length != null) {
            parts.push(`Длина сообщения: ${stats.message_length}`);
        }
        if (stats.decoding_time_ms != null) {
            const sec = (stats.decoding_time_ms / 1000).toFixed(1);
            parts.push(`Время: ${sec} с`);
        }
        if (stats.confidence != null) {
            parts.push(`Уверенность: ${(stats.confidence * 100).toFixed(1)}%`);
        }

        e.decodeStats.textContent = parts.length > 0 ? parts.join(' · ') : '';
        e.decodeStats.style.display = parts.length > 0 ? '' : 'none';
    }
}
