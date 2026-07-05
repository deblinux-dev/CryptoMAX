// Шифрование/дешифрование файлов для CryptoMAX.
// WinZip AES-256: archiver + archiver-zip-encrypted (сжатие),
// 7zip-bin/7za (распаковка).
// БЕЗОПАСНОСТЬ: при расшифровке всегда используется временная папка,
// файлы пользователя никогда не удаляются и не перезаписываются.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const archiver = require('archiver');

let _formatRegistered = false;
function ensureFormatRegistered() {
    if (_formatRegistered) return;
    archiver.registerFormat('zip-encrypted', require('archiver-zip-encrypted'));
    _formatRegistered = true;
}

// Путь к 7za из 7zip-bin
let _7zaPath = null;
function get7zaPath() {
    if (_7zaPath) return _7zaPath;
    try {
        _7zaPath = require('7zip-bin').path7za || require('7zip-bin');
    } catch (e) {
        const platform = process.platform;
        const arch = process.arch;
        const map = {
            'linux-x64': ['linux', 'x64'], 'linux-arm64': ['linux', 'arm64'],
            'darwin-x64': ['mac', 'x64'], 'darwin-arm64': ['mac', 'arm64'],
            'win32-x64': ['win', 'x64'],
        };
        const key = platform + '-' + arch;
        const sub = map[key] || ['linux', 'x64'];
        const name = platform === 'win32' ? '7za.exe' : '7za';
        _7zaPath = path.join(__dirname, 'node_modules', '7zip-bin', sub[0], sub[1], name);
    }
    if (!_7zaPath || !fs.existsSync(_7zaPath)) {
        throw new Error('7za binary not found.');
    }
    try { fs.chmodSync(_7zaPath, 0o755); } catch (e) {}
    return _7zaPath;
}

// Зашифровать файлы в WinZip AES-256 ZIP
function encryptFilesToZip(filePaths, password) {
    return new Promise((resolve, reject) => {
        try {
            ensureFormatRegistered();
            const fileNames = [];
            const errors = [];
            const chunks = [];
            const archive = archiver.create('zip-encrypted', {
                zlib: { level: 9 },
                encryptionMethod: 'aes256',
                password: password,
            });
            archive.on('error', (err) => reject(err));
            archive.on('warning', (err) => console.warn('archiver warning:', err.message));
            const captureStream = {
                write: (chunk) => { chunks.push(Buffer.from(chunk)); },
                end: () => {}, on: () => captureStream, once: () => captureStream, emit: () => false,
            };
            archive.pipe(captureStream);
            for (const fp of filePaths) {
                try {
                    const stat = fs.statSync(fp);
                    if (!stat.isFile()) { errors.push(path.basename(fp) + ': не файл'); continue; }
                    const name = path.basename(fp);
                    const opts = { name: name };
                    if (stat.size === 0) opts.store = true; // баг archiver-zip-encrypted с пустыми файлами
                    archive.file(fp, opts);
                    fileNames.push(name);
                } catch (e) { errors.push(path.basename(fp) + ': ' + e.message); }
            }
            archive.on('close', () => {
                resolve({ zipBuffer: Buffer.concat(chunks), fileNames, errors });
            });
            archive.finalize();
        } catch (e) { reject(e); }
    });
}

// Распаковать ZIP во временную папку (7za).
// ВАЖНО: всегда использует mkdtempSync, никогда не принимает outDir пользователя.
function decryptZipToTemp(zipPath, password) {
    return new Promise((resolve, reject) => {
        try {
            const bin = get7zaPath();
            // Временная папка
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-decrypt-'));
            const args = ['x', '-p' + password, '-o' + tempDir, '-aos', zipPath];
            execFile(bin, args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
                const output = (stderr || stdout || '').toString();
                if (/wrong password|неверный пароль|cannot open encrypted|Data Error in encrypted/i.test(output)) {
                    // Очистить временную папку
                    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}
                    reject(new Error('Неверный пароль.'));
                    return;
                }
                // Собрать список извлечённых файлов
                const files = [];
                try {
                    const entries = fs.readdirSync(tempDir, { withFileTypes: true });
                    for (const e of entries) {
                        if (e.isFile()) {
                            const fp = path.join(tempDir, e.name);
                            const stat = fs.statSync(fp);
                            files.push({ name: e.name, path: fp, size: stat.size });
                        }
                    }
                } catch (e) {}
                if (files.length === 0) {
                    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}
                    reject(new Error('7za error: ' + output.slice(0, 500)));
                    return;
                }
                resolve({ files, tempDir });
            });
        } catch (e) { reject(e); }
    });
}

// Безопасно переместить файлы из временной папки в папку пользователя.
// НЕ перезаписывает существующие файлы -- добавляет суффикс _1, _2, и т.д.
function moveFilesSafely(files, destDir) {
    const moved = [];
    for (const file of files) {
        let destPath = path.join(destDir, file.name);
        // Если файл уже существует -- добавить суффикс
        if (fs.existsSync(destPath)) {
            const ext = path.extname(file.name);
            const base = path.basename(file.name, ext);
            let counter = 1;
            do {
                destPath = path.join(destDir, base + '_' + counter + ext);
                counter++;
            } while (fs.existsSync(destPath));
        }
        // Копировать, затем удалить из временной папки
        fs.copyFileSync(file.path, destPath);
        try { fs.unlinkSync(file.path); } catch (e) {}
        moved.push({ name: path.basename(destPath), path: destPath, size: file.size });
    }
    return moved;
}

// Попробовать расшифровать ZIP списком паролей.
// outDir -- папка пользователя для итоговых файлов.
// Расшифровка всегда идёт во временную папку, файлы пользователя не трогаются.
async function tryDecryptZipWithPasswords(zipPath, passwords, outDir) {
    for (const chatId of Object.keys(passwords)) {
        const pwd = passwords[chatId];
        if (!pwd) continue;
        try {
            // Расшифровка во временную папку (безопасно)
            const result = await decryptZipToTemp(zipPath, pwd);
            if (result.files.length > 0) {
                // Успех -- перемещаем файлы в папку пользователя
                const moved = moveFilesSafely(result.files, outDir);
                // Удалить временную папку
                try { fs.rmSync(result.tempDir, { recursive: true, force: true }); } catch (e) {}
                return { files: moved, chatId };
            }
            // Очистить временную папку перед следующей попыткой
            try { fs.rmSync(result.tempDir, { recursive: true, force: true }); } catch (e) {}
        } catch (e) {
            // не этот пароль -- пробуем следующий
        }
    }
    return null;
}

module.exports = {
    encryptFilesToZip,
    decryptZipToTemp,
    tryDecryptZipWithPasswords,
    moveFilesSafely,
};
