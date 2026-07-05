/**
 * CryptoMAX — preload для панели инструментов (Toolbar BrowserView).
 *
 * Экспортирует IPC-методы для управления зумом, окном и переключением overlay
 * через contextBridge.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ToolbarAPI', {

    // Зум

    /**
     * Текущий уровень зума.
     * @returns {Promise<{zoom: number}>}
     */
    getZoom: function () {
        return ipcRenderer.invoke('get-zoom');
    },

    /**
     * Установить уровень зума (main process ограничивает диапазоном 0.7–1.2).
     * @param {number} zoom
     * @returns {Promise<{success: boolean, zoom: number}>}
     */
    setZoom: function (zoom) {
        return ipcRenderer.invoke('set-zoom', { zoom: zoom });
    },

    // Управление окном

    /**
     * Действие с окном: свернуть / развернуть / закрыть.
     * @param {'minimize'|'maximize'|'close'} action
     * @returns {Promise<{success: boolean}>}
     */
    windowControl: function (action) {
        return ipcRenderer.invoke('window-control', action);
    },

    // Переключение overlay

    /**
     * Включить/выключить показ расшифрованных overlay'ев.
     * @param {boolean} enabled
     * @returns {Promise<{success: boolean}>}
     */
    toggleOverlays: function (enabled) {
        return ipcRenderer.invoke('toggle-overlays', { enabled: enabled });
    },

    /**
     * Текущее состояние показа overlay'ев.
     * @returns {Promise<{enabled: boolean}>}
     */
    getOverlaysEnabled: function () {
        return ipcRenderer.invoke('get-overlays-enabled');
    },

    // Зашифрованные файлы

    /**
     * Зашифровать выбранные файлы в ZIP-контейнер (пароль текущего чата).
     * Открывает native file dialog, шифрует AES-256-GCM, сохраняет temp .zip,
     * показывает файл в проводнике для перетаскивания в чат.
     * @returns {Promise<{success: boolean, count?: number, error?: string}>}
     */
    encryptFiles: function () {
        return ipcRenderer.invoke('encrypt-files');
    },

    /**
     * Расшифровать скачанный ZIP-контейнер CryptoMAX.
     * Открывает native file dialog, пробует все пароли чатов, расшифровывает,
     * предлагает сохранить через native save dialog.
     * @returns {Promise<{success: boolean, count?: number, chatId?: string, error?: string}>}
     */
    decryptFile: function () {
        return ipcRenderer.invoke('decrypt-file');
    },
});
