const MARKER_HEIGHT = 16;

function hasCryptoMarker(imageSource) {
  const w = imageSource.naturalWidth || imageSource.width;
  const h = imageSource.naturalHeight || imageSource.height;
  if (h < MARKER_HEIGHT * 2) return false;

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = MARKER_HEIGHT;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return false;

  ctx.drawImage(imageSource, 0, 0);
  const width = canvas.width;

  const sampleColor = (x) => {
    const data = ctx.getImageData(x, Math.floor(MARKER_HEIGHT / 2), 1, 1).data;
    return { r: data[0], g: data[1], b: data[2] };
  };

  const c1 = sampleColor(Math.floor(width * 0.16));
  const c2 = sampleColor(Math.floor(width * 0.5));
  const c3 = sampleColor(Math.floor(width * 0.83));

  const dist = (c, target) =>
    Math.abs(c.r - target[0]) + Math.abs(c.g - target[1]) + Math.abs(c.b - target[2]);

  const tolerance = 180;
  const isC1 = dist(c1, [255, 0, 255]) < tolerance;
  const isC2 = dist(c2, [0, 255, 255]) < tolerance;
  const isC3 = dist(c3, [255, 255, 0]) < tolerance;

  return isC1 && isC2 && isC3;
}

function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function generateSeed(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const view = new DataView(hashBuffer);
  return view.getUint32(0, true) ^ view.getUint32(4, true);
}

function getShuffleOrder(numElements, randFunc) {
  const array = Array.from({ length: numElements }, (_, i) => i);
  let currentIndex = array.length, randomIndex;
  while (currentIndex !== 0) {
    randomIndex = Math.floor(randFunc() * currentIndex);
    currentIndex--;
    [array[currentIndex], array[randomIndex]] = [array[randomIndex], array[currentIndex]];
  }
  return array;
}

async function processCryptoImage(imageSource, options) {
  const { password, mode, blockSize = 32, useMagicMarker = true, safeModeResize = true } = options;

  const seed = await generateSeed(password);
  const rand = mulberry32(seed);

  const markerPresentInSource = mode === 'decrypt' ? hasCryptoMarker(imageSource) : false;
  const attachMarker = mode === 'encrypt' ? useMagicMarker : false;

  const srcMarkerOffset = markerPresentInSource ? MARKER_HEIGHT : 0;

  const effSrcWidth = imageSource.naturalWidth || imageSource.width;
  const effSrcHeight = (imageSource.naturalHeight || imageSource.height) - srcMarkerOffset;

  let targetWidth = effSrcWidth;
  let targetHeight = effSrcHeight;

  if (mode === 'encrypt' && safeModeResize && (targetWidth > 1024 || targetHeight > 1024)) {
    const scale = 1024 / Math.max(targetWidth, targetHeight);
    targetWidth = Math.floor(targetWidth * scale);
    targetHeight = Math.floor(targetHeight * scale);
  }

  const width = targetWidth - (targetWidth % blockSize);
  const height = targetHeight - (targetHeight % blockSize);

  const offCanvas = document.createElement('canvas');
  offCanvas.width = width;
  offCanvas.height = height;
  const offCtx = offCanvas.getContext('2d', { willReadFrequently: true });
  if (!offCtx) throw new Error('Could not get 2D context');

  offCtx.drawImage(
    imageSource,
    0, srcMarkerOffset, effSrcWidth, effSrcHeight,
    0, 0, width, height
  );
  const sourceImageData = offCtx.getImageData(0, 0, width, height);
  const destImageData = new ImageData(width, height);

  const cols = Math.floor(width / blockSize);
  const rows = Math.floor(height / blockSize);
  const numBlocks = cols * rows;

  const order = getShuffleOrder(numBlocks, rand);

  const blockTransformations = Array.from({ length: numBlocks }, () => ({
    flipX: rand() > 0.5,
    flipY: rand() > 0.5,
    invert: rand() > 0.5,
    colorShift: Math.floor(rand() * 3)
  }));

  for (let i = 0; i < numBlocks; i++) {
    const srcBlockIdx = mode === 'encrypt' ? order[i] : order.indexOf(i);
    const destBlockIdx = i;

    const originalBlockIdx = mode === 'encrypt' ? order[i] : i;
    const { flipX, flipY, invert, colorShift } = blockTransformations[originalBlockIdx];

    const destCol = destBlockIdx % cols;
    const destRow = Math.floor(destBlockIdx / cols);

    const srcCol = srcBlockIdx % cols;
    const srcRow = Math.floor(srcBlockIdx / cols);

    for (let y = 0; y < blockSize; y++) {
      for (let x = 0; x < blockSize; x++) {
        let sX = x;
        let sY = y;

        if (flipX) sX = blockSize - 1 - sX;
        if (flipY) sY = blockSize - 1 - sY;

        const srcPixelIndex = ((srcRow * blockSize + sY) * width + srcCol * blockSize + sX) * 4;
        const destPixelIndex = ((destRow * blockSize + y) * width + destCol * blockSize + x) * 4;

        let r = sourceImageData.data[srcPixelIndex];
        let g = sourceImageData.data[srcPixelIndex + 1];
        let b = sourceImageData.data[srcPixelIndex + 2];

        let shiftToUse = colorShift;
        if (mode === 'decrypt') {
          if (colorShift === 1) shiftToUse = 2;
          else if (colorShift === 2) shiftToUse = 1;
        }

        if (shiftToUse === 1) {
          const temp = r; r = g; g = b; b = temp;
        } else if (shiftToUse === 2) {
          const temp = r; r = b; b = g; g = temp;
        }

        if (invert) {
          r = 255 - r; g = 255 - g; b = 255 - b;
        }

        destImageData.data[destPixelIndex] = r;
        destImageData.data[destPixelIndex + 1] = g;
        destImageData.data[destPixelIndex + 2] = b;
        destImageData.data[destPixelIndex + 3] = 255;
      }
    }
  }

  const destMarkerOffset = attachMarker ? MARKER_HEIGHT : 0;
  const finalCanvas = document.createElement('canvas');
  finalCanvas.width = width;
  finalCanvas.height = height + destMarkerOffset;
  const finalCtx = finalCanvas.getContext('2d');
  if (!finalCtx) throw new Error('No final 2d context');

  if (attachMarker) {
    finalCtx.fillStyle = 'rgb(255, 0, 255)';
    finalCtx.fillRect(0, 0, width / 3, MARKER_HEIGHT);
    finalCtx.fillStyle = 'rgb(0, 255, 255)';
    finalCtx.fillRect(width / 3, 0, width / 3, MARKER_HEIGHT);
    finalCtx.fillStyle = 'rgb(255, 255, 0)';
    finalCtx.fillRect((width / 3) * 2, 0, width - (width / 3) * 2, MARKER_HEIGHT);
  }

  finalCtx.putImageData(destImageData, 0, destMarkerOffset);

  return finalCanvas.toDataURL('image/png');
}

window.ImageScrambler = { processCryptoImage, hasCryptoMarker };
