/**
 * Enhanced Text Overlay Steganography Library
 *
 * Renders secret text onto an image with various effects:
 * - Standard overlay (font, size, color, opacity, position, rotation)
 * - Distortion effects for OCR resistance:
 *   - Wave distortion (per-character sinusoidal y-offset)
 *   - HSL-based random color per letter (varies hue from base color)
 *   - Per-letter random rotation, size, skew, offset, spacing
 *   - Gaussian noise overlay on text
 * - Word wrapping within image bounds (handles per-char effects)
 * - Auto-fit text within bounding box (for bubble presets)
 * - Interactive drag positioning
 *
 * API:
 *   TextOverlay.render(canvas, text, options) → void
 *   TextOverlay.renderToDataUrl(imageElement, text, options) → string
 *   TextOverlay.renderWithEffects(canvas, text, options) → void
 *   TextOverlay.reveal(canvas) → void
 *   TextOverlay.getTextBounds(ctx, text, options) → {x, y, w, h}
 *   TextOverlay.measureTextWrapped(ctx, text, maxWidth, options) → {lines, widths, lineHeight}
 *   TextOverlay.renderBubble(canvas, text, options) → void
 *   TextOverlay.generateColorPalette(baseColor, count) → string[]
 */

const TextOverlay = (() => {
    'use strict';

    const DEFAULT_OPTIONS = {
        fontSize: 24,
        fontFamily: 'Arial, sans-serif',
        color: '#ffffff',
        opacity: 15,              // 1-100 percent
        position: 'tile',         // center | tile | top-left | top-right | bottom-left | bottom-right | top | bottom | custom
        rotation: 0,              // degrees (global rotation)
        padding: 20,              // pixels from edges for non-tile positions
        lineSpacing: 1.4,         // line height multiplier

        // Drag positioning (percent 0-100)
        posX: 10,
        posY: 10,

        // Distortion effects
        randomColorPerLetter: false,
        waveAmplitude: 0,          // 0 = off, 1-8 pixels (per-character)
        waveFrequency: 1,          // cycles per ~10 characters
        perLetterRotation: 0,      // 0 = off, 1-30 degrees range
        perLetterSizeVariation: 0, // 0 = off, 1-10 pixels range
        perLetterSkewX: 0,         // 0 = off, 0.1-0.5 range
        noiseIntensity: 0,         // 0 = off, 1-50 range
        perLetterRandomOffset: 0,  // 0 = off, 1-10 pixels range
        perLetterBoldRandom: false,
        perLetterSpacingVariation: 0, // 0 = off, 1-8 pixels extra space

        // Bubble preset (for renderBubble)
        bubblePreset: null,        // null | 'telegram' | 'whatsapp' | 'imessage' | 'discord' | 'sms'
        bubbleBgColor: null,       // override bubble background color
        bubbleBorderColor: null,
        bubbleBorderRadius: 18,
        bubblePadding: 12,
        bubbleMaxWidth: 0.7,       // fraction of canvas width
        bubbleAlign: 'left',       // 'left' | 'right'
        bubbleTail: true,
    };

    // ─── Bubble Preset Definitions ──────────────────────────
    const BUBBLE_PRESETS = {
        telegram: {
            bubbleBgColor: '#2AABEE',
            bubbleBorderColor: null,
            bubbleBorderRadius: 22,
            bubblePadding: 18,
            bubbleMaxWidth: 0.7,
            bubbleAlign: 'right',
            bubbleTail: true,
            color: '#ffffff',
            fontFamily: 'Arial, sans-serif',
            fontSize: 44,
            lineSpacing: 1.35,
            opacity: 100,
        },
        whatsapp: {
            bubbleBgColor: '#DCF8C6',
            bubbleBorderColor: null,
            bubbleBorderRadius: 14,
            bubblePadding: 16,
            bubbleMaxWidth: 0.75,
            bubbleAlign: 'right',
            bubbleTail: true,
            color: '#111111',
            fontFamily: 'Arial, sans-serif',
            fontSize: 44,
            lineSpacing: 1.35,
            opacity: 100,
        },
        imessage: {
            bubbleBgColor: '#007AFF',
            bubbleBorderColor: null,
            bubbleBorderRadius: 24,
            bubblePadding: 18,
            bubbleMaxWidth: 0.7,
            bubbleAlign: 'right',
            bubbleTail: true,
            color: '#ffffff',
            fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
            fontSize: 44,
            lineSpacing: 1.35,
            opacity: 100,
        },
        discord: {
            bubbleBgColor: '#2F3136',
            bubbleBorderColor: null,
            bubbleBorderRadius: 14,
            bubblePadding: 18,
            bubbleMaxWidth: 0.7,
            bubbleAlign: 'right',
            bubbleTail: false,
            color: '#DCDDDE',
            fontFamily: 'Arial, sans-serif',
            fontSize: 44,
            lineSpacing: 1.35,
            opacity: 100,
        },
        sms: {
            bubbleBgColor: '#C6EBC5',
            bubbleBorderColor: null,
            bubbleBorderRadius: 24,
            bubblePadding: 18,
            bubbleMaxWidth: 0.72,
            bubbleAlign: 'right',
            bubbleTail: true,
            color: '#111111',
            fontFamily: 'Arial, sans-serif',
            fontSize: 44,
            lineSpacing: 1.35,
            opacity: 100,
        },
    };

    // ─── PRNG for repeatable randomness ──────────────────────
    function seededRandom(seed) {
        let s = seed || 42;
        return function() {
            s = (s * 16807 + 0) % 2147483647;
            return (s - 1) / 2147483646;
        };
    }

    // ─── Color Utilities ────────────────────────────────────

    /**
     * Parse hex color to {r, g, b} (0-255).
     */
    function hexToRGB(hex) {
        hex = hex.replace('#', '');
        if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
        return {
            r: parseInt(hex.slice(0,2), 16),
            g: parseInt(hex.slice(2,4), 16),
            b: parseInt(hex.slice(4,6), 16),
        };
    }

    /**
     * Convert RGB (0-255) to HSL (h: 0-360, s: 0-100, l: 0-100).
     */
    function rgbToHSL(r, g, b) {
        r /= 255; g /= 255; b /= 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        let h, s, l = (max + min) / 2;

        if (max === min) {
            h = s = 0;
        } else {
            const d = max - min;
            s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
            switch (max) {
                case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
                case g: h = ((b - r) / d + 2) / 6; break;
                case b: h = ((r - g) / d + 4) / 6; break;
            }
        }
        return { h: h * 360, s: s * 100, l: l * 100 };
    }

    /**
     * Generate a varied color palette from a base color.
     * Varies hue, saturation, and lightness for true multicolor effect.
     * When base saturation is very low (near white/black/gray), boosts saturation
     * so the multicolor effect is actually visible.
     */
    function generateColorPalette(baseColor, count = 14) {
        const rgb = hexToRGB(baseColor);
        const hsl = rgbToHSL(rgb.r, rgb.g, rgb.b);

        // If base color is achromatic (white, black, gray), boost saturation
        const isAchromatic = hsl.s < 15;
        const effectiveSat = isAchromatic ? 75 : hsl.s;
        const effectiveLight = isAchromatic
            ? (hsl.l > 80 ? 65 : hsl.l < 20 ? 40 : hsl.l)
            : hsl.l;

        const palette = [];
        // Use golden angle for even hue distribution
        const goldenAngle = 137.508;
        for (let i = 0; i < count; i++) {
            // Distribute hues evenly around the color wheel
            const hue = (hsl.h + i * goldenAngle) % 360;

            // Vary saturation: keep it vivid
            const sat = Math.max(45, Math.min(100,
                effectiveSat + (Math.sin(i * 1.7) * 20)
            ));

            // Vary lightness: keep it readable
            const light = Math.max(30, Math.min(80,
                effectiveLight + (Math.cos(i * 2.3) * 15)
            ));

            palette.push(`hsl(${Math.round(hue)}, ${Math.round(sat)}%, ${Math.round(light)}%)`);
        }
        return palette;
    }

    // ─── Word wrapping ───────────────────────────────────────

    /**
     * Wrap text to fit within maxWidth, respecting word boundaries.
     * Returns array of line strings.
     */
    function wrapText(ctx, text, maxWidth, fontSize, fontFamily) {
        if (maxWidth <= 0) return [text];

        const savedFont = ctx.font;
        ctx.font = `${fontSize}px ${fontFamily}`;

        const paragraphs = text.split('\n');
        const lines = [];

        for (const paragraph of paragraphs) {
            if (paragraph.trim() === '') {
                lines.push('');
                continue;
            }
            const words = paragraph.split(' ');
            let currentLine = '';

            for (const word of words) {
                const testLine = currentLine ? currentLine + ' ' + word : word;
                const metrics = ctx.measureText(testLine);

                if (metrics.width > maxWidth && currentLine) {
                    lines.push(currentLine);
                    currentLine = word;
                } else {
                    currentLine = testLine;
                }
            }
            if (currentLine) lines.push(currentLine);
        }

        ctx.font = savedFont;
        return lines;
    }

    /**
     * Measure wrapped text and return detailed metrics.
     */
    function measureTextWrapped(ctx, text, maxWidth, options = {}) {
        const fontSize = options.fontSize || DEFAULT_OPTIONS.fontSize;
        const fontFamily = options.fontFamily || DEFAULT_OPTIONS.fontFamily;
        const lineSpacing = options.lineSpacing || DEFAULT_OPTIONS.lineSpacing;

        const savedFont = ctx.font;
        ctx.font = `${fontSize}px ${fontFamily}`;

        const lines = wrapText(ctx, text, maxWidth, fontSize, fontFamily);
        const lineHeight = fontSize * lineSpacing;
        const widths = lines.map(line => ctx.measureText(line).width);
        const totalHeight = lines.length * lineHeight;

        ctx.font = savedFont;
        return { lines, widths, lineHeight, totalHeight, maxWidth };
    }

    /**
     * Get bounding box of wrapped text at a given position.
     */
    function getTextBounds(ctx, text, options = {}) {
        const opts = { ...DEFAULT_OPTIONS, ...options };
        const fontSize = opts.fontSize;
        const fontFamily = opts.fontFamily;
        const padding = opts.padding;
        const w = opts.canvasWidth || 800;
        const h = opts.canvasHeight || 600;
        const maxWidth = w - padding * 2;

        const savedFont = ctx.font;
        ctx.font = `${fontSize}px ${fontFamily}`;

        const { lines, widths, lineHeight, totalHeight } = measureTextWrapped(ctx, text, maxWidth, opts);
        const maxLineWidth = Math.max(...widths, 0);

        let x, y;
        if (opts.position === 'custom') {
            x = (opts.posX || 0) / 100 * w;
            y = (opts.posY || 0) / 100 * h;
        } else if (opts.position === 'center') {
            x = (w - maxLineWidth) / 2;
            y = (h - totalHeight) / 2;
        } else if (opts.position === 'tile') {
            x = padding;
            y = 0;
        } else if (opts.position.includes('right')) {
            x = w - maxLineWidth - padding;
            y = padding;
        } else {
            x = padding;
            y = padding;
        }
        if (opts.position === 'top') {
            x = (w - maxLineWidth) / 2;
            y = padding;
        }
        if (opts.position === 'bottom') {
            x = (w - maxLineWidth) / 2;
            y = h - totalHeight - padding;
        }
        if (opts.position.includes('bottom') && opts.position !== 'bottom') {
            y = h - totalHeight - padding;
        }

        ctx.font = savedFont;
        return { x, y, w: maxLineWidth, h: totalHeight };
    }

    // ═══════════════════════════════════════════════════════════
    //  STANDARD RENDER (no distortion)
    // ═══════════════════════════════════════════════════════════

    function render(canvas, text, options = {}) {
        const opts = { ...DEFAULT_OPTIONS, ...options };
        if (!text || text.trim().length === 0) {
            throw new Error('No text to overlay');
        }

        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Cannot get 2D context');

        const w = canvas.width;
        const h = canvas.height;

        ctx.save();
        ctx.globalAlpha = opts.opacity / 100;
        ctx.fillStyle = opts.color;
        ctx.font = `${opts.fontSize}px ${opts.fontFamily}`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';

        if (opts.rotation !== 0) {
            ctx.translate(w / 2, h / 2);
            ctx.rotate((opts.rotation * Math.PI) / 180);
            ctx.translate(-w / 2, -h / 2);
        }

        const lines = wrapText(ctx, text, w - opts.padding * 2, opts.fontSize, opts.fontFamily);

        switch (opts.position) {
            case 'center': drawCentered(ctx, lines, w, h, opts); break;
            case 'tile': drawTiled(ctx, lines, w, h, opts); break;
            case 'custom': drawCustom(ctx, lines, w, h, opts); break;
            default: drawPositioned(ctx, lines, w, h, opts, opts.position); break;
        }

        ctx.restore();
    }

    function renderToDataUrl(imageElement, text, options = {}) {
        const canvas = document.createElement('canvas');
        canvas.width = imageElement.naturalWidth || imageElement.width;
        canvas.height = imageElement.naturalHeight || imageElement.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(imageElement, 0, 0);
        render(canvas, text, options);
        return canvas.toDataURL(options.outputFormat || 'image/png');
    }

    function reveal(canvas) {
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imageData.data;

        for (let i = 0; i < data.length; i += 4) {
            for (let c = 0; c < 3; c++) {
                let v = data[i + c];
                v = ((v / 255 - 0.5) * 2.5 + 0.5) * 255;
                v += 40;
                data[i + c] = Math.max(0, Math.min(255, Math.round(v)));
            }
        }

        ctx.putImageData(imageData, 0, 0);
    }

    // ═══════════════════════════════════════════════════════════
    //  ENHANCED RENDER WITH DISTORTION EFFECTS
    // ═══════════════════════════════════════════════════════════

    /**
     * Render text with distortion effects onto canvas.
     * Wave is per-CHARACTER (sinusoidal y-offset per letter).
     * Multicolor generates HSL palette from base color.
     */
    function renderWithEffects(canvas, text, options = {}) {
        const opts = { ...DEFAULT_OPTIONS, ...options };
        if (!text || text.trim().length === 0) {
            throw new Error('No text to overlay');
        }

        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Cannot get 2D context');

        const w = canvas.width;
        const h = canvas.height;
        const hasEffects = opts.waveAmplitude > 0 ||
                          opts.perLetterRotation > 0 ||
                          opts.perLetterSizeVariation > 0 ||
                          opts.perLetterSkewX > 0 ||
                          opts.noiseIntensity > 0 ||
                          opts.perLetterRandomOffset > 0 ||
                          opts.perLetterBoldRandom ||
                          opts.perLetterSpacingVariation > 0 ||
                          opts.randomColorPerLetter;

        // If no effects, use the standard renderer
        if (!hasEffects) {
            render(canvas, text, options);
            return;
        }

        // Generate color palette from base color if needed
        let colorPalette = null;
        if (opts.randomColorPerLetter) {
            colorPalette = generateColorPalette(opts.color || '#ffffff', 14);
        }

        // Use distortion-aware rendering
        const rng = seededRandom(12345); // deterministic for preview consistency
        const padding = opts.padding;

        ctx.save();
        ctx.globalAlpha = opts.opacity / 100;
        ctx.textBaseline = 'top';

        // Global rotation
        if (opts.rotation !== 0) {
            ctx.translate(w / 2, h / 2);
            ctx.rotate((opts.rotation * Math.PI) / 180);
            ctx.translate(-w / 2, -h / 2);
        }

        if (opts.position === 'tile') {
            renderDistortedTiled(ctx, text, w, h, opts, rng, colorPalette);
        } else {
            renderDistortedPositioned(ctx, text, w, h, opts, rng, colorPalette);
        }

        // Add noise overlay on text area
        if (opts.noiseIntensity > 0) {
            addNoiseOverlay(ctx, w, h, opts, rng);
        }

        ctx.restore();
    }

    /**
     * Render a single character with all distortion effects.
     * Returns the character's effective width (for position tracking).
     */
    function renderCharWithEffects(ctx, char, px, py, opts, rng, colorPalette, charIdx) {
        const fontSize = opts.fontSize;
        const fontFamily = opts.fontFamily;

        // Per-letter effects
        const letterRotation = opts.perLetterRotation > 0 ?
            (rng() - 0.5) * 2 * opts.perLetterRotation : 0;
        const letterSizeDelta = opts.perLetterSizeVariation > 0 ?
            (rng() - 0.5) * 2 * opts.perLetterSizeVariation : 0;
        const letterSkew = opts.perLetterSkewX > 0 ?
            (rng() - 0.5) * 2 * opts.perLetterSkewX : 0;
        const letterOffsetY = opts.perLetterRandomOffset > 0 ?
            (rng() - 0.5) * 2 * opts.perLetterRandomOffset : 0;
        const letterOffsetX = opts.perLetterRandomOffset > 0 ?
            (rng() - 0.5) * opts.perLetterRandomOffset * 0.5 : 0;

        // Per-CHARACTER wave distortion (not per-line!)
        const waveOffset = opts.waveAmplitude > 0 ?
            Math.sin(charIdx * 0.7 * (opts.waveFrequency || 1)) * opts.waveAmplitude : 0;

        const letterFontSize = Math.max(6, fontSize + letterSizeDelta);
        const isBold = opts.perLetterBoldRandom && rng() > 0.5;

        ctx.save();
        const drawX = px + letterOffsetX;
        const drawY = py + waveOffset + letterOffsetY;

        ctx.translate(drawX, drawY);
        if (letterRotation !== 0) ctx.rotate((letterRotation * Math.PI) / 180);
        if (letterSkew !== 0) ctx.transform(1, 0, letterSkew, 1, 0, 0);

        // Color — use HSL palette for multicolor
        if (colorPalette) {
            ctx.fillStyle = colorPalette[Math.floor(rng() * colorPalette.length)];
        } else {
            ctx.fillStyle = opts.color;
        }

        ctx.font = `${isBold ? 'bold ' : ''}${letterFontSize}px ${fontFamily}`;
        ctx.fillText(char, 0, 0);
        ctx.restore();

        // Return effective advance width
        const charW = measureCharWidth(ctx, char, fontSize, fontFamily);
        const spacing = opts.perLetterSpacingVariation > 0 ?
            rng() * opts.perLetterSpacingVariation : 0;
        return charW * (letterFontSize / fontSize) + spacing;
    }

    function renderDistortedPositioned(ctx, text, w, h, opts, rng, colorPalette) {
        const fontSize = opts.fontSize;
        const fontFamily = opts.fontFamily;
        const lineSpacing = opts.lineSpacing;
        const padding = opts.padding;
        const maxWidth = w - padding * 2;
        const lineHeight = fontSize * lineSpacing;

        const lines = wrapText(ctx, text, maxWidth, fontSize, fontFamily);
        const totalHeight = lines.length * lineHeight;

        let baseX, baseY;
        if (opts.position === 'custom') {
            baseX = (opts.posX || 0) / 100 * w;
            baseY = (opts.posY || 0) / 100 * h;
        } else if (opts.position === 'center') {
            ctx.font = `${fontSize}px ${fontFamily}`;
            const maxW = Math.max(...lines.map(l => ctx.measureText(l).width), 0);
            baseX = (w - maxW) / 2;
            baseY = (h - totalHeight) / 2;
        } else if (opts.position === 'top') {
            ctx.font = `${fontSize}px ${fontFamily}`;
            const maxW = Math.max(...lines.map(l => ctx.measureText(l).width), 0);
            baseX = (w - maxW) / 2;
            baseY = padding;
        } else if (opts.position === 'bottom') {
            ctx.font = `${fontSize}px ${fontFamily}`;
            const maxW = Math.max(...lines.map(l => ctx.measureText(l).width), 0);
            baseX = (w - maxW) / 2;
            baseY = h - totalHeight - padding;
        } else if (opts.position.includes('right')) {
            ctx.font = `${fontSize}px ${fontFamily}`;
            const maxW = Math.max(...lines.map(l => ctx.measureText(l).width), 0);
            baseX = w - maxW - padding;
            baseY = opts.position.includes('bottom') ? h - totalHeight - padding : padding;
        } else {
            baseX = padding;
            baseY = opts.position.includes('bottom') ? h - totalHeight - padding : padding;
        }

        // Clamp to image bounds
        baseX = Math.max(0, Math.min(w - padding, baseX));
        baseY = Math.max(0, Math.min(h - padding, baseY));

        ctx.textAlign = 'left';

        // Track global character index for wave effect continuity across lines
        let globalCharIdx = 0;

        for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
            const line = lines[lineIdx];
            if (!line) { globalCharIdx++; continue; }

            const lineY = baseY + lineIdx * lineHeight;
            let charX = baseX;

            for (let charIdx = 0; charIdx < line.length; charIdx++) {
                // Check if we've exceeded image bounds
                if (charX > w - padding) break;

                const char = line[charIdx];
                const advance = renderCharWithEffects(
                    ctx, char, charX, lineY, opts, rng, colorPalette, globalCharIdx
                );
                charX += advance;
                globalCharIdx++;
            }
            globalCharIdx++; // newline character
        }
    }

    function renderDistortedTiled(ctx, text, w, h, opts, rng, colorPalette) {
        const fontSize = opts.fontSize;
        const fontFamily = opts.fontFamily;
        const lineSpacing = opts.lineSpacing;
        const padding = opts.padding;
        const maxWidth = w - padding * 2;
        const lineHeight = fontSize * lineSpacing;

        const lines = wrapText(ctx, text, maxWidth, fontSize, fontFamily);
        const blockHeight = lines.length * lineHeight + lineHeight;

        let y = -lineHeight;
        while (y < h + blockHeight) {
            let globalCharIdx = 0;
            for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
                const line = lines[lineIdx];
                if (!line) { globalCharIdx++; continue; }
                const ly = y + lineIdx * lineHeight;
                if (ly < -lineHeight || ly > h + lineHeight) { globalCharIdx += line.length + 1; continue; }

                let charX = padding;
                for (let charIdx = 0; charIdx < line.length; charIdx++) {
                    if (charX > w - padding) break;
                    const char = line[charIdx];
                    const advance = renderCharWithEffects(
                        ctx, char, charX, ly, opts, rng, colorPalette, globalCharIdx
                    );
                    charX += advance;
                    globalCharIdx++;
                }
                globalCharIdx++; // newline
            }
            y += blockHeight;
        }
    }

    function addNoiseOverlay(ctx, w, h, opts, rng) {
        const intensity = opts.noiseIntensity || 0;
        if (intensity <= 0) return;

        const imageData = ctx.getImageData(0, 0, w, h);
        const data = imageData.data;
        const noiseVal = intensity;

        for (let i = 0; i < data.length; i += 4) {
            const noise = (rng() - 0.5) * 2 * noiseVal;
            data[i] = Math.max(0, Math.min(255, data[i] + noise));
            data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + noise));
            data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + noise));
        }

        ctx.putImageData(imageData, 0, 0);
    }

    function measureCharWidth(ctx, char, fontSize, fontFamily) {
        const saved = ctx.font;
        ctx.font = `${fontSize}px ${fontFamily}`;
        const w = ctx.measureText(char).width;
        ctx.font = saved;
        return w;
    }

    // ═══════════════════════════════════════════════════════════
    //  BUBBLE PRESET RENDERING
    // ═══════════════════════════════════════════════════════════

    /**
     * Render text inside a message bubble (for screenshot-style generation).
     * Uses preset styles or custom bubble options.
     */
    function renderBubble(canvas, text, options = {}) {
        const opts = { ...DEFAULT_OPTIONS, ...options };

        // Apply preset if specified
        let preset = null;
        if (opts.bubblePreset && BUBBLE_PRESETS[opts.bubblePreset]) {
            preset = BUBBLE_PRESETS[opts.bubblePreset];
        }

        const bgColor = opts.bubbleBgColor || (preset ? preset.bubbleBgColor : '#2AABEE');
        const borderColor = opts.bubbleBorderColor || (preset ? preset.bubbleBorderColor : null);
        const borderRadius = opts.bubbleBorderRadius || (preset ? preset.bubbleBorderRadius : 18);
        const bubblePadding = opts.bubblePadding || (preset ? preset.bubblePadding : 12);
        const maxBubbleWidthFrac = opts.bubbleMaxWidth || (preset ? preset.bubbleMaxWidth : 0.7);
        const align = opts.bubbleAlign || (preset ? preset.bubbleAlign : 'right');
        const showTail = opts.bubbleTail !== false && (preset ? preset.bubbleTail : true);

        const textColor = opts.color || (preset ? preset.color : '#ffffff');
        const fontSize = opts.fontSize || (preset ? preset.fontSize : 15);
        const fontFamily = opts.fontFamily || (preset ? preset.fontFamily : 'Arial, sans-serif');
        const lineSpacing = opts.lineSpacing || (preset ? preset.lineSpacing : 1.35);
        const opacity = opts.opacity || (preset ? preset.opacity : 100);

        if (!text || text.trim().length === 0) {
            throw new Error('No text to overlay');
        }

        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Cannot get 2D context');

        const w = canvas.width;
        const h = canvas.height;

        // Calculate bubble dimensions
        const maxTextWidth = w * maxBubbleWidthFrac - bubblePadding * 2;
        const effectiveMaxTextWidth = Math.max(100, maxTextWidth);

        ctx.save();
        ctx.font = `${fontSize}px ${fontFamily}`;
        ctx.textBaseline = 'top';

        // Wrap text to fit bubble
        const lines = wrapText(ctx, text, effectiveMaxTextWidth, fontSize, fontFamily);
        const lineHeight = fontSize * lineSpacing;

        // Measure actual text block width
        ctx.font = `${fontSize}px ${fontFamily}`;
        const lineWidths = lines.map(l => ctx.measureText(l).width);
        const maxLineWidth = Math.max(...lineWidths, 0);

        // Text block dimensions
        const textBlockW = maxLineWidth;
        const textBlockH = lines.length * lineHeight;

        // Bubble dimensions
        const bubbleW = textBlockW + bubblePadding * 2;
        const bubbleH = textBlockH + bubblePadding * 2;

        // Bubble position — centered vertically, aligned horizontally
        const margin = 24;
        let bubbleX;
        if (align === 'right') {
            bubbleX = w - bubbleW - margin;
        } else {
            bubbleX = margin;
        }
        const bubbleY = Math.max(margin, (h - bubbleH) / 2);

        // Draw bubble background
        ctx.globalAlpha = 1; // bubble is fully opaque
        drawRoundedRect(ctx, bubbleX, bubbleY, bubbleW, bubbleH, borderRadius);
        ctx.fillStyle = bgColor;
        ctx.fill();

        // Draw border if specified
        if (borderColor) {
            ctx.strokeStyle = borderColor;
            ctx.lineWidth = 1;
            ctx.stroke();
        }

        // Draw tail
        if (showTail) {
            ctx.beginPath();
            const tailSize = 8;
            if (align === 'right') {
                // Tail on right side
                ctx.moveTo(bubbleX + bubbleW - borderRadius, bubbleY + bubbleH);
                ctx.lineTo(bubbleX + bubbleW + tailSize, bubbleY + bubbleH + tailSize);
                ctx.lineTo(bubbleX + bubbleW - tailSize * 2, bubbleY + bubbleH);
            } else {
                // Tail on left side
                ctx.moveTo(bubbleX + borderRadius, bubbleY + bubbleH);
                ctx.lineTo(bubbleX - tailSize, bubbleY + bubbleH + tailSize);
                ctx.lineTo(bubbleX + tailSize * 2, bubbleY + bubbleH);
            }
            ctx.fillStyle = bgColor;
            ctx.fill();
        }

        // Draw text inside bubble
        ctx.globalAlpha = opacity / 100;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';

        // Check if distortion effects are active
        const hasBubbleEffects = opts.waveAmplitude > 0 ||
            opts.perLetterRotation > 0 ||
            opts.perLetterSizeVariation > 0 ||
            opts.perLetterSkewX > 0 ||
            opts.noiseIntensity > 0 ||
            opts.perLetterRandomOffset > 0 ||
            opts.perLetterBoldRandom ||
            opts.perLetterSpacingVariation > 0 ||
            opts.randomColorPerLetter;

        if (hasBubbleEffects) {
            // Per-character rendering with effects inside bubble
            let bubbleColorPalette = null;
            if (opts.randomColorPerLetter) {
                bubbleColorPalette = generateColorPalette(textColor, 14);
            }
            const bubbleRng = seededRandom(12345);

            // Merge bubble text settings with distortion options
            const charOpts = { ...opts, color: textColor, fontSize: fontSize, fontFamily: fontFamily };
            const textX = bubbleX + bubblePadding;
            const textY = bubbleY + bubblePadding;

            let globalCharIdx = 0;
            for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
                const line = lines[lineIdx];
                if (!line) { globalCharIdx++; continue; }

                const lineY = textY + lineIdx * lineHeight;
                let charX = textX;

                for (let charIdx = 0; charIdx < line.length; charIdx++) {
                    if (charX > bubbleX + bubbleW - bubblePadding) break;

                    const ch = line[charIdx];
                    const advance = renderCharWithEffects(
                        ctx, ch, charX, lineY, charOpts, bubbleRng, bubbleColorPalette, globalCharIdx
                    );
                    charX += advance;
                    globalCharIdx++;
                }
                globalCharIdx++; // newline character
            }

            // Apply noise overlay if requested (limited to bubble area)
            if (opts.noiseIntensity > 0) {
                const noiseRng = seededRandom(54321);
                const bubbleImgData = ctx.getImageData(
                    Math.max(0, Math.round(bubbleX)),
                    Math.max(0, Math.round(bubbleY)),
                    Math.min(Math.round(bubbleW), w),
                    Math.min(Math.round(bubbleH), h)
                );
                const noiseVal = opts.noiseIntensity;
                const nd = bubbleImgData.data;
                for (let i = 0; i < nd.length; i += 4) {
                    const noise = (noiseRng() - 0.5) * 2 * noiseVal;
                    nd[i] = Math.max(0, Math.min(255, nd[i] + noise));
                    nd[i + 1] = Math.max(0, Math.min(255, nd[i + 1] + noise));
                    nd[i + 2] = Math.max(0, Math.min(255, nd[i + 2] + noise));
                }
                ctx.putImageData(bubbleImgData, Math.max(0, Math.round(bubbleX)), Math.max(0, Math.round(bubbleY)));
            }
        } else {
            // Plain text rendering (original behavior)
            ctx.fillStyle = textColor;
            ctx.font = `${fontSize}px ${fontFamily}`;

            for (let i = 0; i < lines.length; i++) {
                ctx.fillText(lines[i], bubbleX + bubblePadding, bubbleY + bubblePadding + i * lineHeight);
            }
        }

        ctx.restore();

        // Return bubble bounds for positioning info
        return { x: bubbleX, y: bubbleY, w: bubbleW, h: bubbleH };
    }

    /**
     * Draw a rounded rectangle path.
     */
    function drawRoundedRect(ctx, x, y, w, h, r) {
        r = Math.min(r, w / 2, h / 2);
        r = Math.max(0, r);
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        ctx.lineTo(x + w, y + h - r);
        ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        ctx.lineTo(x + r, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath();
    }

    /**
     * Auto-fit text within a bounding box by reducing font size.
     * Returns the effective font size that fits.
     */
    function autoFitText(ctx, text, maxWidth, maxHeight, fontFamily, startSize, lineSpacing) {
        let size = startSize;
        while (size > 8) {
            const lines = wrapText(ctx, text, maxWidth, size, fontFamily);
            const totalHeight = lines.length * size * lineSpacing;
            if (lines.every(l => ctx.measureText(l).width <= maxWidth) && totalHeight <= maxHeight) {
                return size;
            }
            size -= 1;
        }
        return Math.max(8, size);
    }

    // ─── Standard draw helpers ──────────────────────────────

    function drawCentered(ctx, lines, w, h, opts) {
        const lineHeight = opts.fontSize * opts.lineSpacing;
        const totalHeight = lines.length * lineHeight;
        const startY = Math.max(0, (h - totalHeight) / 2);

        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        for (let i = 0; i < lines.length; i++) {
            const y = startY + i * lineHeight + lineHeight / 2;
            ctx.fillText(lines[i], w / 2, y, w - opts.padding * 2);
        }
    }

    function drawTiled(ctx, lines, w, h, opts) {
        const lineHeight = opts.fontSize * opts.lineSpacing;
        const blockHeight = lines.length * lineHeight + lineHeight;
        const startY = -opts.fontSize;

        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';

        let y = startY;
        while (y < h + blockHeight) {
            for (let i = 0; i < lines.length; i++) {
                const ly = y + i * lineHeight;
                if (ly > -lineHeight && ly < h + lineHeight) {
                    ctx.fillText(lines[i], opts.padding, ly, w - opts.padding * 2);
                }
            }
            y += blockHeight;
        }
    }

    function drawPositioned(ctx, lines, w, h, opts, position) {
        const lineHeight = opts.fontSize * opts.lineSpacing;
        const totalHeight = lines.length * lineHeight;
        const p = opts.padding;

        let x = p;
        let y = p;

        if (position.includes('right')) {
            ctx.textAlign = 'right';
            x = w - p;
        } else if (position.includes('bottom')) {
            y = h - totalHeight - p;
        }
        if (position === 'top' || position === 'center-top') {
            ctx.textAlign = 'center';
            x = w / 2;
        }
        if (position === 'bottom') {
            ctx.textAlign = 'center';
            x = w / 2;
        }

        ctx.textBaseline = 'top';

        for (let i = 0; i < lines.length; i++) {
            ctx.fillText(lines[i], x, y + i * lineHeight, w - p * 2);
        }
    }

    function drawCustom(ctx, lines, w, h, opts) {
        const lineHeight = opts.fontSize * opts.lineSpacing;
        const posX = (opts.posX || 0) / 100 * w;
        const posY = (opts.posY || 0) / 100 * h;

        ctx.textBaseline = 'top';
        ctx.textAlign = 'left';

        for (let i = 0; i < lines.length; i++) {
            ctx.fillText(lines[i], posX, posY + i * lineHeight, w - posX - opts.padding);
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  MESSENGER SCREENSHOT BACKGROUND (no text, no bubble)
    // ═══════════════════════════════════════════════════════════

    /**
     * Render a realistic messenger screenshot background.
     * Does NOT include text or bubble — just the UI chrome (header, background, etc.).
     * Text + bubble will be rendered separately via renderBubble().
     *
     * @param {HTMLCanvasElement} canvas
     * @param {string} presetName - 'telegram' | 'whatsapp' | 'imessage' | 'discord' | 'sms'
     */
    function renderMessengerScreenshot(canvas, presetName) {
        const STYLES = {
            telegram: {
                bg: '#0E1621',
                headerBg: '#17212B',
                headerAccent: '#2AABEE',
                textColor: '#ffffff',
                mutedColor: '#6C7883',
                timeColor: '#6C7883',
                statusBg: '#17212B',
                statusText: '#ffffff',
                avatarLetter: 'С',
                chatName: 'Сообщения',
                onlineText: 'в сети',
            },
            whatsapp: {
                bg: '#0B141A',
                headerBg: '#1F2C34',
                headerAccent: '#25D366',
                textColor: '#E9EDEF',
                mutedColor: '#8696A0',
                timeColor: '#8696A0',
                statusBg: '#1F2C34',
                statusText: '#E9EDEF',
                avatarLetter: 'С',
                chatName: 'Сообщения',
                onlineText: 'в сети',
            },
            imessage: {
                bg: '#F2F2F7',
                headerBg: '#F2F2F7',
                headerAccent: '#007AFF',
                textColor: '#000000',
                mutedColor: '#8E8E93',
                timeColor: '#8E8E93',
                statusBg: '#F2F2F7',
                statusText: '#000000',
                avatarLetter: 'С',
                chatName: 'Сообщения',
                onlineText: '',
            },
            discord: {
                bg: '#313338',
                headerBg: '#2B2D31',
                headerAccent: '#5865F2',
                textColor: '#DBDEE1',
                mutedColor: '#949BA4',
                timeColor: '#949BA4',
                statusBg: '#2B2D31',
                statusText: '#DBDEE1',
                avatarLetter: 'С',
                chatName: 'Сообщения',
                onlineText: 'онлайн',
            },
            sms: {
                bg: '#F2F2F7',
                headerBg: '#EFEFF4',
                headerAccent: '#007AFF',
                textColor: '#000000',
                mutedColor: '#8E8E93',
                timeColor: '#8E8E93',
                statusBg: '#EFEFF4',
                statusText: '#000000',
                avatarLetter: 'С',
                chatName: 'Сообщения',
                onlineText: '',
            },
        };

        const style = STYLES[presetName] || STYLES.telegram;
        const ctx = canvas.getContext('2d');
        const w = canvas.width;
        const h = canvas.height;

        // Scale factor for consistent UI elements
        const scale = Math.min(w / 800, h / 600);
        const px = (v) => Math.round(v * scale);

        // ── Background ──
        ctx.fillStyle = style.bg;
        ctx.fillRect(0, 0, w, h);

        // ── Background texture/pattern ──
        ctx.save();
        ctx.globalAlpha = 0.03;
        ctx.strokeStyle = presetName === 'imessage' || presetName === 'sms' ? '#000000' : '#ffffff';
        ctx.lineWidth = 1;
        for (let i = -h; i < w + h; i += Math.max(4, px(4))) {
            ctx.beginPath();
            ctx.moveTo(i, 0);
            ctx.lineTo(i - h * 0.6, h);
            ctx.stroke();
        }
        ctx.globalAlpha = 0.015;
        ctx.fillStyle = presetName === 'imessage' || presetName === 'sms' ? '#000000' : '#ffffff';
        for (let i = 0; i < 40; i++) {
            const cx = Math.random() * w;
            const cy = Math.random() * h;
            const r = Math.random() * px(120) + px(30);
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();

        // ── Status bar ──
        const statusBarH = px(28);
        ctx.fillStyle = style.statusBg;
        ctx.fillRect(0, 0, w, statusBarH);

        ctx.fillStyle = style.statusText;
        ctx.font = `bold ${px(12)}px -apple-system, Arial, sans-serif`;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'center';
        const now = new Date();
        const timeStr = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
        ctx.fillText(timeStr, w / 2, statusBarH / 2);

        // Battery icon (simple rect)
        const battW = px(22);
        const battH = px(10);
        const battX = w - px(16) - battW;
        const battY = (statusBarH - battH) / 2;
        ctx.strokeStyle = style.statusText;
        ctx.lineWidth = px(1);
        ctx.strokeRect(battX, battY, battW, battH);
        ctx.fillStyle = style.statusText;
        ctx.fillRect(battX + px(2), battY + px(2), battW - px(5), battH - px(4));
        ctx.fillRect(battX + battW, battY + px(3), px(2), battH - px(6));

        // ── Header bar ──
        const headerH = px(52);
        const headerY = statusBarH;
        ctx.fillStyle = style.headerBg;
        ctx.fillRect(0, headerY, w, headerH);

        // Separator line
        ctx.fillStyle = style.mutedColor;
        ctx.globalAlpha = 0.15;
        ctx.fillRect(0, headerY + headerH, w, px(1));
        ctx.globalAlpha = 1;

        // Back arrow
        ctx.fillStyle = style.headerAccent;
        ctx.font = `${px(18)}px Arial`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText('‹', px(8), headerY + headerH / 2);

        // Avatar circle
        const avatarR = px(18);
        const avatarCX = px(44);
        const avatarCY = headerY + headerH / 2;
        ctx.beginPath();
        ctx.arc(avatarCX, avatarCY, avatarR, 0, Math.PI * 2);
        ctx.fillStyle = style.headerAccent;
        ctx.fill();
        // Avatar letter
        ctx.fillStyle = '#ffffff';
        ctx.font = `bold ${px(16)}px Arial`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(style.avatarLetter, avatarCX, avatarCY + 1);

        // Chat name
        ctx.fillStyle = style.textColor;
        ctx.font = `600 ${px(15)}px -apple-system, Arial, sans-serif`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(style.chatName, px(72), headerY + headerH / 2 - px(7));

        // Online status text
        if (style.onlineText) {
            ctx.fillStyle = style.headerAccent;
            ctx.font = `${px(11)}px -apple-system, Arial, sans-serif`;
            ctx.fillText(style.onlineText, px(72), headerY + headerH / 2 + px(9));
        }

        // Header right icons (call + menu)
        ctx.fillStyle = style.headerAccent;
        ctx.font = `${px(16)}px Arial`;
        ctx.textAlign = 'right';
        ctx.fillText('⋯', w - px(12), headerY + headerH / 2);
    }

    // Public API
    return {
        render,
        renderToDataUrl,
        renderWithEffects,
        reveal,
        getTextBounds,
        measureTextWrapped,
        wrapText,
        renderBubble,
        renderMessengerScreenshot,
        renderCharWithEffects,
        generateColorPalette,
        autoFitText,
        BUBBLE_PRESETS,
        DEFAULT_OPTIONS,
    };
})();

window.TextOverlay = TextOverlay;
