// Audio extension для CryptoMAX Electron.
// Адаптация userscript-max-audio-extension.user.js v2.1.0.
// Bridge к Electron: window.__evoice_request перенаправляется на ipcRenderer.
// Стили и логика плееров/записи перенесены из Tampermonkey-версии без изменений.

(function () {
    'use strict';

    var ipcRenderer = window.__cm_ipc;
    if (!ipcRenderer) {
        console.error('[CryptoMAX Audio] IPC bridge not available');
        return;
    }

    var AUDIO_EXTENSIONS = /\.(mp3|wav|ogg|oga|opus|m4a|aac|flac|wma|aiff|webm)$/i;
    var AUDIO_TYPE_BADGES = ['MP3', 'WAV', 'OGG', 'OGA', 'OPUS', 'M4A', 'AAC', 'FLAC', 'WMA', 'AIFF', 'WEBM'];
    var EV1_MAGIC = [0x45, 0x56, 0x31]; // "EV1"

    var ICONS = {
        play: '<svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
        pause: '<svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>',
        mic: '<svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/><path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>',
        micStop: '<svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="#ff3b30"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
        download: '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>',
        lock: '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
        lockRec: '<svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/><circle cx="12" cy="16" r="1.5" fill="currentColor"/></svg>',
        lockPlay: '<svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/><polygon points="10,15 10,19 14,17" fill="currentColor" stroke="none"/></svg>',
    };

    // Стили плееров и кнопки записи (из Tampermonkey-версии)
    var style = document.createElement('style');
    style.textContent = [
        '.max-ext-player { display: grid; align-items: center; gap: 8px; border-radius: 4px; padding: 0; grid-template-columns: 44px 1fr auto; min-width: 260px; }',
        '.max-ext-player .max-ext-play-btn { width: 44px; height: 44px; border-radius: 50%; border: none; display: flex; align-items: center; justify-content: center; cursor: pointer; background: var(--bubbles-background-action, rgb(15,142,194)); color: var(--bubbles-icon-action, rgb(233,253,255)); transition: opacity 0.15s; flex-shrink: 0; }',
        '.max-ext-player .max-ext-play-btn:hover { opacity: 0.85; }',
        '.max-ext-player .max-ext-content { display: flex; flex-direction: row; align-items: center; gap: 8px; min-width: 0; overflow: hidden; }',
        '.max-ext-player .max-ext-wave { display: flex; align-items: center; gap: 2px; height: 24px; min-width: 120px; flex: 1; cursor: pointer; }',
        '.max-ext-player .max-ext-peak { width: 2px; flex: 0 1 auto; border-radius: 2px; background: var(--bubbles-background-action-fade, rgba(15,142,194,0.36)); transition: background 0.1s; }',
        '.max-ext-player .max-ext-peak.played { background: var(--bubbles-background-action, rgb(15,142,194)); }',
        '.max-ext-player .max-ext-meta { display: flex; align-items: center; gap: 2px; white-space: nowrap; }',
        '.max-ext-player .max-ext-duration { font-size: 13px; color: var(--text-secondary, rgb(108,116,124)); white-space: nowrap; }',
        '.max-ext-player .max-ext-dl { display: flex; align-items: center; justify-content: center; width: 24px; height: 24px; color: var(--bubbles-background-action, rgb(15,142,194)); opacity: 0.5; cursor: pointer; text-decoration: none; margin-left: 4px; }',
        '.max-ext-player .max-ext-dl:hover { opacity: 0.8; }',
        '',
        '.max-ext-evoice-player { display: grid; align-items: center; gap: 8px; border-radius: 8px; padding: 8px 10px; grid-template-columns: 44px 1fr auto; min-width: 260px; background: linear-gradient(135deg, var(--bubbles-background-bubble-gradient-old-step-1), --bubbles-background-bubble-gradient-old-step-2)); /* border: 1px solid rgba(15,142,194,0.2); */ }',
        '.max-ext-evoice-player .evoice-play-btn { width: 44px; height: 44px; border-radius: 50%; border: 2px solid #671f7de3; display: flex; align-items: center; justify-content: center; cursor: pointer; background: rgb(255 193 245 / 38%); color: rgb(113 49 133); transition: all 0.15s; flex-shrink: 0; }',
        '.max-ext-evoice-player .evoice-play-btn:hover { background: rgba(15,142,194,0.25); transform: scale(1.05); }',
        '.max-ext-evoice-player .evoice-play-btn.playing { border-color: rgba(255,59,48,0.4); background: rgba(255,59,48,0.12); color: rgb(255,59,48); }',
        '.max-ext-evoice-player .evoice-info { display: flex; flex-direction: column; gap: 2px; min-width: 0; overflow: hidden; }',
        '.max-ext-evoice-player .evoice-label { font-size: 13px; font-weight: 800; var(--bubbles-text-body); display: flex; align-items: center; gap: 4px; }',
        '.max-ext-evoice-player .evoice-hint { font-size: 11px; color: var(--text-secondary, rgb(108,116,124)); }',
        '.max-ext-evoice-player .evoice-status { font-size: 12px; color: var(--text-secondary, rgb(108,116,124)); text-align: right; white-space: nowrap; }',
        '',
        '.max-voice-rec-btn.recording .button--overrided { animation: max-rec-pulse 1.2s ease-in-out infinite; }',
        '@keyframes max-rec-pulse { 0% { opacity: 1; } 50% { opacity: 0.3; } 100% { opacity: 1; } }',
        'button.max-voice-rec-btn { background: none; border: none; cursor: pointer; }',
        'button.max-voice-rec-btn svg:hover { fill: #d5d5d5; }',
        '.evoice-status-dot { width: 6px; height: 6px; border-radius: 50%; display: inline-block; margin-left: 2px; }',
        '.evoice-status-dot.online { background: #34c759; }',
        '.evoice-status-dot.offline { background: #ff3b30; }',
    ].join('\n');
    document.head.appendChild(style);

    // Bridge: evoice запросы через Electron IPC
    // В Electron шифрованная запись и воспроизведение идут через main process
    var evoice = {
        serviceAvailable: true,  // В Electron сервис всегда доступен
        passwordSet: false,

        async request(action, params) {
            // Проверить, задан ли пароль
            if (action === 'checkStatus') {
                var chatId = getCurrentChatId();
                var pwd = ipcRenderer.sendSync('cm-get-password-sync', { chatId: chatId });
                evoice.passwordSet = !!pwd;
                return { available: true, password_set: evoice.passwordSet };
            }
            if (action === 'startRecording') {
                // Открыть изолированное окно записи
                ipcRenderer.send('cm-open-voice-recorder', params);
                return { ok: true };
            }
            if (action === 'stopRecording') {
                // Окно само закроется после отправки
                return { ok: true };
            }
            if (action === 'playEncrypted') {
                // Расшифровать и воспроизвести через main process
                return new Promise(function(resolve) {
                    ipcRenderer.invoke('cm-play-encrypted-voice', {
                        url: params.url,
                        chatId: params.chat_id
                    }).then(function(res) {
                        if (res && res.success) {
                            // Воспроизвести расшифрованное аудио
                            var dataUrl = 'data:audio/ogg;base64,' + res.audioBase64;
                            var audio = new Audio(dataUrl);
                            audio.play().catch(function(){});
                            audio.addEventListener('ended', function() {
                                window.__evoice_onPlaybackState && window.__evoice_onPlaybackState('ended');
                            });
                            resolve({ ok: true });
                        } else {
                            resolve({ error: res ? res.error : 'Ошибка воспроизведения' });
                        }
                    }).catch(function(e) {
                        resolve({ error: e.message });
                    });
                });
            }
            if (action === 'stopPlayback') {
                // Простая реализация — остановить все audio элементы
                document.querySelectorAll('audio').forEach(function(el) { try { el.pause(); } catch(e){} });
                return { ok: true };
            }
            return null;
        },

        async startRecording(chatId) { return this.request('startRecording', { chat_id: String(chatId) }); },
        async stopRecording() { return this.request('stopRecording', {}); },
        async playEncrypted(url, chatId) { return this.request('playEncrypted', { url: url, chat_id: String(chatId) }); },
        async stopPlayback() { return this.request('stopPlayback', {}); },
        async checkStatus() { return this.request('checkStatus', {}); },
    };

    // Заглушки callback'ов (вызываются из main process или внутри request)
    window.__evoice_onRecordResult = window.__evoice_onRecordResult || function(base64Data, size) {
        // В Electron запись идёт в изолированном окне, результат отправляется напрямую
        // через IPC, этот callback не используется. Оставляем для совместимости.
    };
    window.__evoice_onRecordError = window.__evoice_onRecordError || function(error) {
        console.error('[CryptoMAX Audio] Запись:', error);
    };
    window.__evoice_onPlaybackState = window.__evoice_onPlaybackState || function(state) {
        document.querySelectorAll('.max-ext-evoice-player').forEach(function(player) {
            var statusDiv = player.querySelector('.evoice-status');
            var hintDiv = player.querySelector('.evoice-hint');
            var playBtn = player.querySelector('.evoice-play-btn');
            if (state === 'stopped' || state === 'ended') {
                if (playBtn) { playBtn.innerHTML = ICONS.lockPlay; playBtn.classList.remove('playing'); }
                if (statusDiv) statusDiv.textContent = '';
                if (hintDiv) hintDiv.textContent = 'Нажмите для безопасного воспроизведения';
            } else if (state === 'error') {
                if (playBtn) { playBtn.innerHTML = ICONS.lockPlay; playBtn.classList.remove('playing'); }
                if (statusDiv) statusDiv.textContent = 'Ошибка';
            }
        });
    };

    // Периодическая проверка статуса
    setInterval(function() { evoice.checkStatus(); }, 15000);
    evoice.checkStatus();

    // Захват URL аудио (перехват a.click и DOM-мутаций)
    var captureMap = new Map();
    var currentCaptureId = null;
    var _origAnchorClick = HTMLAnchorElement.prototype.click;
    var _origAppendChild = Node.prototype.appendChild;
    var _origInsertBefore = Node.prototype.insertBefore;

    function tryCapture(child) {
        try {
            if (child && child.nodeType === 1 && child.tagName === 'A' && child.href && child.download) {
                if (currentCaptureId !== null) {
                    captureMap.set(currentCaptureId, { url: child.href, filename: child.download });
                }
            }
        } catch (e) {}
    }

    HTMLAnchorElement.prototype.click = function() {
        try {
            if (this.href && this.download && currentCaptureId !== null) {
                captureMap.set(currentCaptureId, { url: this.href, filename: this.download });
                return; // Предотвратить авто-скачивание
            }
        } catch (e) {}
        return _origAnchorClick.apply(this, arguments);
    };

    Node.prototype.appendChild = function(child) { tryCapture(child); return _origAppendChild.call(this, child); };
    Node.prototype.insertBefore = function(child, ref) { tryCapture(child); return _origInsertBefore.call(this, child, ref); };

    function getAudioUrl(downloadBtn) {
        return new Promise(function(resolve) {
            var captureId = Date.now() + '_' + Math.random().toString(36).slice(2);
            currentCaptureId = captureId;
            captureMap.delete(captureId);
            downloadBtn.click();
            var attempts = 0;
            var check = setInterval(function() {
                attempts++;
                if (captureMap.has(captureId)) {
                    clearInterval(check);
                    var info = captureMap.get(captureId);
                    captureMap.delete(captureId);
                    currentCaptureId = null;
                    resolve(info.url);
                } else if (attempts > 30) {
                    clearInterval(check);
                    currentCaptureId = null;
                    resolve(null);
                }
            }, 100);
        });
    }

    function formatTime(seconds) {
        if (!seconds || !isFinite(seconds)) return '0:00';
        var m = Math.floor(seconds / 60);
        var s = Math.floor(seconds % 60);
        return m + ':' + (s < 10 ? '0' : '') + s;
    }

    var audioRegistry = new Map();

    // Обычный аудио-плеер с waveform
    function createAudioPlayer(url, filename) {
        audioRegistry.set(filename, url);
        var container = document.createElement('div');
        container.className = 'max-ext-player';
        container.dataset.audioFilename = filename;
        container.dataset.audioUrl = url;

        var playBtn = document.createElement('button');
        playBtn.className = 'max-ext-play-btn';
        playBtn.innerHTML = ICONS.play;
        playBtn.setAttribute('aria-label', 'Воспроизвести');

        var contentDiv = document.createElement('div');
        contentDiv.className = 'max-ext-content';
        var waveDiv = document.createElement('div');
        waveDiv.className = 'max-ext-wave';
        var PEAK_COUNT = 40;
        var peaks = [];
        for (var i = 0; i < PEAK_COUNT; i++) {
            var peak = document.createElement('span');
            peak.className = 'max-ext-peak';
            peak.style.height = (20 + Math.random() * 80) + '%';
            waveDiv.appendChild(peak);
            peaks.push(peak);
        }
        contentDiv.appendChild(waveDiv);

        var metaDiv = document.createElement('div');
        metaDiv.className = 'max-ext-meta';
        var durationDiv = document.createElement('div');
        durationDiv.className = 'max-ext-duration';
        durationDiv.textContent = '0:00';
        var dlLink = document.createElement('a');
        dlLink.href = url;
        dlLink.download = filename;
        dlLink.title = 'Скачать ' + filename;
        dlLink.className = 'max-ext-dl';
        dlLink.innerHTML = ICONS.download;
        metaDiv.appendChild(durationDiv);
        metaDiv.appendChild(dlLink);

        container.appendChild(playBtn);
        container.appendChild(contentDiv);
        container.appendChild(metaDiv);

        var audio = new Audio();
        audio.preload = 'metadata';
        audio.src = url;
        var isPlaying = false;

        audio.addEventListener('loadedmetadata', function() { durationDiv.textContent = formatTime(audio.duration); });
        playBtn.onclick = function(e) {
            e.stopPropagation(); e.preventDefault();
            if (isPlaying) { audio.pause(); }
            else {
                document.querySelectorAll('audio.max-ext-playing').forEach(function(el) { try { el.pause(); } catch(err){} });
                audio.play().catch(function(){});
            }
        };
        audio.addEventListener('play', function() { isPlaying = true; playBtn.innerHTML = ICONS.pause; audio.classList.add('max-ext-playing'); });
        audio.addEventListener('pause', function() { isPlaying = false; playBtn.innerHTML = ICONS.play; audio.classList.remove('max-ext-playing'); });
        audio.addEventListener('ended', function() { isPlaying = false; playBtn.innerHTML = ICONS.play; audio.classList.remove('max-ext-playing'); peaks.forEach(function(p) { p.classList.remove('played'); }); durationDiv.textContent = formatTime(audio.duration); });
        audio.addEventListener('timeupdate', function() {
            if (!audio.duration) return;
            var progress = audio.currentTime / audio.duration;
            var played = Math.floor(progress * peaks.length);
            peaks.forEach(function(p, idx) { if (idx < played) p.classList.add('played'); else p.classList.remove('played'); });
            durationDiv.textContent = formatTime(audio.currentTime);
        });
        waveDiv.onclick = function(e) {
            e.stopPropagation(); e.preventDefault();
            if (!audio.duration) return;
            var rect = waveDiv.getBoundingClientRect();
            var pos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            audio.currentTime = pos * audio.duration;
        };
        dlLink.onclick = function(e) { e.stopPropagation(); };
        return container;
    }

    // Плеер зашифрованного голосового
    function createEncryptedVoicePlayer(url, filename, chatId) {
        var container = document.createElement('div');
        container.className = 'max-ext-evoice-player';
        container.dataset.evoiceUrl = url;
        container.dataset.evoiceFilename = filename;
        container.dataset.evoiceChatId = chatId || '';

        var playBtn = document.createElement('button');
        playBtn.className = 'evoice-play-btn';
        playBtn.innerHTML = ICONS.lockPlay;
        playBtn.setAttribute('aria-label', 'Воспроизвести зашифрованное голосовое');

        var infoDiv = document.createElement('div');
        infoDiv.className = 'evoice-info';
        var labelDiv = document.createElement('div');
        labelDiv.className = 'evoice-label';
        labelDiv.textContent = '🔒 Зашифрованное голосовое';
        var hintDiv = document.createElement('div');
        hintDiv.className = 'evoice-hint';
        hintDiv.textContent = 'Нажмите для безопасного воспроизведения';
        infoDiv.appendChild(labelDiv);
        infoDiv.appendChild(hintDiv);

        var statusDiv = document.createElement('div');
        statusDiv.className = 'evoice-status';

        container.appendChild(playBtn);
        container.appendChild(infoDiv);
        container.appendChild(statusDiv);

        var isPlaying = false;
        playBtn.onclick = async function(e) {
            e.stopPropagation(); e.preventDefault();
            if (isPlaying) {
                await evoice.stopPlayback();
                isPlaying = false;
                playBtn.innerHTML = ICONS.lockPlay;
                playBtn.classList.remove('playing');
                statusDiv.textContent = '';
                hintDiv.textContent = 'Нажмите для безопасного воспроизведения';
                return;
            }
            if (!evoice.passwordSet) {
                statusDiv.textContent = '🔒 Пароль не задан';
                hintDiv.textContent = 'Задайте пароль чата в панели CryptoMAX';
                return;
            }
            isPlaying = true;
            playBtn.innerHTML = ICONS.pause;
            playBtn.classList.add('playing');
            statusDiv.textContent = 'Расшифровка...';
            hintDiv.textContent = 'Аудио воспроизводится изолированно';
            var result = await evoice.playEncrypted(url, chatId);
            if (result && result.error) {
                isPlaying = false;
                playBtn.innerHTML = ICONS.lockPlay;
                playBtn.classList.remove('playing');
                statusDiv.textContent = 'Ошибка';
                hintDiv.textContent = result.error;
            }
        };
        return container;
    }

    // Обработка аудио-вложений: найти кнопку "Скачать", получить URL, создать плеер
    var processedButtons = new WeakSet();
    var isProcessing = false;
    var retryQueue = new Map();
    var RETRY_DELAYS = [5000, 10000, 20000];
    var MAX_RETRIES = RETRY_DELAYS.length;
    var encryptedUrlCache = new Map();

    // Проверка, зашифрован ли файл (по magic-байтам EV1)
    async function checkIfEncrypted(url, filename) {
        if (filename && filename.endsWith('.evoice')) return true;
        if (encryptedUrlCache.has(url)) return encryptedUrlCache.get(url);
        try {
            var response = await fetch(url);
            var reader = response.body.getReader();
            var chunk = await reader.read();
            reader.cancel();
            if (chunk.value && chunk.value.length >= 3) {
                var isEnc = chunk.value[0] === EV1_MAGIC[0] && chunk.value[1] === EV1_MAGIC[1] && chunk.value[2] === EV1_MAGIC[2];
                encryptedUrlCache.set(url, isEnc);
                return isEnc;
            }
        } catch (e) {}
        return false;
    }

    function getCurrentChatId() {
        var pathname = window.location.pathname;
        var parts = pathname.split('/').filter(function(p) { return p && p !== ''; });
        return parts.length > 0 ? parts[parts.length - 1] : null;
    }

    async function processAudioFiles() {
        if (isProcessing) return;
        isProcessing = true;
        try {
            var dlBtns = document.querySelectorAll('button[aria-label="Скачать"]');
            for (var i = 0; i < dlBtns.length; i++) {
                var btn = dlBtns[i];
                if (processedButtons.has(btn)) continue;
                if (btn.closest('.max-ext-done')) continue;
                var retryInfo = retryQueue.get(btn);
                if (retryInfo && Date.now() < retryInfo.nextRetry) continue;

                var titleEl = btn.querySelector('.title');
                var svgTextEl = btn.querySelector('text');
                var fileType = svgTextEl ? svgTextEl.textContent.trim().toUpperCase() : '';
                var filename = titleEl ? titleEl.textContent.trim() : '';
                var isAudio = AUDIO_EXTENSIONS.test(filename) || AUDIO_TYPE_BADGES.indexOf(fileType) !== -1;
                if (!isAudio) continue;

                var url = await getAudioUrl(btn);
                if (url) {
                    processedButtons.add(btn);
                    retryQueue.delete(btn);
                    var attachesDiv = btn.closest('.attaches');
                    if (attachesDiv) attachesDiv.classList.add('max-ext-done');

                    var isEncrypted = await checkIfEncrypted(url, filename);
                    btn.style.display = 'none';
                    if (isEncrypted) {
                        var chatId = getCurrentChatId();
                        var evPlayer = createEncryptedVoicePlayer(url, filename, chatId);
                        btn.parentElement.insertBefore(evPlayer, btn.nextSibling);
                    } else {
                        var player = createAudioPlayer(url, filename);
                        btn.parentElement.insertBefore(player, btn.nextSibling);
                    }
                } else {
                    var currentAttempts = (retryInfo ? retryInfo.attempts : 0) + 1;
                    if (currentAttempts <= MAX_RETRIES) {
                        retryQueue.set(btn, { attempts: currentAttempts, nextRetry: Date.now() + RETRY_DELAYS[currentAttempts - 1], filename: filename, fileType: fileType });
                    } else {
                        processedButtons.add(btn);
                        retryQueue.delete(btn);
                    }
                }
            }
            // Очистка очереди для удалённых кнопок
            retryQueue.forEach(function(val, key) { if (!document.contains(key)) retryQueue.delete(key); });
        } finally {
            isProcessing = false;
        }
    }

    // Обычная запись голосового
    var mediaRecorder = null;
    var audioChunks = [];
    var isRecording = false;
    var recTimer = null;
    var recSeconds = 0;
    var currentRecBtn = null;

    function formatRecTime(s) { return Math.floor(s / 60) + ':' + (s % 60 < 10 ? '0' : '') + (s % 60); }

    function getSupportedMime() {
        var types = ['audio/ogg;codecs=opus', 'audio/ogg', 'audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
        for (var i = 0; i < types.length; i++) { if (MediaRecorder.isTypeSupported(types[i])) return types[i]; }
        return 'audio/webm';
    }

    // Перехват клика по input[type=file] для вставки файла
    var _origFileInputClick = HTMLInputElement.prototype.click;
    var pendingAttachFile = null;
    var fileInputClickIntercepted = false;

    HTMLInputElement.prototype.click = function() {
        if (this.type === 'file' && pendingAttachFile && !fileInputClickIntercepted) {
            fileInputClickIntercepted = true;
            try {
                var dt = new DataTransfer();
                dt.items.add(pendingAttachFile);
                var descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files');
                if (descriptor && descriptor.set) { descriptor.set.call(this, dt.files); }
                else { this.files = dt.files; }
                this.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
            } catch (e) { return _origFileInputClick.apply(this, arguments); }
            return;
        }
        return _origFileInputClick.apply(this, arguments);
    };

    async function attachAndSendFile(file) {
        pendingAttachFile = file;
        fileInputClickIntercepted = false;
        try {
            var attachBtn = document.querySelector('button[aria-label="Загрузить файл"]');
            if (!attachBtn) return false;
            attachBtn.click();
            await new Promise(function(r) { setTimeout(r, 300); });
            var fileMenuItem = document.querySelector('[aria-label="Файл"][role="menuitem"]');
            if (!fileMenuItem) { document.body.click(); return false; }
            fileMenuItem.click();
            await new Promise(function(r) { setTimeout(r, 1500); });
            pendingAttachFile = null;
            fileInputClickIntercepted = false;
            var sendBtn = document.querySelector('button[aria-label="Отправить сообщение"]');
            if (sendBtn) { sendBtn.click(); return true; }
            await new Promise(function(r) { setTimeout(r, 1000); });
            var sendBtn2 = document.querySelector('button[aria-label="Отправить сообщение"]');
            if (sendBtn2) { sendBtn2.click(); return true; }
            return true;
        } catch (e) {
            pendingAttachFile = null;
            fileInputClickIntercepted = false;
            return false;
        }
    }

    async function startRecording() {
        try {
            var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            var mime = getSupportedMime();
            mediaRecorder = new MediaRecorder(stream, { mimeType: mime });
            audioChunks = [];
            recSeconds = 0;
            mediaRecorder.ondataavailable = function(e) { if (e.data.size > 0) audioChunks.push(e.data); };
            mediaRecorder.onstop = function() {
                stream.getTracks().forEach(function(t) { t.stop(); });
                var ext = mime.indexOf('ogg') !== -1 ? 'ogg' : mime.indexOf('webm') !== -1 ? 'webm' : 'mp4';
                var blob = new Blob(audioChunks, { type: mime });
                var file = new File([blob], 'voice_' + Date.now() + '.' + ext, { type: mime });
                if (currentRecBtn) {
                    currentRecBtn.querySelector('.button--overrided').innerHTML = ICONS.mic;
                    currentRecBtn.classList.remove('recording');
                    currentRecBtn.setAttribute('aria-label', 'Записать голосовое сообщение');
                    currentRecBtn.title = 'Записать голосовое сообщение';
                }
                if (recTimer) { clearInterval(recTimer); recTimer = null; }
                isRecording = false;
                attachAndSendFile(file);
            };
            mediaRecorder.start(1000);
            isRecording = true;
            if (currentRecBtn) {
                currentRecBtn.querySelector('.button--overrided').innerHTML = ICONS.micStop;
                currentRecBtn.classList.add('recording');
                currentRecBtn.setAttribute('aria-label', 'Остановить запись');
                currentRecBtn.title = 'Остановить запись (0:00)';
            }
            recTimer = setInterval(function() {
                recSeconds++;
                if (currentRecBtn) currentRecBtn.title = 'Остановить запись (' + formatRecTime(recSeconds) + ')';
            }, 1000);
        } catch (err) {
            alert('Не удалось получить доступ к микрофону.');
        }
    }

    function stopRecording() { if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop(); }
    function toggleRecording() { if (isRecording) stopRecording(); else startRecording(); }

    // Зашифрованная запись (long-press) -- открывает изолированное окно
    var isEncRecording = false;
    var encRecTimer = null;
    var encRecSeconds = 0;

    async function startEncryptedRecording() {
        var chatId = getCurrentChatId();
        if (!chatId) { alert('Сначала откройте чат'); return; }
        if (!evoice.passwordSet) {
            alert('🔒 Пароль не задан.\nЗадайте пароль чата в панели CryptoMAX.');
            return;
        }
        var result = await evoice.startRecording(chatId);
        if (result && result.error) { alert('Ошибка записи: ' + result.error); return; }
        isEncRecording = true;
        encRecSeconds = 0;
        if (currentRecBtn) {
            currentRecBtn.querySelector('.button--overrided').innerHTML = ICONS.lockRec;
            currentRecBtn.classList.add('recording');
            currentRecBtn.setAttribute('aria-label', 'Остановить шифрованную запись');
            currentRecBtn.title = '🔒 Остановить шифрованную запись (0:00)';
        }
        encRecTimer = setInterval(function() {
            encRecSeconds++;
            if (currentRecBtn) currentRecBtn.title = '🔒 Остановить шифрованную запись (' + formatRecTime(encRecSeconds) + ')';
        }, 1000);
    }

    async function stopEncryptedRecording() {
        await evoice.stopRecording();
        isEncRecording = false;
        if (encRecTimer) { clearInterval(encRecTimer); encRecTimer = null; }
        if (currentRecBtn) {
            currentRecBtn.querySelector('.button--overrided').innerHTML = ICONS.mic;
            currentRecBtn.classList.remove('recording');
            currentRecBtn.setAttribute('aria-label', 'Записать голосовое сообщение');
            currentRecBtn.title = 'Записать голосовое сообщение';
        }
    }

    // Инъекция кнопки микрофона (long-press = зашифрованная запись)
    function injectMicButton() {
        if (document.querySelector('.max-voice-rec-btn')) return;
        var attachBtn = document.querySelector('button[aria-label="Загрузить файл"]');
        if (!attachBtn) return;
        var btnContainer = attachBtn.closest('.btn');
        if (!btnContainer) return;

        var wrapper = document.createElement('div');
        wrapper.className = 'btn';

        var micBtn = document.createElement('button');
        micBtn.type = 'button';
        micBtn.className = 'button button--small button--neutral-link button--link max-voice-rec-btn';
        micBtn.setAttribute('aria-label', 'Записать голосовое сообщение');
        micBtn.title = 'Записать голосовое (короткое нажатие)\n🔒 Зашифрованная запись (долгое нажатие)';

        var inner = document.createElement('span');
        inner.className = 'button-inner';
        var iconDiv = document.createElement('div');
        iconDiv.className = 'button--overrided';
        iconDiv.innerHTML = ICONS.mic;
        inner.appendChild(iconDiv);
        micBtn.appendChild(inner);
        wrapper.appendChild(micBtn);

        if (btnContainer.nextSibling) { btnContainer.parentNode.insertBefore(wrapper, btnContainer.nextSibling); }
        else { btnContainer.parentNode.appendChild(wrapper); }

        var longPressTimer = null;
        var isLongPress = false;
        var LONG_PRESS_DELAY = 500;

        micBtn.addEventListener('pointerdown', function(e) {
            if (isRecording || isEncRecording) return;
            isLongPress = false;
            longPressTimer = setTimeout(function() {
                isLongPress = true;
                currentRecBtn = micBtn;
                startEncryptedRecording();
            }, LONG_PRESS_DELAY);
        });
        micBtn.addEventListener('pointerup', function(e) {
            clearTimeout(longPressTimer);
            if (isRecording) { toggleRecording(); isLongPress = false; return; }
            if (isEncRecording) { stopEncryptedRecording(); isLongPress = false; return; }
            if (!isLongPress) { currentRecBtn = micBtn; toggleRecording(); }
            isLongPress = false;
        });
        micBtn.addEventListener('pointerleave', function(e) { clearTimeout(longPressTimer); });
        micBtn.addEventListener('click', function(e) { e.preventDefault(); e.stopPropagation(); });
    }

    // Главный цикл
    var mainObserver = new MutationObserver(function() { processAudioFiles(); injectMicButton(); });
    mainObserver.observe(document.body, { childList: true, subtree: true });
    setInterval(function() { processAudioFiles(); injectMicButton(); }, 3000);
    setTimeout(function() { processAudioFiles(); injectMicButton(); }, 1000);

    // Публичный API
    window.MAX_AUDIO = {
        sendAudioFile: function(file) { return attachAndSendFile(file); },
        startEncryptedRecording: function(chatId) { return evoice.startRecording(chatId); },
        stopEncryptedRecording: function() { return evoice.stopRecording(); },
        playEncryptedVoice: function(url, chatId) { return evoice.playEncrypted(url, chatId); },
        getStatus: function() {
            return {
                version: '2.1.0-electron',
                audioCount: document.querySelectorAll('.max-ext-player').length,
                encryptedCount: document.querySelectorAll('.max-ext-evoice-player').length,
                evoiceAvailable: evoice.serviceAvailable,
                evoicePasswordSet: evoice.passwordSet,
            };
        },
    };

    console.log('[CryptoMAX Audio] v2.1.0-electron загружен');
})();
