const PI = Math.PI;
const SQRT2_INV = 1.0 / Math.SQRT2;
const cosMap = new Float32Array(64);
for (let u = 0; u < 8; u++) {
  for (let x = 0; x < 8; x++) {
    cosMap[u * 8 + x] = Math.cos(((2 * x + 1) * u * PI) / 16);
  }
}

function computeDCT(spatial) {
  const dct = new Float32Array(64);
  for (let u = 0; u < 8; u++) {
    const cu = u === 0 ? SQRT2_INV : 1;
    for (let v = 0; v < 8; v++) {
      const cv = v === 0 ? SQRT2_INV : 1;
      let sum = 0;
      for (let x = 0; x < 8; x++) {
        for (let y = 0; y < 8; y++) {
          sum += spatial[x * 8 + y] * cosMap[u * 8 + x] * cosMap[v * 8 + y];
        }
      }
      dct[u * 8 + v] = 0.25 * cu * cv * sum;
    }
  }
  return dct;
}

function computeIDCT(dct) {
  const spatial = new Float32Array(64);
  for (let x = 0; x < 8; x++) {
    for (let y = 0; y < 8; y++) {
      let sum = 0;
      for (let u = 0; u < 8; u++) {
        const cu = u === 0 ? SQRT2_INV : 1;
        for (let v = 0; v < 8; v++) {
          const cv = v === 0 ? SQRT2_INV : 1;
          sum += cu * cv * dct[u * 8 + v] * cosMap[u * 8 + x] * cosMap[v * 8 + y];
        }
      }
      spatial[x * 8 + y] = 0.25 * sum;
    }
  }
  return spatial;
}

class PRNG {
  constructor(seedStr) {
    let hash = 5381;
    for (let i = 0; i < seedStr.length; i++) {
      hash = ((hash << 5) + hash + seedStr.charCodeAt(i)) & 0xFFFFFFFF;
    }
    this.seed = hash >>> 0 || 12345;
  }
  next() {
    this.seed = (this.seed * 9301 + 49297) % 233280;
    return this.seed / 233280;
  }
  shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const temp = array[i];
      array[i] = array[j];
      array[j] = temp;
    }
  }
}

function stringToBits(str) {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(str);
  const bits = [];
  for (let i = 0; i < bytes.length; i++) {
    for (let b = 7; b >= 0; b--) {
      bits.push((bytes[i] >> b) & 1);
    }
  }
  return bits;
}

function bitsToString(bits) {
  const len = Math.floor(bits.length / 8);
  const bytes = new Uint8Array(len);
  let bitIdx = 0;
  for (let i = 0; i < len; i++) {
    let byte = 0;
    for (let b = 0; b < 8; b++) {
      byte = (byte << 1) | bits[bitIdx++];
    }
    bytes[i] = byte;
  }
  try {
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

function lengthToBits(len) {
  const bits = [];
  for (let i = 31; i >= 0; i--) {
    bits.push((len >> i) & 1);
  }
  return bits;
}

function bitsToLength(bits) {
  if (bits.length < 32) return 0;
  let len = 0;
  for (let i = 0; i < 32; i++) {
    len = (len << 1) | bits[i];
  }
  return len >>> 0;
}

function clamp(val) {
  return Math.max(0, Math.min(255, val));
}

async function aesEncrypt(plaintext, password) {
  if (!password) return plaintext;
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  );
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, enc.encode(plaintext));
  const combined = new Uint8Array(salt.length + iv.length + encrypted.byteLength);
  combined.set(salt, 0);
  combined.set(iv, salt.length);
  combined.set(new Uint8Array(encrypted), salt.length + iv.length);
  return btoa(String.fromCharCode(...combined));
}

async function aesDecrypt(ciphertextB64, password) {
  if (!password) return ciphertextB64;
  try {
    const combined = Uint8Array.from(atob(ciphertextB64), function (c) { return c.charCodeAt(0); });
    const salt = combined.slice(0, 16);
    const iv = combined.slice(16, 28);
    const data = combined.slice(28);
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: salt, iterations: 100000, hash: 'SHA-256' },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt']
    );
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv }, key, data);
    return new TextDecoder().decode(decrypted);
  } catch {
    return null;
  }
}

async function embedData(imageData, dataStr, options) {
  if (options === undefined) options = {};
  var alpha = options.alpha || 20;
  var password = options.password || '';

  var payloadStr = dataStr;
  if (password) {
    payloadStr = await aesEncrypt(dataStr, password);
  }

  var payloadBits = stringToBits(payloadStr);
  var lenBits = lengthToBits(payloadBits.length);

  var width = imageData.width;
  var height = imageData.height;
  var blocksX = Math.floor(width / 8);
  var blocksY = Math.floor(height / 8);
  var totalBlocks = blocksX * blocksY;

  var headerRepeats = Math.max(1, Math.min(15, Math.floor(totalBlocks / 64)));
  var requiredHeaderBlocks = 32 * headerRepeats;

  if (totalBlocks < requiredHeaderBlocks + payloadBits.length) {
    throw new Error('Изображение слишком мало для встраивания этих данных.');
  }

  var prng = new PRNG(password + 'header');
  var blockIndices = [];
  for (var i = 0; i < totalBlocks; i++) blockIndices.push(i);
  prng.shuffle(blockIndices);

  var newImageData = new ImageData(
    new Uint8ClampedArray(imageData.data),
    width,
    height
  );

  var processBlock = function (blockIndex, bit) {
    var bx = blockIndex % blocksX;
    var by = Math.floor(blockIndex / blocksX);
    var startX = bx * 8;
    var startY = by * 8;

    var spatial = new Float32Array(64);
    for (var y = 0; y < 8; y++) {
      for (var x = 0; x < 8; x++) {
        var px = startX + x;
        var py = startY + y;
        var idx = (py * width + px) * 4;
        var r = newImageData.data[idx];
        var g = newImageData.data[idx + 1];
        var b = newImageData.data[idx + 2];
        spatial[y * 8 + x] = 0.299 * r + 0.587 * g + 0.114 * b;
      }
    }

    var dct = computeDCT(spatial);
    var i1 = 18;
    var i2 = 27;
    var diff = dct[i1] - dct[i2];
    if (bit === 1) {
      if (diff < alpha) {
        var adj = (alpha - diff) / 2;
        dct[i1] += adj;
        dct[i2] -= adj;
      }
    } else {
      if (diff > -alpha) {
        var adj = (-alpha - diff) / 2;
        dct[i1] += adj;
        dct[i2] -= adj;
      }
    }

    var newSpatial = computeIDCT(dct);

    for (var y = 0; y < 8; y++) {
      for (var x = 0; x < 8; x++) {
        var px = startX + x;
        var py = startY + y;
        var idx = (py * width + px) * 4;
        var oldY = spatial[y * 8 + x];
        var newY = newSpatial[y * 8 + x];
        var delta = newY - oldY;
        newImageData.data[idx] = Math.round(clamp(newImageData.data[idx] + delta));
        newImageData.data[idx + 1] = Math.round(clamp(newImageData.data[idx + 1] + delta));
        newImageData.data[idx + 2] = Math.round(clamp(newImageData.data[idx + 2] + delta));
      }
    }
  };

  var blockOffset = 0;
  for (var i = 0; i < requiredHeaderBlocks; i++) {
    processBlock(blockIndices[blockOffset++], lenBits[i % 32]);
  }

  var remainingBlocks = totalBlocks - requiredHeaderBlocks;
  var dataRepeats = Math.max(1, Math.floor(remainingBlocks / payloadBits.length));
  var blocksForData = payloadBits.length * dataRepeats;

  for (var i = 0; i < blocksForData; i++) {
    processBlock(blockIndices[blockOffset++], payloadBits[i % payloadBits.length]);
  }

  return newImageData;
}

async function extractData(imageData, options) {
  if (options === undefined) options = {};
  var password = options.password || '';

  var width = imageData.width;
  var height = imageData.height;
  var blocksX = Math.floor(width / 8);
  var blocksY = Math.floor(height / 8);
  var totalBlocks = blocksX * blocksY;

  var headerRepeats = Math.max(1, Math.min(15, Math.floor(totalBlocks / 64)));
  var requiredHeaderBlocks = 32 * headerRepeats;

  if (totalBlocks < requiredHeaderBlocks) return null;

  var prng = new PRNG(password + 'header');
  var blockIndices = [];
  for (var i = 0; i < totalBlocks; i++) blockIndices.push(i);
  prng.shuffle(blockIndices);

  var getBitFromBlock = function (blockIndex) {
    var bx = blockIndex % blocksX;
    var by = Math.floor(blockIndex / blocksX);
    var startX = bx * 8;
    var startY = by * 8;

    var spatial = new Float32Array(64);
    for (var y = 0; y < 8; y++) {
      for (var x = 0; x < 8; x++) {
        var px = startX + x;
        var py = startY + y;
        var idx = (py * width + px) * 4;
        var r = imageData.data[idx];
        var g = imageData.data[idx + 1];
        var b = imageData.data[idx + 2];
        spatial[y * 8 + x] = 0.299 * r + 0.587 * g + 0.114 * b;
      }
    }

    var dct = computeDCT(spatial);
    var i1 = 18;
    var i2 = 27;
    return dct[i1] > dct[i2] ? 1 : 0;
  };

  var blockOffset = 0;

  var headerVotes = new Int32Array(32);
  for (var i = 0; i < requiredHeaderBlocks; i++) {
    var bit = getBitFromBlock(blockIndices[blockOffset++]);
    if (bit === 1) headerVotes[i % 32]++;
    else headerVotes[i % 32]--;
  }

  var lenBits = [];
  for (var i = 0; i < 32; i++) {
    lenBits.push(headerVotes[i] > 0 ? 1 : 0);
  }
  var payloadBitsLength = bitsToLength(lenBits);

  if (payloadBitsLength <= 0 || payloadBitsLength > (totalBlocks - requiredHeaderBlocks)) return null;

  var remainingBlocks = totalBlocks - requiredHeaderBlocks;
  var dataRepeats = Math.floor(remainingBlocks / payloadBitsLength);
  if (dataRepeats < 1) return null;

  var blocksForData = payloadBitsLength * dataRepeats;

  var dataVotes = new Int32Array(payloadBitsLength);
  for (var i = 0; i < blocksForData; i++) {
    var bit = getBitFromBlock(blockIndices[blockOffset++]);
    if (bit === 1) dataVotes[i % payloadBitsLength]++;
    else dataVotes[i % payloadBitsLength]--;
  }

  var payloadBits = [];
  for (var i = 0; i < payloadBitsLength; i++) {
    payloadBits.push(dataVotes[i] > 0 ? 1 : 0);
  }

  var extractedStr = bitsToString(payloadBits);
  if (!extractedStr) return null;

  if (password) {
    var dec = await aesDecrypt(extractedStr, password);
    return dec || null;
  }

  return extractedStr;
}

window.SpectraSteg = { embedData: embedData, extractData: extractData };
