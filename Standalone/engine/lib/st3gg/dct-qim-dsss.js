/**
 * DCT-QIM and DSSS (Spread Spectrum) Steganography Library
 *
 * Based on algorithms from ST3GG (https://github.com/elder-plinius/ST3GG)
 *
 * DCT-QIM: Quantization Index Modulation in DCT domain.
 *   - Embeds data in mid-frequency DCT coefficients
 *   - Survives JPEG recompression (strength controls robustness)
 *   - No password required (optional)
 *
 * DSSS: Direct Sequence Spread Spectrum (LSB-based with PRNG).
 *   - Password-based pseudorandom pixel selection
 *   - Majority voting for error resilience
 *   - Password REQUIRED
 *
 * Usage:
 *   DCTQIM.encode(canvas, data, options) → canvas (modifies in place)
 *   DCTQIM.decode(canvas) → Uint8Array
 *   DSSS.encode(canvas, data, password, options) → canvas
 *   DSSS.decode(canvas, password, options) → Uint8Array
 */

// ═══════════════════════════════════════════════════════════════
//  SHARED UTILITIES
// ═══════════════════════════════════════════════════════════════

function mulberry32(seed) {
    return function() {
        let t = seed += 0x6D2B79F5;
        t = Math.imul(t ^ t >>> 15, t | 1);
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

function hashString(str) {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) + hash + str.charCodeAt(i)) & 0xFFFFFFFF;
    }
    return Math.abs(hash);
}

// ═══════════════════════════════════════════════════════════════
//  DCT-QIM (Quantization Index Modulation)
// ═══════════════════════════════════════════════════════════════

const DCTQIM = (() => {
    'use strict';

    const MAGIC = [0x44, 0x43, 0x54, 0x51]; // "DCTQ"
    const HEADER_SIZE = 9; // 4 magic + 1 strength + 4 length

    const DCT_EMBED_POSITIONS = [
        [0, 1], [1, 0], [2, 0], [1, 1], [0, 2],
        [0, 3], [1, 2], [2, 1], [3, 0],
        [3, 1], [2, 2], [1, 3], [2, 3], [3, 2], [3, 3]
    ];

    function createDCTMatrix(n) {
        const matrix = [];
        for (let i = 0; i < n; i++) {
            matrix[i] = [];
            for (let j = 0; j < n; j++) {
                if (i === 0) {
                    matrix[i][j] = 1 / Math.sqrt(n);
                } else {
                    matrix[i][j] = Math.sqrt(2 / n) * Math.cos(((2 * j + 1) * i * Math.PI) / (2 * n));
                }
            }
        }
        return matrix;
    }

    function dct2D(block, dctMatrix) {
        const n = block.length;
        const temp = Array.from({ length: n }, () => Array(n).fill(0));
        const result = Array.from({ length: n }, () => Array(n).fill(0));
        for (let i = 0; i < n; i++) {
            for (let j = 0; j < n; j++) {
                let sum = 0;
                for (let k = 0; k < n; k++) sum += dctMatrix[j][k] * block[i][k];
                temp[i][j] = sum;
            }
        }
        for (let i = 0; i < n; i++) {
            for (let j = 0; j < n; j++) {
                let sum = 0;
                for (let k = 0; k < n; k++) sum += dctMatrix[i][k] * temp[k][j];
                result[i][j] = sum;
            }
        }
        return result;
    }

    function idct2D(block, dctMatrix) {
        const n = block.length;
        const dctT = Array.from({ length: n }, () => Array(n).fill(0));
        for (let i = 0; i < n; i++)
            for (let j = 0; j < n; j++) dctT[i][j] = dctMatrix[j][i];

        const temp = Array.from({ length: n }, () => Array(n).fill(0));
        const result = Array.from({ length: n }, () => Array(n).fill(0));
        for (let i = 0; i < n; i++) {
            for (let j = 0; j < n; j++) {
                let sum = 0;
                for (let k = 0; k < n; k++) sum += dctT[i][k] * block[k][j];
                temp[i][j] = sum;
            }
        }
        for (let i = 0; i < n; i++) {
            for (let j = 0; j < n; j++) {
                let sum = 0;
                for (let k = 0; k < n; k++) sum += dctT[j][k] * temp[i][k];
                result[i][j] = sum;
            }
        }
        return result;
    }

    function getCapacity(canvas, blockSize) {
        const blocksX = Math.floor(canvas.width / blockSize);
        const blocksY = Math.floor(canvas.height / blockSize);
        return Math.floor((blocksX * blocksY - HEADER_SIZE * 8) / 8);
    }

    /**
     * Encode data into canvas using DCT-QIM.
     * @param {HTMLCanvasElement} canvas
     * @param {Uint8Array} data
     * @param {Object} options - { robustness: 'low'|'medium'|'high', blockSize: 8|16 }
     * @returns {HTMLCanvasElement} modified canvas
     */
    function encode(canvas, data, options = {}) {
        const robustness = options.robustness || 'medium';
        const blockSize = options.blockSize || 8;
        const strength = robustness === 'low' ? 10 : robustness === 'medium' ? 25 : 50;

        const ctx = canvas.getContext('2d');
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const pixels = imageData.data;
        const dctMatrix = createDCTMatrix(blockSize);

        // 9-byte header: "DCTQ" + strength + 4-byte data length
        const header = new Uint8Array(HEADER_SIZE);
        header[0] = MAGIC[0]; header[1] = MAGIC[1]; header[2] = MAGIC[2]; header[3] = MAGIC[3];
        header[4] = strength;
        header[5] = (data.length >> 24) & 0xFF;
        header[6] = (data.length >> 16) & 0xFF;
        header[7] = (data.length >> 8) & 0xFF;
        header[8] = data.length & 0xFF;

        const fullData = new Uint8Array(header.length + data.length);
        fullData.set(header);
        fullData.set(data, header.length);

        // Convert to bit array
        const bits = [];
        for (let i = 0; i < fullData.length; i++)
            for (let j = 7; j >= 0; j--) bits.push((fullData[i] >> j) & 1);

        const blocksX = Math.floor(canvas.width / blockSize);
        const blocksY = Math.floor(canvas.height / blockSize);
        const capacity = blocksX * blocksY;

        if (bits.length > capacity) {
            throw new Error(`DCT-QIM capacity exceeded: need ${bits.length} bits, have ${capacity}`);
        }

        let bitIdx = 0;
        for (let by = 0; by < blocksY && bitIdx < bits.length; by++) {
            for (let bx = 0; bx < blocksX && bitIdx < bits.length; bx++) {
                // Extract luminance block
                const block = [];
                for (let y = 0; y < blockSize; y++) {
                    block[y] = [];
                    for (let x = 0; x < blockSize; x++) {
                        const px = (by * blockSize + y) * canvas.width + (bx * blockSize + x);
                        const idx = px * 4;
                        block[y][x] = 0.299 * pixels[idx] + 0.587 * pixels[idx + 1] + 0.114 * pixels[idx + 2];
                    }
                }

                const dctBlock = dct2D(block, dctMatrix);
                const [cy, cx] = DCT_EMBED_POSITIONS[0]; // [0, 1]
                const bit = bits[bitIdx++];

                // QIM embedding
                const coeff = dctBlock[cy][cx];
                const q = Math.floor(coeff / strength);
                dctBlock[cy][cx] = (q + (bit ? 0.75 : 0.25)) * strength;

                const reconstructed = idct2D(dctBlock, dctMatrix);

                // Write back pixels preserving color ratios
                for (let y = 0; y < blockSize; y++) {
                    for (let x = 0; x < blockSize; x++) {
                        const px = (by * blockSize + y) * canvas.width + (bx * blockSize + x);
                        const idx = px * 4;
                        const oldLum = 0.299 * pixels[idx] + 0.587 * pixels[idx + 1] + 0.114 * pixels[idx + 2];
                        const newLum = Math.max(0, Math.min(255, reconstructed[y][x]));
                        const ratio = oldLum > 0 ? newLum / oldLum : 1;
                        pixels[idx] = Math.max(0, Math.min(255, Math.round(pixels[idx] * ratio)));
                        pixels[idx + 1] = Math.max(0, Math.min(255, Math.round(pixels[idx + 1] * ratio)));
                        pixels[idx + 2] = Math.max(0, Math.min(255, Math.round(pixels[idx + 2] * ratio)));
                    }
                }
            }
        }
        ctx.putImageData(imageData, 0, 0);
        return canvas;
    }

    /**
     * Decode data from canvas using DCT-QIM.
     * Auto-detects strength and parameters from header.
     * @param {HTMLCanvasElement} canvas
     * @returns {Uint8Array} decoded payload
     */
    function decode(canvas) {
        const ctx = canvas.getContext('2d');
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const pixels = imageData.data;

        const blockSize = 8; // Try 8 first, then 16
        const blocksX = Math.floor(canvas.width / blockSize);
        const blocksY = Math.floor(canvas.height / blockSize);

        // Extract all coefficients
        const dctMatrix = createDCTMatrix(blockSize);
        const coefficients = [];
        for (let by = 0; by < blocksY; by++) {
            for (let bx = 0; bx < blocksX; bx++) {
                const block = [];
                for (let y = 0; y < blockSize; y++) {
                    block[y] = [];
                    for (let x = 0; x < blockSize; x++) {
                        const px = (by * blockSize + y) * canvas.width + (bx * blockSize + x);
                        const idx = px * 4;
                        block[y][x] = 0.299 * pixels[idx] + 0.587 * pixels[idx + 1] + 0.114 * pixels[idx + 2];
                    }
                }
                const dctBlock = dct2D(block, dctMatrix);
                const [cy, cx] = DCT_EMBED_POSITIONS[0];
                coefficients.push(dctBlock[cy][cx]);
            }
        }

        // Try all three strengths to find valid header
        const strengths = [10, 25, 50];
        for (const strength of strengths) {
            const bits = coefficients.map(coeff => {
                const q = Math.floor(coeff / strength);
                const remainder = coeff - q * strength;
                return remainder >= strength / 2 ? 1 : 0;
            });

            const bytes = [];
            for (let i = 0; i + 7 < bits.length; i += 8) {
                let byte = 0;
                for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
                bytes.push(byte);
            }

            // Check magic header
            if (bytes.length >= HEADER_SIZE &&
                bytes[0] === MAGIC[0] && bytes[1] === MAGIC[1] &&
                bytes[2] === MAGIC[2] && bytes[3] === MAGIC[3] &&
                bytes[4] === strength) {
                const dataLength = (bytes[5] << 24) | (bytes[6] << 16) | (bytes[7] << 8) | bytes[8];
                if (dataLength >= 0 && dataLength <= 65536) {
                    const payload = bytes.slice(HEADER_SIZE, HEADER_SIZE + dataLength);
                    if (payload.length === dataLength) {
                        return new Uint8Array(payload);
                    }
                }
            }
        }

        throw new Error('DCT-QIM: заголовок не найден (нет стего-данных или повреждено)');
    }

    return { encode, decode, getCapacity, MAGIC };
})();


// ═══════════════════════════════════════════════════════════════
//  DSSS (Direct Sequence Spread Spectrum)
// ═══════════════════════════════════════════════════════════════

const DSSS = (() => {
    'use strict';

    const MAGIC = [0x53, 0x50, 0x52, 0x44]; // "SPRD"
    const HEADER_SIZE = 8; // 4 magic + 4 length

    /**
     * Encode data into canvas using DSSS.
     * @param {HTMLCanvasElement} canvas
     * @param {Uint8Array} data
     * @param {string} password - REQUIRED
     * @param {Object} options - { spreadFactor: 8|16|32|64, strength: 1|2|3 }
     * @returns {HTMLCanvasElement} modified canvas
     */
    function encode(canvas, data, password, options = {}) {
        if (!password) throw new Error('DSSS: пароль обязателен');

        const spreadFactor = options.spreadFactor || 16;
        const strength = options.strength || 2;

        const ctx = canvas.getContext('2d');
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const pixels = imageData.data;
        const totalPixels = canvas.width * canvas.height;

        // 8-byte header
        const header = new Uint8Array(HEADER_SIZE);
        header[0] = MAGIC[0]; header[1] = MAGIC[1]; header[2] = MAGIC[2]; header[3] = MAGIC[3];
        header[4] = (data.length >> 24) & 0xFF;
        header[5] = (data.length >> 16) & 0xFF;
        header[6] = (data.length >> 8) & 0xFF;
        header[7] = data.length & 0xFF;

        const fullData = new Uint8Array(header.length + data.length);
        fullData.set(header);
        fullData.set(data, header.length);

        const bits = [];
        for (let i = 0; i < fullData.length; i++)
            for (let j = 7; j >= 0; j--) bits.push((fullData[i] >> j) & 1);

        const capacity = Math.floor(totalPixels / spreadFactor);
        if (bits.length > capacity) {
            throw new Error(`DSSS capacity exceeded: need ${bits.length} bits, have ${capacity}`);
        }

        const rng = mulberry32(hashString(password));
        const used = new Set();

        for (let bitIdx = 0; bitIdx < bits.length; bitIdx++) {
            const bit = bits[bitIdx];
            for (let s = 0; s < spreadFactor; s++) {
                let pixelIdx;
                do {
                    pixelIdx = Math.floor(rng() * totalPixels);
                } while (used.has(pixelIdx) && used.size < totalPixels);
                used.add(pixelIdx);

                const channel = Math.floor(rng() * 3); // R=0, G=1, B=2
                const polarity = rng() > 0.5 ? 1 : 0;
                const idx = pixelIdx * 4 + channel;
                const targetLSB = bit === polarity ? 1 : 0;
                pixels[idx] = (pixels[idx] & 0xFE) | targetLSB;
            }
        }

        ctx.putImageData(imageData, 0, 0);
        return canvas;
    }

    /**
     * Decode data from canvas using DSSS.
     * @param {HTMLCanvasElement} canvas
     * @param {string} password - REQUIRED (must match encode password)
     * @param {Object} options - { spreadFactor: 8|16|32|64 }
     * @returns {Uint8Array} decoded payload
     */
    function decode(canvas, password, options = {}) {
        if (!password) throw new Error('DSSS: пароль обязателен для декодирования');

        const spreadFactor = options.spreadFactor || 16;

        const ctx = canvas.getContext('2d');
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const pixels = imageData.data;
        const totalPixels = canvas.width * canvas.height;

        const rng = mulberry32(hashString(password));
        const used = new Set();
        const capacity = Math.floor(totalPixels / spreadFactor);
        const maxBits = Math.min(capacity, 65536 * 8); // max 64KB payload

        const decodedBits = [];

        for (let bitIdx = 0; bitIdx < maxBits; bitIdx++) {
            let votes = 0;
            for (let s = 0; s < spreadFactor; s++) {
                let pixelIdx;
                do {
                    pixelIdx = Math.floor(rng() * totalPixels);
                } while (used.has(pixelIdx) && used.size < totalPixels);
                used.add(pixelIdx);

                const channel = Math.floor(rng() * 3);
                const polarity = rng() > 0.5 ? 1 : 0;
                const idx = pixelIdx * 4 + channel;
                const lsb = pixels[idx] & 1;
                const decodedBit = lsb === 1 ? polarity : (1 - polarity);
                votes += decodedBit;
            }
            decodedBits.push(votes > spreadFactor / 2 ? 1 : 0);

            // Early exit: validate header after 64 bits
            if (bitIdx === 63) {
                const headerBytes = [];
                for (let i = 0; i < HEADER_SIZE; i++) {
                    let byte = 0;
                    for (let j = 0; j < 8; j++) byte = (byte << 1) | decodedBits[i * 8 + j];
                    headerBytes.push(byte);
                }
                if (headerBytes[0] !== MAGIC[0] || headerBytes[1] !== MAGIC[1] ||
                    headerBytes[2] !== MAGIC[2] || headerBytes[3] !== MAGIC[3]) {
                    throw new Error('DSSS: заголовок не найден (неверный пароль?)');
                }
                const dataLength = (headerBytes[4] << 24) | (headerBytes[5] << 16) |
                    (headerBytes[6] << 8) | headerBytes[7];
                if (dataLength < 0 || dataLength > 65536) {
                    throw new Error('DSSS: неверная длина данных');
                }
                // Calculate total bits needed and stop when we have them
                const totalBitsNeeded = (HEADER_SIZE + dataLength) * 8;
                if (maxBits > totalBitsNeeded + 8) {
                    // Continue but we know the exact count
                }
            }
        }

        // Convert bits to bytes
        const bytes = [];
        for (let i = 0; i + 7 < decodedBits.length; i += 8) {
            let byte = 0;
            for (let j = 0; j < 8; j++) byte = (byte << 1) | decodedBits[i + j];
            bytes.push(byte);
        }

        if (bytes.length < HEADER_SIZE) {
            throw new Error('DSSS: недостаточно данных для чтения заголовка');
        }

        // Validate magic
        if (bytes[0] !== MAGIC[0] || bytes[1] !== MAGIC[1] ||
            bytes[2] !== MAGIC[2] || bytes[3] !== MAGIC[3]) {
            throw new Error('DSSS: заголовок не найден');
        }

        const dataLength = (bytes[4] << 24) | (bytes[5] << 16) | (bytes[6] << 8) | bytes[7];
        if (dataLength < 0 || dataLength > bytes.length - HEADER_SIZE) {
            throw new Error('DSSS: неверная длина данных');
        }

        return new Uint8Array(bytes.slice(HEADER_SIZE, HEADER_SIZE + dataLength));
    }

    function getCapacity(canvas, spreadFactor) {
        spreadFactor = spreadFactor || 16;
        const totalPixels = canvas.width * canvas.height;
        return Math.floor((Math.floor(totalPixels / spreadFactor) - HEADER_SIZE * 8) / 8);
    }

    return { encode, decode, getCapacity, MAGIC };
})();

// ═══════════════════════════════════════════════════════════════
//  EXPORTS (global scope for script tag loading)
// ═══════════════════════════════════════════════════════════════

window.DCTQIM = DCTQIM;
window.DSSS = DSSS;
