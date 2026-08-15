'use strict';

/* =========================================================
   Minimal self-contained QR code encoder (no dependencies).
   Supports byte-mode text, versions 1-6, error correction
   level M — plenty for encoding a short URL. Everything runs
   locally; nothing is sent anywhere to generate the code.
   ========================================================= */

const QR = (() => {
  // ---- Galois Field GF(256) tables, generated (not hand-transcribed) ----
  const EXP_TABLE = new Array(256);
  const LOG_TABLE = new Array(256);
  for (let i = 0; i < 8; i++) EXP_TABLE[i] = 1 << i;
  for (let i = 8; i < 256; i++) {
    EXP_TABLE[i] = EXP_TABLE[i - 4] ^ EXP_TABLE[i - 5] ^ EXP_TABLE[i - 6] ^ EXP_TABLE[i - 8];
  }
  for (let i = 0; i < 255; i++) LOG_TABLE[EXP_TABLE[i]] = i;

  function gexp(n) {
    while (n < 0) n += 255;
    while (n >= 256) n -= 255;
    return EXP_TABLE[n];
  }
  function glog(n) {
    return LOG_TABLE[n];
  }

  class Polynomial {
    constructor(num, shift) {
      let offset = 0;
      while (offset < num.length && num[offset] === 0) offset++;
      this.num = new Array(num.length - offset + (shift || 0));
      for (let i = 0; i < num.length - offset; i++) this.num[i] = num[i + offset];
      for (let i = 0; i < (shift || 0); i++) this.num[num.length - offset + i] = 0;
    }
    get(i) {
      return this.num[i];
    }
    get length() {
      return this.num.length;
    }
    multiply(e) {
      const num = new Array(this.length + e.length - 1).fill(0);
      for (let i = 0; i < this.length; i++) {
        for (let j = 0; j < e.length; j++) {
          num[i + j] ^= gexp(glog(this.get(i)) + glog(e.get(j)));
        }
      }
      return new Polynomial(num, 0);
    }
    mod(e) {
      if (this.length - e.length < 0) return this;
      const ratio = glog(this.get(0)) - glog(e.get(0));
      const num = this.num.slice();
      for (let i = 0; i < e.length; i++) {
        num[i] ^= gexp(glog(e.get(i)) + ratio);
      }
      return new Polynomial(num, 0).mod(e);
    }
  }

  function errorCorrectPolynomial(errorCorrectLength) {
    let a = new Polynomial([1], 0);
    for (let i = 0; i < errorCorrectLength; i++) {
      a = a.multiply(new Polynomial([1, gexp(i)], 0));
    }
    return a;
  }

  // ---- RS block table, error-correction level M only, versions 1-6 ----
  // Each row: groups of [blockCount, totalCodewordsPerBlock, dataCodewordsPerBlock]
  // (self-consistent: sum(blockCount*totalCodewordsPerBlock) == fixed total codewords for that version)
  const RS_BLOCK_M = {
    1: [[1, 26, 16]],
    2: [[1, 44, 28]],
    3: [[1, 70, 44]],
    4: [[2, 50, 32]],
    5: [[2, 67, 43]],
    6: [[4, 43, 27]]
  };

  // Alignment pattern coordinate list per version (versions 1-6 have at most one non-corner pattern)
  const ALIGNMENT_POSITIONS = {
    1: [],
    2: [6, 18],
    3: [6, 22],
    4: [6, 26],
    5: [6, 30],
    6: [6, 34]
  };

  const G15 = 0b10100110111;
  const G15_MASK = 0b101010000010010;
  const ERROR_CORRECT_LEVEL_M = 0; // per ISO 18004 format-info table: L=01 M=00 Q=11 H=10

  function bchDigitLength(data) {
    let digit = 0;
    while (data !== 0) {
      digit++;
      data >>>= 1;
    }
    return digit;
  }
  function bchTypeInfo(data) {
    let d = data << 10;
    while (bchDigitLength(d) - bchDigitLength(G15) >= 0) {
      d ^= G15 << (bchDigitLength(d) - bchDigitLength(G15));
    }
    return ((data << 10) | d) ^ G15_MASK;
  }

  function getMask(pattern, i, j) {
    switch (pattern) {
      case 0: return (i + j) % 2 === 0;
      case 1: return i % 2 === 0;
      case 2: return j % 3 === 0;
      case 3: return (i + j) % 3 === 0;
      case 4: return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0;
      case 5: return ((i * j) % 2) + ((i * j) % 3) === 0;
      case 6: return (((i * j) % 2) + ((i * j) % 3)) % 2 === 0;
      case 7: return (((i * j) % 3) + ((i + j) % 2)) % 2 === 0;
      default: return false;
    }
  }

  class BitBuffer {
    constructor() {
      this.buffer = [];
      this.length = 0;
    }
    put(num, length) {
      for (let i = 0; i < length; i++) {
        this.putBit(((num >>> (length - i - 1)) & 1) === 1);
      }
    }
    putBit(bit) {
      const bufIndex = Math.floor(this.length / 8);
      if (this.buffer.length <= bufIndex) this.buffer.push(0);
      if (bit) this.buffer[bufIndex] |= 0x80 >>> this.length % 8;
      this.length++;
    }
  }

  function createBytes(buffer, rsBlockGroups) {
    const blocks = [];
    rsBlockGroups.forEach(([count, totalCount, dataCount]) => {
      for (let i = 0; i < count; i++) blocks.push({ totalCount, dataCount });
    });

    let offset = 0;
    const dcdata = [];
    const ecdata = [];

    blocks.forEach((block) => {
      const dcCount = block.dataCount;
      const ecCount = block.totalCount - dcCount;
      const dc = new Array(dcCount);
      for (let i = 0; i < dcCount; i++) {
        dc[i] = 0xff & buffer.buffer[i + offset];
      }
      offset += dcCount;

      const rsPoly = errorCorrectPolynomial(ecCount);
      const rawPoly = new Polynomial(dc, rsPoly.length - 1);
      const modPoly = rawPoly.mod(rsPoly);
      const ec = new Array(rsPoly.length - 1);
      for (let i = 0; i < ec.length; i++) {
        const modIndex = i + modPoly.length - ec.length;
        ec[i] = modIndex >= 0 ? modPoly.get(modIndex) : 0;
      }
      dcdata.push(dc);
      ecdata.push(ec);
    });

    const totalCodeCount = blocks.reduce((sum, b) => sum + b.totalCount, 0);
    const data = new Array(totalCodeCount);
    let index = 0;
    const maxDc = Math.max(...dcdata.map((d) => d.length));
    for (let i = 0; i < maxDc; i++) {
      dcdata.forEach((dc) => {
        if (i < dc.length) data[index++] = dc[i];
      });
    }
    const maxEc = Math.max(...ecdata.map((e) => e.length));
    for (let i = 0; i < maxEc; i++) {
      ecdata.forEach((ec) => {
        if (i < ec.length) data[index++] = ec[i];
      });
    }
    return data;
  }

  function getLostPoint(modules, moduleCount) {
    let lostPoint = 0;

    // Rule 1: runs of 5+ same-color modules in a row/column
    for (let row = 0; row < moduleCount; row++) {
      for (let col = 0; col < moduleCount; col++) {
        let sameCount = 0;
        const dark = modules[row][col];
        for (let r = -1; r <= 1; r++) {
          if (row + r < 0 || moduleCount <= row + r) continue;
          for (let c = -1; c <= 1; c++) {
            if (col + c < 0 || moduleCount <= col + c) continue;
            if (r === 0 && c === 0) continue;
            if (dark === modules[row + r][col + c]) sameCount++;
          }
        }
        if (sameCount > 5) lostPoint += 3 + sameCount - 5;
      }
    }

    // Rule 2: 2x2 blocks of same color
    for (let row = 0; row < moduleCount - 1; row++) {
      for (let col = 0; col < moduleCount - 1; col++) {
        const c =
          (modules[row][col] ? 1 : 0) +
          (modules[row + 1][col] ? 1 : 0) +
          (modules[row][col + 1] ? 1 : 0) +
          (modules[row + 1][col + 1] ? 1 : 0);
        if (c === 0 || c === 4) lostPoint += 3;
      }
    }

    // Rule 3: finder-like 1:1:3:1:1 patterns
    for (let row = 0; row < moduleCount; row++) {
      for (let col = 0; col < moduleCount - 6; col++) {
        if (
          modules[row][col] &&
          !modules[row][col + 1] &&
          modules[row][col + 2] &&
          modules[row][col + 3] &&
          modules[row][col + 4] &&
          !modules[row][col + 5] &&
          modules[row][col + 6]
        ) {
          lostPoint += 40;
        }
      }
    }
    for (let col = 0; col < moduleCount; col++) {
      for (let row = 0; row < moduleCount - 6; row++) {
        if (
          modules[row][col] &&
          !modules[row + 1][col] &&
          modules[row + 2][col] &&
          modules[row + 3][col] &&
          modules[row + 4][col] &&
          !modules[row + 5][col] &&
          modules[row + 6][col]
        ) {
          lostPoint += 40;
        }
      }
    }

    // Rule 4: overall dark ratio deviation from 50%
    let darkCount = 0;
    for (let row = 0; row < moduleCount; row++) {
      for (let col = 0; col < moduleCount; col++) {
        if (modules[row][col]) darkCount++;
      }
    }
    const ratio = Math.abs((100 * darkCount) / moduleCount / moduleCount - 50) / 5;
    lostPoint += ratio * 10;

    return lostPoint;
  }

  function encode(text, version) {
    const bytes = Array.from(new TextEncoder().encode(text));
    const rsBlockGroups = RS_BLOCK_M[version];
    if (!rsBlockGroups) throw new Error('Unsupported QR version');

    const totalDataCount = rsBlockGroups.reduce((sum, [count, , dataCount]) => sum + count * dataCount, 0);

    const buffer = new BitBuffer();
    buffer.put(4, 4); // byte-mode indicator
    buffer.put(bytes.length, 8); // char count (8-bit indicator, valid for versions 1-9)
    bytes.forEach((b) => buffer.put(b, 8));

    const maxBits = totalDataCount * 8;
    if (buffer.length + 4 <= maxBits) buffer.put(0, 4); // terminator
    while (buffer.length % 8 !== 0) buffer.putBit(false);

    const padBytes = [0xec, 0x11];
    let padIndex = 0;
    while (buffer.length < maxBits) {
      buffer.put(padBytes[padIndex % 2], 8);
      padIndex++;
    }
    if (buffer.length > maxBits) throw new Error('Text too long for this QR version');

    const dataCodewords = createBytes(buffer, rsBlockGroups);
    const moduleCount = 17 + version * 4;

    // function-pattern reservation mask, then data placement, computed per candidate mask 0-7,
    // scored, and the lowest-penalty mask is kept.
    let best = null;
    for (let maskPattern = 0; maskPattern < 8; maskPattern++) {
      const modules = buildMatrix(moduleCount, version, dataCodewords, maskPattern);
      const score = getLostPoint(modules, moduleCount);
      if (!best || score < best.score) best = { modules, score };
    }
    return { modules: best.modules, moduleCount };
  }

  function buildMatrix(moduleCount, version, dataCodewords, maskPattern) {
    const modules = Array.from({ length: moduleCount }, () => new Array(moduleCount).fill(null));
    const reserved = Array.from({ length: moduleCount }, () => new Array(moduleCount).fill(false));

    function setFn(row, col, dark) {
      modules[row][col] = dark;
      reserved[row][col] = true;
    }

    function placeFinder(row, col) {
      for (let r = -1; r <= 7; r++) {
        if (row + r <= -1 || moduleCount <= row + r) continue;
        for (let c = -1; c <= 7; c++) {
          if (col + c <= -1 || moduleCount <= col + c) continue;
          const dark =
            (0 <= r && r <= 6 && (c === 0 || c === 6)) ||
            (0 <= c && c <= 6 && (r === 0 || r === 6)) ||
            (2 <= r && r <= 4 && 2 <= c && c <= 4);
          setFn(row + r, col + c, dark);
        }
      }
    }
    placeFinder(0, 0);
    placeFinder(moduleCount - 7, 0);
    placeFinder(0, moduleCount - 7);

    // alignment pattern(s)
    const positions = ALIGNMENT_POSITIONS[version];
    positions.forEach((row) => {
      positions.forEach((col) => {
        if (modules[row][col] !== null) return; // overlaps a finder area already set
        for (let r = -2; r <= 2; r++) {
          for (let c = -2; c <= 2; c++) {
            const dark = r === -2 || r === 2 || c === -2 || c === 2 || (r === 0 && c === 0);
            setFn(row + r, col + c, dark);
          }
        }
      });
    });

    // timing patterns
    for (let i = 8; i < moduleCount - 8; i++) {
      if (modules[i][6] === null) setFn(i, 6, i % 2 === 0);
      if (modules[6][i] === null) setFn(6, i, i % 2 === 0);
    }

    // format info placeholders (reserve now, fill in below) + fixed dark module
    for (let i = 0; i < 9; i++) {
      if (i !== 6) {
        reserved[8][i] = true;
        reserved[i][8] = true;
      }
    }
    for (let i = 0; i < 8; i++) {
      reserved[8][moduleCount - 1 - i] = true;
      reserved[moduleCount - 1 - i][8] = true;
    }
    setFn(moduleCount - 8, 8, true);

    // data placement (zig-zag, skipping reserved cells), then XOR with mask
    const data = dataCodewords;
    let bitIndex = 7;
    let byteIndex = 0;
    let dir = -1;
    let col = moduleCount - 1;
    while (col > 0) {
      if (col === 6) col--;
      for (let count = 0; count < moduleCount; count++) {
        const row = dir < 0 ? moduleCount - 1 - count : count;
        for (let c = 0; c < 2; c++) {
          const curCol = col - c;
          if (reserved[row][curCol]) continue;
          let dark = false;
          if (byteIndex < data.length) {
            dark = ((data[byteIndex] >>> bitIndex) & 1) === 1;
          }
          if (getMask(maskPattern, row, curCol)) dark = !dark;
          modules[row][curCol] = dark;
          reserved[row][curCol] = true;
          bitIndex--;
          if (bitIndex === -1) {
            byteIndex++;
            bitIndex = 7;
          }
        }
      }
      dir = -dir;
      col -= 2;
    }

    // format info (error-correct level M + chosen mask), placed last so it always wins
    const bits = bchTypeInfo((ERROR_CORRECT_LEVEL_M << 3) | maskPattern);
    for (let i = 0; i < 15; i++) {
      const dark = ((bits >> i) & 1) === 1;
      if (i < 6) modules[i][8] = dark;
      else if (i < 8) modules[i + 1][8] = dark;
      else modules[moduleCount - 15 + i][8] = dark;
    }
    for (let i = 0; i < 15; i++) {
      const dark = ((bits >> i) & 1) === 1;
      if (i < 8) modules[8][moduleCount - i - 1] = dark;
      else if (i < 9) modules[8][15 - i - 1 + 1] = dark;
      else modules[8][15 - i - 1] = dark;
    }

    // fill any still-null modules (shouldn't normally happen) as light, for safety
    for (let r = 0; r < moduleCount; r++) {
      for (let c = 0; c < moduleCount; c++) {
        if (modules[r][c] === null) modules[r][c] = false;
      }
    }

    return modules;
  }

  /**
   * Renders `text` as a QR code onto `canvas`. Picks the smallest supported
   * version (1-6, ~106 bytes max at error-correction level M) that fits;
   * throws if the text is too long for that range.
   */
  function renderToCanvas(canvas, text, { size = 240, margin = 4, dark = '#000000', light = '#ffffff' } = {}) {
    let result = null;
    for (let v = 1; v <= 6; v++) {
      try {
        result = encode(text, v);
        break;
      } catch {
        continue;
      }
    }
    if (!result) throw new Error('Text too long to encode as a QR code');

    const { modules, moduleCount } = result;
    const cell = Math.floor(size / (moduleCount + margin * 2));
    const pixelSize = cell * (moduleCount + margin * 2);

    canvas.width = pixelSize;
    canvas.height = pixelSize;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = light;
    ctx.fillRect(0, 0, pixelSize, pixelSize);
    ctx.fillStyle = dark;
    for (let r = 0; r < moduleCount; r++) {
      for (let c = 0; c < moduleCount; c++) {
        if (modules[r][c]) {
          ctx.fillRect((c + margin) * cell, (r + margin) * cell, cell, cell);
        }
      }
    }
  }

  return { renderToCanvas };
})();
