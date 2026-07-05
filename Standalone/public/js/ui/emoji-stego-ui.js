/**
 * Emojistego UI Handler — popup for creating/inserting stego emojis
 *
 * The popup allows users to:
 * 1. Pick a base emoji (via the shared emoji-mart picker or keyboard)
 * 2. Insert a minimal stego-emoji (signature marker) into the carrier text
 *
 * The stego-emoji is just another channel in the mixed-radix system.
 * The encoder automatically determines how much data each channel carries.
 * The UI only creates a signature marker (baseEmoji + U+E0100) that
 * the engine detects and fills with the appropriate portion of encrypted data.
 */

import { EmojiStego } from '../channels/emoji-stego.js';

;(function initEmojiStegoUI() {
    'use strict';

    const popup       = document.getElementById('emojiStegoPopup');
    const btnOpen      = document.getElementById('btn-emoji-stego');
    const btnClose     = document.getElementById('btnCloseEmojiStego');
    const capacityEl   = document.getElementById('emoji-stego-capacity');
    const previewEl    = document.getElementById('emoji-stego-preview');
    const btnPickEmoji = document.getElementById('btnPickStegoEmoji');
    const btnCreate    = document.getElementById('btnCreateStegoEmoji');

    if (!popup || !btnOpen) return;

    let currentBaseEmoji = '😊';

    // ── Open / Close ──────────────────────────────────────────────
    function openPopup() {
        popup.style.display = '';
        updateCapacity();
    }

    function closePopup() {
        popup.style.display = 'none';
    }

    btnOpen.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openPopup();
    });

    btnClose?.addEventListener('click', (e) => {
        e.stopPropagation();
        closePopup();
    });

    // Close on Escape
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && popup.style.display !== 'none') {
            closePopup();
        }
    });

    // Note: popup does NOT close on outside click — only via X button or
    // "Вставить стего-эмодзи" button. This prevents the popup from vanishing
    // when the user interacts with the emoji-mart picker inside it.

    // ── Capacity info ──────────────────────────────────────────
    function updateCapacity() {
        if (!capacityEl) return;
        // Each stego-emoji adds 256 bytes (2048 bits) to the carrier's capacity.
        // The encoder distributes data across all channels proportionally.
        capacityEl.textContent = '💡 +2048 бит (256 байт) к ёмкости носителя';
        capacityEl.style.color = 'var(--cm-text-secondary, #9ca3af)';
    }

    // ── Pick base emoji ───────────────────────────────────────────
    // When the user clicks "pick emoji", open the shared emoji-mart picker
    // in centered mode for reliable positioning.
    let emojiPickMode = false;

    btnPickEmoji?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        emojiPickMode = true;

        // Open picker centered on screen
        if (window._openEmojiPickerCentered) {
            window._openEmojiPickerCentered();
        } else {
            // Fallback: prompt user to paste an emoji
            const customEmoji = prompt('Вставьте эмодзи-носитель (или введите с клавиатуры):', currentBaseEmoji);
            if (customEmoji) {
                setBaseEmoji(customEmoji.trim());
            }
        }
    });

    // Listen for emoji-mart selections in pick mode
    window._emojiStegoPickCallback = function(native) {
        if (emojiPickMode && native) {
            setBaseEmoji(native);
            emojiPickMode = false;
            return true; // consumed
        }
        return false;
    };

    function setBaseEmoji(emoji) {
        if (!emoji) return;
        // Extract the first grapheme cluster
        const graphemes = EmojiStego._iterateGraphemes(emoji);
        if (graphemes.length > 0) {
            currentBaseEmoji = graphemes[0];
            previewEl.textContent = currentBaseEmoji;
        }
    }

    // ── Mobile keyboard emoji input ───────────────────────────────
    const keyboardInput = document.getElementById('emoji-stego-keyboard-input');
    if (keyboardInput) {
        keyboardInput.addEventListener('input', () => {
            const val = keyboardInput.value;
            if (!val) return;
            // Extract the first grapheme cluster
            const graphemes = EmojiStego._iterateGraphemes(val);
            if (graphemes.length > 0) {
                setBaseEmoji(graphemes[0]);
            }
            // Clear input after extracting
            keyboardInput.value = '';
        });
    }

    // ── Create stego emoji (signature marker) ─────────────────────
    // Creates a minimal stego-emoji with just a signature marker (U+E0100 IVS).
    // The encoder will detect this signature and fill the emoji with the
    // appropriate portion of encrypted data during the encoding process.
    // Each stego-emoji acts as a 256-byte channel in the mixed-radix system.
    btnCreate?.addEventListener('click', () => {
        try {
            // Create minimal signature: base emoji + single IVS marker
            // \u{E0100} is an Ideographic Variation Selector never used in normal
            // emoji rendering — it serves as a reliable stego signature.
            // IMPORTANT: must use \u{E0100} (curly braces), NOT \uE0100,
            // because \u only takes 4 hex digits → would produce U+E010 + "0".
            const stegoEmoji = currentBaseEmoji + '\u{E0100}';

            // Auto-insert into carrier textarea at cursor position
            const carrierTextarea = document.getElementById('carrier-text');
            if (carrierTextarea) {
                const start = carrierTextarea.selectionStart;
                const end = carrierTextarea.selectionEnd;
                const value = carrierTextarea.value;
                carrierTextarea.value = value.slice(0, start) + stegoEmoji + value.slice(end);
                const newPos = start + stegoEmoji.length;
                carrierTextarea.selectionStart = carrierTextarea.selectionEnd = newPos;
                carrierTextarea.focus();
                carrierTextarea.dispatchEvent(new Event('input', { bubbles: true }));
            }

            closePopup();
        } catch (e) {
            alert('❌ ' + e.message);
        }
    });

})();
