/**
 * CryptoMAX — preload для панели управления (Control Panel BrowserView).
 *
 * Экспортирует только безопасные IPC-методы для UI панели через contextBridge.
 * UI панели (panel.html) использует их для связи с main process и доступа к
 * виду web.max.ru.
 *
 * Криптографические операции выполняются в контексте рендерера панели
 * (panel.html) через CryptoEngineAPI. Этот preload — просто мост для IPC.
 *
 * Безопасность: contextIsolation=true, web.max.ru не имеет доступа к мосту.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('CryptoMAXAPI', {

    // Информация о чате

    /**
     * Текущий chatId из URL web.max.ru.
     * @returns {Promise<{chatId: string|null}>}
     */
    getChatId: function () {
        return ipcRenderer.invoke('get-chat-id');
    },

    // Настройки

    /**
     * Получить настройки приложения.
     * @returns {Promise<Object>}
     */
    getSettings: function () {
        return ipcRenderer.invoke('get-settings');
    },

    /**
     * Сохранить настройки приложения.
     * @param {Object} newSettings
     * @returns {Promise<{success: boolean}>}
     */
    saveSettings: function (newSettings) {
        return ipcRenderer.invoke('save-settings', newSettings);
    },

    // Управление паролями

    /**
     * Все сохранённые пароли (chatId --> пароль).
     * @returns {Promise<Object>}
     */
    getPasswords: function () {
        return ipcRenderer.invoke('get-passwords');
    },

    /**
     * Сохранить пароль для чата.
     * @param {string} chatId
     * @param {string} password
     * @returns {Promise<{success: boolean}>}
     */
    setPassword: function (chatId, password) {
        return ipcRenderer.invoke('set-password', { chatId: chatId, password: password });
    },

    // Отправка в web.max.ru

    /**
     * Вставить текст в поле ввода web.max.ru и нажать отправку.
     * @param {string} text - текст (может быть зашифрован или открытый)
     * @returns {Promise<{success: boolean, error?: string}>}
     */
    sendToMax: function (text) {
        return ipcRenderer.invoke('send-to-max', { text: text });
    },

    /**
     * Зашифровать текст через CryptoEngineAPI панели и отправить в web.max.ru.
     * Шифрование выполняется в контексте панели (через executeJavaScript).
     * @param {Object} data - { text, mode, password, chatId }
     * @returns {Promise<{success: boolean, encoded?: string, error?: string}>}
     */
    encryptAndSend: function (data) {
        return ipcRenderer.invoke('encrypt-and-send', data);
    },

    /**
     * Зашифровать длинный/многострочный текст как .txt файл (формат CT1,
     * AES-256-GCM) и отправить в чат как вложение.
     * @param {Object} data - { text, password, chatId }
     * @returns {Promise<{success: boolean, filename?: string, size?: number, error?: string}>}
     */
    encryptTextFile: function (data) {
        return ipcRenderer.invoke('encrypt-text-file', data);
    },

    // Входящие сообщения

    /**
     * Подписка на входящие сообщения из web.max.ru.
     * @param {function} callback - принимает ({text, decrypted, chatId, timestamp})
     * @returns {function} функция отписки
     */
    onMessage: function (callback) {
        var handler = function (event, msg) { callback(msg); };
        ipcRenderer.on('new-message', handler);
        return function () {
            ipcRenderer.removeListener('new-message', handler);
        };
    },

    /**
     * История расшифрованных сообщений чата.
     * @param {string} chatId
     * @returns {Promise<Array>}
     */
    getDecryptedHistory: function (chatId) {
        return ipcRenderer.invoke('get-decrypted-history', { chatId: chatId });
    },
});