import { useMemo, useState } from 'react';
import { describeAgentError, createBrowserClient } from '../ai/rotaAgent';
import { IMPORT_FIELDS, mapColumnsWithAI, type ImportKind } from '../ai/importMapper';
import { newEmployee } from '../engine/employees';
import { parseCsv } from '../engine/bookingImport';
import { HOLIDAY_COLUMNS, importHoliday, importPeople, importShifts, PEOPLE_COLUMNS, SHIFT_COLUMNS } from '../engine/externalImport';
import { onboardingTemplate, TEMPLATE_SHEETS } from '../engine/importTemplate';
import type { Employee, RotaState } from '../engine/types';
import { readXlsx, writeXlsx, type Sheet } from '../engine/xlsx';
import { api, ApiError } from './api';

// Set-up, Import: the team, holiday balances at go-live and the rota ahead, from an Excel workbook or
// CSV, the onboarding template or an export from the old system. Columns are matched by name; any
// can be chosen by hand, or Shifty maps them from the headers and the kind of value in each, never
// anyone's personal details. Nothing is saved until the preview has been read and confirmed.

const KINDS: { id: ImportKind; label: string; sheet: string; about: string }[] = [
  { id: 'team', label: 'Team', sheet: TEMPLATE_SHEETS.team, about: 'Everyone who works for you. Do this first: holiday balances and shifts are matched to people already on Preshift.' },
  { id: 'holiday', label: 'Holiday balances', sheet: TEMPLATE_SHEETS.holiday, about: "Each person's holiday position on the day you go live, so balances and the holiday pay accrual carry on from your old system rather than starting from nought." },
  { id: 'rota', label: 'Rota', sheet: TEMPLATE_SHEETS.rota, about: 'Shifts already planned for the weeks ahead. They arrive as a draft for you to check and publish.' },
];
const ALIASES = { team: PEOPLE_COLUMNS, rota: SHIFT_COLUMNS, holiday: HOLIDAY_COLUMNS } as const;

const problem = (e: unknown) => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
const hours = (n: number) => `${Math.round(n * 10) / 10}h`;

function saveBytes(name: string, bytes: Uint8Array) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** The sheet most likely to hold this kind: the template's own, else the one whose headers match most. */
function bestSheet(sheets: Sheet[], kind: ImportKind): number {
  const named = sheets.findIndex((s) => s.name.toLowerCase() === KINDS.find((k) => k.id === kind)!.sheet.toLowerCase());
  if (named >= 0 && sheets[named].rows.length > 1) return named;
  const known = new Set(Object.values(ALIASES[kind]).flat());
  const score = (s: Sheet) => (s.rows.slice(0, 10).flat().filter((c) => known.has(c.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim())).length);
  return sheets.reduce((best, s, i) => (score(s) > score(sheets[best]) ? i : best), 0);
}

export function ImportPanel({ state, onDone }: { state: RotaState; onDone: () => Promise<void> }) {
  const [kind, setKind] = useState<ImportKind>('team');
  const [sheets, setSheets] = useState<Sheet[] | null>(null);
  const [fileName, setFileName] = useState('');
  const [sheetIndex, setSheetIndex] = useState(0);
  const [siteId, setSiteId] = useState(state.sites[0]?.id ?? '');
  const [usDates, setUsDates] = useState(false);
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [ai, setAi] = useState<{ busy: boolean; notes?: string; error?: string; costUsd?: number }>({ busy: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ ok: number; failed: { name: string; reason: string }[]; note?: string } | null>(null);
  const today = new Date().toISOString().slice(0, 10);

  const rows = sheets?.[sheetIndex]?.rows ?? null;
  const columns = chosen as never;
  const preview = useMemo(() => {
    if (!rows) return null;
    if (kind === 'team') return { kind, r: importPeople(rows, state, { usDates, columns }) } as const;
    if (kind === 'holiday') return { kind, r: importHoliday(rows, state, today, { columns }) } as const;
    return { kind, r: importShifts(rows, state, { siteId, usDates, columns }) } as const;
  }, [rows, kind, state, usDates, columns, siteId, today]);

  function reset(next: ImportKind = kind) {
    setKind(next);
    setChosen({});
    setAi({ busy: false });
    setDone(null);
    setError(null);
    if (sheets) setSheetIndex(bestSheet(sheets, next));
  }

  async function open(file: File) {
    setError(null);
    setDone(null);
    setChosen({});
    setAi({ busy: false });
    setFileName(file.name);
    try {
      if (/\.xls$/i.test(file.name)) throw new Error('That is an old Excel file (.xls). Open it in Excel and save it as .xlsx, or as CSV, then upload again.');
      const list = /\.(csv|txt|tsv)$/i.test(file.name)
        ? [{ name: file.name, rows: parseCsv(await file.text()) }]
        : await readXlsx(new Uint8Array(await file.arrayBuffer()));
      if (!list.some((s) => s.rows.length > 1)) throw new Error('The file has no rows under its headers.');
      setSheets(list);
      setSheetIndex(bestSheet(list, kind));
    } catch (e) {
      setSheets(null);
      setError(problem(e));
    }
  }

  async function mapWithShifty() {
    if (!rows) return;
    setAi({ busy: true });
    try {
      const m = await mapColumnsWithAI(createBrowserClient(), kind, rows);
      setChosen(m.columns);
      setAi({ busy: false, notes: m.notes, costUsd: m.costUsd });
    } catch (e) {
      setAi({ busy: false, error: describeAgentError(e) });
    }
  }

  async function apply() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    const failed: { name: string; reason: string }[] = [];
    let ok = 0;
    let note: string | undefined;
    try {
      if (preview.kind === 'team') {
        // One at a time through the starter route, so each is checked and set up in payroll as from People.
        let awaiting = 0;
        for (const p of preview.r.people) {
          const site = state.sites.find((s) => s.id === (p.siteId ?? siteId));
          if (!site) {
            failed.push({ name: p.person.name, reason: 'No site.' });
            continue;
          }
          const base = newEmployee(site.id, site.entityId, p.person.roleIds[0], today);
          const { id: _id, startDate: _start, ...rest } = { ...base, ...p.person };
          const body: Partial<Employee> = { ...rest, ...(p.person.startDate ? { startDate: p.person.startDate } : {}), ...(p.email ? { email: p.email } : {}) };
          try {
            const saved = await api.post<Employee>('/v1/employees', body);
            if (saved.pendingPay) awaiting++;
            ok++;
          } catch (e) {
            failed.push({ name: p.person.name, reason: problem(e) });
          }
        }
        if (awaiting) note = `${awaiting} ${awaiting === 1 ? 'rate is' : 'rates are'} waiting for the finance director under Pay approvals. Until approved, those people are on nought and cannot be costed or paid.`;
      } else if (preview.kind === 'holiday') {
        for (const h of preview.r.rows) {
          try {
            await api.patch(`/v1/employees/${encodeURIComponent(h.employeeId)}`, { holiday: h.holiday });
            ok++;
          } catch (e) {
            failed.push({ name: h.name, reason: problem(e) });
          }
        }
      } else {
        const shifts = preview.r.shifts.map(({ published: _p, ...s }) => s);
        const res = await api.post<{ added: number; skipped: number; refused: { index: number; reason: string }[]; weeks: string[] }>('/v1/rota/import', { shifts });
        ok = res.added;
        const name = (i: number) => state.employees.find((e) => e.id === shifts[i].employeeId)?.name ?? 'Shift';
        for (const r of res.refused) failed.push({ name: `${name(r.index)}, ${shifts[r.index].date}`, reason: r.reason });
        note = res.weeks.length ? `Added as a draft to the weeks of ${res.weeks.join(', ')}. Open the rota for each week, check it against the forecast and publish.` : undefined;
      }
      await onDone();
      setDone({ ok, failed, note });
    } catch (e) {
      setError(problem(e));
    }
    setBusy(false);
  }

  const fields = IMPORT_FIELDS[kind];
  const headers = preview?.r.headers ?? [];
  const matched = preview?.r.columns as Record<string, number | undefined> | undefined;
  const ready = preview ? (preview.kind === 'team' ? preview.r.people.length : preview.kind === 'holiday' ? preview.r.rows.length : preview.r.shifts.length) : 0;
  const what = kind === 'team' ? (ready === 1 ? 'person' : 'people') : kind === 'holiday' ? (ready === 1 ? 'holiday balance' : 'holiday balances') : ready === 1 ? 'shift' : 'shifts';

  return (
    <div className="import-panel">
      <p className="step-intro">
        Bring your team, holiday balances and rota across from your old system in one go. Download the template and fill it in, or
        upload an export from your old rota, HR or payroll system as it is: columns are found by their names. Check the preview,
        then confirm. Nothing is saved before that.
      </p>
      <p>
        <button onClick={() => saveBytes('Preshift onboarding template.xlsx', writeXlsx(onboardingTemplate(state)))}>Download the Excel template</button>
        <span className="muted small"> With your own roles and sites listed, and how to fill in each column.</span>
      </p>

      <div className="segmented" role="tablist">
        {KINDS.map((k) => (
          <button key={k.id} role="tab" aria-selected={kind === k.id} className={kind === k.id ? 'active' : ''} onClick={() => reset(k.id)}>{k.label}</button>
        ))}
      </div>
      <p className="muted small">{KINDS.find((k) => k.id === kind)!.about}</p>

      <div className="setup-row">
        <label>
          File (.xlsx or .csv)
          <input type="file" accept=".xlsx,.csv,.txt,.xls" onChange={(e) => { const f = e.target.files?.[0]; if (f) void open(f); }} />
        </label>
        {sheets && sheets.length > 1 && (
          <label>
            Sheet
            <select value={sheetIndex} onChange={(e) => { setSheetIndex(Number(e.target.value)); setChosen({}); }}>
              {sheets.map((s, i) => <option key={i} value={i}>{s.name}</option>)}
            </select>
          </label>
        )}
        {kind !== 'holiday' && (
          <label>
            Site, where the file names none
            <select value={siteId} onChange={(e) => setSiteId(e.target.value)}>
              {state.sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
        )}
        {kind !== 'holiday' && (
          <label className="check small">
            <input type="checkbox" checked={usDates} onChange={(e) => setUsDates(e.target.checked)} /> Dates are month first (US)
          </label>
        )}
      </div>
      {error && <p className="notice error">{error}</p>}

      {preview && rows && (
        <>
          <h3 className="section-title">Columns in {fileName}</h3>
          <table className="table">
            <thead><tr><th>Preshift needs</th><th>Read from</th></tr></thead>
            <tbody>
              {Object.entries(fields).map(([field, about]) => (
                <tr key={field}>
                  <td>{about}</td>
                  <td>
                    <select
                      value={matched?.[field] !== undefined ? headers[matched[field]!] : ''}
                      onChange={(e) => setChosen((c) => ({ ...c, [field]: e.target.value }))}
                    >
                      <option value="">Not in the file</option>
                      {headers.filter((h) => h.trim()).map((h) => <option key={h} value={h}>{h}</option>)}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="small">
            <button disabled={ai.busy} onClick={() => void mapWithShifty()}>{ai.busy ? 'Shifty is reading the columns' : 'Map the columns with Shifty'}</button>
            <span className="muted"> Shifty sees the headers and the kind of value in each column. Names, emails, dates of birth and other personal details are masked before anything is sent.</span>
          </p>
          {ai.notes && <p className="notice">Shifty: {ai.notes} Check the columns above before going on.</p>}
          {ai.error && <p className="notice error">{ai.error}</p>}
          {preview.r.unused.length > 0 && <p className="muted small">Not read: {preview.r.unused.join(', ')}.</p>}

          <h3 className="section-title">Preview</h3>
          {preview.kind === 'team' && (
            <>
              <p>{preview.r.people.length} ready to add.{preview.r.existing.length ? ` ${preview.r.existing.length} already on Preshift, left out.` : ''}</p>
              {preview.r.people.some((p) => !p.person.rightToWork?.checked) && (
                <p className="small">{(() => { const n = preview.r.people.filter((p) => !p.person.rightToWork?.checked).length; return n === 1 ? '1 person has' : `${n} people have`; })()} no right to work check date: they are added but cannot be rostered until the check is recorded with a copy in Staff.</p>
              )}
              {preview.r.unknownRoles.length > 0 && <p className="notice">Roles not set up here: {preview.r.unknownRoles.map((r) => `${r.name} (${r.rows})`).join(', ')}. Add them under Set-up, Roles, then upload again, or those rows are left out.</p>}
              {preview.r.unknownSites.length > 0 && <p className="notice">Sites not set up here: {preview.r.unknownSites.map((r) => `${r.name} (${r.rows})`).join(', ')}. Those people go to the site chosen above.</p>}
            </>
          )}
          {preview.kind === 'holiday' && (
            <>
              <p>{preview.r.rows.length} balances ready{preview.r.inDays ? ', read as days and turned into hours on each person\'s contracted day' : ', in hours'}.</p>
              {preview.r.rows.length > 0 && (
                <table className="table">
                  <thead><tr><th>Name</th><th className="num">Carried over</th><th className="num">Accrued at go-live</th><th className="num">Taken at go-live</th><th className="num">Remaining on Preshift</th><th /></tr></thead>
                  <tbody>
                    {preview.r.rows.slice(0, 200).map((h) => (
                      <tr key={h.line}>
                        <td>{h.name}</td>
                        <td className="num">{h.holiday.carriedOverHours !== undefined ? hours(h.holiday.carriedOverHours) : '-'}</td>
                        <td className="num">{h.holiday.openingAccruedHours !== undefined ? hours(h.holiday.openingAccruedHours) : 'From the dates'}</td>
                        <td className="num">{h.holiday.openingTakenHours !== undefined ? hours(h.holiday.openingTakenHours) : '-'}</td>
                        <td className="num">{hours(h.remainingHours)}</td>
                        <td className="muted small">{h.note}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p className="muted small">The remaining figure is what Preshift will show today: the leave year&apos;s entitlement for fixed hours staff, holiday earned so far for irregular hours staff. Check a few against your old system before confirming. The untaken balance feeds the holiday pay accrual on the balance sheet.</p>
            </>
          )}
          {preview.kind === 'rota' && (
            <>
              <p>{preview.r.shifts.length} shifts ready{preview.r.weeks.length ? `, in the weeks of ${preview.r.weeks.join(', ')}` : ''}.{preview.r.duplicates ? ` ${preview.r.duplicates} already on the rota, left out.` : ''}</p>
              {preview.r.roleFromPerson > 0 && <p className="small">{preview.r.roleFromPerson} with no role Preshift recognises are given the person&apos;s own role.</p>}
              {preview.r.unknownRoles.length > 0 && <p className="muted small">Roles in the file not set up here: {preview.r.unknownRoles.map((r) => r.name).join(', ')}.</p>}
              {preview.r.unknownSites.length > 0 && <p className="notice">Sites not set up here: {preview.r.unknownSites.map((r) => `${r.name} (${r.rows})`).join(', ')}. Those shifts are left out.</p>}
            </>
          )}
          {'unknownPeople' in preview.r && preview.r.unknownPeople.length > 0 && (
            <p className="notice">Not on Preshift: {preview.r.unknownPeople.slice(0, 12).map((p) => `${p.name} (${p.rows})`).join(', ')}{preview.r.unknownPeople.length > 12 ? ` and ${preview.r.unknownPeople.length - 12} more` : ''}. Import the team first, or check the names match.</p>
          )}
          {preview.r.errors.length > 0 && (
            <ul className="issues">
              {preview.r.errors.slice(0, 50).map((m, i) => <li key={i} className="block">{m}</li>)}
              {preview.r.errors.length > 50 && <li className="muted">And {preview.r.errors.length - 50} more.</li>}
              <li className="muted">These rows are left out. Fix them in the file and upload it again.</li>
            </ul>
          )}

          <p>
            <button className="primary" disabled={busy || ready === 0} onClick={() => void apply()}>
              {busy ? 'Saving' : `${kind === 'holiday' ? 'Save' : 'Add'} ${ready} ${what}`}
            </button>
          </p>
        </>
      )}

      {done && (
        <div className="notice">
          {done.ok} saved.{done.failed.length ? ` ${done.failed.length} refused:` : ''} {done.note}
          {done.failed.length > 0 && (
            <ul className="issues">
              {done.failed.slice(0, 50).map((f, i) => <li key={i} className="block">{f.name}: {f.reason}</li>)}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
