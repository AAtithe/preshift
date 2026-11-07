// Excel workbooks (.xlsx), read and written without a library: an .xlsx is a zip of XML files.
// Reading needs only the sheets' cells as text, which is all the importers use; writing makes the
// onboarding template, plain cells with a bold header row. Runs in the browser and in Node alike.

export interface Sheet {
  name: string;
  rows: string[][];
}

// ---- zip ----

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The files in a zip, by name, unpacked on demand. */
function unzip(bytes: Uint8Array): Map<string, () => Promise<Uint8Array>> {
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (u32(bytes, i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('This is not an Excel workbook (.xlsx). Save it from Excel as .xlsx or .csv and try again.');
  const count = u16(bytes, end + 10);
  let at = u32(bytes, end + 16);
  const files = new Map<string, () => Promise<Uint8Array>>();
  const decoder = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (u32(bytes, at) !== 0x02014b50) throw new Error('The workbook is damaged.');
    const method = u16(bytes, at + 10);
    const size = u32(bytes, at + 20);
    const nameLength = u16(bytes, at + 28);
    const extra = u16(bytes, at + 30);
    const comment = u16(bytes, at + 32);
    const local = u32(bytes, at + 42);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    files.set(name, async () => {
      const start = local + 30 + u16(bytes, local + 26) + u16(bytes, local + 28);
      const raw = bytes.subarray(start, start + size);
      if (method === 0) return raw;
      if (method === 8) return inflate(raw);
      throw new Error('The workbook uses a compression Excel does not normally use. Save it again from Excel.');
    });
    at += 46 + nameLength + extra + comment;
  }
  return files;
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (b: Uint8Array) => {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** A zip of the files given, stored without compression: small enough for a template, and every reader opens it. */
function zip(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const header = (size: number) => new DataView(new ArrayBuffer(size));
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const l = header(30);
    l.setUint32(0, 0x04034b50, true);
    l.setUint16(4, 20, true);
    l.setUint16(8, 0, true);
    l.setUint32(14, crc, true);
    l.setUint32(18, f.data.length, true);
    l.setUint32(22, f.data.length, true);
    l.setUint16(26, name.length, true);
    parts.push(new Uint8Array(l.buffer), name, f.data);
    const c = header(46);
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, f.data.length, true);
    c.setUint32(24, f.data.length, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), name);
    offset += 30 + name.length + f.data.length;
  }
  const size = central.reduce((n, p) => n + p.length, 0);
  const e = header(22);
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, files.length, true);
  e.setUint16(10, files.length, true);
  e.setUint32(12, size, true);
  e.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(e.buffer)];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// ---- reading ----

const unescapeXml = (s: string) =>
  s.replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-f]+);/gi, (_, e: string) =>
    e === 'lt' ? '<' : e === 'gt' ? '>' : e === 'quot' ? '"' : e === 'apos' ? "'" : e === 'amp' ? '&' : String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)),
  );
const attr = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
const texts = (xml: string) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unescapeXml(m[1])).join('');

/** Column letters to a zero-based index: A is 0, AA is 26. */
const columnIndex = (ref: string) => [...ref.replace(/\d+$/, '')].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

const BUILTIN_DATES = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

/** Which cell styles show a date or time, from the workbook's number formats. */
function dateStyles(styles: string): boolean[] {
  const custom = new Map<number, string>();
  for (const m of styles.matchAll(/<numFmt\s[^>]*>/g)) custom.set(Number(attr(m[0], 'numFmtId')), unescapeXml(attr(m[0], 'formatCode') ?? ''));
  const xfs = styles.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] ?? '';
  return [...xfs.matchAll(/<xf\s[^>]*?\/?>/g)].map((m) => {
    const id = Number(attr(m[0], 'numFmtId') ?? 0);
    if (BUILTIN_DATES.has(id)) return true;
    // A custom format is a date when it has day, month, year or hour codes outside quotes and colours.
    const code = (custom.get(id) ?? '').replace(/"[^"]*"|\[[^\]]*\]|\\./g, '');
    return /[dmyhs]/i.test(code) && !/^[#0.,%]*$/.test(code);
  });
}

const pad = (n: number) => String(n).padStart(2, '0');

/** An Excel serial date as text the importers read: 2026-11-09, 2026-11-09 17:30, or 17:30 for a time alone. */
export function serialToText(serial: number): string {
  const whole = Math.floor(serial);
  const minutes = Math.round((serial - whole) * 1440);
  const time = `${pad(Math.floor(minutes / 60) % 24)}:${pad(minutes % 60)}`;
  if (whole === 0) return time;
  // Excel's day 1 is 1 January 1900, counting the 29 February 1900 that never was.
  const date = new Date(Date.UTC(1899, 11, 30) + whole * 86_400_000).toISOString().slice(0, 10);
  return minutes ? `${date} ${time}` : date;
}

/** Every sheet in an .xlsx workbook, each cell as the text it shows (dates as ISO). Blank rows are left out. */
export async function readXlsx(bytes: Uint8Array): Promise<Sheet[]> {
  const files = unzip(bytes);
  const read = async (name: string) => {
    const f = files.get(name);
    return f ? new TextDecoder().decode(await f()) : '';
  };
  const workbook = await read('xl/workbook.xml');
  if (!workbook) throw new Error('This is not an Excel workbook (.xlsx).');
  const rels = await read('xl/_rels/workbook.xml.rels');
  const targets = new Map([...rels.matchAll(/<Relationship\s[^>]*>/g)].map((m) => [attr(m[0], 'Id'), attr(m[0], 'Target') ?? '']));
  const shared = [...(await read('xl/sharedStrings.xml')).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => texts(m[1]));
  const dates = dateStyles(await read('xl/styles.xml'));

  const sheets: Sheet[] = [];
  for (const m of workbook.matchAll(/<sheet\s[^>]*>/g)) {
    const name = unescapeXml(attr(m[0], 'name') ?? `Sheet ${sheets.length + 1}`);
    const target = targets.get(attr(m[0], 'r:id')) ?? '';
    const path = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
    const xml = await read(path);
    const rows: string[][] = [];
    for (const r of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const row: string[] = [];
      for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const head = c[1];
        const body = c[2] ?? '';
        const ref = attr(head, 'r');
        const i = ref ? columnIndex(ref) : row.length;
        const type = attr(head, 't');
        const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        let text = '';
        if (type === 's') text = shared[Number(v)] ?? '';
        else if (type === 'inlineStr') text = texts(body);
        else if (type === 'b') text = v === '1' ? 'TRUE' : 'FALSE';
        else if (type === 'str' || type === 'e') text = unescapeXml(v ?? '');
        else if (v !== undefined) {
          const n = Number(v);
          text = dates[Number(attr(head, 's') ?? 0)] && Number.isFinite(n) ? serialToText(n) : String(Number.isFinite(n) ? Math.round(n * 1e6) / 1e6 : v);
        }
        while (row.length < i) row.push('');
        row[i] = text.trim();
      }
      if (row.some((x) => x !== '')) rows.push(row);
    }
    sheets.push({ name, rows });
  }
  return sheets;
}

// ---- writing ----

const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const columnName = (i: number): string => (i < 26 ? String.fromCharCode(65 + i) : columnName(Math.floor(i / 26) - 1) + String.fromCharCode(65 + (i % 26)));

export interface SheetOut {
  name: string;
  rows: (string | number | null)[][];
  /** Column widths in characters. */
  widths?: number[];
  /** The first row is a header: bold, and frozen when scrolling. */
  header?: boolean;
  /** Text wraps within its column: for a sheet of instructions. */
  wrap?: boolean;
}

/** A workbook of plain sheets. Text is kept as text, so a date typed as 09/11/2026 or a rate of 12.71 reads back as written. */
export function writeXlsx(sheets: SheetOut[]): Uint8Array {
  const enc = new TextEncoder();
  const file = (name: string, xml: string) => ({ name, data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${xml}`) });
  const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const files = [
    file('[Content_Types].xml', `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`),
    file('_rels/.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    file('xl/workbook.xml', `<workbook ${ns}><sheets>${sheets.map((s, i) => `<sheet name="${escapeXml(s.name.slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`),
    file('xl/_rels/workbook.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
    // Style 1 is bold text; 2 is text that wraps; both keep what is typed as text (number format 49, "@").
    file('xl/styles.xml', `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="49" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`),
    ...sheets.map((s, i) => {
      const cols = s.widths?.length ? `<cols>${s.widths.map((w, k) => `<col min="${k + 1}" max="${k + 1}" width="${w}" customWidth="1" style="0"/>`).join('')}</cols>` : '';
      const freeze = s.header ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' : '';
      const rows = s.rows
        .map((row, r) => {
          const style = s.header && r === 0 ? 1 : s.wrap ? 2 : 0;
          const cells = row
            .map((v, c) => {
              if (v === null || v === '') return '';
              const ref = `${columnName(c)}${r + 1}`;
              return typeof v === 'number'
                ? `<c r="${ref}"><v>${v}</v></c>`
                : `<c r="${ref}" t="inlineStr" s="${style}"><is><t xml:space="preserve">${escapeXml(v)}</t></is></c>`;
            })
            .join('');
          return `<row r="${r + 1}">${cells}</row>`;
        })
        .join('');
      return file(`xl/worksheets/sheet${i + 1}.xml`, `<worksheet ${ns}>${freeze}${cols}<sheetData>${rows}</sheetData></worksheet>`);
    }),
  ];
  return zip(files);
}
