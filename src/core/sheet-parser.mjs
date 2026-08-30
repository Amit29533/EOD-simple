/**
 * Spreadsheet reader for bulk question import - pure, no I/O, no dependencies.
 *
 * Accepts the two formats an admin actually has to hand:
 *   .xlsx  - the Office Open XML zip Excel/Sheets/Numbers all export
 *   .csv   - including the tab-separated and semicolon-separated variants
 *            Excel produces under non-English locales
 *
 * Parsing .xlsx from scratch (rather than adding a dependency) is deliberate:
 * the app ships with no required runtime dependencies and runs on Netlify
 * Functions, so a vendored parser keeps `npm install` empty. An .xlsx is a ZIP
 * of XML parts; we only need the shared-string table and the first worksheet,
 * which is a small, well-specified subset:
 *   xl/sharedStrings.xml  <si><t>text</t></si> - string pool
 *   xl/worksheets/sheet1.xml <c r="B4" t="s"><v>7</v></c> - cells
 *
 * Both readers return the same thing: { headers: string[], rows: object[] },
 * keyed by the header row, so the importer above them never has to care which
 * format arrived.
 */

import { inflateRawSync } from 'node:zlib';

/* -------------------------------------------------------------- ZIP ----- */

/**
 * Read the entries of a ZIP archive.
 *
 * Walks the central directory backwards from the End Of Central Directory
 * record rather than scanning local headers forward: local headers may carry
 * streamed sizes of 0 with the real values in a trailing data descriptor, so
 * the central directory is the only authoritative source for entry sizes.
 */
function unzip(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  // End Of Central Directory: signature 0x06054b50, within the last 64KB+22.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid .xlsx file (no ZIP end-of-directory record).');

  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  const files = new Map();

  for (let n = 0; n < count && ptr + 46 <= buf.length; n += 1) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) break;      // central header sig
    const method = buf.readUInt16LE(ptr + 10);
    const compressedSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen);

    // Re-read the *local* header to find where the payload actually starts;
    // its extra field length can differ from the central one.
    if (buf.readUInt32LE(localOffset) === 0x04034b50) {
      const lNameLen = buf.readUInt16LE(localOffset + 26);
      const lExtraLen = buf.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + lNameLen + lExtraLen;
      const slice = buf.subarray(start, start + compressedSize);
      try {
        files.set(name, method === 0 ? slice : inflateRawSync(slice));
      } catch { /* a part we cannot inflate is simply unavailable */ }
    }
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

/* -------------------------------------------------------------- XML ----- */

const XML_ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'",
};

function decodeXml(text) {
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&(amp|lt|gt|quot|apos);/g, (m) => XML_ENTITIES[m]);
}

/** Guard against malformed numeric entities crashing String.fromCodePoint. */
function safeCodePoint(code) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  try { return String.fromCodePoint(code); } catch { return ''; }
}

/** Concatenated text of every <t> in a fragment (a cell can be split into runs). */
function textOf(fragment) {
  const parts = [...fragment.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1]));
  return parts.join('');
}

/* ------------------------------------------------------------- xlsx ----- */

/** "BC12" -> 54 (0-based column index). */
export function columnIndex(ref) {
  const letters = String(ref).match(/^[A-Z]+/i)?.[0] || 'A';
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * Excel serial date -> ISO date. Serial 1 is 1900-01-01, and Excel's
 * deliberate 1900-leap-year bug means serials above 59 are shifted by one.
 */
function excelDate(serial) {
  const n = Number(serial);
  if (!Number.isFinite(n) || n <= 0) return String(serial);
  const days = n > 59 ? n - 1 : n;
  const ms = Date.UTC(1900, 0, 1) + (days - 1) * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

function parseXlsx(buffer) {
  const files = unzip(buffer);

  // Shared strings: the pool cell values of type "s" index into.
  const sharedXml = files.get('xl/sharedStrings.xml')?.toString('utf8') || '';
  const shared = [...sharedXml.matchAll(/<si[^>]*>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]));

  // Which worksheet is *first* is defined by workbook.xml order, not by file
  // name: a workbook whose first tab is sheet3.xml is perfectly legal.
  const workbook = files.get('xl/workbook.xml')?.toString('utf8') || '';
  const rels = files.get('xl/_rels/workbook.xml.rels')?.toString('utf8') || '';
  const firstSheetRid = workbook.match(/<sheet[^>]*r:id="([^"]+)"/)?.[1];
  const relTarget = firstSheetRid
    ? rels.match(new RegExp(`<Relationship[^>]*Id="${firstSheetRid}"[^>]*Target="([^"]+)"`))?.[1]
    : null;

  const candidates = [
    relTarget && `xl/${String(relTarget).replace(/^\/?xl\//, '').replace(/^\//, '')}`,
    'xl/worksheets/sheet1.xml',
    ...[...files.keys()].filter((k) => /^xl\/worksheets\/.*\.xml$/.test(k)).sort(),
  ].filter(Boolean);

  const sheetName = candidates.find((c) => files.has(c));
  if (!sheetName) throw new Error('The workbook contains no readable worksheet.');
  const sheet = files.get(sheetName).toString('utf8');

  // Number formats that mean "this numeric cell is really a date".
  const styles = files.get('xl/styles.xml')?.toString('utf8') || '';
  const cellXfs = styles.match(/<cellXfs[\s\S]*?<\/cellXfs>/)?.[0] || '';
  const xfFormats = [...cellXfs.matchAll(/<xf[^>]*numFmtId="(\d+)"[^>]*\/?>/g)].map((m) => Number(m[1]));
  const BUILTIN_DATES = new Set([14, 15, 16, 17, 22, 27, 30, 36, 45, 46, 47, 50, 57]);
  const customDates = new Set(
    [...styles.matchAll(/<numFmt[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)]
      .filter((m) => /[dmy]/i.test(m[2]) && !/[#0]/.test(m[2]))
      .map((m) => Number(m[1]))
  );

  const grid = [];
  for (const rowMatch of sheet.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    // Match both a populated cell and a SELF-CLOSING empty one (`<c r="E4"/>`).
    // Excel emits the latter for blank cells that carry a style, and skipping
    // them would shift every later value one column to the left — silently
    // filing a rubric under "Option A".
    for (const c of rowMatch[1].matchAll(/<c([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1];
      const inner = c[2] ?? '';
      const ref = attrs.match(/r="([A-Z]+\d+)"/i)?.[1];
      const type = attrs.match(/t="([^"]+)"/)?.[1] || 'n';
      const styleId = Number(attrs.match(/s="(\d+)"/)?.[1] ?? NaN);
      const col = ref ? columnIndex(ref) : cells.length;

      let value = '';
      if (type === 's') {
        const idx = Number(inner.match(/<v>([\s\S]*?)<\/v>/)?.[1]);
        value = shared[idx] ?? '';
      } else if (type === 'inlineStr') {
        value = textOf(inner);
      } else if (type === 'str' || type === 'e') {
        value = decodeXml(inner.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? '');
      } else {
        const raw = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? '';
        if (type === 'b') value = raw === '1' ? 'TRUE' : 'FALSE';
        else {
          const fmt = Number.isFinite(styleId) ? xfFormats[styleId] : undefined;
          value = (BUILTIN_DATES.has(fmt) || customDates.has(fmt)) && raw !== ''
            ? excelDate(raw)
            : decodeXml(raw);
        }
      }
      cells[col] = value;
    }
    // Empty <row> elements still count: they keep row indices aligned.
    grid.push(cells);
  }
  return grid;
}

/* -------------------------------------------------------------- CSV ----- */

/**
 * RFC-4180 CSV, plus the delimiters Excel emits under other locales.
 * Handles quoted fields, escaped quotes, embedded newlines and CRLF.
 */
export function parseDelimited(text, delimiter) {
  const src = String(text).replace(/^\uFEFF/, '');   // strip UTF-8 BOM
  const delim = delimiter || sniffDelimiter(src);
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1; }
        else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === delim) { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** Pick the delimiter that yields the most columns on the header line. */
function sniffDelimiter(text) {
  const line = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n'));
  const counts = [',', ';', '\t', '|'].map((d) => [d, line.split(d).length]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 1 ? counts[0][0] : ',';
}

/* ----------------------------------------------------------- public ----- */

/** Normalize a header cell to a stable key: "Correct Answer " -> "correct_answer". */
export const headerKey = (text) => String(text ?? '')
  .replace(/\uFEFF/g, '')
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '_')
  .replace(/^_|_$/g, '');

/**
 * Parse a spreadsheet into { headers, rows } where each row is an object
 * keyed by normalized header name.
 *
 * `input` is a Buffer/Uint8Array (.xlsx) or a string (.csv). Rows above the
 * header are skipped: exported sheets often carry a title line or two before
 * the real header, so the first row containing a recognizable column wins.
 */
export function parseSheet(input, { format } = {}) {
  const isBinary = Buffer.isBuffer(input) || input instanceof Uint8Array;
  const kind = format || (isBinary ? 'xlsx' : 'csv');

  let grid = kind === 'xlsx'
    ? parseXlsx(input)
    : parseDelimited(typeof input === 'string' ? input : Buffer.from(input).toString('utf8'));

  // Drop fully-empty rows, then locate the header: the first row with at
  // least two non-empty cells (a one-cell row is a title, not a header).
  grid = grid.map((r) => [...r].map((c) => (c === undefined ? '' : String(c))));
  const headerAt = grid.findIndex((r) => r.filter((c) => String(c).trim()).length >= 2);
  if (headerAt === -1) return { headers: [], rows: [] };

  const headers = grid[headerAt].map(headerKey);
  const rows = [];
  for (const raw of grid.slice(headerAt + 1)) {
    if (!raw.some((c) => String(c).trim())) continue;      // blank spacer row
    const row = {};
    headers.forEach((h, i) => {
      if (!h) return;
      row[h] = String(raw[i] ?? '').trim();
    });
    rows.push(row);
  }
  return { headers: headers.filter(Boolean), rows };
}
