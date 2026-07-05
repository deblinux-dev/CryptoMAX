/**
 * CryptoMAX — главный процесс Electron.
 *
 * Тонкий IPC-маршрутизатор — криптографии здесь нет.
 * Всё шифрование/дешифрование происходит в контексте рендерера панели.
 *
 * Архитектура:
 *   Main Process (этот файл)
 *   ├── IPC-обработчики (тонкий маршрутизатор)
 *   ├── safeStorage (пароли в покое)
 *   ├── Настройки в файле (включая zoomLevel)
 *   │
 *   ├── maxView BrowserView (web.max.ru)
 *   │   ├── preload-max.js (ИЗОЛИРОВАН, MutationObserver, только DOM)
 *   │   └── web.max.ru (НЕ имеет доступа к нашему коду)
 *   │
 *   └── panelView BrowserView (панель управления)
 *       ├── preload-panel.js (contextBridge --> CryptoMAXAPI)
 *       └── panel.html
 *           ├── engine-loader.js --> CryptoEngineAPI (полный движок Stegonator)
 *           └── UI (encrypt/decrypt/send)
 */

const { app, BrowserWindow, BrowserView, ipcMain, safeStorage, clipboard, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const cmFileCrypto = require('./cm-file-crypto.js');
const cmVoiceCrypto = require('./cm-voice-crypto.js');
const cmTextFileCrypto = require('./cm-text-file-crypto.js');

// Константы

const PANEL_WIDTH = 300;
const ZOOM_MIN = 0.7;
const ZOOM_MAX = 1.2;
const ZOOM_DEFAULT = 0.9;

// Состояние

let mainWindow = null;
let maxView = null;
let panelView = null;
let toolbarView = null;
let voiceRecorderWindow = null; // Изолированное окно для защищённой записи голосового
let passwords = {};
let decryptedMessages = new Map();
let _clipboardClearTimer = null;
let _lastSecureCopyText = '';

const SETTINGS_FILE = path.join(app.getPath('userData'), 'cryptomax-settings.json');
const PASSWORDS_FILE = path.join(app.getPath('userData'), 'cryptomax-passwords.enc');

// Настройки

let settings = {
    encryptionEnabled: true,
    defaultMode: 'aes256',
    autoDecrypt: true,
    showOverlays: true,
    theme: 'dark',
    zoomLevel: ZOOM_DEFAULT,
};

function loadSettings() {
    try {
        if (fs.existsSync(SETTINGS_FILE)) {
            const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
            settings = Object.assign({}, settings, data);
            // Ограничиваем зум допустимым диапазоном
            if (settings.zoomLevel < ZOOM_MIN) settings.zoomLevel = ZOOM_MIN;
            if (settings.zoomLevel > ZOOM_MAX) settings.zoomLevel = ZOOM_MAX;
        }
    } catch (e) {
        console.error('Failed to load settings:', e);
    }
}

function saveSettings() {
    try {
        fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
    } catch (e) {
        console.error('Failed to save settings:', e);
    }
}

// Хранилище паролей (в покое шифруется через safeStorage)

function loadPasswords() {
    try {
        if (fs.existsSync(PASSWORDS_FILE)) {
            const encrypted = fs.readFileSync(PASSWORDS_FILE);
            if (safeStorage.isEncryptionAvailable()) {
                const decrypted = safeStorage.decryptString(encrypted);
                passwords = JSON.parse(decrypted);
            } else {
                try {
                    passwords = JSON.parse(encrypted.toString('utf8'));
                } catch (_) {
                    passwords = {};
                }
            }
        }
    } catch (e) {
        console.error('Failed to load passwords:', e);
        passwords = {};
    }
}

function savePasswords() {
    try {
        fs.mkdirSync(path.dirname(PASSWORDS_FILE), { recursive: true });
        const json = JSON.stringify(passwords);
        if (safeStorage.isEncryptionAvailable()) {
            const encrypted = safeStorage.encryptString(json);
            fs.writeFileSync(PASSWORDS_FILE, encrypted);
        } else {
            fs.writeFileSync(PASSWORDS_FILE, json);
        }
    } catch (e) {
        console.error('Failed to save passwords:', e);
    }
}

// Настройка окон

function createWindow() {
    loadSettings();
    loadPasswords();

    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 900,
        minHeight: 600,
        icon: path.join(__dirname, 'assets', "CryptoMax.ico"),
        title: 'CryptoMAX',
        backgroundColor: '#0b0d13',
        frame: false, // Custom titlebar via toolbar BrowserView
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
        },
    });

    // Toolbar BrowserView (верхняя панель: зум, заголовок, кнопки окна)
    toolbarView = new BrowserView({
        webPreferences: {
            preload: path.join(__dirname, 'preload-toolbar.js'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: false,
            webSecurity: false,
        },
    });

    mainWindow.addBrowserView(toolbarView);

    mainWindow.on('closed', function () {
        saveSettings();
        savePasswords();
        mainWindow = null;
        maxView = null;
        panelView = null;
        toolbarView = null;
    });

    // web.max.ru BrowserView (полностью изолирован)
    maxView = new BrowserView({
        webPreferences: {
            preload: path.join(__dirname, 'preload-max.js'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webSecurity: true,
            allowRunningInsecureContent: false,
            partition: 'persist:max-session',
        },
    });

    mainWindow.addBrowserView(maxView);
    resizeViews();

    // Применяем сохранённый зум и внедряем скрипты после загрузки
    maxView.webContents.on('did-finish-load', function () {
        console.log('CryptoMAX: web.max.ru loaded, applying zoom:', settings.zoomLevel);
        applyZoom();

        // Внедряем audio-extension.js
        try {
            var audioScript = fs.readFileSync(path.join(__dirname, 'audio-extension.js'), 'utf8');
            maxView.webContents.executeJavaScript(audioScript, true).then(function() {
                console.log('CryptoMAX: audio-extension.js внедрён');
            }).catch(function(e) {
                console.error('CryptoMAX: ошибка внедрения audio-extension.js:', e);
            });
        } catch (e) {
            console.error('CryptoMAX: не удалось прочитать audio-extension.js:', e);
        }

        // Внедряем text-file-extension.js (перехват .txt файлов, расшифровка CT1)
        try {
            var txtScript = fs.readFileSync(path.join(__dirname, 'text-file-extension.js'), 'utf8');
            maxView.webContents.executeJavaScript(txtScript, true).then(function() {
                console.log('CryptoMAX: text-file-extension.js внедрён');
            }).catch(function(e) {
                console.error('CryptoMAX: ошибка внедрения text-file-extension.js:', e);
            });
        } catch (e) {
            console.error('CryptoMAX: не удалось прочитать text-file-extension.js:', e);
        }
    });

    // Скачивание файлов: открываем fd.oneme.ru в скрытом окне.
    // Сервер отдаёт Content-Disposition: attachment, Chromium скачивает
    // файл и показывает стандартный диалог. Окно закрывается автоматически
    // после начала скачивания.
    var _downloadWindows = new Set();
    maxView.webContents.setWindowOpenHandler(function (args) {
        var url = args.url || '';
        if (url.startsWith('https://web.max.ru')) {
            return { action: 'allow' };
        }
        if (/^https:\/\/fd\.oneme\.ru\//.test(url)) {
            // Создаём скрытое окно для скачивания
            var dlWin = new BrowserWindow({
                show: false,
                webPreferences: {
                    session: maxView.webContents.session,
                },
            });
            _downloadWindows.add(dlWin);

            // Закрываем окно когда началось скачивание
            dlWin.webContents.session.on('will-download', function (event, item) {
                // Скачивание началось -- можно закрывать окно
                setTimeout(function () {
                    if (!dlWin.isDestroyed()) {
                        dlWin.close();
                    }
                }, 1000);
            });

            // Закрываем окно если загрузка страницы завершилась (файл скачан)
            dlWin.webContents.on('did-finish-load', function () {
                setTimeout(function () {
                    if (!dlWin.isDestroyed()) {
                        dlWin.close();
                    }
                }, 3000);
            });

            // Закрываем при ошибке
            dlWin.webContents.on('did-fail-load', function () {
                if (!dlWin.isDestroyed()) {
                    dlWin.close();
                }
            });

            // Убираем из set при закрытии
            dlWin.on('closed', function () {
                _downloadWindows.delete(dlWin);
            });

            dlWin.loadURL(url);
            return { action: 'deny' };
        }
        return { action: 'deny' };
    });

    // Логируем релевантные сообщения из консоли web.max.ru
    maxView.webContents.on('console-message', function (event, level, msg) {
        if (msg.includes('CryptoMAX')) {
            console.log('[MAX]', msg);
        }
    });

    maxView.webContents.loadURL('https://web.max.ru');
    // maxView.webContents.openDevTools({ mode: 'detach' });

    // Панель управления BrowserView
    panelView = new BrowserView({
        webPreferences: {
            preload: path.join(__dirname, 'preload-panel.js'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: false, // preload needs ipcRenderer
            webSecurity: false, // allow ES module imports from file://
        },
    });

    mainWindow.addBrowserView(panelView);
    resizeViews();
    panelView.webContents.loadFile(path.join(__dirname, 'panel.html'));

    // Обработка ресайза
    mainWindow.on('resize', resizeViews);

    // Грузим HTML тулбара
    toolbarView.webContents.loadFile(path.join(__dirname, 'toolbar.html'));
    resizeViews();
}

/**
 * Применяем уровень зума к BrowserView web.max.ru.
 * setZoomFactor масштабирует всю страницу целиком, без обрезки.
 */
function applyZoom() {
    if (maxView && !maxView.webContents.isDestroyed()) {
        maxView.webContents.setZoomFactor(settings.zoomLevel);
        console.log('CryptoMAX: Zoom set to', settings.zoomLevel);
    }
}

/**
 * Высота тулбара в пикселях. Панель зума/кнопок сверху окна.
 */
const TOOLBAR_HEIGHT = 36;

function resizeViews() {
    if (!mainWindow || !maxView || !panelView) return;

    const bounds = mainWindow.getBounds();
    const contentHeight = bounds.height - TOOLBAR_HEIGHT;
    const contentWidth = bounds.width - PANEL_WIDTH;

    // Тулбар: на всю ширину, прилеплен к верху
    if (toolbarView) {
        toolbarView.setBounds({ x: 0, y: 0, width: bounds.width, height: TOOLBAR_HEIGHT });
    }

    // web.max.ru: область контента под тулбаром, левее панели
    // setZoomFactor отвечает за визуальное масштабирование внутри этих границ
    maxView.setBounds({
        x: 0,
        y: TOOLBAR_HEIGHT,
        width: contentWidth,
        height: contentHeight,
    });

    // Переприменяем зум после каждого ресайза (setBounds может его сбросить)
    if (maxView.webContents && !maxView.webContents.isDestroyed()) {
        maxView.webContents.setZoomFactor(settings.zoomLevel || 1);
    }

    // Панель: справа, под тулбаром
    panelView.setBounds({
        x: contentWidth,
        y: TOOLBAR_HEIGHT,
        width: PANEL_WIDTH,
        height: contentHeight,
    });
}

// IPC-обработчики (тонкий маршрутизатор, без криптографии)

function setupIPC() {

    // get-chat-id: парсим chatId из URL web.max.ru
    ipcMain.handle('get-chat-id', function () {
        try {
            if (!maxView || maxView.webContents.isDestroyed()) {
                return { chatId: null };
            }
            const url = maxView.webContents.getURL();
            const parts = url.split('/').filter(function (p) { return p && p !== ''; });
            if (parts.length > 0) {
                return { chatId: parts[parts.length - 1] };
            }
            return { chatId: null };
        } catch (e) {
            return { chatId: null };
        }
    });

    // get-zoom: текущий уровень зума
    ipcMain.handle('get-zoom', function () {
        return { zoom: settings.zoomLevel };
    });

    // set-zoom: меняем зум web.max.ru
    ipcMain.handle('set-zoom', function (event, data) {
        var level = parseFloat(data.zoom);
        if (isNaN(level)) level = ZOOM_DEFAULT;
        // Ограничиваем допустимым диапазоном
        level = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, level));
        settings.zoomLevel = level;
        saveSettings();
        resizeViews(); // перепозиционируем виды + переприменяем зум
        return { success: true, zoom: level };
    });

    // send-to-max: отправляем текст через preload maxView
    ipcMain.handle('send-to-max', async function (event, data) {
        try {
            if (!maxView || maxView.webContents.isDestroyed()) {
                return { success: false, error: 'web.max.ru panel not available' };
            }

            maxView.webContents.send('do-send-message', data.text || '');

            await new Promise(function (resolve) { setTimeout(resolve, 500); });

            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    // encrypt-and-send: шифруем в контексте панели, затем отправляем
    ipcMain.handle('encrypt-and-send', async function (event, data) {
        try {
            if (!panelView || panelView.webContents.isDestroyed()) {
                return { success: false, error: 'Panel not available' };
            }

            const jsonArgs = JSON.stringify({
                text: data.text || '',
                password: data.password || '',
                mode: data.mode || 'base64',
                chatId: data.chatId || '',
            });

            const encoded = await panelView.webContents.executeJavaScript(
                '(async function() {' +
                '  var a = ' + jsonArgs + ';' +
                '  if (!window.CryptoEngineAPI || !window.CryptoEngineAPI.isReady()) {' +
                '    return { error: "Engine not ready" };' +
                '  }' +
                '  try {' +
                '    var result = await window.CryptoEngineAPI.encrypt(a.text, a.password, a.mode, a.chatId);' +
                '    return { encoded: result };' +
                '  } catch (e) {' +
                '    return { error: e.message };' +
                '  }' +
                '})()'
            );

            if (encoded && encoded.error) {
                return { success: false, error: encoded.error };
            }
            if (!encoded || !encoded.encoded) {
                return { success: false, error: 'Encryption failed' };
            }

            if (!maxView || maxView.webContents.isDestroyed()) {
                return { success: false, error: 'web.max.ru not available' };
            }
            maxView.webContents.send('do-send-message', encoded.encoded);

            await new Promise(function (resolve) { setTimeout(resolve, 500); });

            return { success: true, encoded: encoded.encoded };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    // incoming-message: из preload'а web.max.ru
    ipcMain.on('incoming-message', function (event, data) {
        const text = data.text || '';
        const chatId = data.chatId || '';

        // Пропускаем уведомления о смене URL для хранения сообщений
        if (text === '__url_change__') {
            if (panelView && !panelView.webContents.isDestroyed()) {
                panelView.webContents.send('new-message', {
                    text: text,
                    decrypted: null,
                    chatId: chatId,
                    timestamp: Date.now(),
                });
            }
            return;
        }

        // Пытаемся авто-дешифровать в контексте панели через executeJavaScript
        const pwd = passwords[chatId] || '';

        if (pwd && settings.autoDecrypt) {
            if (panelView && !panelView.webContents.isDestroyed()) {
                var jsonArgs = JSON.stringify({ text: text, password: pwd, chatId: chatId });

                panelView.webContents.executeJavaScript(
                    '(async function() {' +
                    '  var a = ' + jsonArgs + ';' +
                    '  if (!window.CryptoEngineAPI || !window.CryptoEngineAPI.isReady()) {' +
                    '    return null;' +
                    '  }' +
                    '  try {' +
                    '    var result = await window.CryptoEngineAPI.autoDecode(a.text, a.password, a.chatId);' +
                    '    return result ? result.text : null;' +
                    '  } catch (e) {' +
                    '    return null;' +
                    '  }' +
                    '})()'
                ).then(function (decrypted) {
                    storeAndForward(text, decrypted, chatId);

                    // Отправляем расшифрованный текст обратно в maxView для Shadow DOM overlay
                    // Только если overlay включены И расшифрованный текст валиден
                    if (settings.showOverlays &&
                        decrypted && typeof decrypted === 'string' &&
                        decrypted.length > 0 && decrypted.length < 10000 &&
                        decrypted !== text) {
                        maxView.webContents.send('show-decrypted-overlay', {
                            originalText: text,
                            decryptedText: decrypted,
                        });
                    }
                }).catch(function () {
                    storeAndForward(text, null, chatId);
                });
                return;
            }
        }

        storeAndForward(text, null, chatId);
    });

    // get-passwords: вернуть карту паролей
    ipcMain.handle('get-passwords', function () {
        return passwords;
    });

    // set-password: сохранить пароль для чата
    ipcMain.handle('set-password', function (event, data) {
        var chatId = data.chatId;
        var password = data.password;
        if (password) {
            passwords[chatId] = password;
        } else {
            delete passwords[chatId];
        }
        savePasswords();
        return { success: true };
    });

    // get-settings: вернуть настройки приложения
    ipcMain.handle('get-settings', function () {
        return settings;
    });

    // save-settings: обновить настройки приложения
    ipcMain.handle('save-settings', function (event, newSettings) {
        settings = Object.assign({}, settings, newSettings);
        saveSettings();
        return { success: true };
    });

    // get-decrypted-history: вернуть сообщения чата
    ipcMain.handle('get-decrypted-history', function (event, data) {
        return decryptedMessages.get(data.chatId || 'unknown') || [];
    });

    // encrypt-files: зашифровать файлы и отправить напрямую в чат
    // Поток: native file dialog (trusted) --> AES-256-GCM (пароль чата) --> store-only ZIP
    //        --> IPC send-encrypted-file --> preload-max.js: ClipboardEvent('paste')
    //        на input textbox --> web.max.ru отправляет сообщение с вложением.
    // Метод paste проверен на web.max.ru: файл автоматически отправляется
    // как исходящее сообщение с вложением (до 100KB+). Резервная копия .zip
    // сохраняется в temp на случай ошибки отправки.
    ipcMain.handle('encrypt-files', async function () {
        try {
            // 1. Текущий chatId из URL web.max.ru
            var chatId = '';
            if (maxView && !maxView.webContents.isDestroyed()) {
                var url = maxView.webContents.getURL();
                var parts = url.split('/').filter(function (p) { return p && p !== ''; });
                if (parts.length > 0) chatId = parts[parts.length - 1];
            }
            var pwd = passwords[chatId] || '';
            if (!pwd) {
                await dialog.showMessageBox(mainWindow, {
                    type: 'warning',
                    title: 'CryptoMAX — файлы',
                    message: 'Не задан пароль для чата',
                    detail: 'Сначала задайте пароль чата в панели CryptoMAX. Файлы шифруются тем же паролем, что и сообщения.',
                    buttons: ['OK'],
                });
                return { success: false, error: 'no-password' };
            }

            // 2. Native file dialog (multi-select, любые файлы)
            var choice = await dialog.showOpenDialog(mainWindow, {
                title: 'Выберите файлы для шифрования',
                properties: ['openFile', 'multiSelections'],
            });
            if (choice.canceled || choice.filePaths.length === 0) {
                return { success: false, error: 'canceled' };
            }

            // 3. Имя контейнера:
            //    - 1 файл --> имя исходного файла + .zip (например, document.txt --> document.zip)
            //    - несколько файлов --> предложить пользователю ввести имя архива
            //      через save dialog (defaultPath: archive.zip).
            //    Имя НЕ должно содержать «cryptomax» — это привлекает внимание.
            var zipName;
            if (choice.filePaths.length === 1) {
                var origBase = path.basename(choice.filePaths[0]);
                // Убираем расширение, добавляем .zip
                var ext = path.extname(origBase);
                var stem = ext ? origBase.slice(0, -ext.length) : origBase;
                zipName = stem + '.zip';
            } else {
                // Несколько файлов — спросить имя архива
                var saveChoice = await dialog.showSaveDialog(mainWindow, {
                    title: 'Имя зашифрованного архива (' + choice.filePaths.length + ' файла)',
                    defaultPath: 'archive.zip',
                    filters: [{ name: 'ZIP-архивы', extensions: ['zip'] }],
                });
                if (saveChoice.canceled || !saveChoice.filePath) {
                    return { success: false, error: 'canceled' };
                }
                zipName = path.basename(saveChoice.filePath);
                // Гарантируем .zip
                if (!/\.zip$/i.test(zipName)) zipName += '.zip';
            }

            // 4. Шифрование --> WinZip AES-256 ZIP (archiver + archiver-zip-encrypted).
            //    Стандартный формат, открывается WinRAR/7-Zip/WinZip/macOS.
            //    Пароль = пароль чата (без chatId в KDF, т.к. получатель файла
            //    может не знать chatId — только пароль).
            var enc = await cmFileCrypto.encryptFilesToZip(choice.filePaths, pwd);
            var zipPath = path.join(os.tmpdir(), zipName);
            // Резервная копия в temp (на случай ошибки отправки — пользователь
            // сможет вручную перетащить файл).
            fs.writeFileSync(zipPath, enc.zipBuffer);

            // 5. Отправить напрямую в чат через paste (preload-max.js)
            if (maxView && !maxView.webContents.isDestroyed()) {
                var buffer = enc.zipBuffer.buffer.slice(
                    enc.zipBuffer.byteOffset,
                    enc.zipBuffer.byteOffset + enc.zipBuffer.byteLength
                );
                maxView.webContents.send('send-encrypted-file', {
                    buffer: buffer,
                    filename: zipName,
                });

                // Короткая задержка, чтобы UI обновился
                await new Promise(function (resolve) { setTimeout(resolve, 1200); });

                var msg = 'Зашифровано файлов: ' + enc.fileNames.length +
                    '. Размер: ' + Math.round(enc.zipBuffer.length / 1024) + ' КБ.\n' +
                    'Контейнер «' + zipName + '» отправлен в чат.';
                if (enc.errors.length > 0) {
                    msg += '\n\nОшибки: ' + enc.errors.join('; ');
                }
                await dialog.showMessageBox(mainWindow, {
                    type: 'info',
                    title: 'CryptoMAX — файл отправлен',
                    message: 'Готово',
                    detail: msg,
                    buttons: ['OK'],
                });
                return { success: true, count: enc.fileNames.length, sent: true };
            } else {
                // maxView недоступен — fallback на showItemInFolder
                shell.showItemInFolder(zipPath);
                await dialog.showMessageBox(mainWindow, {
                    type: 'warning',
                    title: 'CryptoMAX — файл зашифрован',
                    message: 'Чат не открыт',
                    detail: 'web.max.ru не загружен. Файл «' + zipName + '» сохранён и открыт в проводнике — перетащите его в чат вручную.',
                    buttons: ['OK'],
                });
                return { success: true, path: zipPath, count: enc.manifest.files.length, sent: false };
            }
        } catch (e) {
            console.error('encrypt-files error:', e);
            await dialog.showMessageBox(mainWindow, {
                type: 'error',
                title: 'CryptoMAX — ошибка',
                message: 'Ошибка шифрования файлов',
                detail: String(e && e.message || e),
                buttons: ['OK'],
            });
            return { success: false, error: String(e && e.message || e) };
        }
    });

    // decrypt-file: расшифровать скачанный ZIP-контейнер
    // Предлагает пользователю выбор:
    //   - «Расшифровать сразу» --> выбрать .zip --> расшифровать --> сохранить файлы
    //   - «Отмена» (только скачать zip) --> закрывает диалог; скачивание zip
    //     выполняется обычным кликом «Скачать» в web.max.ru (will-download handler).
    ipcMain.handle('decrypt-file', async function () {
        try {
            // 1. Спросить режим
            var modeChoice = await dialog.showMessageBox(mainWindow, {
                type: 'question',
                title: 'CryptoMAX — расшифровка файла',
                message: 'Как обработать зашифрованный архив?',
                detail: '«Расшифровать сейчас» — выбрать скачанный .zip и сразу распаковать файлы.\n«Отмена» — просто скачать .zip из чата (клик «Скачать»); распаковать можно будет позже любым архиватором (WinRAR/7-Zip) по паролю чата.',
                buttons: ['Расшифровать сейчас', 'Отмена'],
                defaultId: 0,
                cancelId: 1,
            });
            if (modeChoice.response === 1) {
                return { success: false, error: 'canceled' };
            }

            // 2. Выбрать ZIP
            var choice = await dialog.showOpenDialog(mainWindow, {
                title: 'Выберите зашифрованный ZIP-архив CryptoMAX',
                filters: [{ name: 'ZIP-архивы', extensions: ['zip'] }],
                properties: ['openFile'],
            });
            if (choice.canceled || choice.filePaths.length === 0) {
                return { success: false, error: 'canceled' };
            }
            var zipPath = choice.filePaths[0];

            // 3. Выбрать папку для распаковки
            var dirChoice = await dialog.showOpenDialog(mainWindow, {
                title: 'Выберите папку для распаковки',
                properties: ['openDirectory', 'createDirectory'],
            });
            if (dirChoice.canceled || dirChoice.filePaths.length === 0) {
                return { success: false, error: 'canceled' };
            }
            var outDir = dirChoice.filePaths[0];

            // 4. Попробовать все сохранённые пароли чатов (7za расшифровывает в outDir)
            var result = await cmFileCrypto.tryDecryptZipWithPasswords(zipPath, passwords, outDir);
            if (!result) {
                await dialog.showMessageBox(mainWindow, {
                    type: 'warning',
                    title: 'CryptoMAX — дешифровка файла',
                    message: 'Не удалось расшифровать',
                    detail: 'Ни один из сохранённых паролей чатов не подходит. Убедитесь, что пароль для этого чата задан в панели CryptoMAX. Если архив создан не CryptoMAX, откройте его обычным архиватором (WinRAR/7-Zip) с паролем.',
                    buttons: ['OK'],
                });
                return { success: false, error: 'no-password-match' };
            }

            // 5. Файлы уже распакованы в outDir (7za). Показать результат.
            var files = result.files;
            shell.openPath(outDir);

            await dialog.showMessageBox(mainWindow, {
                type: 'info',
                title: 'CryptoMAX — файлы расшифрованы',
                message: 'Готово',
                detail: 'Расшифровано файлов: ' + files.length + ' (пароль чата ' + result.chatId + ')\nв папку: ' + outDir,
                buttons: ['OK'],
            });
            return { success: true, count: files.length, chatId: result.chatId };
        } catch (e) {
            console.error('decrypt-file error:', e);
            await dialog.showMessageBox(mainWindow, {
                type: 'error',
                title: 'CryptoMAX — ошибка',
                message: 'Ошибка дешифровки файла',
                detail: String(e && e.message || e),
                buttons: ['OK'],
            });
            return { success: false, error: String(e && e.message || e) };
        }
    });

    // Аудио-расширение: bridge для audio-extension.js

    // Синхронный запрос пароля чата (нужен для evoice.checkStatus)
    ipcMain.on('cm-get-password-sync', function (event, data) {
        var chatId = (data && data.chatId) || '';
        event.returnValue = passwords[chatId] || '';
    });

    // Алиас: открыть окно зашифрованной записи
    ipcMain.on('cm-open-voice-recorder', function (event, data) {
        var chatId = (data && data.chat_id) || '';
        if (voiceRecorderWindow && !voiceRecorderWindow.isDestroyed()) {
            voiceRecorderWindow.focus();
            return;
        }
        var pwd = passwords[chatId] || '';
        if (!pwd) return; // audio-extension.js сам покажет alert
        // Создаём изолированное окно (код ниже в open-voice-recorder handler)
        // Дублируем логику, т.к. audio-extension.js вызывает send, а не invoke
        voiceRecorderWindow = new BrowserWindow({
            width: 480, height: 520,
            parent: mainWindow, modal: true,
            resizable: false, minimizable: false, maximizable: false,
            title: 'CryptoMAX -- Защищённая запись голосового',
            backgroundColor: '#0b0d13',
            icon: path.join(__dirname, 'assets', 'CryptoMax.ico'),
            webPreferences: {
                nodeIntegration: true,
                contextIsolation: false,
                sandbox: false,
            },
        });
        voiceRecorderWindow.setMenuBarVisibility(false);
        voiceRecorderWindow.loadFile(path.join(__dirname, 'voice-recorder.html'));
        voiceRecorderWindow.on('closed', function () { voiceRecorderWindow = null; });
    });

    // Алиас: расшифровать и воспроизвести зашифрованное голосовое
    ipcMain.handle('cm-play-encrypted-voice', async function (event, data) {
        try {
            if (!data || !data.url) return { success: false, error: 'Нет URL' };
            var net = require('electron').net;
            var resp = await new Promise(function (resolve, reject) {
                var request = net.request(data.url);
                request.on('response', function (response) {
                    var chunks = [];
                    response.on('data', function (chunk) { chunks.push(chunk); });
                    response.on('end', function () { resolve(Buffer.concat(chunks)); });
                });
                request.on('error', reject);
                request.end();
            });
            if (!resp || resp.length === 0) return { success: false, error: 'Пустой ответ' };
            if (!cmVoiceCrypto.isEncryptedVoice(resp)) return { success: false, error: 'Не зашифрованное голосовое' };
            var chatId = data.chatId || '';
            var pwd = passwords[chatId] || '';
            var audioBytes = null;
            if (pwd) { try { audioBytes = cmVoiceCrypto.decryptVoice(resp, pwd, chatId); } catch (e) {} }
            if (!audioBytes) {
                for (var cid of Object.keys(passwords)) {
                    if (!passwords[cid]) continue;
                    try { audioBytes = cmVoiceCrypto.decryptVoice(resp, passwords[cid], cid); break; } catch (e) {}
                }
            }
            if (!audioBytes) return { success: false, error: 'Неверный пароль' };
            return { success: true, audioBase64: audioBytes.toString('base64') };
        } catch (e) {
            console.error('cm-play-encrypted-voice error:', e);
            return { success: false, error: String(e && e.message || e) };
        }
    });

    // ─── Режим «Текст-файл» (для длинных/многострочных сообщений) ────────
    //
    // Текст шифруется AES-256-GCM (формат CT1, совместимый с CleanCrypto KDF)
    // и отправляется как .txt файл с случайным именем. Анализатор сообщений
    // (preload-max.js) детектит .txt файлы, тихо скачивает их и пытается
    // расшифровать паролем чата. При успехе — текст показывается в Shadow DOM
    // overlay, как обычное расшифрованное сообщение.

    // encrypt-text-file: зашифровать текст и отправить как .txt файл в чат
    // data: { text: string, password: string, chatId: string }
    // Возвращает: { success: true, filename, size } или { success: false, error }
    ipcMain.handle('encrypt-text-file', async function (event, data) {
        try {
            if (!data || typeof data.text !== 'string') {
                return { success: false, error: 'Нет текста' };
            }
            var chatId = data.chatId || '';
            var pwd = data.password || passwords[chatId] || '';
            if (!pwd) {
                return { success: false, error: 'Не задан пароль для чата' };
            }

            // 1. Зашифровать текст в формат CT1 (AES-256-GCM)
            var encBuffer = cmTextFileCrypto.encryptText(data.text, pwd, chatId);

            // 2. Случайное имя файла (без паттернов)
            var filename = cmTextFileCrypto.generateRandomFilename();

            // 3. Отправить в чат через paste (preload-max.js).
            //    ВНИМАНИЕ: НЕ передаём mimeType — используется default 'application/zip'
            //    (как для ZIP-файлов). Если передать 'text/plain' или 'application/octet-stream',
            //    web.max.ru может попытаться вставить бинарное содержимое CT1 как текст
            //    и отклонить сообщение. Default 'application/zip' проверен и работает.
            if (maxView && !maxView.webContents.isDestroyed()) {
                // Копируем байты в независимый ArrayBuffer (не view на пул Buffer),
                // чтобы гарантировать корректную передачу через IPC.
                var ab = new ArrayBuffer(encBuffer.length);
                new Uint8Array(ab).set(new Uint8Array(encBuffer));
                maxView.webContents.send('send-encrypted-file', {
                    buffer: ab,
                    filename: filename,
                    // mimeType НЕ передаём — preload-max.js использует 'application/zip'
                });

                // Короткая задержка, чтобы paste event успел сработать в renderer
                // (такая же как для ZIP-файлов, иначе файл может "отозваться")
                await new Promise(function (resolve) { setTimeout(resolve, 1200); });

                return {
                    success: true,
                    filename: filename,
                    size: encBuffer.length,
                };
            }
            return { success: false, error: 'Чат не открыт' };
        } catch (e) {
            console.error('encrypt-text-file error:', e);
            return { success: false, error: String(e && e.message || e) };
        }
    });

    // decrypt-text-file: скачать .txt файл по URL и расшифровать
    // data: { url: string, chatId: string }
    // Возвращает: { success: true, text } или { success: false, error }
    ipcMain.handle('decrypt-text-file', async function (event, data) {
        try {
            if (!data || !data.url) return { success: false, error: 'Нет URL' };

            // 1. Скачать файл (через electron net, чтобы обойти CORS)
            var net = require('electron').net;
            var resp = await new Promise(function (resolve, reject) {
                var request = net.request(data.url);
                request.on('response', function (response) {
                    var chunks = [];
                    response.on('data', function (chunk) { chunks.push(chunk); });
                    response.on('end', function () { resolve(Buffer.concat(chunks)); });
                });
                request.on('error', reject);
                request.end();
            });

            if (!resp || resp.length === 0) {
                return { success: false, error: 'Пустой файл' };
            }

            // 2. Проверить magic CT1
            if (!cmTextFileCrypto.isEncryptedText(resp)) {
                return { success: false, error: 'Не зашифрованный текст (нет CT1 magic)' };
            }

            // 3. Попробовать расшифровать паролем текущего чата
            var chatId = data.chatId || '';
            var pwd = passwords[chatId] || '';
            var text = null;

            if (pwd) {
                try { text = cmTextFileCrypto.decryptText(resp, pwd, chatId); } catch (e) {}
            }

            // 4. Если не получилось — попробовать все сохранённые пароли
            if (!text) {
                for (var cid of Object.keys(passwords)) {
                    if (!passwords[cid]) continue;
                    try {
                        text = cmTextFileCrypto.decryptText(resp, passwords[cid], cid);
                        break;
                    } catch (e) {}
                }
            }

            if (!text) {
                return { success: false, error: 'Неверный пароль' };
            }
            return { success: true, text: text };
        } catch (e) {
            console.error('decrypt-text-file error:', e);
            return { success: false, error: String(e && e.message || e) };
        }
    });

    // open-voice-recorder: открыть изолированное модальное окно
    // Вызывается из preload-max.js при long-press на кнопке микрофона.
    ipcMain.handle('open-voice-recorder', function () {
        if (voiceRecorderWindow && !voiceRecorderWindow.isDestroyed()) {
            voiceRecorderWindow.focus();
            return { success: true, alreadyOpen: true };
        }
        // Проверить пароль чата
        var chatId = '';
        if (maxView && !maxView.webContents.isDestroyed()) {
            var url = maxView.webContents.getURL();
            var parts = url.split('/').filter(function (p) { return p && p !== ''; });
            if (parts.length > 0) chatId = parts[parts.length - 1];
        }
        var pwd = passwords[chatId] || '';
        if (!pwd) {
            return { success: false, error: 'Не задан пароль для чата. Задайте пароль в панели CryptoMAX.' };
        }

        voiceRecorderWindow = new BrowserWindow({
            width: 480,
            height: 520,
            parent: mainWindow,
            modal: true,
            resizable: false,
            minimizable: false,
            maximizable: false,
            title: 'CryptoMAX — Защищённая запись голосового',
            backgroundColor: '#0b0d13',
            icon: path.join(__dirname, 'assets', 'CryptoMax.ico'),
            webPreferences: {
                nodeIntegration: true,     // voice-recorder.html использует require('electron')
                contextIsolation: false,
                sandbox: false,
            },
        });
        voiceRecorderWindow.setMenuBarVisibility(false);
        voiceRecorderWindow.loadFile(path.join(__dirname, 'voice-recorder.html'));

        voiceRecorderWindow.on('closed', function () {
            voiceRecorderWindow = null;
        });

        return { success: true };
    });

    // voice-recorder-get-context: предоставить chatId и пароль
    ipcMain.handle('voice-recorder-get-context', function () {
        var chatId = '';
        if (maxView && !maxView.webContents.isDestroyed()) {
            var url = maxView.webContents.getURL();
            var parts = url.split('/').filter(function (p) { return p && p !== ''; });
            if (parts.length > 0) chatId = parts[parts.length - 1];
        }
        var pwd = passwords[chatId] || '';
        if (!pwd) {
            return { error: 'Не задан пароль для чата «' + chatId + '». Закройте окно и задайте пароль.' };
        }
        return { chatId: chatId, hasPassword: true };
    });

    // voice-recorder-send: зашифровать аудио и отправить в чат
    ipcMain.on('voice-recorder-send', async function (event, data) {
        try {
            if (!data || !data.audioBytes) {
                event.sender.send('voice-recorder-result', { success: false, error: 'Нет аудио данных' });
                return;
            }
            // chatId + пароль
            var chatId = '';
            if (maxView && !maxView.webContents.isDestroyed()) {
                var url = maxView.webContents.getURL();
                var parts = url.split('/').filter(function (p) { return p && p !== ''; });
                if (parts.length > 0) chatId = parts[parts.length - 1];
            }
            var pwd = passwords[chatId] || '';
            if (!pwd) {
                event.sender.send('voice-recorder-result', { success: false, error: 'Нет пароля чата' });
                return;
            }

            // Шифрование: EV1 + IV + AES-256-GCM(audio) + authTag
            var audioBytes = Buffer.from(data.audioBytes);
            var encBytes = cmVoiceCrypto.encryptVoice(audioBytes, pwd, chatId);

            // Отправить в чат через paste (preload-max.js)
            if (!maxView || maxView.webContents.isDestroyed()) {
                event.sender.send('voice-recorder-result', { success: false, error: 'web.max.ru не загружен' });
                return;
            }
            var buffer = encBytes.buffer.slice(
                encBytes.byteOffset,
                encBytes.byteOffset + encBytes.byteLength
            );
            var filename = 'voice_' + Date.now() + '.ogg';
            maxView.webContents.send('send-encrypted-file', {
                buffer: buffer,
                filename: filename,
            });

            // Короткая задержка
            await new Promise(function (resolve) { setTimeout(resolve, 1000); });

            event.sender.send('voice-recorder-result', { success: true });
        } catch (e) {
            console.error('voice-recorder-send error:', e);
            event.sender.send('voice-recorder-result', { success: false, error: String(e && e.message || e) });
        }
    });

    // voice-recorder-close: закрыть окно записи
    ipcMain.on('voice-recorder-close', function (event) {
        if (voiceRecorderWindow && !voiceRecorderWindow.isDestroyed()) {
            voiceRecorderWindow.close();
        }
    });

    // play-encrypted-voice: расшифровать и воспроизвести голосовое
    // Принимает URL скачивания аудио с web.max.ru, скачивает, расшифровывает,
    // возвращает base64 для воспроизведения в preload-max.js.
    ipcMain.handle('play-encrypted-voice', async function (event, data) {
        try {
            if (!data || !data.url) {
                return { success: false, error: 'Нет URL' };
            }
            // Скачать аудио через fetch (в main process нет fetch, используем net)
            const net = require('electron').net;
            var resp = await new Promise(function (resolve, reject) {
                var request = net.request(data.url);
                request.on('response', function (response) {
                    var chunks = [];
                    response.on('data', function (chunk) { chunks.push(chunk); });
                    response.on('end', function () { resolve(Buffer.concat(chunks)); });
                });
                request.on('error', reject);
                request.end();
            });

            if (!resp || resp.length === 0) {
                return { success: false, error: 'Пустой ответ' };
            }

            // Проверить magic EV1
            if (!cmVoiceCrypto.isEncryptedVoice(resp)) {
                return { success: false, error: 'Файл не является зашифрованным голосовым (нет EV1 маркера)' };
            }

            // Попробовать все пароли чатов
            var chatId = data.chatId || '';
            var pwd = passwords[chatId] || '';
            var audioBytes = null;
            if (pwd) {
                try {
                    audioBytes = cmVoiceCrypto.decryptVoice(resp, pwd, chatId);
                } catch (e) { /* не этот пароль */ }
            }
            if (!audioBytes) {
                // Перебрать все
                for (var cid of Object.keys(passwords)) {
                    if (!passwords[cid]) continue;
                    try {
                        audioBytes = cmVoiceCrypto.decryptVoice(resp, passwords[cid], cid);
                        break;
                    } catch (e) { /* next */ }
                }
            }
            if (!audioBytes) {
                return { success: false, error: 'Неверный пароль (ни один пароль чата не подходит)' };
            }

            // Вернуть base64 для <audio src="data:...">
            return {
                success: true,
                base64: 'data:audio/ogg;base64,' + resp.toString('base64'),
                audioBase64: audioBytes.toString('base64'),
            };
        } catch (e) {
            console.error('play-encrypted-voice error:', e);
            return { success: false, error: String(e && e.message || e) };
        }
    });

    // toggle-overlays: показать/скрыть расшифрованные overlay
    ipcMain.handle('toggle-overlays', function (event, data) {
        var enabled = data.enabled !== false; // по умолчанию true
        settings.showOverlays = enabled;
        saveSettings();

        // Перенаправляем в maxView, чтобы показать/скрыть существующие overlay
        if (maxView && !maxView.webContents.isDestroyed()) {
            maxView.webContents.send('set-overlays-visible', { visible: enabled });
        }

        return { success: true, enabled: enabled };
    });

    // get-overlays-enabled: текущее состояние overlay
    ipcMain.handle('get-overlays-enabled', function () {
        return { enabled: settings.showOverlays !== false };
    });

    // secure-copy: копируем текст в буфер с автоочисткой
    // Безопасность: буфер очищается через 30 секунд, чтобы web.max.ru
    // не смог прочитать расшифрованный текст через опрос буфера.
    ipcMain.on('secure-copy', function (event, data) {
        if (data && data.text) {
            clipboard.writeText(data.text);
            _lastSecureCopyText = data.text;

            // Сбрасываем предыдущий таймер
            if (_clipboardClearTimer) clearTimeout(_clipboardClearTimer);

            // Автоочистка буфера через 30 секунд
            _clipboardClearTimer = setTimeout(function () {
                // Очищаем, только если в буфере всё ещё наш текст
                // (пользователь мог скопировать что-то другое за это время)
                try {
                    if (clipboard.readText() === _lastSecureCopyText) {
                        clipboard.clear();
                    }
                    _lastSecureCopyText = '';
                } catch (e) {
                    // буфер может быть недоступен на некоторых платформах
                }
            }, 30000);
        }
    });

    // window-control: свернуть / развернуть / закрыть
    ipcMain.handle('window-control', function (event, action) {
        if (!mainWindow) return { success: false };
        switch (action) {
            case 'minimize': mainWindow.minimize(); break;
            case 'maximize':
                mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
                break;
            case 'close': mainWindow.close(); break;
        }
        return { success: true };
    });
}

// Хранение и пересылка сообщений

function storeAndForward(text, decrypted, chatId) {
    var msg = {
        text: text,
        decrypted: decrypted,
        chatId: chatId || '',
        timestamp: Date.now(),
    };

    var key = chatId || 'unknown';
    if (!decryptedMessages.has(key)) {
        decryptedMessages.set(key, []);
    }
    var history = decryptedMessages.get(key);
    history.push(msg);
    if (history.length > 200) history.shift();

    if (panelView && !panelView.webContents.isDestroyed()) {
        panelView.webContents.send('new-message', msg);
    }
}

// Жизненный цикл приложения

app.whenReady().then(function () {
    createWindow();
    setupIPC();
});

app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') app.quit();
});

app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});

// Отладка: логируем все события webContents
process.on('SIGUSR1', function() {
    console.log('[DEBUG] SIGUSR1 received');
});
