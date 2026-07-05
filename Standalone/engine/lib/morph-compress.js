/**
 * MorphCompress v1 — Morphological text compression for Russian (JavaScript)
 *
 * Binary-compatible port of MorphCompress v2 (Python). Uses Az.Morph for
 * morphological analysis and pako (optional) for raw Deflate compression.
 *
 * Binary format (v2) — matches Python exactly:
 *   [1B header]:  bits 7-5 = mode, bits 4-0 = reserved
 *     mode 0 (0b000): passthrough  - raw UTF-8 bytes
 *     mode 1 (0b001): dict         - morphological word table + data stream
 *     mode 2 (0b010): dict+deflate - raw Deflate wrapping mode 1 payload
 *
 *   mode 1 payload:
 *     [varint wordTableSize]
 *     [wordTableEntry x N]:
 *       [1B type]
 *       type=0 (dict):    varint(lemmaLen) [lemmaLen bytes UTF-8] varint(formIdx)
 *       type=1 (literal):  varint(wordLen)  [wordLen bytes UTF-8]
 *     [dataStream]:
 *       0b0_CC_NNNNN  = dict ref  (CC=case 0-2, NNNNN=tableIdx 0-30)
 *       0b10LLLLLL    = literal    (LLLLLL+1 raw bytes follow)
 *       0b110_NNNN    = extended dict ref (varint follows: index - 31)
 *
 * Dependencies (loaded via script tags before this file):
 *   - Az.Morph  (az.js + az.morph.js) - morphological analyzer
 *   - pako      (pako.min.js)         - raw Deflate (optional)
 *
 * Usage:
 *   Az.Morph.init(function() {
 *     var mc = new MorphCompress();
 *     var compressed = mc.compress("Привет, мир! Как дела?");
 *     var original = mc.decompress(compressed);
 *     console.log(mc.stats);
 *   });
 */
(function(global) {
  'use strict';

  // =====================================================================
  // Dependency checks
  // =====================================================================
  var _hasMorph = (typeof Az !== 'undefined' && typeof Az.Morph === 'function');
  var _hasPako  = (typeof pako !== 'undefined' && typeof pako.deflate === 'function');

  // =====================================================================
  // UTF-8 helpers
  // =====================================================================
  var _encoder = (typeof TextEncoder !== 'undefined') ? new TextEncoder() : null;
  var _decoder = (typeof TextDecoder !== 'undefined') ? new TextDecoder() : null;

  function utf8Encode(str) {
    if (_encoder) return _encoder.encode(str);
    // Manual fallback
    var bytes = [], i, code, hi, lo, cp;
    for (i = 0; i < str.length; i++) {
      code = str.charCodeAt(i);
      if (code < 0x80) {
        bytes.push(code);
      } else if (code < 0x800) {
        bytes.push(0xC0 | (code >> 6), 0x80 | (code & 0x3F));
      } else if (code >= 0xD800 && code <= 0xDBFF && i + 1 < str.length) {
        hi = code;
        lo = str.charCodeAt(++i);
        cp = ((hi - 0xD800) << 10) + (lo - 0xDC00) + 0x10000;
        bytes.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F),
                   0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
      } else {
        bytes.push(0xE0 | (code >> 12), 0x80 | ((code >> 6) & 0x3F), 0x80 | (code & 0x3F));
      }
    }
    return new Uint8Array(bytes);
  }

  function utf8Decode(bytes, offset, length) {
    if (_decoder) {
      var view = (bytes.subarray)
        ? bytes.subarray(offset, offset + length)
        : bytes.slice(offset, offset + length);
      return _decoder.decode(view);
    }
    // Manual fallback (best-effort)
    var s = '', i, b, b2, b3, b4, cp;
    for (i = offset; i < offset + length; i++) {
      b = bytes[i];
      if (b < 0x80) { s += String.fromCharCode(b); }
      else if (b < 0xE0) { b2 = bytes[++i]; s += String.fromCharCode(((b & 0x1F) << 6) | (b2 & 0x3F)); }
      else if (b < 0xF0) { b2 = bytes[++i]; b3 = bytes[++i]; cp = ((b & 0x0F) << 12) | ((b2 & 0x3F) << 6) | (b3 & 0x3F); s += String.fromCharCode(cp); }
      else { b2 = bytes[++i]; b3 = bytes[++i]; b4 = bytes[++i]; cp = ((b & 0x07) << 18) | ((b2 & 0x3F) << 12) | ((b3 & 0x3F) << 6) | (b4 & 0x3F); s += String.fromCharCode(0xD800 + ((cp - 0x10000) >> 10), 0xDC00 + ((cp - 0x10000) & 0x3FF)); }
    }
    return s;
  }

  // =====================================================================
  // Constants
  // =====================================================================
  var Mode = {
    PASSTHROUGH:   0,  // 0b000
    DICT:         1,   // 0b001
    DICT_DEFLATE: 2,   // 0b010
    DICT_BROTLI:  3    // 0b011
  };

  var MODE_NAMES = ['passthrough', 'dictionary', 'dictionary+deflate', 'dictionary+brotli'];

  // =====================================================================
  // Varint encoding / decoding
  // =====================================================================

  /**
   * Encode unsigned integer as varint bytes (array of byte values).
   */
  function encodeVarint(value) {
    if (value < 0) throw new Error('varint must be >= 0, got ' + value);
    var buf = [];
    while (value > 0x7F) {
      buf.push((value & 0x7F) | 0x80);
      value = value >>> 7;
    }
    buf.push(value & 0x7F);
    return buf;
  }

  /**
   * Decode varint from Uint8Array at offset.
   * Returns { value: number, offset: number }.
   */
  function decodeVarint(data, offset) {
    var result = 0, shift = 0, b;
    while (offset < data.length) {
      b = data[offset];
      result |= (b & 0x7F) << shift;
      offset += 1;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return { value: result, offset: offset };
  }

  /**
   * Number of bytes needed to encode value as varint.
   */
  function varintSize(value) {
    var s = 0;
    value = value >>> 0;
    while (value > 0) { s += 1; value = value >>> 7; }
    return Math.max(s, 1);
  }

  // =====================================================================
  // Tokenizer
  // =====================================================================

  /**
   * Split text into tokens: WORD (Cyrillic), LATIN, NUMBER, SPACE, OTHER.
   * Identical logic to Python tokenize().
   */
  function tokenize(text) {
    var tokens = [], i = 0, n = text.length, code, c2, start;
    while (i < n) {
      code = text.charCodeAt(i);

      // Cyrillic (0x0400-0x04FF, plus ё 0x0401, Ё 0x0451)
      if ((0x0400 <= code && code <= 0x04FF) || code === 0x0401 || code === 0x0451) {
        start = i;
        while (i < n) {
          c2 = text.charCodeAt(i);
          if ((0x0400 <= c2 && c2 <= 0x04FF) || c2 === 0x0401 || c2 === 0x0451) { i++; }
          else break;
        }
        tokens.push({ type: 'WORD', text: text.substring(start, i) });
      }
      // Latin (A-Z, a-z)
      else if ((0x41 <= code && code <= 0x5A) || (0x61 <= code && code <= 0x7A)) {
        start = i;
        while (i < n) {
          c2 = text.charCodeAt(i);
          if ((0x41 <= c2 && c2 <= 0x5A) || (0x61 <= c2 && c2 <= 0x7A)) { i++; }
          else break;
        }
        tokens.push({ type: 'LATIN', text: text.substring(start, i) });
      }
      // Number (digits, dots, commas within)
      else if (0x30 <= code && code <= 0x39) {
        start = i;
        while (i < n) {
          c2 = text.charCodeAt(i);
          if ((0x30 <= c2 && c2 <= 0x39) || c2 === 0x2C || c2 === 0x2E) { i++; }
          else break;
        }
        tokens.push({ type: 'NUMBER', text: text.substring(start, i) });
      }
      // Whitespace
      else if (code === 0x20 || code === 0x09 || code === 0x0A || code === 0x0D) {
        start = i;
        while (i < n) {
          c2 = text.charCodeAt(i);
          if (c2 === 0x20 || c2 === 0x09 || c2 === 0x0A || c2 === 0x0D) { i++; }
          else break;
        }
        tokens.push({ type: 'SPACE', text: text.substring(start, i) });
      }
      // Other (punctuation, symbols) — single character
      else {
        tokens.push({ type: 'OTHER', text: text.charAt(i) });
        i++;
      }
    }
    return tokens;
  }

  // =====================================================================
  // Case preservation
  // =====================================================================

  /** Normalize ё/Ё to е/Е for consistent comparison. */
  function normalizeEO(text) {
    return text.replace(/\u0451/g, '\u0435').replace(/\u0401/g, '\u0415');
  }

  /** Return 0=lower, 1=first_upper, 2=ALL_UPPER. */
  function getCaseFlag(word) {
    if (!word) return 0;
    var first = word.charAt(0);
    if (first !== first.toLowerCase()) {
      return (word === word.toUpperCase()) ? 2 : 1;
    }
    return 0;
  }

  /** Apply case flag to word. */
  function applyCase(word, flag) {
    if (flag === 0 || !word) return word;
    if (flag === 2) return word.toUpperCase();
    if (flag === 1) return word.charAt(0).toUpperCase() + word.substring(1).toLowerCase();
    return word;
  }

  // =====================================================================
  // Morphological analyzer (Az.Morph wrapper)
  // =====================================================================

  /**
   * Get the best DictionaryParse for a word from Az.Morph.
   * Returns DictionaryParse or null.
   */
  function getBestDictParse(word) {
    if (!_hasMorph) return null;
    try {
      var parses = Az.Morph(word);
      for (var j = 0; j < parses.length; j++) {
        if (parses[j].parser === 'Dictionary') {
          return parses[j];
        }
      }
    } catch (e) {
      // Az.Morph not initialized
    }
    return null;
  }

  /**
   * Analyze a word: get its lemma (normal form) and form_index.
   * Returns { word, lemma, formIndex, isKnown, score } or null.
   */
  function analyzeWord(word) {
    var dp = getBestDictParse(word);
    if (!dp || !dp.formCnt) return null;

    try {
      var norm = dp.normalize();
      if (!norm) return null;
      var lemma = norm.toString();
      if (!lemma) return null;

      return {
        word: word,
        lemma: lemma,
        formIndex: dp.formIdx,
        isKnown: true,
        score: dp.score
      };
    } catch (e) {
      return null;
    }
  }

  /**
   * Reconstruct a word form from its lemma and form_index using Az.Morph.
   * Falls back to returning the lemma if reconstruction fails.
   */
  function reconstructWord(lemma, formIndex) {
    if (!_hasMorph) return lemma;

    try {
      var dp = getBestDictParse(lemma);
      if (!dp || !dp.formCnt) return lemma;

      if (formIndex >= 0 && formIndex < dp.formCnt) {
        var form = dp.inflect(formIndex);
        if (form) {
          var w = form.toString();
          if (w) return w.toLowerCase();
        }
      }
    } catch (e) {
      // Fall through
    }
    return lemma;
  }

  // =====================================================================
  // Entry size estimation (for cost analysis during encoding)
  // =====================================================================

  function estimateEntrySize(entry) {
    if (entry.type === 0) {
      var lb = utf8Encode(entry.lemma);
      return 1 + varintSize(lb.length) + lb.length + varintSize(entry.formIndex);
    } else {
      var wb = utf8Encode(entry.literal);
      return 1 + varintSize(wb.length) + wb.length;
    }
  }

  // =====================================================================
  // Binary format: ENCODE (build dict payload)
  // =====================================================================

  /**
   * Build the intermediate dict payload (word table + data stream).
   * Only type=0 (dict, lemma+formIdx) and type=1 (literal) entries.
   * Returns { payload: Uint8Array, stats: Object }.
   */
  function buildDictPayload(text, textBytes, tokens) {
    // === Pass 1: analyze words, count frequencies ===
    var wordInfo = {};
    var dictHits = 0, dictMisses = 0, totalWords = 0;

    for (var ti = 0; ti < tokens.length; ti++) {
      var tok = tokens[ti];
      if (tok.type !== 'WORD') continue;
      totalWords++;

      var lower = tok.text.toLowerCase();
      if (!(lower in wordInfo)) {
        var analysis = analyzeWord(lower);
        var isKnown = (analysis !== null);
        wordInfo[lower] = {
          count: 0,
          lower: lower,
          caseFlag: getCaseFlag(tok.text),
          analysis: analysis,
          isKnown: isKnown
        };
        if (isKnown) { dictHits++; } else { dictMisses++; }
      }
      wordInfo[lower].count++;
    }

    // === Pass 2: build word table ===
    var wordTable = [];
    var wordToIndex = {};

    var lowerWords = Object.keys(wordInfo);
    for (var ki = 0; ki < lowerWords.length; ki++) {
      var lw = lowerWords[ki];
      var wi = wordInfo[lw];
      var wordBytesLen = utf8Encode(lw).length;

      var entry, dedupKey;

      if (wi.isKnown && wi.analysis) {
        var a = wi.analysis;
        dedupKey = 'D:' + a.lemma + ':' + a.formIndex;
        if (dedupKey in wordToIndex) continue;
        entry = {
          type: 0,
          lemma: a.lemma,
          formIndex: a.formIndex,
          caseFlag: wi.caseFlag,
          dedupKey: dedupKey
        };
      } else {
        dedupKey = 'L:' + lw;
        if (dedupKey in wordToIndex) continue;
        entry = {
          type: 1,
          literal: lw,
          caseFlag: wi.caseFlag,
          dedupKey: dedupKey
        };
      }

      // Cost analysis: only include if it saves bytes
      var entrySize = estimateEntrySize(entry);
      var refCost = wi.count;                          // 1 byte per occurrence
      var costInTable = entrySize + refCost;
      var costAsLiteral = wordBytesLen * wi.count + Math.min(wi.count, 1);

      if (costInTable <= costAsLiteral + 2) {
        wordToIndex[dedupKey] = wordTable.length;
        wordTable.push(entry);
      }
    }

    // === Pass 3: encode data stream ===
    var payload = [];

    // Word table size (varint)
    pushVarint(payload, wordTable.length);

    // Word table entries
    for (var ti2 = 0; ti2 < wordTable.length; ti2++) {
      var ent = wordTable[ti2];
      payload.push(ent.type);

      if (ent.type === 0) {
        // type=0: lemma string + form_index
        var lemmaB = utf8Encode(ent.lemma);
        pushVarint(payload, lemmaB.length);
        pushBytes(payload, lemmaB);
        pushVarint(payload, ent.formIndex);
      } else {
        // type=1: literal
        var litB = utf8Encode(ent.literal);
        pushVarint(payload, litB.length);
        pushBytes(payload, litB);
      }
    }

    // Data stream: dict refs + literal segments
    var nonDictBuf = [];

    for (var ti3 = 0; ti3 < tokens.length; ti3++) {
      var tok = tokens[ti3];

      if (tok.type === 'WORD') {
        var wLower = tok.text.toLowerCase();
        var cf = getCaseFlag(tok.text);
        var wi2 = wordInfo[wLower];

        var idx = -1;
        if (wi2 && wi2.isKnown && wi2.analysis) {
          var a2 = wi2.analysis;
          var dk = 'D:' + a2.lemma + ':' + a2.formIndex;
          if (dk in wordToIndex) { idx = wordToIndex[dk]; }
        }
        if (idx === -1) {
          var lk = 'L:' + wLower;
          if (lk in wordToIndex) { idx = wordToIndex[lk]; }
        }

        if (idx >= 0) {
          flushLiteralBuf(payload, nonDictBuf);
          var caseBits = cf << 5;
          if (idx <= 30) {
            payload.push(caseBits | idx);
          } else {
            payload.push(caseBits | 31);
            pushVarint(payload, idx - 31);
          }
          continue;
        }
      }

      // Non-dict token -> literal buffer
      var tokB = utf8Encode(tok.text);
      for (var j = 0; j < tokB.length; j++) {
        nonDictBuf.push(tokB[j]);
      }
    }

    flushLiteralBuf(payload, nonDictBuf);

    return {
      payload: new Uint8Array(payload),
      stats: {
        dictHits: dictHits,
        dictMisses: dictMisses,
        totalWords: totalWords,
        wordTableEntries: wordTable.length,
        useIdMode: false,
        reverseMapSize: 0
      }
    };
  }

  /** Append varint-encoded value to byte array. */
  function pushVarint(arr, value) {
    var vb = encodeVarint(value);
    for (var k = 0; k < vb.length; k++) arr.push(vb[k]);
  }

  /** Append Uint8Array values to byte array. */
  function pushBytes(arr, u8) {
    for (var k = 0; k < u8.length; k++) arr.push(u8[k]);
  }

  /**
   * Flush accumulated non-dict bytes as literal segments.
   * Each segment: 0b10LLLLLL header + up to 64 raw bytes.
   */
  function flushLiteralBuf(payload, nonDictBuf) {
    if (nonDictBuf.length === 0) return;
    var off = 0;
    while (off < nonDictBuf.length) {
      var chunk = Math.min(64, nonDictBuf.length - off);
      payload.push(0x80 | (chunk - 1));
      for (var j = 0; j < chunk; j++) {
        payload.push(nonDictBuf[off + j]);
      }
      off += chunk;
    }
    nonDictBuf.length = 0;
  }

  // =====================================================================
  // Binary format: DECODE (dict payload)
  // =====================================================================

  /**
   * Decode a dict payload back to a text string.
   */
  function decodeDictPayload(payload) {
    var offset = { v: 0 };
    offset.v = 0;

    // Helper to read from payload
    function readByte() { return payload[offset.v++]; }
    function readVarint() {
      var r = decodeVarint(payload, offset.v);
      offset.v = r.offset;
      return r.value;
    }

    // Read word table
    var wtSize = readVarint();
    var wordTable = [];

    for (var i = 0; i < wtSize; i++) {
      var entryType = readByte();

      if (entryType === 0) {
        // type=0: lemma string + form_index
        var lemmaLen = readVarint();
        var lemma = utf8Decode(payload, offset.v, lemmaLen);
        offset.v += lemmaLen;
        var formIdx = readVarint();
        wordTable.push({ type: 0, lemma: lemma, formIndex: formIdx });
      } else if (entryType === 2) {
        // type=2: lemma_id + form_index (requires ReverseMap)
        readVarint(); // lemma_id (skip)
        readVarint(); // form_index (skip)
        throw new Error('MorphCompress: type=2 entries require ReverseMap (not yet supported in JS port)');
      } else {
        // type=1: literal
        var wordLen = readVarint();
        var literal = utf8Decode(payload, offset.v, wordLen);
        offset.v += wordLen;
        wordTable.push({ type: 1, literal: literal });
      }
    }

    // Decode data stream -> build UTF-8 byte array
    var result = [];

    while (offset.v < payload.length) {
      var b = payload[offset.v++];

      if (!(b & 0x80)) {
        // Dict ref: 0b0_CC_IIIII
        var caseFlag = (b >> 5) & 0x03;
        var idx = b & 0x1F;

        if (idx === 31) {
          idx = readVarint() + 31;
        }

        if (idx < wordTable.length) {
          var entry = wordTable[idx];
          var word;
          if (entry.type === 0) {
            word = reconstructWord(entry.lemma, entry.formIndex);
          } else {
            word = entry.literal;
          }
          word = applyCase(word, caseFlag);
          var wb = utf8Encode(word);
          for (var j = 0; j < wb.length; j++) {
            result.push(wb[j]);
          }
        }
      } else if ((b & 0xC0) === 0x80) {
        // Literal segment: 0b10LLLLLL
        var count = (b & 0x3F) + 1;
        for (var j = 0; j < count; j++) {
          result.push(payload[offset.v++]);
        }
      } else {
        throw new Error('MorphCompress: Unsupported segment type: 0x' + ((b >>> 0).toString(16)));
      }
    }

    return utf8Decode(new Uint8Array(result), 0, result.length);
  }

  // =====================================================================
  // Deflate helpers
  // =====================================================================

  /** Raw Deflate (no zlib/gzip header), max compression via pako. */
  function tryDeflate(data) {
    if (!_hasPako) return null;
    try {
      return pako.deflate(data, { level: 9, raw: true });
    } catch (e) {
      return null;
    }
  }

  /** Inflate raw Deflate stream via pako. */
  function inflateDeflate(data) {
    if (!_hasPako) {
      throw new Error('MorphCompress: pako is required for deflate decompression');
    }
    try {
      return pako.inflate(data, { raw: true });
    } catch (e) {
      throw new Error('MorphCompress: Failed to inflate: ' + e.message);
    }
  }

  // =====================================================================
  // Header encoding / decoding
  // =====================================================================

  function encodeHeader(mode) {
    return (mode << 5) & 0xFF;
  }

  function decodeHeader(byte) {
    return (byte >> 5) & 0x07;
  }

  // =====================================================================
  // Stats object factory
  // =====================================================================

  function emptyStats() {
    return {
      originalBytes: 0,
      compressedBytes: 0,
      ratio: 0,
      modeUsed: '',
      modeRaw: 0,
      dictHits: 0,
      dictMisses: 0,
      totalWords: 0,
      wordTableEntries: 0,
      methodUsed: {},
      candidateSizes: {},
      deflateSaved: 0,
      deflateTimeMs: 0,
      brotliSaved: 0,
      brotliTimeMs: 0,
      useIdMode: false,
      reverseMapSize: 0
    };
  }

  // =====================================================================
  // MorphCompress class
  // =====================================================================

  /**
   * Morphological text compression for Russian.
   *
   * Uses Az.Morph to replace Russian words with compact (lemma, form_index)
   * references stored in a word table. Automatically tries raw Deflate
   * post-compression (if pako is loaded) and picks the smallest result.
   *
   * @constructor
   */
  function MorphCompress() {
    this._lastStats = emptyStats();
  }

  /**
   * Whether Az.Morph is available for morphological analysis.
   * @type {boolean}
   */
  Object.defineProperty(MorphCompress.prototype, 'morphAvailable', {
    get: function() { return _hasMorph; },
    enumerable: true
  });

  /**
   * Whether pako is available for Deflate compression.
   * @type {boolean}
   */
  Object.defineProperty(MorphCompress.prototype, 'pakoAvailable', {
    get: function() { return _hasPako; },
    enumerable: true
  });

  /**
   * Statistics from the last compress() call.
   * @type {Object}
   */
  Object.defineProperty(MorphCompress.prototype, 'stats', {
    get: function() { return this._lastStats; },
    enumerable: true
  });

  /**
   * Compress text to a Uint8Array. Picks the best mode automatically.
   *
   * @param {string} text - The text to compress.
   * @returns {Uint8Array} The compressed binary data.
   */
  MorphCompress.prototype.compress = function(text) {
    this._lastStats = emptyStats();

    if (!text) return new Uint8Array(0);

    var textBytes = utf8Encode(text);
    var tokens = tokenize(text);

    // Build dict payload
    var buildResult = buildDictPayload(text, textBytes, tokens);
    var dictPayload = buildResult.payload;
    var dpStats = buildResult.stats;

    // Try post-compression options
    var dictSize = 1 + dictPayload.length;
    var passthroughSize = 1 + textBytes.length;

    // Candidate: passthrough
    var bestName = 'passthrough';
    var bestSize = passthroughSize;
    var bestMode = Mode.PASSTHROUGH;
    var bestData = textBytes;

    // Candidate: dict
    if (dictSize < bestSize) {
      bestName = 'dict';
      bestSize = dictSize;
      bestMode = Mode.DICT;
      bestData = dictPayload;
    }

    // Candidate: dict+deflate (if pako available)
    var deflateResult = null;
    var deflateTime = 0;
    if (_hasPako) {
      var t0 = (typeof performance !== 'undefined') ? performance.now() : Date.now();
      deflateResult = tryDeflate(dictPayload);
      var t1 = (typeof performance !== 'undefined') ? performance.now() : Date.now();
      deflateTime = t1 - t0;

      if (deflateResult) {
        var deflateSize = 1 + deflateResult.length;
        if (deflateSize < bestSize) {
          bestName = 'deflate';
          bestSize = deflateSize;
          bestMode = Mode.DICT_DEFLATE;
          bestData = deflateResult;
        }
      }
    }

    // Build final output: [header byte] + [data]
    var output = new Uint8Array(1 + bestData.length);
    output[0] = encodeHeader(bestMode);
    output.set(bestData, 1);

    // Compute stats
    var deflateSaved = 0;
    if (deflateResult) {
      deflateSaved = dictSize - (1 + deflateResult.length);
    }

    var methodTypes = {};
    if (dpStats.dictHits > 0) {
      methodTypes['Morphological (dict_str)'] = dpStats.dictHits;
    }
    if (bestName === 'deflate') {
      methodTypes['Raw Deflate'] = 'applied (-' + deflateSaved + ' bytes)';
    }
    var saved = textBytes.length - output.length;
    methodTypes['Savings'] = saved + ' bytes';

    this._lastStats = {
      originalBytes: textBytes.length,
      compressedBytes: output.length,
      ratio: textBytes.length > 0 ? ((1 - output.length / textBytes.length) * 100) : 0,
      modeUsed: MODE_NAMES[bestMode] || bestName,
      modeRaw: bestMode,
      dictHits: dpStats.dictHits,
      dictMisses: dpStats.dictMisses,
      totalWords: dpStats.totalWords,
      wordTableEntries: dpStats.wordTableEntries,
      methodUsed: methodTypes,
      candidateSizes: {
        passthrough: passthroughSize,
        dict: dictSize,
        'dict+deflate': deflateResult ? (1 + deflateResult.length) : null
      },
      deflateSaved: deflateSaved,
      deflateTimeMs: deflateTime,
      brotliSaved: 0,
      brotliTimeMs: 0,
      useIdMode: false,
      reverseMapSize: 0
    };

    return output;
  };

  /**
   * Decompress binary data back to the original text.
   *
   * @param {Uint8Array|ArrayBuffer} data - The compressed binary data.
   * @returns {string} The decompressed text.
   */
  MorphCompress.prototype.decompress = function(data) {
    // Accept ArrayBuffer
    if (data instanceof ArrayBuffer) {
      data = new Uint8Array(data);
    }

    if (!data || data.length < 1) return '';

    var mode = decodeHeader(data[0]);
    var bodyLen = data.length - 1;
    var body = (data.subarray) ? data.subarray(1) : new Uint8Array(data.length - 1);
    // For non-Uint8Array, copy manually
    if (!data.subarray) {
      body = new Uint8Array(bodyLen);
      for (var i = 0; i < bodyLen; i++) body[i] = data[i + 1];
    }

    if (mode === Mode.PASSTHROUGH) {
      return utf8Decode(body, 0, body.length);
    }

    if (mode === Mode.DICT) {
      return decodeDictPayload(body);
    }

    if (mode === Mode.DICT_DEFLATE) {
      var inflated = inflateDeflate(body);
      return decodeDictPayload(inflated);
    }

    if (mode === Mode.DICT_BROTLI) {
      throw new Error('MorphCompress: Brotli decompression not supported in JS port (v1)');
    }

    throw new Error('MorphCompress: Unknown mode: ' + mode);
  };

  // =====================================================================
  // Exports
  // =====================================================================

  /**
   * @namespace MorphCompress
   * @global
   * @constructor
   */
  global.MorphCompress = MorphCompress;

  /**
   * Tokenizer function (exported for testing).
   * @param {string} text
   * @returns {Array<{type: string, text: string}>}
   */
  global.MorphCompress.tokenize = tokenize;

  /**
   * Varint utilities (exported for testing).
   */
  global.MorphCompress.encodeVarint = encodeVarint;
  global.MorphCompress.decodeVarint = decodeVarint;

  /**
   * Mode constants (exported for reference).
   */
  global.MorphCompress.Mode = Mode;

})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
