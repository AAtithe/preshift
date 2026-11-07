// Excel 97-2003 workbooks (.xls), read without a library. Plenty of older rota, payroll and HR systems
// still export these. An .xls is a compound file (a small file system in one file) holding a
// "Workbook" stream of BIFF8 records; only what the importers need is read: each sheet's cells as
// text, with dates shown as dates. Formats, styles and formulas themselves are ignored; a formula's
// last calculated value is read.

import { serialToText, type Sheet } from './xlsx';

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const f64 = (b: Uint8Array, o: number) => new DataView(b.buffer, b.byteOffset + o, 8).getFloat64(0, true);

const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const END_OF_CHAIN = 0xfffffffe;
const FREE = 0xffffffff;

/** Whether the bytes are an old-style Excel file rather than .xlsx. */
export const isXls = (b: Uint8Array) => SIGNATURE.every((x, i) => b[i] === x);

/** The named stream from a compound file, following its sector chain (or the mini stream for small ones). */
function cfbStream(file: Uint8Array, names: string[]): Uint8Array | null {
  const sectorSize = 1 << u16(file, 30);
  const miniSize = 1 << u16(file, 32);
  const cutoff = u32(file, 56);
  const sector = (id: number) => 512 + id * sectorSize;

  // The sector allocation table, from the DIFAT in the header and any DIFAT sectors chained after it.
  const fatSectors: number[] = [];
  for (let i = 0; i < 109; i++) {
    const id = u32(file, 76 + i * 4);
    if (id !== FREE && id !== END_OF_CHAIN) fatSectors.push(id);
  }
  let difat = u32(file, 68);
  for (let guard = 0; difat !== END_OF_CHAIN && difat !== FREE && guard < 10000; guard++) {
    const at = sector(difat);
    for (let i = 0; i < sectorSize / 4 - 1; i++) {
      const id = u32(file, at + i * 4);
      if (id !== FREE && id !== END_OF_CHAIN) fatSectors.push(id);
    }
    difat = u32(file, at + sectorSize - 4);
  }
  const fat: number[] = [];
  for (const s of fatSectors) for (let i = 0; i < sectorSize / 4; i++) fat.push(u32(file, sector(s) + i * 4));

  const chain = (start: number, table: number[]) => {
    const out: number[] = [];
    for (let id = start; id !== END_OF_CHAIN && id !== FREE && id < table.length && out.length <= table.length; id = table[id]) out.push(id);
    return out;
  };
  const read = (start: number, size: number) => {
    const out = new Uint8Array(size);
    let at = 0;
    for (const id of chain(start, fat)) {
      const n = Math.min(sectorSize, size - at);
      if (n <= 0) break;
      out.set(file.subarray(sector(id), sector(id) + n), at);
      at += n;
    }
    return out;
  };

  // The directory: 128 byte entries, names in UTF-16.
  const dirBytes = read(u32(file, 48), chain(u32(file, 48), fat).length * sectorSize);
  const entries: { name: string; type: number; start: number; size: number }[] = [];
  for (let o = 0; o + 128 <= dirBytes.length; o += 128) {
    const len = u16(dirBytes, o + 64);
    let name = '';
    for (let i = 0; i + 2 < len; i += 2) name += String.fromCharCode(u16(dirBytes, o + i));
    entries.push({ name, type: dirBytes[o + 66], start: u32(dirBytes, o + 116), size: u32(dirBytes, o + 120) });
  }
  const entry = entries.find((e) => e.type === 2 && names.includes(e.name));
  if (!entry) return null;
  if (entry.size >= cutoff) return read(entry.start, entry.size);

  // A small stream lives in the mini stream, held by the root entry and mapped by the mini FAT.
  const root = entries.find((e) => e.type === 5)!;
  const ministream = read(root.start, root.size);
  const minifatStart = u32(file, 60);
  const minifatBytes = read(minifatStart, chain(minifatStart, fat).length * sectorSize);
  const minifat: number[] = [];
  for (let i = 0; i + 4 <= minifatBytes.length; i += 4) minifat.push(u32(minifatBytes, i));
  const out = new Uint8Array(entry.size);
  let at = 0;
  for (const id of chain(entry.start, minifat)) {
    const n = Math.min(miniSize, entry.size - at);
    if (n <= 0) break;
    out.set(ministream.subarray(id * miniSize, id * miniSize + n), at);
    at += n;
  }
  return out;
}

interface BiffRecord {
  type: number;
  data: Uint8Array;
  /** Where the record starts in the stream: sheets are found by it. */
  pos: number;
}

function records(stream: Uint8Array): BiffRecord[] {
  const out: BiffRecord[] = [];
  for (let o = 0; o + 4 <= stream.length; ) {
    const type = u16(stream, o);
    const len = u16(stream, o + 2);
    out.push({ type, data: stream.subarray(o + 4, o + 4 + len), pos: o });
    o += 4 + len;
  }
  return out;
}

const latin1 = (b: Uint8Array) => String.fromCharCode(...b);
const utf16 = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode(u16(b, i));
  return s;
};

/** A string in one record: its length is `cch` characters, one or two bytes each by the flags byte. */
function plainString(b: Uint8Array, o: number, cch: number): string {
  const high = b[o] & 1;
  const start = o + 1;
  return high ? utf16(b.subarray(start, start + cch * 2)) : latin1(b.subarray(start, start + cch));
}

/**
 * The shared strings. They run on into CONTINUE records, and a string's characters can break across
 * one: the next record then starts with a fresh flags byte for the rest of that string.
 */
function sharedStrings(sst: Uint8Array, continues: Uint8Array[]): string[] {
  const parts = [sst.subarray(8), ...continues];
  let p = 0;
  let o = 0;
  // Anything but a string's characters simply carries on in the next record.
  const byte = () => {
    while (p < parts.length && o >= parts[p].length) {
      p++;
      o = 0;
    }
    return p < parts.length ? parts[p][o++] : 0;
  };
  const word = () => byte() | (byte() << 8);
  const dword = () => (word() | (word() << 16)) >>> 0;
  const skip = (n: number) => {
    for (let i = 0; i < n; i++) byte();
  };
  const count = u32(sst, 4);
  const out: string[] = [];
  for (let n = 0; n < count && p < parts.length; n++) {
    if (o >= parts[p].length) {
      p++;
      o = 0;
      if (p >= parts.length) break;
    }
    const cch = word();
    let flags = byte();
    const runs = flags & 0x08 ? word() : 0;
    const ext = flags & 0x04 ? dword() : 0;
    let s = '';
    let left = cch;
    while (left > 0) {
      if (o >= parts[p].length) {
        // Characters carry on in the next CONTINUE, which restates whether they are one byte or two.
        p++;
        o = 0;
        if (p >= parts.length) break;
        flags = parts[p][o++];
      }
      const high = flags & 1;
      const fit = Math.min(left, Math.floor((parts[p].length - o) / (high ? 2 : 1)));
      const bytes = parts[p].subarray(o, o + fit * (high ? 2 : 1));
      s += high ? utf16(bytes) : latin1(bytes);
      o += bytes.length;
      left -= fit;
      if (fit === 0) {
        p++;
        o = 0;
        if (p >= parts.length) break;
        flags = parts[p][o++];
      }
    }
    skip(runs * 4 + ext);
    out.push(s);
  }
  return out;
}

/** An RK number: a compact integer or the top of a double, times 100 when flagged. */
function rk(v: number): number {
  let n: number;
  if (v & 2) n = (v | 0) >> 2;
  else {
    const buf = new DataView(new ArrayBuffer(8));
    buf.setUint32(4, v & 0xfffffffc, true);
    n = buf.getFloat64(0, true);
  }
  return v & 1 ? n / 100 : n;
}

const BUILTIN_DATES = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
const isDateFormat = (code: string) => {
  const c = code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, '');
  return /[dmyhs]/i.test(c) && !/^[#0.,%]*$/.test(c);
};

/** Every sheet in an .xls workbook, each cell as the text it shows (dates as ISO). Blank rows are left out. */
export function readXls(file: Uint8Array): Sheet[] {
  if (!isXls(file)) throw new Error('This is not an Excel 97-2003 workbook (.xls).');
  const stream = cfbStream(file, ['Workbook', 'Book']);
  if (!stream) throw new Error('The .xls file has no workbook in it. Open it in Excel and save it as .xlsx.');
  const recs = records(stream);
  if (recs.some((r) => r.type === 0x002f)) throw new Error('The workbook is password protected. Open it in Excel, remove the password, and save it again.');
  if (recs[0]?.type !== 0x0809 || u16(recs[0].data, 0) !== 0x0600) throw new Error('This .xls is older than Excel 97. Open it in Excel and save it as .xlsx.');

  // The workbook globals: sheet names, shared strings, cell formats and the date system.
  const sheets: { name: string; pos: number }[] = [];
  const formats = new Map<number, string>();
  const xfFormat: number[] = [];
  let strings: string[] = [];
  let date1904 = false;
  let i = 0;
  for (; i < recs.length; i++) {
    const r = recs[i];
    if (r.type === 0x000a) break;
    if (r.type === 0x0085 && r.data[5] === 0) sheets.push({ pos: u32(r.data, 0), name: plainString(r.data, 7, r.data[6]) });
    else if (r.type === 0x041e) formats.set(u16(r.data, 0), plainString(r.data, 4, u16(r.data, 2)));
    else if (r.type === 0x00e0) xfFormat.push(u16(r.data, 2));
    else if (r.type === 0x0022) date1904 = u16(r.data, 0) === 1;
    else if (r.type === 0x00fc) {
      const continues: Uint8Array[] = [];
      for (let k = i + 1; k < recs.length && recs[k].type === 0x003c; k++) continues.push(recs[k].data);
      strings = sharedStrings(r.data, continues);
    }
  }
  const isDate = (xf: number) => {
    const fmt = xfFormat[xf];
    return fmt !== undefined && (BUILTIN_DATES.has(fmt) || isDateFormat(formats.get(fmt) ?? ''));
  };
  const number = (n: number, xf: number) => (isDate(xf) ? serialToText(date1904 ? n + 1462 : n) : String(Math.round(n * 1e6) / 1e6));

  const byPos = new Map(recs.map((r, k) => [r.pos, k]));
  return sheets.map(({ name, pos }) => {
    const grid: string[][] = [];
    const put = (row: number, col: number, text: string) => {
      const r = (grid[row] ??= []);
      while (r.length < col) r.push('');
      r[col] = text.trim();
    };
    let pendingFormula: [number, number] | null = null;
    for (let k = (byPos.get(pos) ?? recs.length) + 1; k < recs.length && recs[k].type !== 0x000a; k++) {
      const { type, data: d } = recs[k];
      const row = u16(d, 0);
      const col = u16(d, 2);
      const xf = u16(d, 4);
      if (type === 0x00fd) put(row, col, strings[u32(d, 6)] ?? '');
      else if (type === 0x0203) put(row, col, number(f64(d, 6), xf));
      else if (type === 0x027e) put(row, col, number(rk(u32(d, 6)), xf));
      else if (type === 0x00bd) {
        const last = u16(d, d.length - 2);
        for (let c = col, o = 4; c <= last; c++, o += 6) put(row, c, number(rk(u32(d, o + 2)), u16(d, o)));
      } else if (type === 0x0204) put(row, col, plainString(d, 8, u16(d, 6)));
      else if (type === 0x0205) put(row, col, d[7] ? '' : d[6] ? 'TRUE' : 'FALSE');
      else if (type === 0x0006) {
        // A formula's cached result: a number, or a flag saying the value follows (text) or is a boolean.
        if (d[12] === 0xff && d[13] === 0xff) {
          if (d[6] === 0) pendingFormula = [row, col];
          else if (d[6] === 1) put(row, col, d[8] ? 'TRUE' : 'FALSE');
        } else put(row, col, number(f64(d, 6), xf));
      } else if (type === 0x0207 && pendingFormula) {
        put(pendingFormula[0], pendingFormula[1], plainString(d, 2, u16(d, 0)));
        pendingFormula = null;
      }
    }
    return { name, rows: grid.filter((r) => r && r.some((c) => c !== '')).map((r) => Array.from(r, (c) => c ?? '')) };
  });
}
