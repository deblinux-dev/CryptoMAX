/**
 * Code Steganography Channel — v2
 *
 * Encodes data in procedurally generated, realistic code files
 * (Python, TypeScript, Go, Rust, CSS).
 *
 * Each language-specific tag produces a complete code file with exactly 8 hex
 * constants (0xXXXXXXXX), each carrying 32 bits.  Total capacity per tag:
 * 8 × 32 = 256 bits = 32 bytes.
 *
 * Tags: [steg-code-python], [steg-code-typescript], [steg-code-go],
 *       [steg-code-rust], [steg-code-css]
 *
 * Detection: distinctive multi-line header patterns — NO markers.
 */

// ─── Vocabulary ────────────────────────────────────────────────────────────────

const LANGUAGES = ['python', 'typescript', 'go', 'rust', 'css'];

const CODE_CLASS_NOUNS = [
    'Session', 'Config', 'Data', 'Metrics', 'Auth', 'Transaction',
    'Network', 'Cache', 'Query', 'Render', 'User', 'System',
    'Process', 'Event', 'Stream', 'Log', 'Message', 'Worker',
    'Service', 'Handler', 'Pipeline', 'Gateway', 'Broker',
    'Scheduler', 'Connector', 'Validator', 'Encoder', 'Decoder',
    'Serializer', 'Dispatcher', 'Registry', 'Provider', 'Resolver',
    'Adapter', 'Middleware', 'Controller', 'Repository', 'Facade',
];

const CODE_CLASS_SUFFIXES = [
    'Manager', 'Parser', 'Validator', 'Collector', 'Service', 'Handler',
    'Adapter', 'Controller', 'Builder', 'Engine', 'Provider', 'Factory',
    'Worker', 'Listener',
];

const CODE_VAR_NAMES = [
    'mask', 'seed', 'factor', 'base_limit', 'threshold', 'multiplier',
    'offset', 'padding', 'magic_bytes', 'checksum', 'alpha', 'beta',
    'gamma', 'delta', 'epsilon', 'flags', 'mode', 'limit', 'capacity',
    'buffer_size', 'chunk_count', 'max_retries', 'timeout', 'batch_size',
    'window', 'interval', 'retry_delay', 'backoff', 'shard_id',
    'partition_key', 'generation', 'epoch', 'nonce', 'salt',
];

const CODE_METHOD_VERBS = [
    'initialize', 'process', 'calculate', 'verify', 'update', 'flush',
    'parse', 'get', 'set', 'handle', 'validate', 'extract',
    'transform', 'load', 'compute', 'dispatch',
];

const CODE_METHOD_NOUNS = [
    'Buffer', 'Hash', 'Signature', 'State', 'Data', 'Payload',
    'Status', 'Timeout', 'Request', 'Response', 'Connection', 'Stream',
    'Event', 'Task', 'Metrics', 'Context',
];

const CSS_SELECTORS = [
    'container', 'wrapper', 'layout', 'card', 'panel', 'box',
    'modal', 'dialog', 'overlay', 'btn-primary', 'btn-secondary',
    'button', 'link', 'nav', 'header', 'footer', 'sidebar',
    'content', 'main', 'section', 'article', 'form-group',
    'input-field', 'dropdown', 'tooltip', 'badge', 'tag',
    'alert', 'toast', 'progress', 'slider', 'carousel',
    'accordion', 'tab-panel', 'table-responsive', 'media-object',
    'thumbnail', 'caption', 'jumbotron', 'well', 'page-header',
    'hero', 'banner', 'cta', 'pricing-card', 'feature-block',
    'testimonial', 'avatar', 'icon-box', 'stat-card', 'divider',
];

// ─── Helper functions ──────────────────────────────────────────────────────────

function codeRandomChoice(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

/** Pick *count* unique elements from *arr*. */
function codeRandomPick(arr, count) {
    const pool = [...arr];
    const result = [];
    for (let i = 0; i < count && pool.length > 0; i++) {
        const idx = Math.floor(Math.random() * pool.length);
        result.push(pool[idx]);
        pool.splice(idx, 1);
    }
    return result;
}

/** Format a 0‥2³²−1 integer as 0x + 8 uppercase hex digits. */
function codeToHex8(value) {
    return '0x' + value.toString(16).toUpperCase().padStart(8, '0');
}

/** snake_case → PascalCase (e.g. base_limit → BaseLimit) */
function snakeToPascal(s) {
    return s.split('_').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('');
}

/** snake_case → camelCase (e.g. base_limit → baseLimit) */
function snakeToCamel(s) {
    return s.split('_').map((p, i) => i === 0 ? p : p.charAt(0).toUpperCase() + p.slice(1)).join('');
}

/** snake_case → kebab-case (e.g. base_limit → base-limit) */
function snakeToKebab(s) {
    return s.replace(/_/g, '-');
}

// ─── Detection header / footer configurations ──────────────────────────────────

/**
 * Each entry: { language, headerRegex, footerRegex }
 *
 * headerRegex — multi-line pattern that uniquely identifies a generated block.
 * footerRegex — short pattern near the end of the block (used to find block end).
 */
const HEADER_CONFIGS = [
    {
        language: 'python',
        headerRegex: /import os\nimport sys\nimport time\nimport hashlib\nimport json\nimport logging/g,
        footerRegex: /sys\.exit\(0\)/g,
    },
    {
        language: 'typescript',
        headerRegex: /import \* as crypto from 'crypto';\nimport \* as fs from 'fs';\nimport \{ EventEmitter \} from 'events';/g,
        footerRegex: /require\.main === module/g,
    },
    {
        language: 'go',
        headerRegex: /package main\n\nimport \(\n\t"fmt"\n\t"time"/g,
        footerRegex: /fmt\.Println\("Daemon is running\.\.\."\)/g,
    },
    {
        language: 'rust',
        headerRegex: /use std::collections::HashMap;\nuse std::sync::Arc;\nuse std::time::Duration;/g,
        footerRegex: /println!\("System initialized\."\)/g,
    },
    {
        language: 'css',
        headerRegex: /:root \{\n    --[a-z][a-z0-9_-]*: 0x[0-9a-fA-F]{8};/g,
        footerRegex: null,   // handled specially
    },
];

// ─── Code generators (produce full, realistic files with exactly 8 hex consts) ─

function generatePythonCode(classNames, varNames, methodNames, hex) {
    const c1 = classNames[0], c2 = classNames[1];
    const m1 = methodNames[0], m2 = methodNames[1];
    return [
        'import os',
        'import sys',
        'import time',
        'import hashlib',
        'import json',
        'import logging',
        '',
        'logger = logging.getLogger(__name__)',
        '',
        `class ${c1}:`,
        `    def __init__(self):`,
        `        self.${varNames[0]} = ${hex[0]}`,
        `        self.${varNames[1]} = ${hex[1]}`,
        '',
        `    def ${m1}(self, payload=None):`,
        `        local_${varNames[2]} = ${hex[2]}`,
        `        local_${varNames[3]} = ${hex[3]}`,
        `        return local_${varNames[2]} ^ local_${varNames[3]}`,
        '',
        `class ${c2}:`,
        `    def __init__(self):`,
        `        self.${varNames[4]} = ${hex[4]}`,
        `        self.${varNames[5]} = ${hex[5]}`,
        '',
        `    def ${m2}(self, data=None):`,
        `        local_${varNames[6]} = ${hex[6]}`,
        `        local_${varNames[7]} = ${hex[7]}`,
        `        return local_${varNames[6]} ^ local_${varNames[7]}`,
        '',
        'if __name__ == "__main__":',
        '    logging.basicConfig(level=logging.INFO)',
        '    logger.info("Service initialized and ready.")',
        '    sys.exit(0)',
        '',
    ].join('\n');
}

function generateTypeScriptCode(classNames, varNames, methodNames, hex) {
    const c1 = classNames[0], c2 = classNames[1];
    const v1a = snakeToCamel(varNames[0]), v1b = snakeToCamel(varNames[1]);
    const v2a = snakeToCamel(varNames[2]), v2b = snakeToCamel(varNames[3]);
    const v3a = snakeToCamel(varNames[4]), v3b = snakeToCamel(varNames[5]);
    const v4a = snakeToCamel(varNames[6]), v4b = snakeToCamel(varNames[7]);
    const m1 = snakeToCamel(methodNames[0]);
    const m2 = snakeToCamel(methodNames[1]);
    return [
        "import * as crypto from 'crypto';",
        "import * as fs from 'fs';",
        "import { EventEmitter } from 'events';",
        '',
        `export class ${c1} extends EventEmitter {`,
        `    private readonly ${v1a}: number = ${hex[0]};`,
        `    private readonly ${v1b}: number = ${hex[1]};`,
        '',
        `    public ${m1}(payload?: any): number {`,
        `        const ${v2a} = ${hex[2]};`,
        `        const ${v2b} = ${hex[3]};`,
        `        return ${v2a} ^ ${v2b};`,
        '    }',
        '}',
        '',
        `export class ${c2} extends EventEmitter {`,
        `    private readonly ${v3a}: number = ${hex[4]};`,
        `    private readonly ${v3b}: number = ${hex[5]};`,
        '',
        `    public ${m2}(data?: any): number {`,
        `        const ${v4a} = ${hex[6]};`,
        `        const ${v4b} = ${hex[7]};`,
        `        return ${v4a} ^ ${v4b};`,
        '    }',
        '}',
        '',
        "if (require.main === module) {",
        '    console.log("Service bootstrap completed.");',
        '}',
        '',
    ].join('\n');
}

function generateGoCode(classNames, varNames, methodNames, hex) {
    const s1 = classNames[0], s2 = classNames[1];
    const f1a = snakeToPascal(varNames[0]), f1b = snakeToPascal(varNames[1]);
    const f2a = snakeToPascal(varNames[2]), f2b = snakeToPascal(varNames[3]);
    const f3a = snakeToPascal(varNames[4]), f3b = snakeToPascal(varNames[5]);
    const f4a = snakeToPascal(varNames[6]), f4b = snakeToPascal(varNames[7]);
    const m1 = snakeToPascal(methodNames[0]);
    const m2 = snakeToPascal(methodNames[1]);
    const l1a = snakeToCamel(varNames[2]), l1b = snakeToCamel(varNames[3]);
    const l2a = snakeToCamel(varNames[6]), l2b = snakeToCamel(varNames[7]);
    return [
        'package main',
        '',
        'import (',
        '\t"fmt"',
        '\t"time"',
        '\t"crypto/sha256"',
        '\t"encoding/json"',
        ')',
        '',
        `type ${s1} struct {`,
        `\t${f1a} uint32`,
        `\t${f1b} uint32`,
        '}',
        '',
        `func New${s1}() *${s1} {`,
        `\treturn &${s1}{`,
        `\t\t${f1a}: ${hex[0]},`,
        `\t\t${f1b}: ${hex[1]},`,
        '\t}',
        '}',
        '',
        `func (s *${s1}) ${m1}(data []byte) uint32 {`,
        `\tvar ${l1a} uint32 = ${hex[2]}`,
        `\tvar ${l1b} uint32 = ${hex[3]}`,
        `\treturn ${l1a} ^ ${l1b}`,
        '}',
        '',
        `type ${s2} struct {`,
        `\t${f3a} uint32`,
        `\t${f3b} uint32`,
        '}',
        '',
        `func New${s2}() *${s2} {`,
        `\treturn &${s2}{`,
        `\t\t${f3a}: ${hex[4]},`,
        `\t\t${f3b}: ${hex[5]},`,
        '\t}',
        '}',
        '',
        `func (s *${s2}) ${m2}(buf []byte) uint32 {`,
        `\tvar ${l2a} uint32 = ${hex[6]}`,
        `\tvar ${l2b} uint32 = ${hex[7]}`,
        `\treturn ${l2a} ^ ${l2b}`,
        '}',
        '',
        'func main() {',
        '\tfmt.Println("Daemon is running...")',
        '}',
        '',
    ].join('\n');
}

function generateRustCode(classNames, varNames, methodNames, hex) {
    const s1 = classNames[0], s2 = classNames[1];
    const m1 = methodNames[0], m2 = methodNames[1];
    return [
        'use std::collections::HashMap;',
        'use std::sync::Arc;',
        'use std::time::Duration;',
        '',
        `pub struct ${s1} {`,
        `    pub ${varNames[0]}: u32,`,
        `    pub ${varNames[1]}: u32,`,
        '}',
        '',
        `impl ${s1} {`,
        '    pub fn new() -> Self {',
        '        Self {',
        `            ${varNames[0]}: ${hex[0]},`,
        `            ${varNames[1]}: ${hex[1]},`,
        '        }',
        '    }',
        '',
        `    pub fn ${m1}(&mut self, _buf: &[u8]) -> u32 {`,
        `        let ${varNames[2]}: u32 = ${hex[2]};`,
        `        let ${varNames[3]}: u32 = ${hex[3]};`,
        `        ${varNames[2]} ^ ${varNames[3]}`,
        '    }',
        '}',
        '',
        `pub struct ${s2} {`,
        `    pub ${varNames[4]}: u32,`,
        `    pub ${varNames[5]}: u32,`,
        '}',
        '',
        `impl ${s2} {`,
        '    pub fn new() -> Self {',
        '        Self {',
        `            ${varNames[4]}: ${hex[4]},`,
        `            ${varNames[5]}: ${hex[5]},`,
        '        }',
        '    }',
        '',
        `    pub fn ${m2}(&mut self, _data: &[u8]) -> u32 {`,
        `        let ${varNames[6]}: u32 = ${hex[6]};`,
        `        let ${varNames[7]}: u32 = ${hex[7]};`,
        `        ${varNames[6]} ^ ${varNames[7]}`,
        '    }',
        '}',
        '',
        'fn main() {',
        '    println!("System initialized.");',
        '}',
        '',
    ].join('\n');
}

function generateCSSCode(varNames, hex, selectors) {
    const sel1 = selectors[0], sel2 = selectors[1], sel3 = selectors[2];
    return [
        ':root {',
        `    --${snakeToKebab(varNames[0])}: ${hex[0]};`,
        `    --${snakeToKebab(varNames[1])}: ${hex[1]};`,
        '}',
        '',
        `.${sel1} {`,
        `    --${snakeToKebab(varNames[2])}: ${hex[2]};`,
        `    --${snakeToKebab(varNames[3])}: ${hex[3]};`,
        '}',
        '',
        `.${sel2} {`,
        `    --${snakeToKebab(varNames[4])}: ${hex[4]};`,
        `    --${snakeToKebab(varNames[5])}: ${hex[5]};`,
        '}',
        '',
        `.${sel3} {`,
        `    --${snakeToKebab(varNames[6])}: ${hex[6]};`,
        `    --${snakeToKebab(varNames[7])}: ${hex[7]};`,
        '}',
        '',
    ].join('\n');
}

// ─── Channel class ─────────────────────────────────────────────────────────────

export class CodeStegoChannel {
    constructor() {
        this.name = 'code-stego';
        this.loaded = true;
        this._isTagBased = true;
        this.TAG_REGEX = /\[steg-code-(python|typescript|go|rust|css)\]/g;
        this._selfTest();
    }

    // ─── Self-test ──────────────────────────────────────────────────────────

    _selfTest() {
        const testValues = [
            0x12345678, 0xDEADBEEF, 0xCAFEBABE, 0x00000000,
            0xFFFFFFFF, 0x00FF00FF, 0xFF00FF00, 0x87654321,
        ];

        let allPassed = true;
        for (const lang of LANGUAGES) {
            try {
                const code = this._generateCode(lang, testValues);
                const hexMatches = [...code.matchAll(/0x([0-9a-fA-F]{8})/gi)];
                if (hexMatches.length !== 8) {
                    console.error(
                        `[code-stego] Self-test FAILED (${lang}): ` +
                        `expected 8 hex constants, got ${hexMatches.length}`
                    );
                    allPassed = false;
                    continue;
                }
                const decoded = hexMatches.map(m => parseInt(m[1], 16));
                for (let i = 0; i < 8; i++) {
                    if (decoded[i] !== testValues[i]) {
                        console.error(
                            `[code-stego] Self-test FAILED (${lang}): ` +
                            `hex[${i}] expected ${testValues[i]}, got ${decoded[i]}`
                        );
                        allPassed = false;
                        break;
                    }
                }
            } catch (e) {
                console.error(`[code-stego] Self-test ERROR (${lang}):`, e);
                allPassed = false;
            }
        }

        // Round-trip test: encode tags then decode
        try {
            const tagText = '[steg-code-python] some text [steg-code-rust] more text';
            const cap = this.analyzeCapacity(tagText);
            // 2 tags × 8 bases = 16 indices
            if (cap.bases.length !== 16) {
                console.error(
                    `[code-stego] Self-test FAILED (capacity): ` +
                    `expected 16 bases, got ${cap.bases.length}`
                );
                allPassed = false;
            } else {
                const indices = [];
                for (let i = 0; i < 16; i++) indices.push((i * 2654435761) >>> 0);
                const encoded = this.encode(tagText, indices);
                const decoded = this.decode(encoded);
                if (decoded.length !== 16) {
                    console.error(
                        `[code-stego] Self-test FAILED (round-trip length): ` +
                        `expected 16 indices, got ${decoded.length}`
                    );
                    allPassed = false;
                } else {
                    for (let i = 0; i < 16; i++) {
                        if (decoded[i] !== indices[i]) {
                            console.error(
                                `[code-stego] Self-test FAILED (round-trip value): ` +
                                `index[${i}] expected ${indices[i]}, got ${decoded[i]}`
                            );
                            allPassed = false;
                            break;
                        }
                    }
                }
            }
        } catch (e) {
            console.error('[code-stego] Self-test ERROR (round-trip):', e);
            allPassed = false;
        }

        if (allPassed) {
            console.log('[code-stego] Self-test PASSED ✓');
        }
    }

    // ─── Code generation ────────────────────────────────────────────────────

    /**
     * Generate a full code block for *language* embedding the 8 values as hex
     * constants (0xXXXXXXXX format).
     */
    _generateCode(language, values) {
        const hex = values.map(v => codeToHex8(v % 4294967296));

        // Pick randomised identifiers
        const classNames = codeRandomPick(CODE_CLASS_NOUNS, 2)
            .map(n => n + codeRandomChoice(CODE_CLASS_SUFFIXES));
        // Ensure class names differ
        while (classNames[0] === classNames[1]) {
            classNames[1] = codeRandomPick(CODE_CLASS_NOUNS, 1)[0] +
                codeRandomChoice(CODE_CLASS_SUFFIXES);
        }

        const varNames = codeRandomPick(CODE_VAR_NAMES, 8);

        const methodNames = [
            codeRandomChoice(CODE_METHOD_VERBS).toLowerCase() + '_' +
            codeRandomChoice(CODE_METHOD_NOUNS).toLowerCase(),
            codeRandomChoice(CODE_METHOD_VERBS).toLowerCase() + '_' +
            codeRandomChoice(CODE_METHOD_NOUNS).toLowerCase(),
        ];
        while (methodNames[0] === methodNames[1]) {
            methodNames[1] = codeRandomChoice(CODE_METHOD_VERBS).toLowerCase() + '_' +
                codeRandomChoice(CODE_METHOD_NOUNS).toLowerCase();
        }

        switch (language) {
            case 'python':
                return generatePythonCode(classNames, varNames, methodNames, hex);
            case 'typescript':
                return generateTypeScriptCode(classNames, varNames, methodNames, hex);
            case 'go':
                return generateGoCode(classNames, varNames, methodNames, hex);
            case 'rust':
                return generateRustCode(classNames, varNames, methodNames, hex);
            case 'css': {
                const sel = codeRandomPick(CSS_SELECTORS, 3);
                return generateCSSCode(varNames, hex, sel);
            }
            default:
                return generatePythonCode(classNames, varNames, methodNames, hex);
        }
    }

    // ─── Block detection ────────────────────────────────────────────────────

    /**
     * Locate generated code blocks already present in *text* by matching
     * the distinctive multi-line header patterns.  Returns an array of
     * { start, end, language, isTag: false } sorted by position.
     */
    _findCodeBlocks(text) {
        const blocks = [];

        for (const cfg of HEADER_CONFIGS) {
            cfg.headerRegex.lastIndex = 0;
            let m;
            while ((m = cfg.headerRegex.exec(text)) !== null) {
                const startPos = m.index;
                let endPos;

                if (cfg.footerRegex) {
                    cfg.footerRegex.lastIndex = startPos + m[0].length;
                    const footer = cfg.footerRegex.exec(text);
                    if (!footer || footer.index > startPos + 5000) continue;
                    // Block end = end of line containing footer
                    endPos = text.indexOf('\n', footer.index);
                    if (endPos === -1) endPos = text.length;
                    else endPos += 1; // include the \n
                } else {
                    // CSS — find last hex constant then closing brace
                    const hexSearch = /0x[0-9a-fA-F]{8}/g;
                    hexSearch.lastIndex = startPos;
                    let lastHex = null;
                    let hm;
                    while ((hm = hexSearch.exec(text)) !== null) {
                        if (hm.index > startPos + 3000) break;
                        lastHex = hm;
                    }
                    if (!lastHex) continue;
                    // Find the closing brace after the last hex constant
                    const closeBrace = text.indexOf('}', lastHex.index);
                    if (closeBrace === -1 || closeBrace > startPos + 3000) continue;
                    endPos = text.indexOf('\n', closeBrace);
                    if (endPos === -1) endPos = text.length;
                    else endPos += 1;
                }

                blocks.push({ start: startPos, end: endPos, language: cfg.language, isTag: false });
            }
        }

        // De-duplicate overlapping blocks
        blocks.sort((a, b) => a.start - b.start || a.end - b.end);
        const deduped = [];
        for (const b of blocks) {
            if (deduped.length === 0 || b.start >= deduped[deduped.length - 1].end) {
                deduped.push(b);
            }
        }

        return deduped;
    }

    // ─── Unified match finder (tags + generated blocks) ─────────────────────

    /**
     * Returns all steganographic positions in *text*:
     *  - tags:   { start, end, isTag: true,  language, tag }
     *  - blocks: { start, end, isTag: false, language }
     * Sorted by position.
     */
    _findMatches(text) {
        const matches = [];

        // 1. Tags
        this.TAG_REGEX.lastIndex = 0;
        let m;
        while ((m = this.TAG_REGEX.exec(text)) !== null) {
            matches.push({
                start: m.index,
                end: m.index + m[0].length,
                isTag: true,
                language: m[1],
                tag: m[0],
            });
        }

        // 2. Generated code blocks
        const codeBlocks = this._findCodeBlocks(text);
        matches.push(...codeBlocks);

        // 3. Sort by position
        matches.sort((a, b) => a.start - b.start);

        return matches;
    }

    // ─── Channel API ────────────────────────────────────────────────────────

    analyzeCapacity(text) {
        if (!this.loaded) return { totalBits: 0, positions: [], bases: [] };

        const matches = this._findMatches(text);
        if (matches.length === 0) return { totalBits: 0, positions: [], bases: [] };

        const positions = [];
        const bases = [];

        for (const match of matches) {
            positions.push({
                index: match.start,
                length: match.end - match.start,
                type: 'code',
                word: match.isTag ? match.tag : `[steg-code-${match.language}]`,
            });
            // 8 hex constants per tag/block, each 32 bits
            for (let i = 0; i < 8; i++) {
                bases.push(4294967296);
            }
        }

        const totalBits = bases.reduce((s, b) => s + Math.log2(b), 0);
        return { totalBits, positions, bases };
    }

    encode(text, indices) {
        if (!this.loaded || indices.length === 0) return text;

        const matches = this._findMatches(text);
        if (matches.length === 0) return text;

        const replacements = [];
        let idx = 0;

        for (const match of matches) {
            if (idx + 8 > indices.length) break;

            const values = [];
            for (let i = 0; i < 8; i++) {
                values.push(indices[idx + i] % 4294967296);
            }

            const code = this._generateCode(match.language, values);
            replacements.push({ start: match.start, end: match.end, replacement: code });
            idx += 8;
        }

        // Apply in reverse order to preserve positions
        let result = text;
        for (let i = replacements.length - 1; i >= 0; i--) {
            const r = replacements[i];
            result = result.slice(0, r.start) + r.replacement + result.slice(r.end);
        }

        return result;
    }

    decode(stegoText) {
        if (!this.loaded) return [];

        const codeBlocks = this._findCodeBlocks(stegoText);
        const indices = [];

        for (const block of codeBlocks) {
            const blockText = stegoText.substring(block.start, block.end);
            const hexMatches = [...blockText.matchAll(/0x([0-9a-fA-F]{8})/gi)];
            for (const hm of hexMatches) {
                indices.push(parseInt(hm[1], 16));
            }
        }

        return indices;
    }

    getSpans(text) {
        const matches = this._findMatches(text);
        return matches.map(m => ({ start: m.start, end: m.end }));
    }

    getStats() {
        return {
            name: this.name,
            loaded: this.loaded,
            aliases: LANGUAGES.map(l => `[steg-code-${l}]`),
            dims: Array(8).fill(4294967296),
            bitsPerTag: '256',
            languages: LANGUAGES,
            capacityPerTag: '256 bits (32 bytes)',
            hexFormat: '0xXXXXXXXX (8 uppercase hex digits)',
        };
    }
}

export default CodeStegoChannel;
