import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { readXlsx, serialToText, writeXlsx } from './xlsx';

// Excel workbooks without a library: the template written, and workbooks as Excel saves them read.

/** A zip as Excel writes one: each file deflated. */
function excelZip(files: Record<string, string>): Uint8Array {
  const enc = new TextEncoder();
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = enc.encode(text);
    const data = deflateRawSync(raw);
    const n = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(n.length, 26);
    parts.push(local, n, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(8, 10);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(raw.length, 24);
    c.writeUInt16LE(n.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, n);
    offset += 30 + n.length + data.length;
  }
  const size = central.reduce((s, b) => s + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, ...central, end]));
}

describe('xlsx', () => {
  it('reads back what it writes, text kept as typed', async () => {
    const bytes = writeXlsx([
      { name: 'Team', header: true, rows: [['Name', 'Rate', 'Date of birth'], ['Pat & Lee <QA>', '12.71', '30/06/1990'], ['Jo', 13, null]] },
      { name: 'Rota', rows: [['Name', 'Start']] },
    ]);
    const sheets = await readXlsx(bytes);
    expect(sheets.map((s) => s.name)).toEqual(['Team', 'Rota']);
    expect(sheets[0].rows).toEqual([['Name', 'Rate', 'Date of birth'], ['Pat & Lee <QA>', '12.71', '30/06/1990'], ['Jo', '13']]);
  });

  it('reads a workbook as Excel saves it: shared strings, dates and times, gaps between cells', async () => {
    const bytes = excelZip({
      'xl/workbook.xml': '<workbook><sheets><sheet name="Shifts" sheetId="1" r:id="rId1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/sharedStrings.xml': '<sst><si><t>Team Member</t></si><si><r><t>Sam </t></r><r><t>Cook</t></r></si><si><t>Date</t></si></sst>',
      'xl/styles.xml': '<styleSheet><numFmts><numFmt numFmtId="164" formatCode="hh:mm"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="2"/></cellXfs></styleSheet>',
      'xl/worksheets/sheet1.xml':
        '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>2</v></c></row>' +
        '<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2" s="3"><v>12.5</v></c><c r="C2" s="1"><v>46335</v></c><c r="D2" s="2"><v>0.729166666666667</v></c><c r="E2" t="b"><v>1</v></c></row>' +
        '<row r="3"/></sheetData></worksheet>',
    });
    const [sheet] = await readXlsx(bytes);
    expect(sheet.rows).toEqual([['Team Member', '', 'Date'], ['Sam Cook', '12.5', '2026-11-09', '17:30', 'TRUE']]);
  });

  it('turns serial dates into text the importers read', () => {
    expect([serialToText(46335), serialToText(46335.75), serialToText(0.25)]).toEqual(['2026-11-09', '2026-11-09 18:00', '06:00']);
  });

  it('refuses a file that is not a workbook', async () => {
    await expect(readXlsx(new TextEncoder().encode('Name,Role\nPat,Chef'))).rejects.toThrow(/not an Excel workbook/);
  });
});
