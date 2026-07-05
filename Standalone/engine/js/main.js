/**
 * Стегонатор — Main Application Entry Point
 *
 * Initializes both:
 *  - Clean Encryption (AES-256-GCM + encoding wrappers)
 *  - Steganography (linguistic stego via Az.js + StegoEngine)
 *
 * Exposes a global API for integration with Tampermonkey, extensions, etc.
 */

import CleanCrypto from './core/clean-crypto.js';
import CompactCipher from './core/compact-cipher.js';
import { getEncoderById, detectEncoder, getEncoderList } from './core/encoders/index.js';
import LayoutSwitchEncoder from './core/encoders/layout-switch-encoder.js';
import { StegoAnalyzer } from './ui/stego-analyzer.js';
import ExtremeChannelManager from './core/extreme-encoding.js';
import { ImageStegoUI } from './ui/image-stego.js';
import { MarkovStegoUI } from './ui/markov-stego-ui.js';
import { LlmStegoUI } from './ui/llm-stego-ui.js';

// ─── Bridge API ──────────────────────────────────────────────
//
// ## Security Model
//
// The bridge is the ONLY communication channel between our
// encryption module and the insecure web messenger.
//
// CRITICAL RULES:
// 1. Outgoing messages contain ONLY encrypted/encoded text — NEVER plaintext or passwords
// 2. Incoming messages only carry (text, chatId, timestamp) — nothing else
// 3. Auto-detection returns ONLY metadata (isEncrypted, algorithm) — NEVER decrypted text
// 4. Decryption is ALWAYS triggered by user action in our UI, never by bridge API calls
// 5. Passwords are NEVER exposed through any API endpoint
// 6. The StegoEngine and CryptoEngine instances are NEVER accessible through the API
//
// ## Supported Platforms
//
// - Android: Two separate WebViews communicating via JSI bridge
// - Python: Two web windows communicating via PyWebView API
// - Browser extension: Extension has isolated context, no bridge needed
// - iframe: postMessage with origin validation
//

class BridgeAPI {
    constructor() {
        this.enabled = true;  // Bridge ON by default — API only accessible within app's own context
        this.method = 'postMessage'; // 'postMessage' | 'jsi' | 'pywebview' | 'clipboard'
        this.targetOrigin = '*';
        this.autoDecode = false;
        this.allowDetection = true;  // Detection ON by default — returns only metadata, never plaintext
        this._incomingCallback = null;
        this._detectCallCount = 0;
        this._detectCallWindow = 0;
        this._DETECT_RATE_LIMIT = 30; // max detection calls per 60 seconds
        this._sessionToken = null;
    }

    /**
     * Generate a new session token for bridge authentication.
     * Must be called before using postMessage communication.
     * @returns {string} The generated session token
     */
    initSessionToken() {
        this._sessionToken = crypto.randomUUID();
        return this._sessionToken;
    }

    /**
     * Get the current session token.
     * @returns {string|null} The current token, or null if not initialized
     */
    getToken() {
        return this._sessionToken;
    }

    configure({ enabled, method, targetOrigin, autoDecode, allowDetection }) {
        if (enabled !== undefined) this.enabled = enabled;
        if (method !== undefined) this.method = method;
        if (targetOrigin !== undefined) this.targetOrigin = targetOrigin;
        if (autoDecode !== undefined) this.autoDecode = autoDecode;
        if (allowDetection !== undefined) this.allowDetection = allowDetection;
    }

    // ─── (a) Send encrypted text TO the messenger ─────────────
    //
    // SECURITY: Only sends the encrypted/encoded text — NEVER the password or plaintext.
    // The messenger only receives opaque ciphertext.

    async send(encryptedText, chatId, timestamp) {
        if (!this.enabled) return false;

        const payload = {
            type: 'stegonator-outgoing',
            text: encryptedText,
            chatId: chatId || '',
            timestamp: timestamp || Date.now()
        };

        switch (this.method) {
            case 'postMessage':
                return this._sendPostMessage(payload);
            case 'jsi':
                return this._sendJSI(payload);
            case 'pywebview':
                return this._sendPyWebView(payload);
            case 'clipboard':
                return this._sendClipboard(payload);
            default:
                return false;
        }
    }

    _sendPostMessage(payload) {
        try {
            // Include session token in outgoing payload for authentication
            payload.token = this._sessionToken;
            if (window.parent !== window) {
                window.parent.postMessage(payload, this.targetOrigin);
                return true;
            }
            if (window.opener) {
                window.opener.postMessage(payload, this.targetOrigin);
                return true;
            }
            return false;
        } catch (e) {
            console.warn('Bridge postMessage failed:', e);
            return false;
        }
    }

    _sendJSI(payload) {
        try {
            if (window.AndroidBridge && window.AndroidBridge.sendMessage) {
                window.AndroidBridge.sendMessage(JSON.stringify(payload));
                return true;
            }
            return false;
        } catch (e) {
            console.warn('Bridge JSI failed:', e);
            return false;
        }
    }

    _sendPyWebView(payload) {
        try {
            if (window.pywebview && window.pywebview.api && window.pywebview.api.on_message) {
                window.pywebview.api.on_message(JSON.stringify(payload));
                return true;
            }
            return false;
        } catch (e) {
            console.warn('Bridge PyWebView failed:', e);
            return false;
        }
    }

    async _sendClipboard(payload) {
        try {
            await navigator.clipboard.writeText(payload.text);
            return true;
        } catch (e) {
            console.warn('Bridge clipboard failed:', e);
            return false;
        }
    }

    // ─── (b) Receive text FROM the messenger for decryption ───
    //
    // SECURITY: Only receives (text, chatId, timestamp).
    // The messenger cannot access the decryption engine or passwords.
    // Decryption happens entirely within our isolated context.

    listen(callback) {
        this._incomingCallback = callback;

        // postMessage listener (iframe, extension content script)
        window.addEventListener('message', (event) => {
            if (!this.enabled) return;

            // Origin validation: reject messages from unexpected origins
            if (this.targetOrigin !== '*' && event.origin !== this.targetOrigin) {
                console.warn('Bridge: rejected message from untrusted origin:', event.origin);
                return;
            }

            const data = event.data;
            if (data && data.type === 'stegonator-incoming') {
                // Token validation: require matching session token
                if (!this._sessionToken) {
                    console.warn('Bridge: rejected incoming message — no session token initialized');
                    return;
                }
                if (data.token !== this._sessionToken) {
                    console.warn('Bridge: rejected incoming message — token mismatch');
                    return;
                }

                this._handleIncoming({
                    text: String(data.text || ''),
                    chatId: String(data.chatId || ''),
                    timestamp: Number(data.timestamp) || Date.now()
                });
            }
        });

        // JSI listener (Android WebView bridge)
        // The Android bridge calls this method to deliver incoming messages
        window.StegonatorBridge = {
            onIncoming: (jsonStr) => {
                if (!this.enabled) return;
                try {
                    const data = JSON.parse(jsonStr);
                    this._handleIncoming({
                        text: String(data.text || ''),
                        chatId: String(data.chatId || ''),
                        timestamp: Number(data.timestamp) || Date.now()
                    });
                } catch (e) {
                    console.warn('Bridge JSI incoming parse error:', e);
                }
            },
            // Detection request from the messenger side
            detect: (jsonStr) => {
                if (!this.enabled || !this.allowDetection) {
                    return JSON.stringify({ isEncrypted: false, algorithm: null, isStego: false });
                }
                try {
                    const data = JSON.parse(jsonStr);
                    const result = this.detectEncryption(String(data.text || ''));
                    return JSON.stringify(result);
                } catch (e) {
                    return JSON.stringify({ isEncrypted: false, algorithm: null, isStego: false, error: 'Detection failed' });
                }
            }
        };

        // PyWebView listener
        if (window.pywebview) {
            // PyWebView can call our bridge methods directly
            window.pywebview.api.stegonator_incoming = (jsonStr) => {
                if (!this.enabled) return;
                try {
                    const data = typeof jsonStr === 'string' ? JSON.parse(jsonStr) : jsonStr;
                    this._handleIncoming({
                        text: String(data.text || ''),
                        chatId: String(data.chatId || ''),
                        timestamp: Number(data.timestamp) || Date.now()
                    });
                } catch (e) {
                    console.warn('Bridge PyWebView incoming parse error:', e);
                }
            };
        }
    }

    _handleIncoming(safeData) {
        // Validate input lengths to prevent abuse
        if (safeData.text.length > 100000) {
            console.warn('Bridge: incoming text too long, ignoring');
            return;
        }
        if (safeData.chatId.length > 256) {
            console.warn('Bridge: incoming chatId too long, ignoring');
            return;
        }

        if (this._incomingCallback) {
            this._incomingCallback(safeData);
        }
    }

    // ─── (c) Auto-detection: is text encrypted? Which algorithm? ─
    //
    // SECURITY: Returns ONLY metadata — never decrypts, never returns plaintext.
    // This endpoint allows the bridge to check if a message looks encrypted
    // so it can route it to our module for decryption.
    //
    // Returns:
    //   { isEncrypted: boolean, algorithm: string|null, isStego: boolean, stegoCapacity: number }
    //
    // Detection order:
    //   1. Check CRY magic bytes → AES-256-GCM (CleanCrypto)
    //   2. Check encoder signatures → base64, invisible, emoji, chinese, compression, layout
    //   3. Check steganographic capacity → linguistic stego

    detectEncryption(text) {
        if (!text || typeof text !== 'string') {
            return { isEncrypted: false, algorithm: null, isStego: false, stegoCapacity: 0 };
        }

        // Rate limiting
        const now = Date.now();
        if (now - this._detectCallWindow > 60000) {
            this._detectCallCount = 0;
            this._detectCallWindow = now;
        }
        this._detectCallCount++;
        if (this._detectCallCount > this._DETECT_RATE_LIMIT) {
            return { isEncrypted: false, algorithm: null, isStego: false, stegoCapacity: 0, rateLimited: true };
        }

        // 1. Check CRY magic bytes (0x43, 0x52, 0x59) → AES-256-GCM from CleanCrypto
        const cryBytes = _base64urlToBytes(text);
        if (cryBytes && cryBytes.length >= 3 &&
            cryBytes[0] === 0x43 && cryBytes[1] === 0x52 && cryBytes[2] === 0x59) {
            return { isEncrypted: true, algorithm: 'AES-256-GCM', isStego: false, stegoCapacity: 0 };
        }

        // 2. Check encoder signatures (base64, invisible, emoji, chinese, compression, layout)
        try {
            const encoder = detectEncoder(text);
            if (encoder) {
                return { isEncrypted: true, algorithm: encoder.label || encoder.id, isStego: false, stegoCapacity: 0 };
            }
        } catch (e) { /* detection failed */ }

        // 3. Check layout switch (Cyrillic text with Latin layout or vice versa)
        try {
            const layoutDecoded = LayoutSwitchEncoder.decodeToString(text);
            if (layoutDecoded && layoutDecoded !== text) {
                return { isEncrypted: true, algorithm: 'Раскладка', isStego: false, stegoCapacity: 0 };
            }
        } catch (e) { /* not layout switch */ }

        // 4. Check steganographic capacity (without decrypting!)
        //    If the text has capacity in our stego channels, it MIGHT contain hidden data.
        //    This is a heuristic — it can't confirm stego without the password.
        if (state.stegoReady && state.stegoAnalyzer) {
            try {
                const autoChannels = state.stegoAnalyzer.getAutoChannels(text);
                if (autoChannels.length > 0) {
                    const analysis = state.stegoEngine.analyzeCarrier(text);
                    if (analysis.totalBits > 0) {
                        return {
                            isEncrypted: true,
                            algorithm: 'Стего',
                            isStego: true,
                            stegoCapacity: analysis.totalBits,
                            stegoChannels: autoChannels.length
                        };
                    }
                }
            } catch (e) { /* stego analysis failed */ }
        }

        return { isEncrypted: false, algorithm: null, isStego: false, stegoCapacity: 0 };
    }

    // ─── Internal: Auto-decode (only called by bridge listener) ──
    //
    // SECURITY: This is an INTERNAL method — NOT exposed through the public API.
    // It's only called by the bridge incoming message handler when autoDecode is enabled.
    // The result is shown in our UI only — never sent back through the bridge.

    async _tryAutoDecode(text, password, chatId) {
        if (!text || !password) return null;

        // 1. Try clean encryption auto-detect (base64, invisible, emoji, etc.)
        try {
            const encoder = detectEncoder(text);
            if (encoder) {
                let decodedBytes;
                if (encoder.decode.constructor.name === 'AsyncFunction') {
                    decodedBytes = await encoder.decode(text);
                } else {
                    decodedBytes = encoder.decode(text);
                }
                if (decodedBytes) {
                    try {
                        const decrypted = await cleanCrypto.decrypt(decodedBytes, password, chatId);
                        return { text: decrypted, method: encoder.label || 'auto' };
                    } catch (e) { /* wrong password or not encrypted */ }
                }
            }
        } catch (e) { /* detection failed */ }

        // 2. Try AES-256 base64
        try {
            const bytes = _base64urlToBytes(text);
            if (bytes) {
                const decrypted = await cleanCrypto.decrypt(bytes, password, chatId);
                return { text: decrypted, method: 'AES-256' };
            }
        } catch (e) { /* not AES-256 */ }

        // 3. Try steganography decode (if engine is ready)
        if (state.stegoReady && state.stegoEngine) {
            try {
                // Используем ВСЕ каналы по умолчанию (same fix as handleStegoDecode)
                state.stegoEngine._setDefaultChannels();
                const message = await state.stegoEngine.decodeMessage(text, password);
                return { text: message, method: 'Стего' };
            } catch (e) { /* not stego text */ }
        }

        // 4. Try compact cipher (before layout — MAC-validated, no false positives)
        if (text.length >= 12 && CompactCipher.isSupported(text)) {
            try {
                const compactDecoded = await compactCipher.decrypt(text, password, chatId);
                if (compactDecoded !== null) {
                    return { text: compactDecoded, method: 'Компактный' };
                }
            } catch (e) { /* not compact cipher */ }
        }

        return null;
    }

    // ─── Safe stego encode (for bridge use) ────────────────────
    //
    // SECURITY: Returns only stego text — never the plaintext secret.
    // The bridge caller gets the encoded carrier text, nothing else.

    async stegoEncode(secretMessage, carrierText, password) {
        if (!this.enabled) return null;
        if (!state.stegoReady || !state.stegoEngine) return null;
        try {
            const autoChannels = state.stegoAnalyzer
                ? state.stegoAnalyzer.getAutoChannels(carrierText)
                : [];
            if (autoChannels.length > 0) {
                state.stegoEngine.setActiveChannels(autoChannels);
            }
            return await state.stegoEngine.encodeMessage(secretMessage, carrierText, password);
        } catch (e) {
            return null;
        }
    }

    // ─── Safe stego decode (for bridge use) ────────────────────
    //
    // SECURITY: Returns decoded text — but ONLY for the trusted bridge.
    // This is NOT exposed through the public web API.

    async stegoDecode(stegoText, password) {
        if (!this.enabled) return null;
        if (!state.stegoReady || !state.stegoEngine) return null;
        try {
            // Используем ВСЕ каналы по умолчанию (same fix as handleStegoDecode)
            state.stegoEngine._setDefaultChannels();
            return await state.stegoEngine.decodeMessage(stegoText, password);
        } catch (e) {
            return null;
        }
    }
}

const bridge = new BridgeAPI();

// ─── Send Callback (for FAB / external integration) ───────────
// Set via StegonatorAPI.setSendCallback(fn)
// fn(text, mode) — mode is 'encryption' | 'steganography'
let _sendCallback = null;

// ─── State ───────────────────────────────────────────────────

const state = {
    mode: 'encryption',        // 'encryption' | 'steganography'
    subMode: 'aes256',         // encryption: aes256, invisible, base64, compression, emoji, chinese, layout, compact
                               // stego: stego-encode, stego-decode, stego-recovery
    direction: 'encode',       // 'encode' | 'decode'
    chatId: '',
    stegoReady: false,
    stegoEngine: null,
    stegoAnalyzer: null,       // StegoAnalyzer instance for real-time analysis
    charLimit: 4096,
    _lsEditMode: false,        // true = LS mutations stripped for form editing
    _extremeManager: null,   // ExtremeChannelManager instance (set after engine loads)
    _extremeMethods: [],       // Active extreme method names
};

// ─── DOM References ──────────────────────────────────────────

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const dom = {
    loading: $('#loading'),
    loadingProgress: $('#loadingProgressBar'),
    // Header
    chatIdDisplay: $('#chatIdDisplay'),
    btnSettings: $('#btnSettings'),
    // Tabs
    mainTabs: $('#mainTabs'),
    subtabsEncryption: $('#subtabsEncryption'),
    subtabsSteganography: $('#subtabsSteganography'),
    subtabsImages: $('#subtabsImages'),
    subtabsMarkov: $('#subtabsMarkov'),
    subtabsLlm: $('#subtabsLlm'),
    // Encryption input
    panelEncryption: $('#panelEncryption'),
    encryptInput: $('#encryptInput'),
    encryptPassword: $('#encryptPassword'),
    btnToggleEncryptPw: $('#btnToggleEncryptPw'),
    encryptDirection: $('#encryptDirection'),
    btnEncryptSend: $('#btnEncryptSend'),
    btnEncryptCopy: $('#btnEncryptCopy'),
    // Encryption result preview
    encryptResultSection: $('#encryptResultSection'),
    encryptResultPreview: $('#encryptResultPreview'),
    btnEncryptResultCopy: $('#btnEncryptResultCopy'),
    btnBridgeSend: $('#btnBridgeSend'),
    // Stego encode
    panelStegoEncode: $('#panelStegoEncode'),
    secretMessage: $('#secret-message'),
    carrierText: $('#carrier-text'),
    passwordEncode: $('#password-encode'),
    btnToggleStegoEncPw: $('#btnToggleStegoEncPw'),
    btnEncode: $('#btn-encode'),
    outputText: $('#output-text'),
    btnCopy: $('#btn-copy'),
    // Stego decode
    panelStegoDecode: $('#panelStegoDecode'),
    stegoText: $('#stego-text'),
    passwordDecode: $('#password-decode'),
    btnToggleStegoDecPw: $('#btnToggleStegoDecPw'),
    btnDecode: $('#btn-decode'),
    decodedMessage: $('#decoded-message'),
    // Stego recovery
    panelStegoRecovery: $('#panelStegoRecovery'),
    recoveryText: $('#recovery-text'),
    passwordRecovery: $('#password-recovery'),
    btnToggleStegoRecPw: $('#btnToggleStegoRecPw'),
    btnRecovery: $('#btn-recovery'),
    recoveryResult: $('#recovery-result'),
    // Extreme stego
    panelStegoExtreme: $('#panelStegoExtreme'),
    extremeSecret: $('#extreme-secret'),
    extremeCarrier: $('#extreme-carrier'),
    extremeStegoText: $('#extreme-stego-text'),
    extremePassword: $('#extreme-password'),
    extremeMethodZW: $('#extremeMethodZW'),
    extremeMethodSpaces: $('#extremeMethodSpaces'),
    extremeMethodCase: $('#extremeMethodCase'),
    extremeMethodCyrLat: $('#extremeMethodCyrLat'),
    extremeCapacity: $('#extreme-capacity'),
    extremeCapZW: $('#extremeCapZW'),
    extremeCapSpaces: $('#extremeCapSpaces'),
    extremeCapCase: $('#extremeCapCase'),
    extremeCapCyrLat: $('#extremeCapCyrLat'),
    extremeOutput: $('#extreme-output'),
    btnExtremeAction: $('#btn-extreme-action'),
    btnExtremeCopy: $('#btn-extreme-copy'),
    extremeEncodeSection: $('#extremeEncodeSection'),
    extremeDecodeSection: $('#extremeDecodeSection'),
    extremeDetectedMethods: $('#extremeDetectedMethods'),
    extremeDetectedList: $('#extremeDetectedList'),
    extremeDirection: $('#extremeDirection'),
    // Settings
    settingsOverlay: $('#settingsOverlay'),
    settingsPanel: $('#settingsPanel'),
    btnCloseSettings: $('#btnCloseSettings'),
    stegoChannelsSection: $('#stegoChannelsSection'),
    settingCurrentChatId: $('#settingCurrentChatId'),
    settingRememberPw: $('#settingRememberPw'),
    newChatIdInput: $('#newChatIdInput'),
    newChatPwInput: $('#newChatPwInput'),
    btnAddChatPw: $('#btnAddChatPw'),
    chatPasswordList: $('#chatPasswordList'),
    synThreshold: $('#syn-threshold'),
    thresholdVal: $('#threshold-val'),
    // Stats
    statChannels: $('#stat-channels'),
    statBits: $('#stat-bits'),
    statEfficiency: $('#stat-efficiency'),
    statTime: $('#stat-time'),
    secretLength: $('#secret-length'),
    secretBytes: $('#secret-bytes'),
    // Toast
    toastArea: $('#toastArea'),
    // Floating Action Button
    btnFabSend: $('#btnFabSend'),
    // Extreme encoding controls
    extremeCaseLadder: $('#extremeCaseLadder'),
    extremeZeroWidth: $('#extremeZeroWidth'),
    extremeCyrillicLatin: $('#extremeCyrillicLatin'),
    extremeCapacity: $('#extreme-capacity'),
    extremeWarning: $('#extreme-warning'),
    extremeDisabledInfo: $('#extreme-disabled-info'),
    // Image stego
    panelImageStego: $('#panelImageStego'),
    // Markov stego
    panelMarkovStego: $('#panelMarkovStego'),
    markovSecretInput: $('#markovSecretInput'),
    markovCorpusSelect: $('#markovCorpusSelect'),
    markovLoadCorpusBtn: $('#markovLoadCorpusBtn'),
    markovNGramOrder: $('#markovNGramOrder'),
    markovEncodeBtn: $('#markovEncodeBtn'),
    markovEncodeProgress: $('#markovEncodeProgress'),
    markovEncodeProgressBar: $('#markovEncodeProgressBar'),
    markovEncodeProgressText: $('#markovEncodeProgressText'),
    markovEncodeResult: $('#markovEncodeResult'),
    markovCorpusInfo: $('#markovCorpusInfo'),
    markovUnloadCorpusBtn: $('#markovUnloadCorpusBtn'),
    markovDecodeSection: $('#markovDecodeSection'),
    markovDecodeInput: $('#markovDecodeInput'),
    markovDecodeCorpusSelect: $('#markovDecodeCorpusSelect'),
    markovDecodeBtn: $('#markovDecodeBtn'),
    markovDecodeResult: $('#markovDecodeResult'),
    markovDecodeProgress: $('#markovDecodeProgress'),
    markovDecodeProgressText: $('#markovDecodeProgressText'),
    markovEncodeSection: $('#markovEncodeSection'),
    markovCopyResult: $('#markovCopyResult'),
    markovCopyDecodeResult: $('#markovCopyDecodeResult'),
    // LLM stego
    panelLlmStego: $('#panelLlmStego'),
    llmEndpointInput: $('#llmEndpointInput'),
    llmPortInput: $('#llmPortInput'),
    llmConnectBtn: $('#llmConnectBtn'),
    llmStatusDot: $('#llmStatusDot'),
    llmStatusText: $('#llmStatusText'),
    llmSecretInput: $('#llmSecretInput'),
    llmSeedText: $('#llmSeedText'),
    llmContext: $('#llmContext'),
    llmTopK: $('#llmTopK'),
    llmTemperature: $('#llmTemperature'),
    llmAutoAccept: $('#llmAutoAccept'),
    llmNaturalCompletion: $('#llmNaturalCompletion'),
    llmStreamToggle: $('#llmStreamToggle'),
    llmEncodeBtn: $('#llmEncodeBtn'),
    llmEncodeCancelBtn: $('#llmEncodeCancelBtn'),
    llmEncodeProgress: $('#llmEncodeProgress'),
    llmEncodeProgressBar: $('#llmEncodeProgressBar'),
    llmEncodeProgressText: $('#llmEncodeProgressText'),
    llmEncodePartial: $('#llmEncodePartial'),
    llmEncodePartialSection: $('#llmEncodePartialSection'),
    llmEncodeResult: $('#llmEncodeResult'),
    llmEncodeResultSection: $('#llmEncodeResultSection'),
    llmEncodeStats: $('#llmEncodeStats'),
    llmEncodeSection: $('#llmEncodeSection'),
    llmCapacityBtn: $('#llmCapacityBtn'),
    llmCapacityResult: $('#llmCapacityResult'),
    llmCapacityText: $('#llmCapacityText'),
    llmDecodeSection: $('#llmDecodeSection'),
    llmDecodeInput: $('#llmDecodeInput'),
    llmDecodeContext: $('#llmDecodeContext'),
    llmDecodeTopK: $('#llmDecodeTopK'),
    llmDecodeBtn: $('#llmDecodeBtn'),
    llmDecodeResult: $('#llmDecodeResult'),
    llmDecodeResultSection: $('#llmDecodeResultSection'),
    llmDecodeStats: $('#llmDecodeStats'),
    llmDecodeProgress: $('#llmDecodeProgress'),
    llmDecodeProgressText: $('#llmDecodeProgressText'),
    llmCopyResult: $('#llmCopyResult'),
    llmCopyDecodeResult: $('#llmCopyDecodeResult'),
};

// ─── Clean Crypto Instance ───────────────────────────────────

const cleanCrypto = new CleanCrypto();
const compactCipher = new CompactCipher();

// ─── Toast ───────────────────────────────────────────────────

function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `cm-toast cm-toast--${type}`;
    toast.textContent = message;
    dom.toastArea.appendChild(toast);

    setTimeout(() => {
        toast.classList.add('removing');
        setTimeout(() => toast.remove(), 250);
    }, 2500);
}

// Expose globally so non-module scripts (loaded via _loadScript) can use it
window.showToast = showToast;

// ─── Helpers ─────────────────────────────────────────────────

function _escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ─── Mode Switching ──────────────────────────────────────────

function switchMainMode(category) {
    state.mode = category;

    // Update tabs
    $$('.cm-tab').forEach(t => t.classList.toggle('active', t.dataset.category === category));

    // Show/hide subtabs
    dom.subtabsEncryption.classList.toggle('cm-hidden', category !== 'encryption');
    dom.subtabsSteganography.classList.toggle('cm-hidden', category !== 'steganography');
    if (dom.subtabsImages) dom.subtabsImages.classList.toggle('cm-hidden', category !== 'images');
    if (dom.subtabsMarkov) dom.subtabsMarkov.classList.toggle('cm-hidden', category !== 'markov');
    if (dom.subtabsLlm) dom.subtabsLlm.classList.toggle('cm-hidden', category !== 'llm');

    // Show/hide stego channels in settings
    dom.stegoChannelsSection.classList.toggle('visible', category === 'steganography');

    // Set default sub-mode
    if (category === 'encryption') {
        switchSubMode('aes256');
    } else if (category === 'images') {
        switchSubMode('img-encode');
    } else if (category === 'markov') {
        switchSubMode('markov-encode');
    } else if (category === 'llm') {
        switchSubMode('llm-encode');
    } else {
        switchSubMode('stego-encode');
    }

    _updateFabState();
}

function switchSubMode(mode) {
    state.subMode = mode;

    // Update subtab pills
    $$('.cm-subtab').forEach(s => s.classList.toggle('active', s.dataset.mode === mode));

    // Show correct input panel
    dom.panelEncryption.classList.toggle('active', mode !== 'stego-encode' && mode !== 'stego-decode' && mode !== 'stego-recovery' && mode !== 'stego-extreme' && mode !== 'img-encode' && mode !== 'img-decode' && mode !== 'markov-encode' && mode !== 'markov-decode' && mode !== 'llm-encode' && mode !== 'llm-decode');
    dom.panelStegoEncode.classList.toggle('active', mode === 'stego-encode');
    dom.panelStegoDecode.classList.toggle('active', mode === 'stego-decode');
    dom.panelStegoRecovery.classList.toggle('active', mode === 'stego-recovery');
    dom.panelStegoExtreme.classList.toggle('active', mode === 'stego-extreme');
    if (dom.panelImageStego) dom.panelImageStego.classList.toggle('active', mode === 'img-encode' || mode === 'img-decode');
    if (dom.panelMarkovStego) dom.panelMarkovStego.classList.toggle('active', mode === 'markov-encode' || mode === 'markov-decode');
    if (dom.panelLlmStego) dom.panelLlmStego.classList.toggle('active', mode === 'llm-encode' || mode === 'llm-decode');

    _updateFabState();
}

function switchDirection(dir) {
    state.direction = dir;
    $$('.cm-direction-toggle__btn').forEach(b => b.classList.toggle('active', b.dataset.direction === dir));

    // Update placeholder
    if (dir === 'encode') {
        dom.encryptInput.placeholder = 'Введите сообщение для шифрования…';
    } else {
        dom.encryptInput.placeholder = 'Вставьте зашифрованное сообщение…';
    }

    // Hide encryption result preview when switching direction
    if (dom.encryptResultSection) {
        dom.encryptResultSection.style.display = 'none';
    }
    if (dom.encryptResultPreview) {
        dom.encryptResultPreview.textContent = '';
    }
    const previewIndicator = dom.encryptResultSection?.querySelector('.cm-preview-indicator');
    if (previewIndicator) {
        previewIndicator.textContent = 'Предпросмотр';
        previewIndicator.style.color = 'var(--cm-text-muted)';
    }

    _updateFabState();
}

// ─── Encryption Result Preview ───────────────────────────────

function _showEncryptResult(text) {
    if (dom.encryptResultPreview) {
        dom.encryptResultPreview.textContent = text;
    }
    if (dom.encryptResultSection) {
        dom.encryptResultSection.style.display = '';
    }
    _updateFabState();
}

// ─── Live Encryption Preview ─────────────────────────────────

let _encryptPreviewTimer = null;
function _tryEncryptPreview() {
    clearTimeout(_encryptPreviewTimer);
    _encryptPreviewTimer = setTimeout(async () => {
        // Only preview in encode direction with text + password
        if (state.direction !== 'encode') return;

        const text = dom.encryptInput?.value?.trim();
        const password = _getPassword();

        if (!text || !password) {
            // Clear preview if missing requirements
            if (dom.encryptResultPreview) dom.encryptResultPreview.textContent = '';
            if (dom.encryptResultSection) dom.encryptResultSection.style.display = 'none';
            return;
        }

        try {
            let result;

            if (state.subMode === 'layout') {
                result = LayoutSwitchEncoder.encodeString(text, false);
            } else if (state.subMode === 'aes256') {
                const encrypted = await cleanCrypto.encrypt(text, password, state.chatId);
                result = _bytesToBase64url(encrypted);
            } else if (state.subMode === 'compact') {
                result = await compactCipher.encrypt(text, password, state.chatId);
            } else {
                const encrypted = await cleanCrypto.encrypt(text, password, state.chatId);
                const encoder = getEncoderById(state.subMode === 'invisible' ? 'invisible-spaces'
                    : state.subMode === 'base64' ? 'base64'
                    : state.subMode === 'compression' ? 'compression'
                    : state.subMode === 'emoji' ? 'emoji'
                    : state.subMode === 'chinese' ? 'chinese'
                    : null);

                if (!encoder) return;

                if (encoder.encode.constructor.name === 'AsyncFunction') {
                    result = await encoder.encode(encrypted);
                } else {
                    result = encoder.encode(encrypted);
                }
            }

            if (result && dom.encryptResultPreview) {
                dom.encryptResultPreview.textContent = result;
                // Mark as preview
                const previewIndicator = dom.encryptResultSection?.querySelector('.cm-preview-indicator');
                if (previewIndicator) previewIndicator.textContent = 'Предпросмотр';
                if (dom.encryptResultSection) dom.encryptResultSection.style.display = '';

                // Auto roundtrip validation (non-blocking)
                _autoEncryptRoundtrip(result, text, password);
            }
        } catch (e) {
            // Silent fail for preview
        }
    }, 300);
}

// ─── Auto Encrypt Roundtrip Validation ─────────────────────────

let _encryptRoundtripTimer = null;
function _autoEncryptRoundtrip(encryptedText, originalText, password) {
    clearTimeout(_encryptRoundtripTimer);
    _encryptRoundtripTimer = setTimeout(async () => {
        const indicator = dom.encryptResultSection?.querySelector('.cm-preview-indicator');
        try {
            let decrypted;
            if (state.subMode === 'layout') {
                decrypted = LayoutSwitchEncoder.decodeToString(encryptedText);
            } else if (state.subMode === 'aes256') {
                const bytes = _base64urlToBytes(encryptedText);
                if (!bytes) throw new Error('Invalid base64');
                decrypted = await cleanCrypto.decrypt(bytes, password, state.chatId);
            } else if (state.subMode === 'compact') {
                decrypted = await compactCipher.decrypt(encryptedText, password, state.chatId);
                if (decrypted === null) throw new Error('Compact decrypt failed');
            } else {
                const encoder = detectEncoder(encryptedText);
                if (!encoder) throw new Error('Cannot detect encoder');
                let decodedBytes;
                if (encoder.decode.constructor.name === 'AsyncFunction') {
                    decodedBytes = await encoder.decode(encryptedText);
                } else {
                    decodedBytes = encoder.decode(encryptedText);
                }
                if (!decodedBytes) throw new Error('Decode failed');
                decrypted = await cleanCrypto.decrypt(decodedBytes, password, state.chatId);
            }
            
            if (decrypted === originalText) {
                if (indicator) indicator.textContent = '✅ Валидно';
                if (indicator) indicator.style.color = '#4ade80';
            } else {
                if (indicator) indicator.textContent = '⚠ Несовпадение';
                if (indicator) indicator.style.color = '#fbbf24';
            }
        } catch (e) {
            if (indicator) indicator.textContent = '❌ Ошибка валидации';
            if (indicator) indicator.style.color = '#f87171';
        }
    }, 100);
}

// ─── Floating Action Button (FAB) ──────────────────────────────

function _updateFabState() {
    if (!dom.btnFabSend) return;

    let hasOutput = false;

    if (state.mode === 'encryption' && state.direction === 'encode') {
        const sectionVisible = dom.encryptResultSection
            && dom.encryptResultSection.style.display !== 'none';
        const resultText = dom.encryptResultPreview?.textContent?.trim();
        hasOutput = sectionVisible && !!resultText;
    } else if (state.mode === 'steganography' && state.subMode === 'stego-encode') {
        hasOutput = !!state._lastStegoText;
    } else if (state.mode === 'steganography' && state.subMode === 'stego-extreme') {
        const text = dom.extremeOutput?.textContent?.trim();
        hasOutput = !!text && !text.startsWith('\u26a0');
    } else if (state.mode === 'images') {
        hasOutput = !!state._lastImageStegoDataUrl;
    }

    dom.btnFabSend.disabled = !hasOutput;
    dom.btnFabSend.classList.toggle('cm-fab--ready', hasOutput);
}

async function handleFabSend() {
    let outputText = null;
    let mode = state.mode;

    if (state.mode === 'encryption') {
        if (state.direction !== 'encode') {
            showToast('Отправка доступна только в режиме шифрования', 'warning');
            return;
        }
        outputText = dom.encryptResultPreview?.textContent?.trim();
        if (!outputText) {
            showToast('Сначала зашифруйте сообщение', 'warning');
            return;
        }
    } else if (state.mode === 'steganography') {
        if (state.subMode === 'stego-encode') {
            outputText = state._lastStegoText;
            if (!outputText) {
                showToast('Сначала закодируйте сообщение', 'warning');
                return;
            }
        } else if (state.subMode === 'stego-extreme') {
            const dir = state._extremeDirection || 'encode';
            if (dir === 'encode') {
                outputText = dom.extremeOutput?.textContent?.trim();
                if (!outputText || outputText.startsWith('\u26a0')) {
                    showToast('Сначала закодируйте сообщение', 'warning');
                    return;
                }
            } else {
                outputText = dom.extremeOutput?.textContent?.trim();
                if (!outputText || outputText.startsWith('\u26a0')) {
                    showToast('Сначала декодируйте сообщение', 'warning');
                    return;
                }
            }
        } else {
            showToast('Отправка доступна только в режиме кодирования', 'warning');
            return;
        }
    } else if (state.mode === 'images') {
        if (!state._lastImageStegoDataUrl) {
            showToast('Сначала создайте стего-изображение', 'warning');
            return;
        }
        // For image stego, send via bridge with image data
        if (_sendCallback) {
            try {
                await _sendCallback(state._lastImageStegoDataUrl, 'images', { blob: state._lastImageStegoBlob });
                showToast('Отправлено', 'success');
            } catch (e) {
                showToast('Ошибка отправки: ' + e.message, 'error');
                console.error('FAB send error:', e);
            }
            return;
        } else if (bridge.enabled) {
            // Can't send image via bridge text API — notify user
            showToast('Используйте скачивание или функцию отправки для изображений', 'info');
            return;
        } else {
            showToast('Отправка изображений не настроена. Используйте StegonatorAPI.setSendCallback(fn)', 'info');
            return;
        }
    }

    if (_sendCallback) {
        try {
            await _sendCallback(outputText, mode);
            showToast('Отправлено', 'success');
        } catch (e) {
            showToast('Ошибка отправки: ' + e.message, 'error');
            console.error('FAB send error:', e);
        }
    } else if (bridge.enabled) {
        const sent = await bridge.send(outputText, state.chatId);
        if (sent) {
            showToast('Отправлено через мост', 'success');
        } else {
            showToast('Мост не подключён', 'warning');
        }
    } else {
        showToast('Отправка не настроена. Используйте StegonatorAPI.setSendCallback(fn)', 'info');
    }
}

// ─── Clean Encryption ────────────────────────────────────────

async function handleEncryptSend() {
    // In decode mode, only strip ASCII whitespace (tabs, newlines, regular spaces).
    // Do NOT use .trim() — it strips Unicode Zs characters (NBSP, Em Space, etc.)
    // which are used as data in the invisible encoder.
    let text;
    if (state.direction === 'decode') {
        text = dom.encryptInput.value.replace(/^[\t\n\r ]+/, '').replace(/[\t\n\r ]+$/, '');
    } else {
        text = dom.encryptInput.value.trim();
    }
    if (!text) return;

    const password = _getPassword();
    const chatId = state.chatId;

    if (state.direction === 'encode') {
        // ENCODE
        try {
            let result;

            if (state.subMode === 'layout') {
                // Layout switch (no encryption, just obfuscation)
                result = LayoutSwitchEncoder.encodeString(text, false);
                showToast('Закодировано сменой раскладки', 'success');
            } else if (state.subMode === 'aes256') {
                // AES-256 with base64 output
                const encrypted = await cleanCrypto.encrypt(text, password, chatId);
                result = _bytesToBase64url(encrypted);
                showToast('Зашифровано AES-256-GCM', 'success');
            } else if (state.subMode === 'compact') {
                // Compact cipher: length-preserving, no inflation
                result = await compactCipher.encrypt(text, password, chatId);
                showToast('Зашифровано компактным шифром (1:1)', 'success');
            } else {
                // Other encoders: encrypt first, then encode
                const encrypted = await cleanCrypto.encrypt(text, password, chatId);
                const encoder = getEncoderById(state.subMode === 'invisible' ? 'invisible-spaces'
                    : state.subMode === 'base64' ? 'base64'
                    : state.subMode === 'compression' ? 'compression'
                    : state.subMode === 'emoji' ? 'emoji'
                    : state.subMode === 'chinese' ? 'chinese'
                    : null);

                if (!encoder) {
                    showToast('Неизвестный кодировщик', 'error');
                    return;
                }

                if (encoder.encode.constructor.name === 'AsyncFunction') {
                    result = await encoder.encode(encrypted);
                } else {
                    result = encoder.encode(encrypted);
                }

                const label = encoder.label || state.subMode;
                showToast(`Зашифровано (${label})`, 'success');
            }

            // Show result in preview
            _showEncryptResult(result);

            // Try custom sendCallback first, then bridge
            if (_sendCallback) {
                try {
                    await _sendCallback(result, 'encryption');
                    showToast('Отправлено', 'success');
                } catch (e) {
                    showToast('Ошибка отправки: ' + e.message, 'error');
                }
            } else if (bridge.enabled) {
                const sent = await bridge.send(result, chatId);
                if (sent) {
                    showToast('Отправлено через мост', 'success');
                }
            }

            dom.encryptInput.value = '';
        } catch (e) {
            showToast('Ошибка шифрования: ' + e.message, 'error');
            console.error(e);
        }
    } else {
        // DECODE
        try {
            let decoded;

            if (state.subMode === 'layout') {
                decoded = LayoutSwitchEncoder.decodeToString(text);
                if (decoded) {
                    _showEncryptResult(decoded);
                    showToast('Декодировано', 'success');
                } else {
                    showToast('Не удалось определить раскладку', 'error');
                }
            } else if (state.subMode === 'aes256') {
                // Try base64 decode first
                const bytes = _base64urlToBytes(text);
                if (bytes) {
                    decoded = await cleanCrypto.decrypt(bytes, password, chatId);
                    _showEncryptResult(decoded);
                    showToast('Дешифровано', 'success');
                } else {
                    showToast('Неверный формат Base64', 'error');
                }
            } else if (state.subMode === 'compact') {
                // Compact cipher: length-preserving, MAC-validated
                decoded = await compactCipher.decrypt(text, password, chatId);
                if (decoded !== null) {
                    _showEncryptResult(decoded);
                    showToast('Дешифровано (компактный шифр)', 'success');
                } else {
                    showToast('Не удалось расшифровать: неверный пароль или данные', 'error');
                }
            } else {
                // Auto-detect encoder and decode
                const encoder = detectEncoder(text);
                if (!encoder) {
                    showToast('Не удалось определить тип кодировки', 'error');
                    return;
                }

                let decodedBytes;
                if (encoder.decode.constructor.name === 'AsyncFunction') {
                    decodedBytes = await encoder.decode(text);
                } else {
                    decodedBytes = encoder.decode(text);
                }

                if (!decodedBytes) {
                    showToast('Ошибка декодирования', 'error');
                    return;
                }

                // Try to decrypt
                try {
                    decoded = await cleanCrypto.decrypt(decodedBytes, password, chatId);
                    _showEncryptResult(decoded);
                    showToast(`Дешифровано (${encoder.label})`, 'success');
                } catch (e) {
                    showToast('Неверный пароль или повреждённые данные', 'error');
                }
            }

            dom.encryptInput.value = '';
        } catch (e) {
            showToast('Ошибка дешифровки: ' + e.message, 'error');
            console.error(e);
        }
    }
}

// ─── Steganography ───────────────────────────────────────────

async function handleStegoEncode() {
    if (!state.stegoReady) {
        showToast('Движок стеганографии ещё загружается…', 'warning');
        return;
    }

    // Prevent concurrent encode calls (e.g., from live preview timer + checkbox change)
    if (_stegoEncodingInProgress) return;

    const secret = dom.secretMessage.value;
    const carrier = dom.carrierText.value;
    const password = dom.passwordEncode.value;

    if (!secret || !carrier || !password) {
        showToast('Заполните все поля!', 'error');
        return;
    }

    dom.btnEncode.disabled = true;
    dom.btnEncode.innerHTML = '<svg class="cm-icon cm-icon--sm"><use href="assets/icons/sprite.svg#icon-zap"/></svg> Кодирование…';
    _stegoEncodingInProgress = true;

    try {
        // Clear abbr form memory for a new encoding
        _abbrFormMemory.clear();
        state._lastStegoText = null;
        state._lsEditMode = false;
        _updateLsToggleVisibility();

        // ─── Extreme encoding: determine active methods ───
        const activeMethods = [];
        if (dom.extremeCaseLadder?.checked) activeMethods.push('case-ladder');
        if (dom.extremeZeroWidth?.checked) activeMethods.push('zero-width-ext');
        if (dom.extremeCyrillicLatin?.checked) activeMethods.push('cyrillic-latin');
        // ZW-ext is independent — NOT auto-added. User controls it via checkbox.
        state._extremeMethods = activeMethods;

        // Update extreme warning UI
        const disabledChannels = [];
        for (const name of activeMethods) {
            (ExtremeChannelManager.COMPAT_MAP[name] || []).forEach(ch => {
                if (!disabledChannels.includes(ch)) disabledChannels.push(ch);
            });
        }
        _updateExtremeWarning(activeMethods, disabledChannels);

        if (activeMethods.length > 0) {
            // Use engine's extreme channel integration
            state.stegoEngine.setActiveExtremeChannels(activeMethods);
            // Respect user's letter-stego toggle — filter out LS if disabled
            if (!_isLetterStegoEnabled()) {
                state.stegoEngine.activeChannels = state.stegoEngine.activeChannels
                    .filter(c => c.name !== 'letter-stego');
            }
        } else {
            // Standard encode: use ALL default channels (same set as decode).
            // CRITICAL: Must match decode's _setDefaultChannels() so that channels
            // which gain capacity from other channels' text modifications (e.g.,
            // punctuation finding dashes introduced by phone reformatting) are
            // included in the convergence loop. Using getAutoChannels() here but
            // _setDefaultChannels() in decode causes base mismatch → broken roundtrip.
            state.stegoEngine._setDefaultChannels();
            if (!_isLetterStegoEnabled()) {
                state.stegoEngine.activeChannels = state.stegoEngine.activeChannels
                    .filter(c => c.name !== 'letter-stego');
            }
        }

        const stegoText = await state.stegoEngine.encodeMessage(secret, carrier, password);

        // Store and render
        state._lastStegoText = stegoText;
        _renderStegoOutput(stegoText);

        const stats = state.stegoEngine.getStats();
        if (dom.statChannels) dom.statChannels.textContent = stats.channels;
        if (dom.statBits) dom.statBits.textContent = stats.bits;
        if (dom.statEfficiency) dom.statEfficiency.textContent = (stats.efficiency || 0) + '%';
        if (dom.statTime) dom.statTime.textContent = stats.time + ' мс';

        showToast('Сообщение закодировано в стего-текст', 'success');
        _updateFabState();

        // Automatic roundtrip verification (non-blocking)
        // Roundtrip is scheduled after encoding completes; the finally block
        // clears _stegoEncodingInProgress first, then fires roundtrip.
    } catch (e) {
        showToast('Ошибка: ' + e.message, 'error');
        console.error(e);
    } finally {
        _stegoEncodingInProgress = false;
        dom.btnEncode.disabled = false;
        dom.btnEncode.innerHTML = '<svg class="cm-icon cm-icon--sm"><use href="assets/icons/sprite.svg#icon-zap"/></svg> Кодировать';
        // Schedule roundtrip here so _stegoEncodingInProgress is already false
        // and _autoRoundtrip won't be blocked by any guard.
        if (typeof stegoText !== 'undefined' && stegoText && secret) {
            _autoRoundtrip(stegoText, secret, password);
        }
    }
}

async function handleStegoDecode() {
    if (!state.stegoReady) {
        showToast('Движок стеганографии ещё загружается…', 'warning');
        return;
    }

    // Prevent concurrent operations (encode/decode/preview all share engine state)
    if (_stegoEncodingInProgress) {
        showToast('Подождите завершения текущей операции…', 'warning');
        return;
    }

    const stegoText = dom.stegoText.value;
    const password = dom.passwordDecode.value;

    if (!stegoText || !password) {
        showToast('Заполните все поля!', 'error');
        return;
    }

    dom.btnDecode.disabled = true;
    dom.btnDecode.innerHTML = '<svg class="cm-icon cm-icon--sm"><use href="assets/icons/sprite.svg#icon-search"/></svg> Декодирование…';
    _stegoEncodingInProgress = true;

    try {
        // Set default channels — engine will auto-detect extreme methods in decodeMessage
        state.stegoEngine._setDefaultChannels();
        // Respect user's letter-stego toggle — if LS was disabled during encode,
        // it must also be disabled during decode to match the bases order.
        if (!_isLetterStegoEnabled()) {
            state.stegoEngine.activeChannels = state.stegoEngine.activeChannels
                .filter(c => c.name !== 'letter-stego');
        }

        // ─── Standard stego decode (engine handles extreme auto-detection internally) ───
        const message = await state.stegoEngine.decodeMessage(stegoText, password);

        dom.decodedMessage.textContent = message;
        showToast('Сообщение декодировано', 'success');
    } catch (e) {
        showToast('Ошибка: ' + e.message, 'error');
        console.error(e);
    } finally {
        dom.btnDecode.disabled = false;
        dom.btnDecode.innerHTML = '<svg class="cm-icon cm-icon--sm"><use href="assets/icons/sprite.svg#icon-search"/></svg> Декодировать';
        _stegoEncodingInProgress = false;
        // Reset to default channels after decode
        state.stegoEngine._setDefaultChannels();
    }
}

// ─── Extreme Stego Handlers ─────────────────────────────────────

let _extremeEngine = null;

async function _getExtremeEngine() {
    if (!_extremeEngine) {
        const { ExtremeStegoEngine } = await import('./core/extreme-stego-engine.js');
        _extremeEngine = new ExtremeStegoEngine();
    }
    return _extremeEngine;
}

function _updateExtremeCapacity() {
    const carrier = dom.extremeCarrier?.value || '';
    const els = {
        capacity: dom.extremeCapacity,
        zw: dom.extremeCapZW,
        spaces: dom.extremeCapSpaces,
        case_: dom.extremeCapCase,
        cyrLat: dom.extremeCapCyrLat,
    };

    if (!carrier || !_extremeEngine) {
        if (els.capacity) els.capacity.textContent = '—';
        if (els.zw) els.zw.textContent = '— бит';
        if (els.spaces) els.spaces.textContent = '— бит';
        if (els.case_) els.case_.textContent = '— бит';
        if (els.cyrLat) els.cyrLat.textContent = '— бит';
        return;
    }

    const enabled = {
        'zero-width': dom.extremeMethodZW?.checked || false,
        'spaces': dom.extremeMethodSpaces?.checked || false,
        'case': dom.extremeMethodCase?.checked || false,
        'cyrillic-latin': dom.extremeMethodCyrLat?.checked || false,
    };

    const cap = _extremeEngine.getCapacity(carrier, enabled);

    if (els.capacity) els.capacity.textContent = `${cap.usableBytes} байт (~${cap.usableBits} бит)`;
    if (els.zw) els.zw.textContent = `${cap.perMethod['zero-width']?.bits || 0} бит`;
    if (els.spaces) els.spaces.textContent = `${cap.perMethod['spaces']?.bits || 0} бит`;
    if (els.case_) els.case_.textContent = `${cap.perMethod['case']?.bits || 0} бит`;
    if (els.cyrLat) els.cyrLat.textContent = `${cap.perMethod['cyrillic-latin']?.bits || 0} бит`;
}

async function handleExtremeAction() {
    const dir = state._extremeDirection || 'encode';
    const password = dom.extremePassword?.value || '';

    if (!password) {
        showToast('Введите пароль', 'error');
        return;
    }

    const engine = await _getExtremeEngine();

    if (dir === 'encode') {
        const secret = dom.extremeSecret?.value || '';
        const carrier = dom.extremeCarrier?.value || '';

        if (!secret || !carrier) {
            showToast('Заполните все поля', 'error');
            return;
        }

        const enabled = {
            'zero-width': dom.extremeMethodZW?.checked || false,
            'spaces': dom.extremeMethodSpaces?.checked || false,
            'case': dom.extremeMethodCase?.checked || false,
            'cyrillic-latin': dom.extremeMethodCyrLat?.checked || false,
        };

        // Check at least one method is enabled
        if (!Object.values(enabled).some(v => v)) {
            showToast('Включите хотя бы один метод кодирования', 'error');
            return;
        }

        dom.btnExtremeAction.disabled = true;
        try {
            const result = await engine.encode(carrier, secret, password, enabled);
            dom.extremeOutput.textContent = result.encoded;
            showToast('Сообщение закодировано', 'success');
        } catch (e) {
            dom.extremeOutput.textContent = '⚠ ' + e.message;
            showToast(e.message, 'error');
        } finally {
            dom.btnExtremeAction.disabled = false;
        }
    } else {
        // Decode
        const stegoText = dom.extremeStegoText?.value || '';

        if (!stegoText) {
            showToast('Введите стего-текст', 'error');
            return;
        }

        dom.btnExtremeAction.disabled = true;
        dom.extremeOutput.textContent = '';

        try {
            // Auto-detect methods
            const detected = engine.detectMethods(stegoText);

            if (detected.length > 0) {
                dom.extremeDetectedMethods.style.display = 'flex';
                dom.extremeDetectedList.innerHTML = detected.map(m => {
                    const labels = { 'zero-width': 'Zero-width', 'spaces': 'Пробелы', 'case': 'Регистр', 'cyrillic-latin': 'Кириллица→Лат.' };
                    return `<span>${labels[m] || m}</span>`;
                }).join('');
            } else {
                dom.extremeDetectedMethods.style.display = 'none';
            }

            const result = await engine.decode(stegoText, password);
            dom.extremeOutput.textContent = result.secret;
            showToast('Сообщение декодировано', 'success');
        } catch (e) {
            dom.extremeOutput.textContent = '';
            dom.extremeDetectedMethods.style.display = 'none';
            showToast('Ошибка: ' + e.message, 'error');
        } finally {
            dom.btnExtremeAction.disabled = false;
        }
    }
}

function handleStegoRecovery() {
    dom.btnRecovery.disabled = true;
    dom.btnRecovery.innerHTML = '<svg class="cm-icon cm-icon--sm"><use href="assets/icons/sprite.svg#icon-shield"/></svg> Восстановление…';

    try {
        showToast('Функция восстановления в разработке', 'warning');
    } finally {
        dom.btnRecovery.disabled = false;
        dom.btnRecovery.innerHTML = '<svg class="cm-icon cm-icon--sm"><use href="assets/icons/sprite.svg#icon-shield"/></svg> Восстановить';
    }
}

// ─── Password Management ─────────────────────────────────────

function _getPassword() {
    // Try to get from current chat's saved password
    const chatId = state.chatId;
    const saved = CleanCrypto.getSavedPassword(chatId);
    if (saved) return saved;

    // Otherwise use the input field
    return dom.encryptPassword.value;
}

function _loadChatPasswords() {
    const passwords = CleanCrypto.getAllPasswords();
    dom.chatPasswordList.innerHTML = '';

    for (const [chatId, pw] of Object.entries(passwords)) {
        const entry = document.createElement('div');
        entry.className = 'cm-chat-entry';
        entry.innerHTML = `
            <span class="cm-chat-entry__id">${_escapeHtml(chatId)}</span>
            <span class="cm-chat-entry__pw">${'•'.repeat(Math.min(pw.length, 8))}</span>
            <button class="cm-chat-entry__remove" data-chat-id="${_escapeHtml(chatId)}" type="button"><svg class="cm-icon cm-icon--sm"><use href="assets/icons/sprite.svg#icon-trash"/></svg></button>
        `;
        dom.chatPasswordList.appendChild(entry);
    }

    // Remove buttons
    dom.chatPasswordList.querySelectorAll('.cm-chat-entry__remove').forEach(btn => {
        btn.addEventListener('click', () => {
            CleanCrypto.removePassword(btn.dataset.chatId);
            _loadChatPasswords();
            showToast('Пароль удалён', 'info');
        });
    });
}

function _addChatPassword() {
    const chatId = dom.newChatIdInput.value.trim();
    const pw = dom.newChatPwInput.value.trim();

    if (!chatId || !pw) {
        showToast('Введите ID чата и пароль', 'error');
        return;
    }

    CleanCrypto.savePassword(chatId, pw);
    dom.newChatIdInput.value = '';
    dom.newChatPwInput.value = '';
    _loadChatPasswords();
    showToast('Пароль сохранён', 'success');
}

// ─── Settings ────────────────────────────────────────────────


function openSettings() {
    dom.settingsPanel.classList.add('open');
    dom.settingsOverlay.classList.add('open');
}

function closeSettings() {
    dom.settingsPanel.classList.remove('open');
    dom.settingsOverlay.classList.remove('open');
}

// ─── Settings Persistence ──────────────────────────────────────

function _saveSettings() {
    try {
        const settings = {
            chatId: state.chatId,
            charLimit: state.charLimit,
            // Password storage preference
            rememberPassword: dom.settingRememberPw?.checked || false,
            // Stego channel toggles
            letterStegoEnabled: _isLetterStegoEnabled(),
            // Synonym threshold
            synThreshold: dom.synThreshold?.value ? parseFloat(dom.synThreshold.value) : undefined,
            // Letter density
            letterDensity: dom.letterDensity?.value ? parseInt(dom.letterDensity.value) : undefined,
        };
        localStorage.setItem('cryptoMsg_settings', JSON.stringify(settings));
    } catch (e) {
        console.warn('Failed to save settings:', e);
    }
}

function _loadSettings() {
    try {
        const raw = localStorage.getItem('cryptoMsg_settings');
        if (!raw) return;
        const settings = JSON.parse(raw);

        if (settings.chatId) {
            state.chatId = settings.chatId;
            dom.chatIdDisplay.textContent = state.chatId;
            dom.settingCurrentChatId.value = state.chatId;
        }
        if (settings.charLimit) state.charLimit = settings.charLimit;

        // Password storage preference
        if (settings.rememberPassword !== undefined && dom.settingRememberPw) {
            dom.settingRememberPw.checked = settings.rememberPassword;
        }

        // Stego channel toggles
        if (settings.letterStegoEnabled !== undefined) {
            const cb = document.getElementById('chLetterStego');
            if (cb) cb.checked = settings.letterStegoEnabled;
        }

        // Synonym threshold
        if (settings.synThreshold !== undefined && dom.synThreshold) {
            dom.synThreshold.value = settings.synThreshold;
            if (dom.thresholdVal) dom.thresholdVal.textContent = settings.synThreshold.toFixed(2);
        }

        // Letter density
        if (settings.letterDensity !== undefined && dom.letterDensity) {
            dom.letterDensity.value = settings.letterDensity;
            if (dom.densityVal) dom.densityVal.textContent = settings.letterDensity + '%';
        }
    } catch (e) {
        console.warn('Failed to load settings:', e);
    }
}

// ─── Stego Capacity Stats & Live Analysis ───────────────────

function updateStegoStats() {
    if (!state.stegoReady) return;

    const secret = dom.secretMessage?.value || '';
    const carrier = dom.carrierText?.value || '';

    const secretBytes = state.stegoEngine?.crypto
        ? state.stegoEngine.crypto.stringToBytes(secret).length
        : new TextEncoder().encode(secret).length;

    // Check extreme channel checkboxes
    const activeMethods = [];
    if (dom.extremeCaseLadder?.checked) activeMethods.push('case-ladder');
    if (dom.extremeZeroWidth?.checked) activeMethods.push('zero-width-ext');
    if (dom.extremeCyrillicLatin?.checked) activeMethods.push('cyrillic-latin');

    if (activeMethods.length > 0) {
        // Extreme mode: set extreme-compatible channels
        state.stegoEngine.setActiveExtremeChannels(activeMethods);
        // Respect user's letter-stego toggle — filter out LS if disabled
        if (!_isLetterStegoEnabled()) {
            state.stegoEngine.activeChannels = state.stegoEngine.activeChannels
                .filter(c => c.name !== 'letter-stego');
        }
    } else {
        // Standard mode: use analyzer for auto channel detection
        const autoChannels = state.stegoAnalyzer
            ? state.stegoAnalyzer.getAutoChannels(carrier)
            : [];

        // Set the engine's active channels to the auto-detected ones
        if (autoChannels.length > 0) {
            state.stegoEngine.setActiveChannels(autoChannels);
        }
    }

    // Analyze capacity
    let capacityBits = 0;
    if (carrier) {
        try {
            const analysis = state.stegoEngine.analyzeCarrier(carrier);
            capacityBits = Math.floor(analysis.totalBits);
        } catch (e) {
            // silent
        }
    }

    // Calculate required bits (encrypted message size)
    const overhead = state.stegoEngine.crypto
        ? state.stegoEngine.crypto.getOverhead(secretBytes)
        : 2;
    const encryptedBytes = secretBytes + overhead;
    const requiredBits = encryptedBytes * 8;

    // Update capacity badge
    const badge = document.getElementById('capacity-badge');
    if (badge) {
        badge.textContent = `${capacityBits} бит`;
        badge.classList.remove('cm-stego-capacity-badge--low', 'cm-stego-capacity-badge--ok');
        if (capacityBits === 0) {
            badge.classList.add('cm-stego-capacity-badge--low');
        } else if (capacityBits < requiredBits) {
            badge.classList.add('cm-stego-capacity-badge--ok');
        }
    }
}

/**
 * Show a roundtrip verification badge on the stego result section.
 * @param {'ok'|'warn'|'err'} status
 * @param {string} message
 */
function _showRoundtripBadge(status, message) {
    const resultSection = dom.outputText?.closest('.cm-stego-result-section');
    if (!resultSection) return;

    const header = resultSection.querySelector('.cm-stego-preview-header');
    if (!header) return;

    const existing = header.querySelector('.cm-roundtrip-badge');
    if (existing) existing.remove();

    const rtBadge = document.createElement('div');
    const cls = status === 'ok' ? 'ok' : status === 'warn' ? 'warn' : 'err';
    const icon = status === 'ok' ? 'icon-check' : status === 'warn' ? 'icon-alert-triangle' : 'icon-x';
    rtBadge.className = `cm-roundtrip-badge cm-roundtrip-badge--${cls}`;
    rtBadge.innerHTML = `<svg class="cm-icon cm-icon--sm"><use href="assets/icons/sprite.svg#${icon}"/></svg> ${message}`;
    header.appendChild(rtBadge);
}

/**
 * Remove the roundtrip badge from the stego result section.
 */
function _clearRoundtripBadge() {
    const resultSection = dom.outputText?.closest('.cm-stego-result-section');
    if (!resultSection) return;
    resultSection.querySelector('.cm-roundtrip-badge')?.remove();
}

// ─── Abbreviation Form Selection (Inline Word UI) ─────────────

// Abbr form memory — persists across auto-preview updates
const _abbrFormMemory = new Map(); // "abbr:index" -> selected form string

// Ref to the currently open popover (for cleanup)
let _activeFormPopover = null;
let _popoverDocClickListener = null;

/**
 * Render stego output text: shows raw text, and if abbreviation expansions
 * are present, wraps them in clickable spans for form selection.
 * Always sets the output text — never leaves it empty.
 */
function _renderStegoOutput(stegoText) {
    const outputEl = dom.outputText;
    if (!outputEl) return;

    const abbrCh = state.stegoEngine?.channels?.['abbreviations'];
    if (!abbrCh || !abbrCh.loaded || !stegoText) {
        outputEl.textContent = stegoText || '';
        _clearAbbrFormsPanel();
        return;
    }

    const expansions = abbrCh.getExpandedForms(stegoText);
    if (expansions.length === 0) {
        outputEl.textContent = stegoText;
        _clearAbbrFormsPanel();
        return;
    }

    // ── There ARE expansions — render rich HTML ──

    // Show the reset button
    const resetBtn = document.getElementById('btn-abbr-reset');
    if (resetBtn) resetBtn.style.display = '';

    // Close any existing popover
    _closeFormPopover();

    // Apply remembered forms to text before rendering
    let workingText = stegoText;
    // We need to apply forms in reverse order to preserve indices
    const expansionsWithMemory = expansions.map((exp, idx) => {
        const memKey = `${exp.abbr}:${idx}`;
        const savedForm = _abbrFormMemory.get(memKey);
        return { ...exp, idx, memKey, savedForm };
    });

    // Apply saved forms from memory (reverse order to maintain indices)
    for (let i = expansionsWithMemory.length - 1; i >= 0; i--) {
        const exp = expansionsWithMemory[i];
        if (exp.savedForm) {
            const capitalized = _capitalizePhrase(exp.savedForm, exp.currentForm);
            workingText = workingText.substring(0, exp.index)
                + capitalized
                + workingText.substring(exp.index + exp.length);
        }
    }

    // Re-scan with the updated text to get correct positions
    const finalExpansions = abbrCh.getExpandedForms(workingText);

    // Build rich text HTML: wrap abbreviation expansions as clickable spans
    let html = '';
    let lastEnd = 0;

    finalExpansions.forEach((exp, idx) => {
        // Text before this expansion
        if (exp.index > lastEnd) {
            html += _escapeHtml(workingText.substring(lastEnd, exp.index));
        }

        const memKey = expansionsWithMemory[idx]?.memKey || `${exp.abbr}:${idx}`;
        const currentDisplay = workingText.substring(exp.index, exp.index + exp.length);

        // Split multi-word expansions into individual clickable spans
        // but link them with the same data-pair-idx
        const words = currentDisplay.split(/(\s+)/);
        words.forEach(part => {
            if (/^\s+$/.test(part)) {
                // Preserve whitespace between words (non-clickable)
                html += part;
            } else if (part.length > 0) {
                html += `<span class="cm-abbr-word" data-pair-idx="${idx}" data-mem-key="${_escapeHtml(memKey)}">${_escapeHtml(part)}</span>`;
            }
        });

        lastEnd = exp.index + exp.length;
    });

    // Remaining text after last expansion
    if (lastEnd < workingText.length) {
        html += _escapeHtml(workingText.substring(lastEnd));
    }

    outputEl.innerHTML = html;

    // Attach click handlers to all abbr-word spans
    outputEl.querySelectorAll('.cm-abbr-word').forEach(span => {
        span.addEventListener('click', (e) => {
            e.stopPropagation();
            const pairIdx = parseInt(span.dataset.pairIdx, 10);
            const memKey = span.dataset.memKey;
            if (pairIdx >= 0 && pairIdx < finalExpansions.length) {
                _showFormPopover(span, finalExpansions[pairIdx], pairIdx, memKey);
            }
        });
    });

    // Update stored text
    state._lastStegoText = workingText;

    // Show/hide LS edit toggle button
    _updateLsToggleVisibility();
}

/**
 * @deprecated Use _renderStegoOutput() instead.
 * Show inline word highlights in the stego output text for expanded abbreviations.
 * Each highlighted word group is clickable to open a form-selection popover.
 */
function _showAbbrFormsPanel(stegoText) {
    _renderStegoOutput(stegoText);
}

/**
 * Show a popover near the clicked abbreviation word with form options.
 */
function _showFormPopover(targetEl, expansion, pairIdx, memKey) {
    // Close any existing popover first
    _closeFormPopover();

    const popover = document.createElement('div');
    popover.className = 'cm-form-popover';
    _activeFormPopover = popover;

    const currentForm = expansion.currentForm;

    // Deduplicate options by form text
    const seen = new Set();
    const uniqueOptions = expansion.options.filter(opt => {
        if (seen.has(opt.form)) return false;
        seen.add(opt.form);
        return true;
    });

    // Group by number
    const singOptions = uniqueOptions.filter(o => o.number !== 'plur');
    const plurOptions = uniqueOptions.filter(o => o.number === 'plur');

    // Helper to create option elements
    const createOptionEl = (opt) => {
        const el = document.createElement('div');
        el.className = 'cm-form-option';
        const isActive = opt.form.toLowerCase() === currentForm.toLowerCase();
        if (isActive) el.classList.add('cm-form-option--active');

        const labelEl = document.createElement('span');
        labelEl.className = 'cm-form-option__label';
        labelEl.textContent = opt.label || 'Базовая';

        const formEl = document.createElement('span');
        formEl.className = 'cm-form-option__form';
        formEl.textContent = _capitalizePhrase(opt.form, currentForm);

        el.appendChild(labelEl);
        el.appendChild(formEl);

        el.addEventListener('click', (e) => {
            e.stopPropagation();
            _applyAbbrFormInline(memKey, opt.form, pairIdx);
        });

        return el;
    };

    // Singular section
    if (singOptions.length > 0) {
        const sectionHeader = document.createElement('div');
        sectionHeader.className = 'cm-form-section';
        sectionHeader.textContent = 'Единственное число';
        popover.appendChild(sectionHeader);

        singOptions.forEach(opt => {
            popover.appendChild(createOptionEl(opt));
        });
    }

    // Plural section
    if (plurOptions.length > 0) {
        const sectionHeader = document.createElement('div');
        sectionHeader.className = 'cm-form-section';
        sectionHeader.textContent = 'Множественное число';
        popover.appendChild(sectionHeader);

        plurOptions.forEach(opt => {
            popover.appendChild(createOptionEl(opt));
        });
    }

    // Reset button at the bottom
    const resetBtn = document.createElement('button');
    resetBtn.className = 'cm-form-reset';
    resetBtn.type = 'button';
    resetBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg> Сбросить';
    resetBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        _abbrFormMemory.delete(memKey);
        // Re-render from base text
        if (state._lastStegoText) {
            _showAbbrFormsPanel(state._lastStegoText);
        }
        showToast('Форма сброшена', 'info');
    });
    popover.appendChild(resetBtn);

    // Position the popover below the clicked word
    const rect = targetEl.getBoundingClientRect();
    popover.style.left = rect.left + 'px';
    popover.style.top = (rect.bottom + 4) + 'px';

    // Add to DOM
    document.body.appendChild(popover);

    // Adjust position if overflowing viewport
    requestAnimationFrame(() => {
        const popRect = popover.getBoundingClientRect();

        // Horizontal overflow
        if (popRect.right > window.innerWidth - 8) {
            popover.style.left = Math.max(8, window.innerWidth - 8 - popRect.width) + 'px';
        }
        if (popRect.left < 8) {
            popover.style.left = '8px';
        }

        // Vertical overflow — show above if no room below
        if (popRect.bottom > window.innerHeight - 8) {
            if (rect.top - popRect.height - 4 > 8) {
                // Show above
                popover.style.top = (rect.top - popRect.height - 4) + 'px';
            } else {
                // Scrollable — clip to viewport
                popover.style.maxHeight = (window.innerHeight - rect.bottom - 12) + 'px';
            }
        }
    });

    // Close on click outside
    _popoverDocClickListener = (e) => {
        if (!popover.contains(e.target)) {
            _closeFormPopover();
        }
    };
    // Delay listener to avoid immediate close from the triggering click
    setTimeout(() => {
        document.addEventListener('click', _popoverDocClickListener);
    }, 0);
}

/**
 * Close the currently open form popover.
 */
function _closeFormPopover() {
    if (_activeFormPopover) {
        _activeFormPopover.remove();
        _activeFormPopover = null;
    }
    if (_popoverDocClickListener) {
        document.removeEventListener('click', _popoverDocClickListener);
        _popoverDocClickListener = null;
    }
}

/**
 * Apply a new grammatical form inline by replacing text in the output.
 * Uses the abbreviation channel's re-scan to find the correct position.
 */
function _applyAbbrFormInline(memKey, newForm, pairIdx) {
    const outputEl = dom.outputText;
    if (!outputEl) return;

    let text = outputEl.textContent || '';
    const abbrCh = state.stegoEngine?.channels?.['abbreviations'];
    if (!abbrCh) return;

    // Re-scan to find current positions in the actual text
    const expansions = abbrCh.getExpandedForms(text);
    if (pairIdx >= expansions.length) return;

    const exp = expansions[pairIdx];
    const finalForm = _capitalizePhrase(newForm, exp.currentForm);

    // Replace at the correct position
    text = text.substring(0, exp.index) + finalForm + text.substring(exp.index + exp.length);

    // Save to memory
    _abbrFormMemory.set(memKey, newForm);

    // Close popover
    _closeFormPopover();

    // Update stored text
    state._lastStegoText = text;

    // Re-render with the new text
    _showAbbrFormsPanel(text);
}

/**
 * Clear the abbreviation form memory and re-render.
 */
function _clearAbbrFormMemory() {
    _abbrFormMemory.clear();
    _closeFormPopover();
    if (state._lastStegoText) {
        _showAbbrFormsPanel(state._lastStegoText);
    } else {
        _clearAbbrFormsPanel();
    }
}

/**
 * Capitalize a phrase to match the pattern of a reference phrase.
 * "российская федерация" + "Российской Федерации" → "Российской Федерации"
 */
function _capitalizePhrase(target, reference) {
    if (!reference || !target) return target;
    const isAllUpper = reference === reference.toUpperCase() && reference.length > 1;
    if (isAllUpper) return target.toUpperCase();

    // Capitalize each word if the corresponding word in reference is capitalized
    const targetWords = target.split(/\s+/);
    const refWords = reference.split(/\s+/);
    return targetWords.map((tw, i) => {
        const rw = refWords[Math.min(i, refWords.length - 1)];
        if (rw && rw[0] === rw[0].toUpperCase() && rw[0] !== rw[0].toLowerCase()) {
            return tw.charAt(0).toUpperCase() + tw.slice(1);
        }
        return tw;
    }).join(' ');
}

/**
 * Clear the abbreviation form selection panel.
 */
function _clearAbbrFormsPanel() {
    const outputEl = dom.outputText;
    // If outputText has innerHTML with abbr-word spans, convert to plain text
    if (outputEl && outputEl.querySelector('.cm-abbr-word')) {
        // Keep the text content but remove HTML
        const text = outputEl.textContent || '';
        outputEl.textContent = text;
    }
    const panel = document.getElementById('abbr-forms-panel');
    if (!panel) return;
    panel.innerHTML = '';
    panel.classList.remove('visible');

    // Hide reset button
    const resetBtn = document.getElementById('btn-abbr-reset');
    if (resetBtn) resetBtn.style.display = 'none';

    // Close any open popover
    _closeFormPopover();
}

// ─── LS Edit Mode Toggle ─────────────────────────────────────────

/**
 * Toggle letter-stego edit mode.
 *
 * When entering edit mode:
 *   - Strips LS mutations from the current stego text using lsCh.restore()
 *   - Shows the clean text with abbreviation form highlights
 *   - Users can now select correct word forms without LS interference
 *
 * When exiting edit mode:
 *   - Re-encodes from scratch (live preview triggers automatically)
 *   - LS mutations are re-applied
 *   - Abbreviation form memory (_abbrFormMemory) is preserved
 */
function _toggleLsEditMode() {
    const btn = document.getElementById('btn-ls-toggle');
    if (!btn) return;

    if (state._lsEditMode) {
        // ── EXIT edit mode: re-encode with LS ──
        state._lsEditMode = false;
        btn.classList.remove('cm-btn--active');
        btn.title = 'Редактировать формы слов (временно отключить буквенное стего)';

        // Re-encode from scratch — live preview will pick up the change
        // and produce a new stego text with LS mutations applied.
        // _abbrFormMemory is preserved — _renderStegoOutput will apply saved forms.
        _tryLivePreview();
        showToast('Буквенное стего включено', 'info');
    } else {
        // ── ENTER edit mode: strip LS mutations ──
        const stegoText = state._lastStegoText || dom.outputText?.textContent || '';
        if (!stegoText) {
            showToast('Нет результата для редактирования', 'warning');
            return;
        }

        const lsCh = state.stegoEngine?.channels?.['letter-stego'];
        if (!lsCh || !lsCh.loaded) {
            showToast('Буквенное стего не загружено', 'warning');
            return;
        }

        // Restore: strip LS mutations to get clean text
        const cleanText = lsCh.restore(stegoText);
        if (cleanText === stegoText) {
            // No LS mutations found — text is already clean
            showToast('В тексте нет мутаций буквенного стего', 'info');
            return;
        }

        // Save the LS-encoded text for later restoration
        state._stegoTextWithLS = stegoText;
        state._lsEditMode = true;
        btn.classList.add('cm-btn--active');
        btn.title = 'Применить буквенное стего (вернуть мутации)';

        // Render clean text with abbreviation form highlights
        state._lastStegoText = cleanText;
        _renderStegoOutput(cleanText);
        _clearRoundtripBadge();
        showToast('Режим редактирования: мутации убраны, выберите формы слов', 'info');
    }
}

/**
 * Show/hide the LS toggle button based on whether LS is active
 * and there's a stego result to edit.
 */
function _updateLsToggleVisibility() {
    const btn = document.getElementById('btn-ls-toggle');
    if (!btn) return;

    const lsCh = state.stegoEngine?.channels?.['letter-stego'];
    const hasStegoText = state._lastStegoText && state._lastStegoText.length > 0;
    const lsEnabled = _isLetterStegoEnabled();

    btn.style.display = (lsCh && lsCh.loaded && hasStegoText && lsEnabled && !state._lsEditMode)
        ? '' : (state._lsEditMode ? '' : 'none');
}

/**
 * Run a non-blocking roundtrip verification: decode the stego text
 * and compare with the original secret.
 * @param {string} stegoText - the encoded result
 * @param {string} secret - the original secret message
 * @param {string} password - the encryption password
 */
async function _autoRoundtrip(stegoText, secret, password) {
    try {
        // НЕ переопределяем каналы! Используем те же каналы, что были
        // при кодировании (setActiveChannels вызван в handleStegoEncode).
        // Если бы мы вызвали getAutoChannels(stegoText), LS-мутации в
        // stego-тексте могли бы скрыть слова-синонимы → synonyms вернул бы
        // 0 бит → канал исключён → bases не совпадают с encode → roundtrip
        // падает с «Неверный пароль или повреждённые данные».
        const roundtripResult = await state.stegoEngine.decodeMessage(stegoText, password);
        if (roundtripResult === secret) {
            _showRoundtripBadge('ok', 'Roundtrip OK');
        } else {
            _showRoundtripBadge('warn', 'Roundtrip: несовпадение');
        }
    } catch (rtErr) {
        _showRoundtripBadge('err', 'Roundtrip: ' + rtErr.message);
    }
}

/**
 * Try to generate a live preview of the stego encoding.
 * Shows result even if capacity is insufficient (with warning).
 * Only requires carrier text + password; secret message can be empty for preview.
 * After successful encoding, automatically runs roundtrip verification (non-blocking).
 */
let _livePreviewTimer = null;
let _livePreviewRunning = false;
let _stegoEncodingInProgress = false; // Global lock: prevents concurrent encode calls

function _tryLivePreview() {
    clearTimeout(_livePreviewTimer);
    _livePreviewTimer = setTimeout(async () => {
        if (!state.stegoReady || _livePreviewRunning || _stegoEncodingInProgress) return;

        // CRITICAL: Do NOT run live preview when extreme channels are active.
        // Extreme encoding (CL/CYR/ZW-ext) modifies text in ways that conflict
        // with the async analysis cycle (changes activeChannels, _excludedSpans),
        // causing state corruption and UI freeze. Extreme encoding is triggered
        // by checkbox changes via handleStegoEncode, not by live preview.
        const extremeActive = (dom.extremeCaseLadder?.checked || dom.extremeZeroWidth?.checked || dom.extremeCyrillicLatin?.checked);
        if (extremeActive) return;

        const secret = dom.secretMessage?.value || '';
        const carrier = dom.carrierText?.value || '';
        const password = dom.passwordEncode?.value || '';

        if (!carrier || !password) {
            if (dom.outputText) dom.outputText.textContent = '';
            _clearRoundtripBadge();
            _clearAbbrFormsPanel();
            return;
        }

        // Use a default secret if empty (for preview purposes)
        const previewSecret = secret || 'тест';

        _livePreviewRunning = true;
        _stegoEncodingInProgress = true; // Prevent concurrent handleStegoEncode
        try {
            // Check extreme channel checkboxes (same logic as handleStegoEncode)
            const activeMethods = [];
            if (dom.extremeCaseLadder?.checked) activeMethods.push('case-ladder');
            if (dom.extremeZeroWidth?.checked) activeMethods.push('zero-width-ext');
            if (dom.extremeCyrillicLatin?.checked) activeMethods.push('cyrillic-latin');
            // ZW-ext is independent — NOT auto-added. User controls it via checkbox.
            state._extremeMethods = activeMethods;

            if (activeMethods.length > 0) {
                // Extreme encoding: use engine's extreme channel integration
                state.stegoEngine.setActiveExtremeChannels(activeMethods);
                // Respect user's letter-stego toggle — filter out LS if disabled
                if (!_isLetterStegoEnabled()) {
                    state.stegoEngine.activeChannels = state.stegoEngine.activeChannels
                        .filter(c => c.name !== 'letter-stego');
                }
            } else {
                // Standard encode: use ALL default channels (same set as decode)
                state.stegoEngine._setDefaultChannels();
                if (!_isLetterStegoEnabled()) {
                    state.stegoEngine.activeChannels = state.stegoEngine.activeChannels
                        .filter(c => c.name !== 'letter-stego');
                }
            }

            const stegoText = await state.stegoEngine.encodeMessage(previewSecret, carrier, password);
            if (dom.outputText) {
                if (!secret) {
                    dom.outputText.textContent = stegoText + '\n\n⚠ Предпросмотр (введите секретное сообщение)';
                    _clearAbbrFormsPanel();
                } else {
                    // Store raw text and render (with abbreviation form highlights if any)
                    state._lastStegoText = stegoText;
                    _renderStegoOutput(stegoText);
                }
            }

            // Automatic roundtrip verification (non-blocking, with delay)
            // Guard: only run if no new encoding operation started during the delay
            if (secret && stegoText) {
                setTimeout(() => {
                    if (!_stegoEncodingInProgress) {
                        _autoRoundtrip(stegoText, secret, password);
                    }
                }, 300);
            } else {
                _clearRoundtripBadge();
            }
        } catch (e) {
            if (dom.outputText) {
                dom.outputText.textContent = `⚠ ${e.message}`;
            }
            _clearRoundtripBadge();
            _clearAbbrFormsPanel();
        } finally {
            _livePreviewRunning = false;
            _stegoEncodingInProgress = false;
        }
    }, 200);
}

/**
 * Render analysis result to the carrier overlay and channel badges.
 * Called by StegoAnalyzer.onChange callback.
 */
function _renderAnalysisResult(result) {
    // Set engine's active channels from the analysis result,
    // filtering by user's letter-stego toggle.
    // IMPORTANT: Do NOT override channels when extreme mode is active —
    // extreme mode has its own channel setup via setActiveExtremeChannels().
    //
    // CRITICAL: Use getAutoChannels() for deterministic channel order!
    // result.channels is sorted by bits DESCENDING — using that order for
    // activeChannels breaks encode/decode roundtrip (the engine encodes in
    // activeChannels order and decodes in the same order — order must match).
    const extremeActive = (dom.extremeCaseLadder?.checked || dom.extremeZeroWidth?.checked || dom.extremeCyrillicLatin?.checked);
    if (state.stegoEngine && result.channels.length > 0 && !extremeActive) {
        // Use getAutoChannels for deterministic AUTO_CHANNELS order
        let activeChannelNames = state.stegoAnalyzer
            ? state.stegoAnalyzer.getAutoChannels(dom.carrierText?.value || '')
            : result.channels.filter(ch => ch.bits > 0).map(ch => ch.name);
        // Only letter-stego can be optionally disabled —
        // it's safe because it's always last in the bases array and
        // returns all-zero indices when not encoded (trailing zeros
        // don't affect the mixed-radix number M).
        if (!_isLetterStegoEnabled()) {
            activeChannelNames = activeChannelNames.filter(ch => ch !== 'letter-stego');
        }
        if (activeChannelNames.length > 0) {
            state.stegoEngine.setActiveChannels(activeChannelNames);
        }
    }

    // Update carrier overlay with highlighted HTML
    // Only update if the analysis text matches the current textarea value,
    // otherwise the overlay would show stale highlighted text that misaligns the cursor.
    const carrier = dom.carrierText;
    const overlay = document.getElementById('carrier-overlay');
    if (overlay && carrier) {
        if (result.text === carrier.value) {
            if (result.highlightedHTML) {
                overlay.innerHTML = result.highlightedHTML;
            } else {
                overlay.innerHTML = '';
            }
            // Re-sync scroll after replacing overlay content with highlighted HTML
            _syncCarrierScroll();
        }
        // If text has changed since analysis started, _syncCarrierOverlay
        // already set plain text — leave it until next analysis catches up.
    }

    // Update channel badges — show all detected channels,
    // but mark letter-stego as disabled if user toggled it off
    const lsEnabled = _isLetterStegoEnabled();
    const chEl = document.getElementById('stego-channels');
    if (chEl) {
        if (result.channels.length === 0) {
            chEl.innerHTML = '<span style="font-size:11px;color:var(--cm-text-muted);">Каналы не обнаружены</span>';
        } else {
            chEl.innerHTML = result.channels.map(ch => {
                const c = ch.color;
                const isDisabled = (ch.name === 'letter-stego' && !lsEnabled);
                const dimStyle = isDisabled ? 'opacity:0.4;text-decoration:line-through;' : '';
                return `<span class="cm-stego-channel-badge" style="background:${c.bg};border-color:${c.border};color:${c.text};${dimStyle}">`
                    + `<span class="cm-stego-channel-badge__dot" style="background:${c.border};"></span>`
                    + `${ch.label}`
                    + `<span class="cm-stego-channel-badge__bits">${ch.bits.toFixed(1)}b</span>`
                    + `</span>`;
            }).join('');
        }
    }

    // Update capacity badge
    const badge = document.getElementById('capacity-badge');
    if (badge) {
        // Calculate effective bits (excluding letter-stego if disabled)
        const effectiveBits = lsEnabled
            ? result.totalBits
            : result.channels
                .filter(ch => ch.name !== 'letter-stego')
                .reduce((sum, ch) => sum + ch.bits, 0);
        const bits = Math.floor(effectiveBits);
        badge.textContent = `${bits} бит`;
        badge.classList.remove('cm-stego-capacity-badge--low', 'cm-stego-capacity-badge--ok');
        const secret = dom.secretMessage?.value || '';
        const secretBytes = state.stegoEngine?.crypto
            ? state.stegoEngine.crypto.stringToBytes(secret).length
            : new TextEncoder().encode(secret).length;
        const overhead = state.stegoEngine?.crypto
            ? state.stegoEngine.crypto.getOverhead(secretBytes)
            : 2;
        const requiredBits = (secretBytes + overhead) * 8;
        if (bits === 0) {
            badge.classList.add('cm-stego-capacity-badge--low');
        } else if (bits < requiredBits) {
            badge.classList.add('cm-stego-capacity-badge--ok');
        }
    }

    // Try live preview whenever analysis updates
    _tryLivePreview();
}

// ─── Stego Channel Auto-Detection ────────────────────────────

/**
 * Check if letter-stego is enabled via the settings checkbox.
 * Only letter-stego can be safely disabled — all other channels are always active
 * because disabling them would break decoding (the decoder auto-detects them
 * from the text and reads "natural" non-zero indices that corrupt the mixed-radix number).
 */
function _isLetterStegoEnabled() {
    const cb = document.getElementById('chLetterStego');
    return cb ? cb.checked : true;
}

function updateActiveChannels() {
    if (!state.stegoReady) return;

    // Auto-detect channels from current carrier text
    const carrier = dom.carrierText?.value || '';
    if (carrier && state.stegoAnalyzer) {
        const autoChannels = state.stegoAnalyzer.getAutoChannels(carrier);
        // Only letter-stego can be optionally disabled
        const active = _isLetterStegoEnabled()
            ? autoChannels
            : autoChannels.filter(ch => ch !== 'letter-stego');
        if (active.length > 0) {
            state.stegoEngine.setActiveChannels(active);
        }
    }
    updateStegoStats();
}

// ─── Extreme Encoding UI Helpers ──────────────────────────────

/**
 * Update extreme encoding warning display.
 */
function _updateExtremeWarning(activeMethods, disabledChannels) {
    if (dom.extremeWarning) {
        dom.extremeWarning.style.display = activeMethods.length > 0 ? '' : 'none';
    }
    if (dom.extremeDisabledInfo) {
        if (disabledChannels.length > 0) {
            const channelLabels = {
                'synonyms': 'Синонимы', 'abbreviations': 'Аббревиатуры', 'duplets': 'Дублеты',
                'letter-stego': 'Буквенное стего', 'parasites': 'Слова-паразиты',
                'participles': 'Причастия', 'voice': 'Формы глагола', 'phrases': 'Фразы',
                'yo-replacement': 'Ё/е', 'categorized-words': 'Категории',
            };
            const labels = disabledChannels.map(c => channelLabels[c] || c);
            dom.extremeDisabledInfo.textContent = `Отключены каналы: ${labels.join(', ')}`;
            dom.extremeDisabledInfo.style.display = '';
        } else {
            dom.extremeDisabledInfo.style.display = 'none';
        }
    }
}

/**
 * Update extreme encoding capacity display.
 */
function _updateInlineExtremeCapacity() {
    if (!dom.extremeCapacity || !dom.carrierText || !state.stegoEngine) return;

    const carrier = dom.carrierText.value;
    if (!carrier) {
        dom.extremeCapacity.textContent = '0 бит';
        return;
    }

    const activeMethods = [];
    if (dom.extremeCaseLadder?.checked) activeMethods.push('case-ladder');
    if (dom.extremeZeroWidth?.checked) activeMethods.push('zero-width-ext');
    if (dom.extremeCyrillicLatin?.checked) activeMethods.push('cyrillic-latin');

    if (activeMethods.length === 0) {
        dom.extremeCapacity.textContent = '—';
        _updateExtremeWarning([], []);
        return;
    }

    // Use the engine's extreme manager for capacity analysis
    // CRITICAL: must setActiveMethods first — otherwise manager uses default empty list
    state.stegoEngine.extremeManager.setActiveMethods(activeMethods);
    const analysis = state.stegoEngine.extremeManager.analyzeCapacity(carrier);
    dom.extremeCapacity.textContent = `${analysis.totalBits} бит (~${analysis.totalBytes} байт)`;

    // Update warning about disabled channels
    const disabledChannels = [];
    for (const name of activeMethods) {
        (ExtremeChannelManager.COMPAT_MAP[name] || []).forEach(ch => {
            if (!disabledChannels.includes(ch)) disabledChannels.push(ch);
        });
    }
    _updateExtremeWarning(activeMethods, disabledChannels);
}

/**
 * Initialize extreme encoding event listeners.
 * Capacity update is debounced (150ms) to avoid UI lag on long texts.
 */
let _extremeCapacityTimer = null;
function _updateInlineExtremeCapacityDebounced() {
    clearTimeout(_extremeCapacityTimer);
    _extremeCapacityTimer = setTimeout(_updateInlineExtremeCapacity, 150);
}
function _initExtremeEncodingListeners() {
    // On extreme checkbox change: update capacity display AND auto-encode if fields are filled
    const onExtremeChange = () => {
        _updateInlineExtremeCapacity();
        // Auto-encode if all required fields are filled (secret, carrier, password)
        const secret = dom.secretMessage?.value;
        const carrier = dom.carrierText?.value;
        const password = dom.passwordEncode?.value;
        if (secret && carrier && password && state.stegoReady && !dom.btnEncode?.disabled) {
            handleStegoEncode();
        }
    };
    dom.extremeCaseLadder?.addEventListener('change', onExtremeChange);
    dom.extremeZeroWidth?.addEventListener('change', onExtremeChange);
    dom.extremeCyrillicLatin?.addEventListener('change', onExtremeChange);
}

// ─── Base64url Helpers ───────────────────────────────────────

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64_DECODE = new Map();
B64_CHARS.split('').forEach((ch, i) => B64_DECODE.set(ch, i));

function _bytesToBase64url(bytes) {
    let result = '';
    for (let i = 0; i < bytes.length; i += 3) {
        const a = bytes[i];
        const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
        const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
        const bits = (a << 16) | (b << 8) | c;
        result += B64_CHARS[(bits >> 18) & 0x3F];
        result += B64_CHARS[(bits >> 12) & 0x3F];
        result += (i + 1 < bytes.length) ? B64_CHARS[(bits >> 6) & 0x3F] : '';
        result += (i + 2 < bytes.length) ? B64_CHARS[bits & 0x3F] : '';
    }
    return result;
}

function _base64urlToBytes(str) {
    if (!str) return null;
    if (str.length === 0) return new Uint8Array(0);

    const len = str.length;
    const remainder = len % 4;
    if (remainder === 1) return null; // invalid base64

    // Calculate exact output byte count
    let outputLen;
    if (remainder === 0) {
        outputLen = Math.floor(len / 4) * 3;
    } else if (remainder === 2) {
        outputLen = Math.floor(len / 4) * 3 + 1;
    } else { // remainder === 3
        outputLen = Math.floor(len / 4) * 3 + 2;
    }

    const bytes = new Uint8Array(outputLen);
    let byteIdx = 0;
    let i = 0;

    // Process complete groups of 4 chars → 3 bytes
    while (i + 4 <= len) {
        const a = B64_DECODE.get(str[i++]) ?? 0;
        const b = B64_DECODE.get(str[i++]) ?? 0;
        const c = B64_DECODE.get(str[i++]) ?? 0;
        const d = B64_DECODE.get(str[i++]) ?? 0;
        const bits = (a << 18) | (b << 12) | (c << 6) | d;
        bytes[byteIdx++] = (bits >> 16) & 0xFF;
        bytes[byteIdx++] = (bits >> 8) & 0xFF;
        bytes[byteIdx++] = bits & 0xFF;
    }

    // Process remaining chars (2 or 3)
    if (remainder === 2) {
        const a = B64_DECODE.get(str[i]) ?? 0;
        const b = B64_DECODE.get(str[i + 1]) ?? 0;
        bytes[byteIdx++] = ((a << 2) | (b >> 4)) & 0xFF;
    } else if (remainder === 3) {
        const a = B64_DECODE.get(str[i]) ?? 0;
        const b = B64_DECODE.get(str[i + 1]) ?? 0;
        const c = B64_DECODE.get(str[i + 2]) ?? 0;
        bytes[byteIdx++] = ((a << 2) | (b >> 4)) & 0xFF;
        bytes[byteIdx++] = ((b << 4) | (c >> 2)) & 0xFF;
    }

    return bytes;
}

// ─── MorphCompress Decompression Helper ──────────────────

/**
 * Try to decompress text that was compressed before encryption.
 * Compressed data is prefixed with magic byte 0x01 followed by base64.
 * @param {string} text - Possibly compressed text
 * @returns {string} Decompressed text or original text
 */
function _tryDecompress(text) {
    if (!text || text.length < 4 || text.charCodeAt(0) !== 0x01) {
        return text;
    }
    try {
        const b64 = text.substring(1);
        const binary = atob(b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        if (window.MorphCompress) {
            const mc = new window.MorphCompress();
            return mc.decompress(bytes);
        }
    } catch (e) { /* decompression failed, return original */ }
    return text;
}

// ─── Stego Carrier Overlay Sync ──────────────────────────────

/**
 * Sync the carrier overlay with the textarea content.
 * Immediately shows plain text (matching textarea exactly) so cursor stays aligned.
 * The debounced analysis will later replace with highlighted HTML.
 */
function _syncCarrierOverlay() {
    const carrier = dom.carrierText;
    const overlay = document.getElementById('carrier-overlay');
    if (!carrier || !overlay) return;

    if (!carrier.value) {
        // Show placeholder text (no highlights)
        overlay.setAttribute('data-placeholder', carrier.placeholder || '');
        overlay.innerHTML = '';
    } else {
        // Immediately show plain text — keeps cursor aligned with visible text.
        // The debounced analyzer will replace this with highlighted HTML shortly.
        overlay.removeAttribute('data-placeholder');
        // Use textContent for safety (no XSS) + white-space:pre-wrap handles newlines
        overlay.textContent = carrier.value;
    }

    // Re-sync scroll position after content change
    _syncCarrierScroll();
}

/**
 * Sync the overlay scroll position with the textarea.
 * The overlay uses overflow:hidden — only JS can scroll it.
 * Must be called after every overlay content update and on textarea scroll.
 */
function _syncCarrierScroll() {
    const overlay = document.getElementById('carrier-overlay');
    if (overlay && dom.carrierText) {
        overlay.scrollTop = dom.carrierText.scrollTop;
        overlay.scrollLeft = dom.carrierText.scrollLeft;
    }
}

// ─── Stego Tooltip System ───────────────────────────────────

let _stegoTooltipEl = null;
let _stegoTooltipTimer = null;

/**
 * Initialize the stego tooltip system.
 * Creates a fixed-position tooltip element and sets up hover detection
 * on the carrier overlay's highlighted spans via mousemove.
 */
function _initStegoTooltip() {
    // Create tooltip element
    _stegoTooltipEl = document.createElement('div');
    _stegoTooltipEl.className = 'cm-stego-tooltip';
    const messenger = document.querySelector('.crypto-messenger');
    if (messenger) {
        messenger.appendChild(_stegoTooltipEl);
    } else {
        document.body.appendChild(_stegoTooltipEl);
    }

    // Listen for mousemove on the carrier container to detect hover over highlights
    const container = document.getElementById('carrierContainer');
    if (container) {
        container.addEventListener('mousemove', (e) => {
            _handleStegoHover(e, container);
        });
        container.addEventListener('mouseleave', () => {
            _hideStegoTooltip();
        });
    }
}

function _handleStegoHover(e, container) {
    const overlay = document.getElementById('carrier-overlay');
    if (!overlay) return;

    // Find all highlighted spans and check if mouse is over any
    const spans = overlay.querySelectorAll('.stego-hl[data-tooltip]');
    let found = null;

    for (const span of spans) {
        const rect = span.getBoundingClientRect();
        if (e.clientX >= rect.left && e.clientX <= rect.right &&
            e.clientY >= rect.top && e.clientY <= rect.bottom) {
            found = span;
            break;
        }
    }

    if (found) {
        const tooltipText = found.getAttribute('data-tooltip');
        if (tooltipText) {
            _showStegoTooltip(tooltipText, found);
        }
    } else {
        _hideStegoTooltip();
    }
}

function _showStegoTooltip(text, anchorEl) {
    if (!_stegoTooltipEl) return;

    clearTimeout(_stegoTooltipTimer);

    // Decode HTML entities in tooltip text (data-tooltip may contain &#10; for newlines)
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = text;
    const decodedText = tempDiv.textContent || tempDiv.innerText || text;
    _stegoTooltipEl.textContent = decodedText;

    // Position above the anchor element
    const rect = anchorEl.getBoundingClientRect();
    let left = rect.left + rect.width / 2;
    let top = rect.top - 8;

    // Make sure tooltip is visible
    _stegoTooltipEl.style.left = left + 'px';
    _stegoTooltipEl.style.top = top + 'px';
    _stegoTooltipEl.style.transform = 'translate(-50%, -100%)';

    // Adjust if tooltip goes off-screen
    requestAnimationFrame(() => {
        const tooltipRect = _stegoTooltipEl.getBoundingClientRect();
        if (tooltipRect.left < 8) {
            _stegoTooltipEl.style.left = (8 + tooltipRect.width / 2) + 'px';
        }
        if (tooltipRect.right > window.innerWidth - 8) {
            _stegoTooltipEl.style.left = (window.innerWidth - 8 - tooltipRect.width / 2) + 'px';
        }
        if (tooltipRect.top < 8) {
            // Show below instead
            _stegoTooltipEl.style.top = (rect.bottom + 8) + 'px';
            _stegoTooltipEl.style.transform = 'translate(-50%, 0)';
        }
    });

    _stegoTooltipEl.classList.add('visible');
}

function _hideStegoTooltip() {
    if (!_stegoTooltipEl) return;
    _stegoTooltipTimer = setTimeout(() => {
        _stegoTooltipEl.classList.remove('visible');
    }, 100);
}

// ─── Event Listeners ─────────────────────────────────────────

function initEventListeners() {
    // Main mode tabs
    $$('.cm-tab').forEach(tab => {
        tab.addEventListener('click', () => switchMainMode(tab.dataset.category));
    });

    // Sub-mode tabs
    $$('.cm-subtab').forEach(subtab => {
        subtab.addEventListener('click', () => switchSubMode(subtab.dataset.mode));
    });

    // Direction toggle
    $$('.cm-direction-toggle__btn').forEach(btn => {
        btn.addEventListener('click', () => switchDirection(btn.dataset.direction));
    });

    // Encrypt send
    dom.btnEncryptSend?.addEventListener('click', handleEncryptSend);
    dom.encryptInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleEncryptSend();
        }
    });

    // FAB (Floating Action Button) send
    dom.btnFabSend?.addEventListener('click', handleFabSend);

    // Encrypt input live preview
    dom.encryptInput?.addEventListener('input', _tryEncryptPreview);

    // Password toggles
    _initPasswordToggle(dom.btnToggleEncryptPw, dom.encryptPassword);
    _initPasswordToggle(dom.btnToggleStegoEncPw, dom.passwordEncode);
    _initPasswordToggle(dom.btnToggleStegoDecPw, dom.passwordDecode);
    _initPasswordToggle(dom.btnToggleStegoRecPw, dom.passwordRecovery);

    // Encrypt copy
    dom.btnEncryptCopy?.addEventListener('click', () => {
        _copyToClipboard(dom.encryptInput.value);
    });

    // Encrypt result copy
    dom.btnEncryptResultCopy?.addEventListener('click', () => {
        const text = dom.encryptResultPreview?.textContent;
        if (text) _copyToClipboard(text);
    });

    // Bridge send
    dom.btnBridgeSend?.addEventListener('click', async () => {
        const text = dom.encryptResultPreview?.textContent;
        if (!text) return;
        const sent = await bridge.send(text, state.chatId);
        if (sent) {
            showToast('Отправлено через мост', 'success');
        } else {
            showToast('Мост не подключён или отправка не удалась', 'warning');
        }
    });

    // Stego encode
    dom.btnEncode?.addEventListener('click', handleStegoEncode);
    dom.secretMessage?.addEventListener('input', () => {
        updateStegoStats();
        _tryLivePreview();
    });
    // ─── Quick-insert aliases: [steg-email], [steg-phone], [steg-url] ───
    // When user types these aliases, they auto-expand to realistic placeholders
    const STEG_ALIASES = {
        '[steg-email]': 'ivanov.petrov@yandex.ru',
        '[steg-phone]': '+79001234567',
        '[steg-url]':   'https://example.com/page',
    };
    let _aliasExpanding = false; // guard against infinite loop

    function _expandStegAliases(textarea) {
        if (_aliasExpanding) return; // prevent re-entry
        const text = textarea.value;

        for (const [alias, replacement] of Object.entries(STEG_ALIASES)) {
            const aliasIdx = text.indexOf(alias);
            if (aliasIdx !== -1) {
                _aliasExpanding = true;
                const before = text.slice(0, aliasIdx);
                const after = text.slice(aliasIdx + alias.length);
                textarea.value = before + replacement + after;
                // Place cursor after the replacement
                const newCursor = aliasIdx + replacement.length;
                textarea.setSelectionRange(newCursor, newCursor);
                showToast(`Алиас ${alias} → ${replacement}`, 'info');
                break; // only expand one alias at a time
            }
        }
    }

    // Check for aliases on input
    dom.carrierText?.addEventListener('input', () => {
        // Check for alias expansion (has re-entry guard)
        _expandStegAliases(dom.carrierText);
        _aliasExpanding = false;
        // Clear abbr form memory when carrier text changes
        if (!dom.carrierText.value) {
            _abbrFormMemory.clear();
            state._lastStegoText = null;
        }
        // Sync overlay immediately (cheap) — keeps cursor aligned
        _syncCarrierOverlay();
        // Update extreme encoding capacity (debounced)
        _updateInlineExtremeCapacityDebounced();
        // Debounce the heavy analysis (non-blocking)
        if (state.stegoAnalyzer) {
            state.stegoAnalyzer.analyzeDebounced(dom.carrierText.value);
        } else {
            // Fallback: update stats synchronously only if no analyzer
            updateStegoStats();
        }
    });
    dom.passwordEncode?.addEventListener('input', _tryLivePreview);
    dom.passwordDecode?.addEventListener('input', () => {});

    // Carrier textarea scroll sync → overlay
    // Overlay uses overflow:hidden, so only JS can scroll it.
    dom.carrierText?.addEventListener('scroll', _syncCarrierScroll);

    // Initialize extreme encoding listeners
    _initExtremeEncodingListeners();

    // Explicitly handle paste: ensure analysis triggers after paste
    dom.carrierText?.addEventListener('paste', () => {
        // Use requestAnimationFrame to ensure the paste has been applied to textarea.value
        requestAnimationFrame(() => {
            _syncCarrierOverlay();
            // Debounce the heavy analysis (non-blocking)
            if (state.stegoAnalyzer) {
                state.stegoAnalyzer.analyzeDebounced(dom.carrierText.value);
            }
        });
    });

    // Stego tooltip system (fixed-position, not clipped by overflow)
    _initStegoTooltip();

    // Stego decode
    dom.btnDecode?.addEventListener('click', handleStegoDecode);

    // Stego recovery
    dom.btnRecovery?.addEventListener('click', handleStegoRecovery);

    // ─── Extreme Stego ──────────────────────────────────────
    dom.btnExtremeAction?.addEventListener('click', handleExtremeAction);
    dom.btnExtremeCopy?.addEventListener('click', () => {
        _copyToClipboard(dom.extremeOutput.textContent);
    });
    // "Send to Decode" button — transfers encoded text to decode textarea
    // without going through clipboard (avoids NBSP/ZW character stripping)
    document.getElementById('btn-extreme-to-decode')?.addEventListener('click', () => {
        const text = dom.extremeOutput?.textContent || '';
        if (!text || text.startsWith('⚠')) {
            showToast('Нет закодированного текста', 'warning');
            return;
        }
        // Store encoded text for decode
        state._extremeLastEncoded = text;
        // Switch to decode direction
        const dirBtn = dom.extremeDirection?.querySelector('[data-direction="decode"]');
        if (dirBtn) dirBtn.click();
        // Fill decode textarea
        if (dom.extremeStegoText) {
            dom.extremeStegoText.value = text;
        }
        showToast('Текст перенесён в декодирование', 'success');
    });
    dom.btnToggleExtremePw?.addEventListener('click', () => {
        _togglePasswordVisibility(dom.extremePassword);
    });
    // Extreme direction toggle
    dom.extremeDirection?.querySelectorAll('.cm-direction-toggle__btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const dir = btn.dataset.direction;
            dom.extremeDirection.querySelectorAll('.cm-direction-toggle__btn').forEach(b => b.classList.toggle('active', b.dataset.direction === dir));
            dom.extremeEncodeSection.style.display = dir === 'encode' ? '' : 'none';
            dom.extremeDecodeSection.style.display = dir === 'decode' ? '' : 'none';
            dom.btnExtremeAction.innerHTML = dir === 'encode'
                ? '<svg class="cm-icon cm-icon--sm"><use href="assets/icons/sprite.svg#icon-zap"/></svg> Кодировать'
                : '<svg class="cm-icon cm-icon--sm"><use href="assets/icons/sprite.svg#icon-unlock"/></svg> Декодировать';
            state._extremeDirection = dir;
            dom.extremeOutput.textContent = '';
        });
    });
    // Method toggles → update capacity
    [dom.extremeMethodZW, dom.extremeMethodSpaces, dom.extremeMethodCase, dom.extremeMethodCyrLat].forEach(cb => {
        cb?.addEventListener('change', _updateExtremeCapacity);
    });
    // Carrier input → update capacity
    dom.extremeCarrier?.addEventListener('input', _updateExtremeCapacity);
    state._extremeDirection = 'encode';

    // Stego copy
    dom.btnCopy?.addEventListener('click', () => {
        _copyToClipboard(dom.outputText.textContent);
    });

    // Abbr form reset button
    document.getElementById('btn-abbr-reset')?.addEventListener('click', () => {
        _clearAbbrFormMemory();
        showToast('Формы слов сброшены', 'info');
    });

    // LS edit mode toggle — temporarily strip letter-stego mutations for form editing
    document.getElementById('btn-ls-toggle')?.addEventListener('click', () => {
        _toggleLsEditMode();
    });

    // Settings
    dom.btnSettings?.addEventListener('click', openSettings);
    dom.btnCloseSettings?.addEventListener('click', closeSettings);
    dom.settingsOverlay?.addEventListener('click', closeSettings);

    // Chat ID
    dom.settingCurrentChatId?.addEventListener('change', () => {
        state.chatId = dom.settingCurrentChatId.value.trim();
        dom.chatIdDisplay.textContent = state.chatId || '—';

        // Auto-fill password if saved
        const saved = CleanCrypto.getSavedPassword(state.chatId);
        if (saved) {
            dom.encryptPassword.value = saved;
            dom.passwordEncode.value = saved;
            dom.passwordDecode.value = saved;
        }
    });

    // Chat password management
    dom.btnAddChatPw?.addEventListener('click', _addChatPassword);

    // Remember password toggle - save password when chatId changes
    dom.settingRememberPw?.addEventListener('change', () => {
        _saveSettings();
        if (dom.settingRememberPw.checked && state.chatId) {
            const pw = dom.encryptPassword.value;
            if (pw) {
                CleanCrypto.savePassword(state.chatId, pw);
                _loadChatPasswords();
            }
        }
    });

    // Stego channel toggles
    $$('.channel-toggle').forEach(cb => {
        cb.addEventListener('change', () => { updateActiveChannels(); _saveSettings(); });
    });

    // Synonym threshold slider
    dom.synThreshold?.addEventListener('input', () => {
        const val = parseFloat(dom.synThreshold.value);
        if (dom.thresholdVal) dom.thresholdVal.textContent = val.toFixed(2);
        const synCh = state.stegoEngine?.channels?.['synonyms'];
        if (synCh) synCh.setThreshold(val);
        updateStegoStats();
        _saveSettings();
    });

    // Letter density slider
    dom.letterDensity?.addEventListener('input', () => {
        const val = parseInt(dom.letterDensity.value);
        if (dom.densityVal) dom.densityVal.textContent = val + '%';
        const letterCh = state.stegoEngine?.channels?.['letter-stego'];
        if (letterCh) letterCh.setDensity(val / 100);
        updateStegoStats();
        _saveSettings();
    });

    // Synonym mode buttons
    $$('.syn-mode-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            $$('.syn-mode-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const mode = btn.dataset.synmode;
            const synCh = state.stegoEngine?.channels?.['synonyms'];
            if (synCh) synCh.setMode(mode);

            // Show/hide backend rows
            const backendRows = [document.getElementById('backend-url-row'),
                                document.getElementById('backend-status-row'),
                                document.getElementById('backend-check-row')];
            backendRows.forEach(el => el?.classList.toggle('cm-hidden', mode !== 'backend'));

            updateStegoStats();
        });
    });

    // Backend check
    document.getElementById('btn-check-backend')?.addEventListener('click', async () => {
        const synCh = state.stegoEngine?.channels?.['synonyms'];
        const statusEl = document.getElementById('backend-status');
        if (!synCh || !statusEl) return;

        const urlInput = document.getElementById('backend-url');
        if (urlInput) synCh.setBackendUrl(urlInput.value.trim());

        statusEl.textContent = '⏳ Проверка…';
        statusEl.style.color = 'var(--cm-text-muted)';
        const ok = await synCh.checkBackend();
        statusEl.textContent = ok ? '✅ Доступен' : '❌ Недоступен';
        statusEl.style.color = ok ? 'var(--cm-accent)' : 'var(--cm-danger)';
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeSettings();
        }
    });

    // Bridge incoming messages listener
    // SECURITY: Decrypted text is shown in our UI only — never sent back through the bridge
    bridge.listen(async ({ text, chatId, timestamp }) => {
        if (!bridge.autoDecode) return;
        const password = CleanCrypto.getSavedPassword(chatId) || dom.encryptPassword.value;
        if (!password) return;

        try {
            const result = await bridge._tryAutoDecode(text, password, chatId);
            if (result) {
                _showEncryptResult(result.text);
                showToast(`Авто-декодирование (${result.method})`, 'success');
            }
        } catch (e) {
            // silent
        }
    });
}

function _initPasswordToggle(btn, input) {
    if (!btn || !input) return;
    btn.addEventListener('click', () => {
        const isPassword = input.type === 'password';
        input.type = isPassword ? 'text' : 'password';
        // Update icon
        const use = btn.querySelector('use');
        if (use) {
            use.setAttribute('href', `assets/icons/sprite.svg#icon-${isPassword ? 'eye-off' : 'eye'}`);
        }
    });
}

function _copyToClipboard(text) {
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
        showToast('Скопировано!', 'success');
    }).catch(() => {
        // Fallback
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        showToast('Скопировано!', 'success');
    });
}

// ─── Initialize StegoEngine (async, non-blocking) ────────────

async function initStegoEngine() {
    try {
        if (typeof Az === 'undefined') {
            console.warn('Az.js not loaded, steganography disabled');
            return;
        }

        const { default: StegoEngine } = await import('./core/engine.js');
        const engine = new StegoEngine();

        if (dom.loadingProgress) dom.loadingProgress.style.width = '30%';

        await engine.loadChannels('');

        if (dom.loadingProgress) dom.loadingProgress.style.width = '100%';

        state.stegoEngine = engine;
        state.stegoReady = true;
        window.__stegoEngine = engine; // debug

        // Create analyzer for auto channel detection and highlighting
        const analyzer = new StegoAnalyzer(engine);
        analyzer.onChange(_renderAnalysisResult);

        // Connect analyzer progress indicator
        analyzer.onProgress((analyzing) => {
            const container = document.getElementById('carrierContainer');
            if (container) {
                container.classList.toggle('analyzing', analyzing);
            }
        });

        state.stegoAnalyzer = analyzer;

        // Initialize StegoT9 (или обновить синонимы если уже создан)
        if (!state._stegoT9 && dom.carrierText) {
            const { default: StegoT9 } = await import('./ui/stego-t9.js');
            state._stegoT9 = new StegoT9(dom.carrierText, engine);
        } else if (state._stegoT9) {
            // Engine загрузился — обновляем engine и синонимы в T9
            state._stegoT9.setEngine(engine);
        }

        // Initial stats
        updateActiveChannels();

        console.log('✅ StegoEngine ready. Channels:', Object.keys(engine.channels).length);
    } catch (e) {
        console.error('❌ StegoEngine init error:', e);
    }
}

// ─── Main Init ───────────────────────────────────────────────

async function init() {
    console.log('🔒 Стегонатор initializing…');

    // Load chat passwords (only if user previously opted in)
    _loadChatPasswords();

    // Load all saved settings from localStorage
    _loadSettings();

    // Init event listeners
    initEventListeners();

    // Set initial mode
    switchMainMode('encryption');
    switchDirection('encode');

    // Hide loading (stego engine loads in background)
    setTimeout(() => {
        if (dom.loading) {
            dom.loading.classList.add('hidden');
            setTimeout(() => dom.loading.style.display = 'none', 400);
        }
    }, 300);

    // Init stego engine (async, non-blocking)
    initStegoEngine().then(() => {
        // Re-hide loading after stego is ready
        if (dom.loading) {
            dom.loading.classList.add('hidden');
            setTimeout(() => dom.loading.style.display = 'none', 400);
        }
    });

    // Initialize StegoT9 IMMEDIATELY (before engine loads)
    // so alias suggestions work right away. Synonyms will be loaded later.
    if (dom.carrierText) {
        import('./ui/stego-t9.js').then(({ default: StegoT9 }) => {
            state._stegoT9 = new StegoT9(dom.carrierText, null);
        });
    }

    // Initialize Image Stego UI
    try {
        const imageStegoUI = new ImageStegoUI();
        imageStegoUI.init();
        state._imageStegoUI = imageStegoUI;
        console.log('🖼️ Image Stego UI ready');
    } catch (e) {
        console.warn('Image Stego UI init failed:', e.message);
    }

    // Initialize Markov Stego UI
    try {
        const markovStegoUI = new MarkovStegoUI();
        markovStegoUI.init();
        state._markovStegoUI = markovStegoUI;
        console.log('📚 Markov Stego UI ready');
    } catch (e) {
        console.warn('Markov Stego UI init failed:', e.message);
    }

    // Initialize LLM Stego UI
    try {
        const llmStegoUI = new LlmStegoUI();
        llmStegoUI.init();
        state._llmStegoUI = llmStegoUI;
        console.log('✨ LLM Stego UI ready');
    } catch (e) {
        console.warn('LLM Stego UI init failed:', e.message);
    }

    // Init Dev Tester (Ctrl+Shift+D)
    try {
        const { initDevShortcut, toggleDevPanel, runAllTests } = await import('./dev/dev-tester.js');
        initDevShortcut(state.stegoEngine);

        // Double-click on logo to open dev panel
        const logoEl = document.querySelector('.cm-header__logo');
        if (logoEl) {
            logoEl.addEventListener('dblclick', (e) => {
                e.preventDefault();
                toggleDevPanel(state.stegoEngine);
            });
        }

        console.log('🧪 Dev Tester ready (Ctrl+Shift+D)');
    } catch (e) {
        console.warn('Dev Tester not loaded:', e.message);
    }

    console.log('✅ Стегонатор ready!');
}

// ─── Public API (for integration: Tampermonkey, extensions, etc.) ──

window.StegonatorAPI = {
    /**
     * Set the current chat ID (for per-chat password management)
     * @param {string} chatId
     */
    setChatId(chatId) {
        state.chatId = chatId;
        dom.chatIdDisplay.textContent = chatId || '—';
        dom.settingCurrentChatId.value = chatId;

        // Auto-fill saved password
        const saved = CleanCrypto.getSavedPassword(chatId);
        if (saved) {
            dom.encryptPassword.value = saved;
            dom.passwordEncode.value = saved;
            dom.passwordDecode.value = saved;
        }
    },

    /**
     * Get the current chat ID.
     * @returns {string}
     */
    getChatId() {
        return state.chatId || '';
    },

    /**
     * Encrypt a message and return the encoded string
     * @param {string} plaintext
     * @param {string} password
     * @param {string} mode - 'aes256', 'invisible', 'base64', 'emoji', 'chinese', 'layout', 'compact'
     * @returns {Promise<string>}
     */
    async encrypt(plaintext, password, mode = 'aes256') {
        const chatId = state.chatId;

        if (mode === 'layout') {
            return LayoutSwitchEncoder.encodeString(plaintext, false);
        }

        // Compact cipher: standalone length-preserving encryption (no CleanCrypto)
        if (mode === 'compact') {
            return await compactCipher.encrypt(plaintext, password, chatId);
        }

        // MorphCompress: compress plaintext before encryption (saves space)
        let dataToEncrypt = plaintext;
        let compressed = false;
        if (window.MorphCompress && plaintext.length > 30) {
            try {
                const mc = new window.MorphCompress();
                const result = mc.compress(plaintext);
                if (result && result.length < plaintext.length * 0.95) {
                    // Compression saves >5% — prefix with magic byte to signal
                    dataToEncrypt = String.fromCharCode(0x01) + btoa(String.fromCharCode(...new Uint8Array(result)));
                    compressed = true;
                }
            } catch (e) { /* compression not available or failed */ }
        }

        const encrypted = await cleanCrypto.encrypt(dataToEncrypt, password, chatId);

        if (mode === 'aes256') {
            return _bytesToBase64url(encrypted);
        }

        const encoderId = mode === 'invisible' ? 'invisible-spaces' : mode;
        const encoder = getEncoderById(encoderId);
        if (!encoder) throw new Error('Unknown encoder: ' + mode);

        if (encoder.encode.constructor.name === 'AsyncFunction') {
            return await encoder.encode(encrypted);
        }
        return encoder.encode(encrypted);
    },

    /**
     * Decrypt an encrypted message.
     *
     * @param {string} ciphertext - The encrypted/encoded text
     * @param {string} password - Decryption password
     * @returns {Promise<string|null>} Decrypted plaintext, or null on failure
     */
    async decrypt(ciphertext, password) {
        if (!ciphertext || !password) return null;

        try {
            // Try CleanCrypto AES-256 base64
            const bytes = _base64urlToBytes(ciphertext);
            if (bytes) {
                const decrypted = await cleanCrypto.decrypt(bytes, password, state.chatId);
                if (decrypted) {
                    return _tryDecompress(decrypted);
                }
            }

            // Try encoder auto-detect
            const encoder = detectEncoder(ciphertext);
            if (encoder) {
                let decodedBytes;
                if (encoder.decode.constructor.name === 'AsyncFunction') {
                    decodedBytes = await encoder.decode(ciphertext);
                } else {
                    decodedBytes = encoder.decode(ciphertext);
                }
                if (decodedBytes) {
                    const decrypted = await cleanCrypto.decrypt(decodedBytes, password, state.chatId);
                    if (decrypted) {
                        return _tryDecompress(decrypted);
                    }
                }
            }

            // Try compact cipher (before layout — layout switch is always LAST
            // because it can "decode" almost any Latin text, producing garbage
            // for compact-encrypted messages. Compact cipher's MAC check ensures
            // no false positives, so it's safe to try before layout.)
            if (ciphertext.length >= 12 && CompactCipher.isSupported(ciphertext)) {
                try {
                    const compactDecoded = await compactCipher.decrypt(ciphertext, password, state.chatId);
                    if (compactDecoded !== null) {
                        return compactDecoded;
                    }
                } catch (e) { /* not compact cipher */ }
            }

            // Try layout switch (always LAST — just visual masking, not real encryption)
            const layoutDecoded = LayoutSwitchEncoder.decodeToString(ciphertext);
            if (layoutDecoded && layoutDecoded !== ciphertext) {
                return layoutDecoded;
            }

            return null;
        } catch (e) {
            return null;
        }
    },

    /**
     * Detect if text contains encrypted or steganographic content.
     * Returns ONLY metadata — never decrypts or returns plaintext.
     * @param {string} text
     * @returns {{ isEncrypted: boolean, algorithm: string|null, isStego: boolean, stegoCapacity: number }}
     */
    detect(text) {
        return bridge.detectEncryption(text);
    },

    /**
     * Encode a secret message into carrier text using steganography.
     * Returns the stego text only — never the plaintext secret.
     * @param {string} secret - The secret message to hide
     * @param {string} carrier - The carrier text to hide within
     * @param {string} password - Encryption password
     * @returns {Promise<string|null>} The stego text, or null on failure
     */
    async stegoEncode(secret, carrier, password) {
        if (!state.stegoReady) return null;
        try {
            let autoChannels = state.stegoAnalyzer
                ? state.stegoAnalyzer.getAutoChannels(carrier)
                : [];
            if (!_isLetterStegoEnabled()) {
                autoChannels = autoChannels.filter(ch => ch !== 'letter-stego');
            }
            if (autoChannels.length > 0) {
                state.stegoEngine.setActiveChannels(autoChannels);
            }
            return await state.stegoEngine.encodeMessage(secret, carrier, password);
        } catch (e) {
            return null;
        }
    },

    /**
     * Decode a steganographic message.
     * Returns the decoded message text.
     * @param {string} stegoText - The stego text containing a hidden message
     * @param {string} password - Decryption password
     * @returns {Promise<string|null>} The decoded message, or null on failure
     */
    async stegoDecode(stegoText, password) {
        if (!state.stegoReady) return null;
        try {
            const autoChannels = state.stegoAnalyzer
                ? state.stegoAnalyzer.getAutoChannels(stegoText)
                : [];
            if (autoChannels.length > 0) {
                state.stegoEngine.setActiveChannels(autoChannels);
            }
            return await state.stegoEngine.decodeMessage(stegoText, password);
        } catch (e) {
            return null;
        }
    },

    /**
     * Check if the steganography engine is loaded and ready.
     * @returns {boolean}
     */
    isReady() {
        return state.stegoReady;
    },

    /**
     * Get sanitized app state (safe fields only).
     * Removes sensitive internal references (stegoEngine, stegoAnalyzer).
     */
    getState() {
        const safe = { ...state };
        delete safe.stegoEngine;
        delete safe.stegoAnalyzer;
        return safe;
    },

    /**
     * Show a toast notification
     */
    notify: showToast,

    /**
     * Set a custom send callback for the floating action button (FAB).
     * When the user clicks the FAB, this callback is invoked with the
     * encrypted/stego output text.
     *
     * @param {Function|null} fn - async (text, mode) => void
     *   Pass null to clear the callback (falls back to bridge).
     *
     * @example
     *   StegonatorAPI.setSendCallback(async (text, mode) => {
     *     await myMessenger.send(text);
     *   });
     */
    setSendCallback(fn) {
        _sendCallback = fn;
    },

    /**
     * Get the current output text (encrypted/stego result), if any.
     * Returns null if no output is available in the current mode.
     * @returns {string|null}
     */
    getOutputText() {
        if (state.mode === 'encryption') {
            if (dom.encryptResultSection?.style.display === 'none') return null;
            return dom.encryptResultPreview?.textContent?.trim() || null;
        }
        if (state.mode === 'steganography' && state.subMode === 'stego-encode') {
            return state._lastStegoText || null;
        }
        return null;
    },

    /**
     * Programmatically trigger the floating send button.
     * @returns {Promise<void>}
     */
    async fabSend() {
        return handleFabSend();
    },

    // ─── Debug methods — only available if localStorage flag is set ──
    // Set localStorage.setItem('stegonator_debug', 'true') to enable.

    get _debug() {
        try { return JSON.parse(localStorage.getItem('stegonator_debug') || 'false'); } catch { return false; }
    },

    /**
     * Get stego engine instance (debug only).
     * @returns {StegoEngine|null}
     */
    _debug_getEngine() {
        if (!this._debug) return null;
        return state.stegoEngine;
    },
};

window.CryptoMsgAPI = window.StegonatorAPI; // backward compat

// ─── Start ───────────────────────────────────────────────────

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
