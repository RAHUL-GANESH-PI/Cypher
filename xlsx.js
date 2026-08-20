'use strict';

/* =========================================================
   Minimal, dependency-free .xlsx reader/writer.
   Builds a genuine multi-sheet Excel workbook (OOXML inside an
   uncompressed ZIP) entirely on-device — nothing is uploaded
   anywhere to do this. Only needs to round-trip files this app
   itself produces, so it stays deliberately small: text/number
   cells only, one worksheet part per sheet, inline strings
   (no shared-strings table), no styles/formulas.
   ========================================================= */

const Xlsx = (() => {
  /* ---------- CRC32 (standard, table-generated) ---------- */
  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  /* ---------- tiny binary writer ---------- */
  class ByteWriter {
    constructor() {
      this.bytes = [];
    }
    u8(n) {
      this.bytes.push(n & 0xff);
    }
    u16(n) {
      this.bytes.push(n & 0xff, (n >>> 8) & 0xff);
    }
    u32(n) {
      this.bytes.push(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
    }
    raw(arr) {
      for (let i = 0; i < arr.length; i++) this.bytes.push(arr[i]);
    }
    toUint8Array() {
      return Uint8Array.from(this.bytes);
    }
  }

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  /* ---------- ZIP (store method, no compression) ---------- */
  function buildZip(files) {
    // files: [{ name: string, data: Uint8Array }]
    const w = new ByteWriter();
    const central = [];

    files.forEach((f) => {
      const nameBytes = enc.encode(f.name);
      const crc = crc32(f.data);
      const localOffset = w.bytes.length;

      w.u32(0x04034b50); // local file header signature
      w.u16(20); // version needed
      w.u16(0); // flags
      w.u16(0); // method: store
      w.u16(0); // mod time
      w.u16(0); // mod date
      w.u32(crc);
      w.u32(f.data.length); // compressed size
      w.u32(f.data.length); // uncompressed size
      w.u16(nameBytes.length);
      w.u16(0); // extra length
      w.raw(nameBytes);
      w.raw(f.data);

      central.push({ nameBytes, crc, size: f.data.length, localOffset });
    });

    const centralStart = w.bytes.length;
    central.forEach((f) => {
      w.u32(0x02014b50); // central directory signature
      w.u16(20); // version made by
      w.u16(20); // version needed
      w.u16(0); // flags
      w.u16(0); // method
      w.u16(0); // mod time
      w.u16(0); // mod date
      w.u32(f.crc);
      w.u32(f.size);
      w.u32(f.size);
      w.u16(f.nameBytes.length);
      w.u16(0); // extra length
      w.u16(0); // comment length
      w.u16(0); // disk number
      w.u16(0); // internal attrs
      w.u32(0); // external attrs
      w.u32(f.localOffset);
      w.raw(f.nameBytes);
    });
    const centralSize = w.bytes.length - centralStart;

    w.u32(0x06054b50); // end of central directory signature
    w.u16(0); // disk number
    w.u16(0); // disk with central dir
    w.u16(central.length);
    w.u16(central.length);
    w.u32(centralSize);
    w.u32(centralStart);
    w.u16(0); // comment length

    return w.toUint8Array();
  }

  function readZip(buffer) {
    const bytes = new Uint8Array(buffer);
    const dv = new DataView(buffer);

    // find End Of Central Directory by scanning backward for its signature
    let eocd = -1;
    const minPos = Math.max(0, bytes.length - 65557);
    for (let i = bytes.length - 22; i >= minPos; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd === -1) throw new Error('Not a valid .xlsx file (no ZIP end-of-directory record found).');

    const entryCount = dv.getUint16(eocd + 10, true);
    const centralOffset = dv.getUint32(eocd + 16, true);

    const files = {};
    let ptr = centralOffset;
    for (let i = 0; i < entryCount; i++) {
      if (dv.getUint32(ptr, true) !== 0x02014b50) throw new Error('Corrupt .xlsx file (bad central directory entry).');
      const compSize = dv.getUint32(ptr + 20, true);
      const nameLen = dv.getUint16(ptr + 28, true);
      const extraLen = dv.getUint16(ptr + 30, true);
      const commentLen = dv.getUint16(ptr + 32, true);
      const localOffset = dv.getUint32(ptr + 42, true);
      const name = dec.decode(bytes.slice(ptr + 46, ptr + 46 + nameLen));

      // read the local header to find where the actual file data starts
      const localNameLen = dv.getUint16(localOffset + 26, true);
      const localExtraLen = dv.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + localNameLen + localExtraLen;
      files[name] = bytes.slice(dataStart, dataStart + compSize);

      ptr += 46 + nameLen + extraLen + commentLen;
    }
    return files;
  }

  /* ---------- OOXML generation ---------- */
  function escapeXml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
  }

  function colLetters(n) {
    let s = '';
    n += 1;
    while (n > 0) {
      const rem = (n - 1) % 26;
      s = String.fromCharCode(65 + rem) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  function sheetXml(rows) {
    const rowsXml = rows
      .map((row, r) => {
        const cellsXml = row
          .map((val, c) => {
            const ref = colLetters(c) + (r + 1);
            if (typeof val === 'number' && Number.isFinite(val)) {
              return `<c r="${ref}"><v>${val}</v></c>`;
            }
            return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(val ?? '')}</t></is></c>`;
          })
          .join('');
        return `<row r="${r + 1}">${cellsXml}</row>`;
      })
      .join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowsXml}</sheetData></worksheet>`;
  }

  function contentTypesXml(sheetCount) {
    const overrides = Array.from(
      { length: sheetCount },
      (_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
    ).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${overrides}</Types>`;
  }

  function rootRelsXml() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  }

  function workbookXml(sheetNames) {
    const sheets = sheetNames.map((name, i) => `<sheet name="${escapeXml(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets}</sheets></workbook>`;
  }

  function workbookRelsXml(sheetCount) {
    const rels = Array.from(
      { length: sheetCount },
      (_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
    ).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`;
  }

  /**
   * sheets: [{ name: string, rows: any[][] }]
   * returns a Blob (application/vnd...spreadsheetml.sheet)
   */
  function buildWorkbook(sheets) {
    const files = [
      { name: '[Content_Types].xml', data: enc.encode(contentTypesXml(sheets.length)) },
      { name: '_rels/.rels', data: enc.encode(rootRelsXml()) },
      { name: 'xl/workbook.xml', data: enc.encode(workbookXml(sheets.map((s) => s.name))) },
      { name: 'xl/_rels/workbook.xml.rels', data: enc.encode(workbookRelsXml(sheets.length)) }
    ];
    sheets.forEach((s, i) => {
      files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: enc.encode(sheetXml(s.rows)) });
    });
    const zipBytes = buildZip(files);
    return new Blob([zipBytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  /**
   * Parses an .xlsx ArrayBuffer back into { sheetName: rows[][] }.
   * Cells are returned as numbers or strings, matching what buildWorkbook wrote.
   */
  function parseWorkbook(arrayBuffer) {
    const files = readZip(arrayBuffer);
    const parser = new DOMParser();

    const workbookDoc = parser.parseFromString(dec.decode(files['xl/workbook.xml']), 'application/xml');
    const relsDoc = parser.parseFromString(dec.decode(files['xl/_rels/workbook.xml.rels']), 'application/xml');

    const relTargets = {};
    Array.from(relsDoc.getElementsByTagName('Relationship')).forEach((rel) => {
      relTargets[rel.getAttribute('Id')] = rel.getAttribute('Target');
    });

    const result = {};
    Array.from(workbookDoc.getElementsByTagName('sheet')).forEach((sheetEl) => {
      const name = sheetEl.getAttribute('name');
      const rId = sheetEl.getAttribute('r:id') || sheetEl.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
      const target = relTargets[rId];
      const partPath = 'xl/' + target;
      const sheetDoc = parser.parseFromString(dec.decode(files[partPath]), 'application/xml');

      const rows = [];
      Array.from(sheetDoc.getElementsByTagName('row')).forEach((rowEl) => {
        const rowIndex = parseInt(rowEl.getAttribute('r'), 10) - 1;
        const row = rows[rowIndex] || (rows[rowIndex] = []);
        Array.from(rowEl.getElementsByTagName('c')).forEach((cellEl) => {
          const ref = cellEl.getAttribute('r');
          const colStr = ref.match(/[A-Z]+/)[0];
          let colIndex = 0;
          for (let i = 0; i < colStr.length; i++) colIndex = colIndex * 26 + (colStr.charCodeAt(i) - 64);
          colIndex -= 1;

          const isStr = cellEl.getAttribute('t') === 'inlineStr';
          let value;
          if (isStr) {
            const tEl = cellEl.getElementsByTagName('t')[0];
            value = tEl ? tEl.textContent : '';
          } else {
            const vEl = cellEl.getElementsByTagName('v')[0];
            value = vEl ? Number(vEl.textContent) : null;
          }
          row[colIndex] = value;
        });
      });
      // normalize sparse rows (fill gaps with '')
      result[name] = rows.map((r) => (r || []).map((c) => (c === undefined ? '' : c)));
    });
    return result;
  }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  return { buildWorkbook, parseWorkbook, download, _crc32: crc32 };
})();
