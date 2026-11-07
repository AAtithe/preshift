import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isXls, readXls } from './xls';

// Excel 97-2003 files, read without a library. The fixtures were saved as .xls by LibreOffice from
// workbooks with accented text, dates, date-times, a formula, a title row, and a sheet long enough for
// the shared strings to run across several records; the tiny one is small enough to sit in the mini stream.

const file = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

describe('xls', () => {
  it('reads every sheet, with dates as dates and accented text intact', () => {
    const sheets = readXls(file('libreoffice-big.xls'));
    expect(sheets.map((s) => s.name)).toEqual(['Staff list', 'Long']);
    expect(sheets[0].rows.slice(0, 4)).toEqual([
      ['Exported from RotaSys'],
      ['Employee', 'Job Title', 'Hourly Rate', 'Date of Birth', 'Start', 'Notes'],
      ['Zoë Brontë', 'Server', '12.71', '1990-06-30', '2026-10-02 17:30', 'Café – late'],
      ['Sam Cook', 'Chef', '15.5', '2001-04-12', '2026-10-03 09:00', 'ab', '2'],
    ]);
    expect(sheets[0].rows[4].slice(0, 4)).toEqual(['Big Number', 'Chef', '123456.789', '1985-01-01']);
  });

  it('reads shared strings that run across continuation records', () => {
    const long = readXls(file('libreoffice-big.xls'))[1].rows;
    expect(long).toHaveLength(601);
    for (const i of [0, 77, 311, 599]) expect(long[i + 1]).toEqual([String(i), `Row text number ${i} with some padding so the shared string table runs well past one record`]);
  });

  it('reads a workbook small enough to sit in the mini stream', () => {
    expect(readXls(file('libreoffice-tiny.xls'))[0].rows).toEqual([['Name', 'Hours'], ['Pat Lee', '7.5'], ['Jo Ray', '8']]);
  });

  it('knows an .xls from anything else', () => {
    expect(isXls(file('libreoffice-tiny.xls'))).toBe(true);
    expect(() => readXls(new TextEncoder().encode('Name,Role'))).toThrow(/not an Excel 97-2003/);
  });
});
