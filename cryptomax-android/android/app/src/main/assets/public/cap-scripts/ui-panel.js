/**
 * ui-panel.js — Material Design UI panel for CryptoMAX Android
 *
 * Injected into web.max.ru WebView AFTER preload-main.js and engine-bundle.js.
 *
 * Components:
 * 1. Bottom drawer (25-30% screen height) with settings:
 *    - Chat ID, password input (show/hide), save button
 *    - Overlay toggle, encryption mode picker
 * 2. Floating input bar (appears when user taps web.max.ru message input
 *    AND encryption is enabled)
 *
 * Uses window.CryptoEngineAPI for encrypt/decrypt (in-page, no bridge).
 * Uses window.__cm_send_encrypted() to send to web.max.ru.
 * Uses window.__cm_bridgeCall() for native operations (save password, etc.).
 *
 * Security: UI is isolated from web.max.ru via Shadow DOM (closed).
 */

(function () {
    'use strict';
    if (window.__cm_ui_injected) return;
    window.__cm_ui_injected = true;

    // ─── Lucide Icons (inline SVG) ────────────────────────────────

    var ICONS = {
        chevronUp: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>',
        chevronDown: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
        eye: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>',
        eyeOff: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/></svg>',
        save: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>',
        lock: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
        unlock: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>',
        send: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>',
        close: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
        shield: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/></svg>',
        chat: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 21 1.9-5.7a8.5 8.5 0 1 1 3.8 3.8z"/></svg>',
        key: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4"/><path d="m21 2-9.6 9.6"/><circle cx="7.5" cy="15.5" r="5.5"/></svg>',
    };

    // ─── State ────────────────────────────────────────────────────

    var _state = {
        mode: 'aes256',
        chatId: '',
        password: '',
        passwordVisible: false,
        encryptionEnabled: true,
        overlaysVisible: true,
        drawerExpanded: false,
        savedPasswords: {},
    };

    var _drawerHost = null;
    var _drawerShadow = null;
    var _floatingHost = null;
    var _floatingShadow = null;
    var _floatingInput = null;
    var _floatingVisible = false;
    var _savedInputText = ''; // Preserved text when floating bar is hidden

    // ─── Material Design Colors ───────────────────────────────────

    var COLORS = {
        bg: '#1e1e2e',
        surface: '#2a2a3c',
        surfaceLight: '#353548',
        primary: '#0fe2c2',
        primaryDark: '#0bc4a8',
        text: '#e4e6eb',
        textSecondary: '#9ca3af',
        error: '#ef4444',
        border: '#3a3a4e',
    };

    // ─── Bottom Drawer (Settings Panel) ───────────────────────────
    //
    // Pull tab at bottom of screen. Expands to 28% screen height.
    // Contains: chat ID, password, mode picker, toggles.

    function createDrawer() {
        if (_drawerHost) return;

        _drawerHost = document.createElement('div');
        _drawerHost.id = 'cm-drawer-host';
        _drawerHost.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:999998;pointer-events:none;';

        _drawerShadow = _drawerHost.attachShadow({ mode: 'closed' });

        var style = document.createElement('style');
        style.textContent = [
            ':host { all: initial; }',
            '.drawer {',
            '  position: fixed; bottom: 0; left: 0; right: 0;',
            '  background: ' + COLORS.bg + ';',
            '  border-radius: 16px 16px 0 0;',
            '  box-shadow: 0 -4px 20px rgba(0,0,0,0.4);',
            '  transition: transform 0.3s cubic-bezier(0.4,0,0.2,1);',
            '  transform: translateY(calc(100% - 36px));',
            '  pointer-events: auto;',
            '  max-height: 28vh;',
            '  overflow-y: auto;',
            '  -webkit-overflow-scrolling: touch;',
            '}',
            '.drawer.expanded { transform: translateY(0); }',
            '.tab {',
            '  height: 36px; display: flex; align-items: center; justify-content: center;',
            '  cursor: pointer; gap: 6px; color: ' + COLORS.textSecondary + ';',
            '  font-size: 12px; font-family: Roboto, sans-serif;',
            '  border-bottom: 1px solid ' + COLORS.border + ';',
            '}',
            '.tab:active { background: ' + COLORS.surfaceLight + '; }',
            '.content { padding: 12px 16px 16px; }',
            '.row { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }',
            '.label { color: ' + COLORS.textSecondary + '; font-size: 12px; font-family: Roboto,sans-serif; min-width: 56px; }',
            '.value { color: ' + COLORS.text + '; font-size: 14px; font-family: Roboto,sans-serif; flex: 1; }',
            '.input {',
            '  flex: 1; background: ' + COLORS.surface + '; border: 1px solid ' + COLORS.border + ';',
            '  border-radius: 8px; padding: 8px 12px; color: ' + COLORS.text + ';',
            '  font-size: 14px; font-family: Roboto,sans-serif; outline: none;',
            '}',
            '.input:focus { border-color: ' + COLORS.primary + '; }',
            '.btn {',
            '  width: 36px; height: 36px; border-radius: 8px; border: none;',
            '  background: ' + COLORS.surface + '; color: ' + COLORS.text + ';',
            '  display: flex; align-items: center; justify-content: center;',
            '  cursor: pointer; flex-shrink: 0;',
            '}',
            '.btn:active { background: ' + COLORS.surfaceLight + '; }',
            '.btn.primary { background: ' + COLORS.primary + '; color: #fff; }',
            '.btn.primary:active { background: ' + COLORS.primaryDark + '; }',
            '.select {',
            '  flex: 1; background: ' + COLORS.surface + '; border: 1px solid ' + COLORS.border + ';',
            '  border-radius: 8px; padding: 8px 12px; color: ' + COLORS.text + ';',
            '  font-size: 14px; font-family: Roboto,sans-serif; outline: none;',
            '  -webkit-appearance: none; appearance: none;',
            '}',
            '.toggle {',
            '  width: 44px; height: 24px; border-radius: 12px;',
            '  background: ' + COLORS.border + '; position: relative; cursor: pointer;',
            '  transition: background 0.2s; flex-shrink: 0;',
            '}',
            '.toggle.on { background: ' + COLORS.primary + '; }',
            '.toggle-knob {',
            '  width: 20px; height: 20px; border-radius: 50%; background: #fff;',
            '  position: absolute; top: 2px; left: 2px;',
            '  transition: transform 0.2s;',
            '}',
            '.toggle.on .toggle-knob { transform: translateX(20px); }',
            '.status-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }',
            '.status-dot.on { background: ' + COLORS.primary + '; }',
            '.status-dot.off { background: ' + COLORS.error + '; }',
        ].join('\n');
        _drawerShadow.appendChild(style);

        var drawer = document.createElement('div');
        drawer.className = 'drawer';
        drawer.id = 'cm-drawer';

        // Tab handle
        var tab = document.createElement('div');
        tab.className = 'tab';
        tab.innerHTML = ICONS.chevronUp + '<span>CryptoMAX</span>';
        tab.addEventListener('click', function () {
            _state.drawerExpanded = !_state.drawerExpanded;
            drawer.classList.toggle('expanded', _state.drawerExpanded);
            tab.innerHTML = _state.drawerExpanded
                ? ICONS.chevronDown + '<span>CryptoMAX</span>'
                : ICONS.chevronUp + '<span>CryptoMAX</span>';
        });
        drawer.appendChild(tab);

        // Content
        var content = document.createElement('div');
        content.className = 'content';

        // Row 1: Chat ID
        var row1 = document.createElement('div');
        row1.className = 'row';
        row1.innerHTML =
            '<span class="label">Чат</span>' +
            '<span class="value" id="cm-chat-id">—</span>' +
            '<div class="status-dot off" id="cm-pw-status"></div>';
        content.appendChild(row1);

        // Row 2: Password
        var row2 = document.createElement('div');
        row2.className = 'row';
        var pwLabel = document.createElement('span');
        pwLabel.className = 'label';
        pwLabel.innerHTML = ICONS.key;
        row2.appendChild(pwLabel);

        var pwInput = document.createElement('input');
        pwInput.type = 'password';
        pwInput.className = 'input';
        pwInput.placeholder = 'Пароль';
        pwInput.id = 'cm-pw-input';
        pwInput.addEventListener('input', function () {
            _state.password = pwInput.value;
            window.__cm_setPwd(_state.password);
        });
        row2.appendChild(pwInput);

        var pwToggle = document.createElement('button');
        pwToggle.className = 'btn';
        pwToggle.innerHTML = ICONS.eye;
        pwToggle.addEventListener('click', function () {
            _state.passwordVisible = !_state.passwordVisible;
            pwInput.type = _state.passwordVisible ? 'text' : 'password';
            pwToggle.innerHTML = _state.passwordVisible ? ICONS.eyeOff : ICONS.eye;
        });
        row2.appendChild(pwToggle);

        var saveBtn = document.createElement('button');
        saveBtn.className = 'btn primary';
        saveBtn.innerHTML = ICONS.save;
        saveBtn.title = 'Сохранить пароль';
        saveBtn.addEventListener('click', function () {
            if (!_state.chatId) return;
            window.__cm_bridgeCall('savePassword', [_state.chatId, _state.password]).then(function () {
                _state.savedPasswords[_state.chatId] = _state.password;
                updateStatus();
                showToast('Пароль сохранён');
            });
        });
        row2.appendChild(saveBtn);

        content.appendChild(row2);

        // Row 3: Mode picker
        var row3 = document.createElement('div');
        row3.className = 'row';
        var modeLabel = document.createElement('span');
        modeLabel.className = 'label';
        modeLabel.innerHTML = ICONS.shield;
        row3.appendChild(modeLabel);

        var modeSelect = document.createElement('select');
        modeSelect.className = 'select';
        modeSelect.id = 'cm-mode-select';
        row3.appendChild(modeSelect);

        content.appendChild(row3);

        // Row 4: Toggles
        var row4 = document.createElement('div');
        row4.className = 'row';

        // Encryption toggle
        var encLabel = document.createElement('span');
        encLabel.className = 'label';
        encLabel.textContent = 'Шифр';
        row4.appendChild(encLabel);

        var encToggle = document.createElement('div');
        encToggle.className = 'toggle on';
        encToggle.innerHTML = '<div class="toggle-knob"></div>';
        encToggle.addEventListener('click', function () {
            _state.encryptionEnabled = !_state.encryptionEnabled;
            encToggle.classList.toggle('on', _state.encryptionEnabled);
            window.__cm_encryptionEnabled = _state.encryptionEnabled;
            if (window.__cm_encryptionEnabled === false) {
                hideFloatingBar();
            }
        });
        row4.appendChild(encToggle);

        // Overlay toggle
        var ovLabel = document.createElement('span');
        ovLabel.className = 'label';
        ovLabel.style.marginLeft = '16px';
        ovLabel.textContent = 'Overlay';
        row4.appendChild(ovLabel);

        var ovToggle = document.createElement('div');
        ovToggle.className = 'toggle on';
        ovToggle.innerHTML = '<div class="toggle-knob"></div>';
        ovToggle.addEventListener('click', function () {
            _state.overlaysVisible = !_state.overlaysVisible;
            ovToggle.classList.toggle('on', _state.overlaysVisible);
            window.__cm_overlaysVisible = _state.overlaysVisible;
            window.__cm_bridgeCall('setOverlayVisibility', [_state.overlaysVisible]);
        });
        row4.appendChild(ovToggle);

        content.appendChild(row4);

        drawer.appendChild(content);
        _drawerShadow.appendChild(drawer);
        document.body.appendChild(_drawerHost);
    }

    function updateStatus() {
        var dot = _drawerShadow.querySelector('#cm-pw-status');
        if (!dot) return;
        var hasPw = _state.password && _state.password.length > 0;
        dot.className = 'status-dot ' + (hasPw ? 'on' : 'off');
    }

    function updateChatId(chatId) {
        _state.chatId = chatId || '';
        window.__cm_setChatId(_state.chatId);
        var el = _drawerShadow.querySelector('#cm-chat-id');
        if (el) el.textContent = _state.chatId || '—';
        // Auto-fill password if saved
        if (_state.savedPasswords[_state.chatId]) {
            _state.password = _state.savedPasswords[_state.chatId];
            window.__cm_setPwd(_state.password);
            var pwInput = _drawerShadow.querySelector('#cm-pw-input');
            if (pwInput) pwInput.value = _state.password;
        }
        updateStatus();
    }

    function populateModes() {
        var select = _drawerShadow.querySelector('#cm-mode-select');
        if (!select || !window.CryptoEngineAPI) return;
        var modes = window.CryptoEngineAPI.getSupportedModes();
        select.innerHTML = '';
        for (var i = 0; i < modes.length; i++) {
            var opt = document.createElement('option');
            opt.value = modes[i].id;
            opt.textContent = (modes[i].icon || '') + ' ' + modes[i].label;
            select.appendChild(opt);
        }
        select.value = _state.mode;
        select.addEventListener('change', function () {
            _state.mode = select.value;
            window.__cm_setMode(_state.mode);
        });
    }

    // ─── Floating Input Bar ───────────────────────────────────────
    //
    // Appears when user taps web.max.ru message input AND encryption is ON.
    // Multi-line textarea with send button. Text preserved when hidden.

    function createFloatingBar() {
        if (_floatingHost) return;

        _floatingHost = document.createElement('div');
        _floatingHost.id = 'cm-floating-host';
        _floatingHost.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:999999;pointer-events:none;';

        _floatingShadow = _floatingHost.attachShadow({ mode: 'closed' });

        var style = document.createElement('style');
        style.textContent = [
            ':host { all: initial; }',
            '.bar {',
            '  position: fixed; bottom: 0; left: 0; right: 0;',
            '  background: ' + COLORS.bg + ';',
            '  border-radius: 16px 16px 0 0;',
            '  box-shadow: 0 -4px 20px rgba(0,0,0,0.5);',
            '  padding: 12px 12px 16px;',
            '  pointer-events: auto;',
            '  display: none;',
            '  animation: slideUp 0.2s ease-out;',
            '}',
            '.bar.visible { display: block; }',
            '@keyframes slideUp { from { transform: translateY(100%); } to { transform: translateY(0); } }',
            '.row { display: flex; gap: 8px; align-items: flex-end; }',
            '.input {',
            '  flex: 1; background: ' + COLORS.surface + '; border: 1px solid ' + COLORS.border + ';',
            '  border-radius: 20px; padding: 10px 16px; color: ' + COLORS.text + ';',
            '  font-size: 15px; font-family: Roboto,sans-serif; outline: none;',
            '  resize: none; overflow-y: auto; max-height: 120px; line-height: 1.4;',
            '  min-height: 40px;',
            '}',
            '.input:focus { border-color: ' + COLORS.primary + '; }',
            '.send {',
            '  width: 44px; height: 44px; border-radius: 50%; border: none;',
            '  background: ' + COLORS.primary + '; color: #fff;',
            '  display: flex; align-items: center; justify-content: center;',
            '  cursor: pointer; flex-shrink: 0;',
            '}',
            '.send:active { background: ' + COLORS.primaryDark + '; }',
            '.send:disabled { opacity: 0.4; }',
            '.header { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; color: ' + COLORS.textSecondary + '; font-size: 11px; font-family: Roboto,sans-serif; }',
            '.close-btn {',
            '  margin-left: auto; width: 28px; height: 28px; border-radius: 50%;',
            '  border: none; background: ' + COLORS.surface + '; color: ' + COLORS.textSecondary + ';',
            '  display: flex; align-items: center; justify-content: center; cursor: pointer;',
            '}',
        ].join('\n');
        _floatingShadow.appendChild(style);

        var bar = document.createElement('div');
        bar.className = 'bar';
        bar.id = 'cm-floating-bar';

        var header = document.createElement('div');
        header.className = 'header';
        header.innerHTML = ICONS.lock + '<span>Зашифрованное сообщение</span>';
        var closeBtn = document.createElement('button');
        closeBtn.className = 'close-btn';
        closeBtn.innerHTML = ICONS.close;
        closeBtn.addEventListener('click', function () { hideFloatingBar(); });
        header.appendChild(closeBtn);
        bar.appendChild(header);

        var row = document.createElement('div');
        row.className = 'row';

        var input = document.createElement('textarea');
        input.className = 'input';
        input.placeholder = 'Введите сообщение...';
        input.rows = 1;
        input.addEventListener('input', function () {
            _savedInputText = input.value;
            input.style.height = 'auto';
            input.style.height = Math.min(input.scrollHeight, 120) + 'px';
        });
        input.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                onSend();
            }
        });
        row.appendChild(input);

        var sendBtn = document.createElement('button');
        sendBtn.className = 'send';
        sendBtn.innerHTML = ICONS.send;
        sendBtn.addEventListener('click', function () { onSend(); });
        row.appendChild(sendBtn);

        bar.appendChild(row);
        _floatingShadow.appendChild(bar);
        document.body.appendChild(_floatingHost);

        _floatingInput = input;
    }

    function showFloatingBar() {
        if (!_state.encryptionEnabled) return;
        createFloatingBar();
        var bar = _floatingShadow.querySelector('#cm-floating-bar');
        if (bar) {
            bar.classList.add('visible');
            _floatingVisible = true;
            // Restore saved text
            _floatingInput.value = _savedInputText;
            setTimeout(function () { _floatingInput.focus(); }, 100);
        }
    }

    function hideFloatingBar() {
        if (!_floatingShadow) return;
        var bar = _floatingShadow.querySelector('#cm-floating-bar');
        if (bar) {
            // Save text before hiding
            if (_floatingInput) _savedInputText = _floatingInput.value;
            bar.classList.remove('visible');
            _floatingVisible = false;
        }
    }

    function onSend() {
        if (!_floatingInput || !_floatingInput.value.trim()) return;
        var text = _floatingInput.value;
        _floatingInput.value = '';
        _savedInputText = '';
        _floatingInput.style.height = 'auto';

        // Encrypt via CryptoEngineAPI (in-page, no bridge)
        if (!window.CryptoEngineAPI) {
            console.error('[CryptoMAX] Engine not ready');
            return;
        }

        window.CryptoEngineAPI.encrypt(text, _state.password, _state.mode, _state.chatId)
            .then(function (encoded) {
                if (encoded) {
                    window.__cm_send_encrypted(encoded);
                    hideFloatingBar();
                }
            })
            .catch(function (e) {
                console.error('[CryptoMAX] encrypt error:', e);
                showToast('Ошибка: ' + (e.message || e));
            });
    }

    // ─── Textbox Focus Interception ───────────────────────────────
    //
    // When user taps web.max.ru message input AND encryption is ON,
    // intercept focus and show floating bar instead.

    function interceptTextboxFocus() {
        var textboxes = document.querySelectorAll('div[role="textbox"]');
        for (var i = 0; i < textboxes.length; i++) {
            var tb = textboxes[i];
            if (tb.dataset.cmIntercepted) continue;
            if (tb.closest('#cm-drawer-host') || tb.closest('#cm-floating-host')) continue;
            if (tb.closest('.messageWrapper')) continue;

            tb.dataset.cmIntercepted = '1';

            tb.addEventListener('focus', function (e) {
                if (window.__cm_sending) return;
                if (!_state.encryptionEnabled) return;
                e.preventDefault();
                e.stopPropagation();
                // Blur the web.max.ru textbox to prevent keyboard confusion
                this.blur();
                showFloatingBar();
            });

            tb.addEventListener('touchstart', function (e) {
                if (window.__cm_sending) return;
                if (!_state.encryptionEnabled) return;
                e.preventDefault();
                e.stopPropagation();
                this.blur();
                showFloatingBar();
            }, { passive: false });
        }
    }

    // ─── Click outside to hide floating bar ───────────────────────

    function setupOutsideClickHandler() {
        document.addEventListener('click', function (e) {
            if (!_floatingVisible) return;
            // Check if click is outside floating bar
            var target = e.target;
            if (_floatingHost && _floatingHost.contains(target)) return;
            // If clicking on web.max.ru content (not our UI), hide floating bar
            if (target.closest && !target.closest('#cm-floating-host')) {
                hideFloatingBar();
            }
        }, true);
    }

    // ─── Toast ────────────────────────────────────────────────────

    function showToast(msg) {
        var t = document.createElement('div');
        t.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:' + COLORS.surface + ';color:' + COLORS.text + ';padding:8px 16px;border-radius:8px;font-size:13px;font-family:Roboto,sans-serif;z-index:9999999;box-shadow:0 2px 8px rgba(0,0,0,0.3);';
        t.textContent = msg;
        document.body.appendChild(t);
        setTimeout(function () {
            t.style.opacity = '0';
            t.style.transition = 'opacity 0.3s';
            setTimeout(function () { t.remove(); }, 300);
        }, 2000);
    }

    // ─── URL Observer (SPA navigation) ────────────────────────────

    function setupUrlObserver() {
        var lastUrl = location.href;
        function checkUrl() {
            if (location.href !== lastUrl) {
                lastUrl = location.href;
                // Extract chatId from URL
                var parts = location.pathname.split('/').filter(function (p) { return p && p !== ''; });
                var chatId = parts.length > 0 ? parts[parts.length - 1] : '';
                updateChatId(chatId);
            }
        }
        setInterval(checkUrl, 1000);
    }

    // ─── Init ─────────────────────────────────────────────────────

    function init() {
        // Wait for engine to be ready
        function waitForEngine() {
            if (window.CryptoEngineAPI && window.CryptoEngineAPI.isReady()) {
                start();
            } else {
                setTimeout(waitForEngine, 200);
            }
        }

        function start() {
            // Create UI
            createDrawer();
            createFloatingBar();
            populateModes();
            setupOutsideClickHandler();
            setupUrlObserver();

            // Intercept textbox focus
            setTimeout(interceptTextboxFocus, 1500);
            setInterval(interceptTextboxFocus, 3000);

            // Load saved passwords from native
            window.__cm_bridgeCall('getAllPasswords', []).then(function (result) {
                if (result && result.passwords) {
                    _state.savedPasswords = result.passwords;
                }
                // Get current chatId
                return window.__cm_bridgeCall('getChatId', []);
            }).then(function (result) {
                if (result && result.chatId) {
                    updateChatId(result.chatId);
                } else {
                    // Fallback: extract from URL
                    var parts = location.pathname.split('/').filter(function (p) { return p && p !== ''; });
                    updateChatId(parts.length > 0 ? parts[parts.length - 1] : '');
                }
            }).catch(function (e) {
                console.log('[CryptoMAX] init error:', e);
            });

            console.log('[CryptoMAX] UI panel initialized');
        }

        waitForEngine();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
