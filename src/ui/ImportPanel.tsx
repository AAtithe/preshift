import { useEffect, useMemo, useState } from 'react';
import { describeAgentError, createBrowserClient } from '../ai/rotaAgent';
import { IMPORT_FIELDS, mapColumnsWithAI, type ImportKind } from '../ai/importMapper';
import { parseCsv } from '../engine/bookingImport';
import { normal } from '../engine/externalImport';
import { onboardingTemplate } from '../engine/importTemplate';
import type { Employee, HrRecord, RotaState } from '../engine/types';
import { isXls, readXls } from '../engine/xls';
import { readXlsx, writeXlsx, type Sheet } from '../engine/xlsx';
import { api, ApiError } from './api';
import { IMPORT_ALIASES, IMPORT_KINDS, planImport, type UndoCall } from './importPlan';

interface Batch {
  id: string;
  kind: string;
  file: string;
  at: string;
  by: string;
  items: { label: string; undo: UndoCall | null }[];
  undoneAt?: string;
  undoneBy?: string;
  undoFailed?: { label: string; reason: string }[];
}

// Set-up, Import: the team, right to work, HR files and documents, training, holiday and TOIL
// balances at go-live, absences, and the rota ahead, from an Excel workbook or CSV: the onboarding
// template or an export from the old system. Columns are matched by name; any can be chosen by hand,
// or Shifty maps them from the headers and the kind of value in each, never anyone's personal details.
// Nothing is saved until the preview has been read and confirmed.

const problem = (e: unknown) => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));

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
  const named = sheets.findIndex((s) => s.name.toLowerCase() === IMPORT_KINDS.find((k) => k.id === kind)!.sheet.toLowerCase());
  if (named >= 0 && sheets[named].rows.length > 1) return named;
  const known = new Set(Object.values(IMPORT_ALIASES[kind]).flat());
  const score = (s: Sheet) => s.rows.slice(0, 10).flat().filter((c) => known.has(normal(c))).length;
  return sheets.reduce((best, s, i) => (score(s) > score(sheets[best]) ? i : best), 0);
}

type Done = { ok: number; failed: { name: string; reason: string }[]; notes: string[] };

export function ImportPanel({ state, onDone, initialKind }: { state: RotaState; onDone: () => Promise<void>; initialKind?: ImportKind }) {
  const [kind, setKind] = useState<ImportKind>(initialKind ?? 'team');
  const [sheets, setSheets] = useState<Sheet[] | null>(null);
  const [fileName, setFileName] = useState('');
  const [sheetIndex, setSheetIndex] = useState(0);
  const [siteId, setSiteId] = useState(state.sites[0]?.id ?? '');
  const [usDates, setUsDates] = useState(false);
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [ai, setAi] = useState<{ busy: boolean; notes?: string; error?: string }>({ busy: false });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  // Training and documents already on file, so the same certificate is not recorded twice.
  const [hrRecords, setHrRecords] = useState<HrRecord[]>([]);
  const today = new Date().toISOString().slice(0, 10);
  const [batches, setBatches] = useState<Batch[]>([]);
  const loadBatches = () => api.get<Batch[]>('/v1/import/batches').then(setBatches).catch(() => setBatches([]));
  useEffect(() => { void loadBatches(); }, []);

  // Sign-ins already here, so a manager is not invited twice.
  const [users, setUsers] = useState<{ email: string }[]>([]);
  useEffect(() => {
    if (kind !== 'managers') return;
    api.get<{ email: string }[] | { users: { email: string }[] }>('/v1/users').then((r) => setUsers(Array.isArray(r) ? r : r.users ?? [])).catch(() => setUsers([]));
  }, [kind, done]);

  useEffect(() => {
    if (kind !== 'training' && kind !== 'documents' && kind !== 'reviews') return;
    api.get<HrRecord[]>('/v1/hr/records').then(setHrRecords).catch(() => setHrRecords([]));
  }, [kind, done]);

  const rows = sheets?.[sheetIndex]?.rows ?? null;
  const plan = useMemo(
    () => (rows ? planImport({ kind, rows, state, hrRecords, users, today, siteId, usDates, columns: chosen }) : null),
    [rows, kind, state, hrRecords, users, today, siteId, usDates, chosen],
  );

  function choose(next: ImportKind) {
    setKind(next);
    setChosen({});
    setAi({ busy: false });
    setDone(null);
    setError(null);
    // The same workbook serves every tab: each opens on its own sheet.
    if (sheets) setSheetIndex(bestSheet(sheets, next));
  }

  async function open(file: File) {
    setError(null);
    setDone(null);
    setChosen({});
    setAi({ busy: false });
    setFileName(file.name);
    try {
      // Workbooks are told apart by their contents, not their name: .xlsx is a zip, .xls a compound file.
      const bytes = /\.(csv|txt|tsv)$/i.test(file.name) ? null : new Uint8Array(await file.arrayBuffer());
      const list = !bytes ? [{ name: file.name, rows: parseCsv(await file.text()) }] : isXls(bytes) ? readXls(bytes) : await readXlsx(bytes);
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
      setAi({ busy: false, notes: m.notes });
    } catch (e) {
      setAi({ busy: false, error: describeAgentError(e) });
    }
  }

  async function apply() {
    if (!plan) return;
    setError(null);
    const result: Done = { ok: 0, failed: [], notes: [] };
    let awaitingPay = 0;
    // What each saved row was, and how to put it back, kept as one upload.
    const items: { label: string; undo: UndoCall | null }[] = [];
    // One call at a time, each through the same checks as the screens, so one refusal stops nothing else.
    for (const [i, call] of plan.calls.entries()) {
      setBusy(`Saving ${i + 1} of ${plan.calls.length}`);
      try {
        const res = await (call.method === 'POST' ? api.post<unknown>(call.path, call.body) : call.method === 'PUT' ? api.put<unknown>(call.path, call.body) : api.patch<unknown>(call.path, call.body));
        // Anything that needs the new record's id, such as its clock card, goes straight after it.
        for (const t of call.then?.(res) ?? []) {
          try {
            await (t.method === 'PUT' ? api.put(t.path, t.body) : t.method === 'POST' ? api.post(t.path, t.body) : api.patch(t.path, t.body));
          } catch (e) {
            result.failed.push({ name: `${call.label} (clock card)`, reason: problem(e) });
          }
        }
        const undo = call.undo(res);
        if (undo.length) for (const u of undo) items.push({ label: call.label, undo: u });
        else items.push({ label: call.label, undo: null });
        if (call.path === '/v1/import/hours') {
          const r = res as { added: string[]; skipped: number; refused: { index: number; reason: string }[] };
          result.ok += r.added.length;
          for (const x of r.refused.slice(0, 50)) result.failed.push({ name: `Row ${x.index + 1}`, reason: x.reason });
          if (r.skipped) result.notes.push(`${r.skipped} already held, left as they were.`);
        } else if (call.path === '/v1/sales') {
          result.ok += (res as { upserted: number }).upserted;
        } else if (call.path === '/v1/rota/import') {
          const r = res as { added: number; refused: { index: number; reason: string }[]; weeks: string[] };
          const shifts = (call.body as { shifts: { employeeId: string; date: string }[] }).shifts;
          result.ok += r.added;
          for (const x of r.refused) result.failed.push({ name: `${state.employees.find((e) => e.id === shifts[x.index].employeeId)?.name ?? 'Shift'}, ${shifts[x.index].date}`, reason: x.reason });
          if (r.weeks.length) result.notes.push(`Added as a draft to the weeks of ${r.weeks.join(', ')}. Open the rota for each week, check it against the forecast and publish.`);
        } else {
          if ((res as Employee | undefined)?.pendingPay) awaitingPay++;
          result.ok++;
        }
      } catch (e) {
        result.failed.push({ name: call.label, reason: problem(e) });
      }
    }
    if (items.length) {
      try {
        await api.post('/v1/import/batches', { kind, file: fileName || 'file', items });
        result.notes.push('Kept under Recent uploads below, where it can be undone.');
      } catch (e) {
        result.notes.push(`The upload is saved, but it could not be recorded for undo: ${problem(e)}`);
      }
      void loadBatches();
    }
    if (awaitingPay) result.notes.push(`${awaitingPay} ${awaitingPay === 1 ? 'rate is' : 'rates are'} waiting for the finance director under Pay approvals. Until approved, those people are on nought and cannot be costed or paid.`);
    const next = IMPORT_KINDS[IMPORT_KINDS.findIndex((k) => k.id === kind) + 1];
    if (next && !result.failed.length) result.notes.push(`Next: ${next.label}.`);
    await onDone();
    setDone(result);
    setBusy(null);
  }

  async function undoBatch(b: Batch) {
    if (!window.confirm(`Undo ${b.kind} from ${b.file}, saved by ${b.by}? Each of its ${b.items.length} rows is put back as it was before.`)) return;
    const failed: { label: string; reason: string }[] = [];
    // Newest first, so later rows that depend on earlier ones go before them.
    for (const [i, item] of [...b.items].reverse().entries()) {
      setBusy(`Undoing ${i + 1} of ${b.items.length}`);
      const u = item.undo;
      if (!u) {
        failed.push({ label: item.label, reason: 'This row cannot be undone automatically. Correct it by hand.' });
        continue;
      }
      try {
        if (u.method === 'DELETE') await api.del(u.path);
        else if (u.method === 'POST') await api.post(u.path, u.body);
        else if (u.method === 'PUT') await api.put(u.path, u.body);
        else await api.patch(u.path, u.body);
      } catch (e) {
        failed.push({ label: item.label, reason: problem(e) });
      }
    }
    try {
      await api.post(`/v1/import/batches/${encodeURIComponent(b.id)}/undone`, { failed });
    } catch (e) {
      setError(problem(e));
    }
    setBusy(null);
    await onDone();
    await loadBatches();
    setDone({ ok: b.items.length - failed.length, failed: failed.map((f) => ({ name: f.label, reason: f.reason })), notes: [failed.length ? 'Undone, except the rows listed.' : 'Undone: everything from that upload is back as it was.'] });
  }

  const fields = IMPORT_FIELDS[kind];
  const about = IMPORT_KINDS.find((k) => k.id === kind)!.about;

  return (
    <div className="import-panel">
      <p className="step-intro">
        Bring everything across from your old system: the team and managers, right to work checks, HR files, training and reviews,
        holiday and TOIL balances, absences, past hours, takings and the rota ahead. Download the template and fill it in, or upload
        exports from your old rota, HR or payroll system as they are (.xlsx, .xls or .csv): columns are found by their names. Work
        through the tabs in order. Each shows a preview, nothing is saved until you confirm it, and every upload can be undone.
      </p>
      <p>
        <button onClick={() => saveBytes('Preshift Rota onboarding template.xlsx', writeXlsx(onboardingTemplate(state)))}>Download the Excel template</button>
        <span className="muted small"> One sheet for each tab, with your own roles and sites listed and how to fill in each column.</span>
      </p>

      <div className="segmented" role="tablist">
        {IMPORT_KINDS.map((k, i) => (
          <button key={k.id} role="tab" aria-selected={kind === k.id} className={kind === k.id ? 'active' : ''} onClick={() => choose(k.id)}>{i + 1}. {k.label}</button>
        ))}
      </div>
      <p className="muted small">{about}</p>

      <div className="setup-row">
        <label>
          File (.xlsx, .xls or .csv)
          <input type="file" accept=".xlsx,.csv,.txt,.xls" onChange={(e) => { const f = e.target.files?.[0]; if (f) void open(f); e.target.value = ''; }} />
        </label>
        {sheets && sheets.length > 1 && (
          <label>
            Sheet
            <select value={sheetIndex} onChange={(e) => { setSheetIndex(Number(e.target.value)); setChosen({}); setDone(null); }}>
              {sheets.map((s, i) => <option key={i} value={i}>{s.name}</option>)}
            </select>
          </label>
        )}
        {(kind === 'team' || kind === 'rota' || kind === 'takings') && (
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

      {plan && (
        <>
          <h3 className="section-title">Columns in {fileName}{sheets && sheets.length > 1 ? `, ${sheets[sheetIndex].name}` : ''}</h3>
          <table className="table">
            <thead><tr><th>Preshift Rota needs</th><th>Read from</th></tr></thead>
            <tbody>
              {Object.entries(fields).map(([field, label]) => (
                <tr key={field}>
                  <td>{label}</td>
                  <td>
                    <select value={plan.columns[field] !== undefined ? plan.headers[plan.columns[field]!] : ''} onChange={(e) => setChosen((c) => ({ ...c, [field]: e.target.value }))}>
                      <option value="">Not in the file</option>
                      {plan.headers.filter((x) => x.trim()).map((x) => <option key={x} value={x}>{x}</option>)}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="small">
            <button disabled={ai.busy} onClick={() => void mapWithShifty()}>{ai.busy ? 'Shifty is reading the columns' : 'Map the columns with Shifty'}</button>
            <span className="muted"> Shifty sees the headers and the kind of value in each column. Names, emails, dates of birth, NI numbers and other personal details are masked before anything is sent.</span>
          </p>
          {ai.notes && <p className="notice">Shifty: {ai.notes} Check the columns above before going on.</p>}
          {ai.error && <p className="notice error">{ai.error}</p>}
          {plan.unused.length > 0 && <p className="muted small">Not read: {plan.unused.join(', ')}.</p>}

          <h3 className="section-title">Preview</h3>
          {plan.info.map((m, i) => <p key={i} className={i ? 'small' : undefined}>{m}</p>)}
          {plan.warnings.map((m, i) => <p key={i} className="notice">{m}</p>)}
          {plan.unknownPeople.length > 0 && (
            <p className="notice">
              Not on Preshift Rota: {plan.unknownPeople.slice(0, 12).map((x) => `${x.name} (${x.rows})`).join(', ')}
              {plan.unknownPeople.length > 12 ? ` and ${plan.unknownPeople.length - 12} more` : ''}. Import the team first, or check the names match.
            </p>
          )}
          {plan.table && plan.table.rows.length > 0 && (
            <div className="grid-wrap">
              <table className="table">
                <thead><tr>{plan.table.head.map((x, i) => <th key={i}>{x}</th>)}</tr></thead>
                <tbody>{plan.table.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className={j === r.length - 1 && c.length > 30 ? 'muted small' : undefined}>{c}</td>)}</tr>)}</tbody>
              </table>
            </div>
          )}
          {plan.errors.length > 0 && (
            <ul className="issues">
              {plan.errors.slice(0, 50).map((m, i) => <li key={i} className="block">{m}</li>)}
              {plan.errors.length > 50 && <li className="muted">And {plan.errors.length - 50} more.</li>}
              <li className="muted">These rows are left out. Fix them in the file and upload it again.</li>
            </ul>
          )}

          <p>
            <button className="primary" disabled={!!busy || plan.ready === 0} onClick={() => void apply()}>
              {busy ?? `${plan.verb} ${plan.ready} ${plan.noun}`}
            </button>
          </p>
        </>
      )}

      {batches.length > 0 && (
        <>
          <h3 className="section-title">Recent uploads</h3>
          <table className="table">
            <thead><tr><th>Upload</th><th>File</th><th className="num">Rows</th><th>Saved</th><th /></tr></thead>
            <tbody>
              {batches.slice(0, 10).map((b) => (
                <tr key={b.id}>
                  <td>{IMPORT_KINDS.find((k) => k.id === b.kind)?.label ?? b.kind}</td>
                  <td className="muted">{b.file}</td>
                  <td className="num">{b.items.length}</td>
                  <td className="muted small">{new Date(b.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} by {b.by}</td>
                  <td>
                    {b.undoneAt
                      ? <span className="muted small">Undone {b.undoneAt.slice(0, 10)}{b.undoFailed?.length ? `, ${b.undoFailed.length} rows by hand` : ''}</span>
                      : <button className="link" disabled={!!busy} onClick={() => void undoBatch(b)}>Undo</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {done && (
        <div className="notice" role="status">
          {done.ok} saved.{done.failed.length ? ` ${done.failed.length} refused:` : ''} {done.notes.join(' ')}
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
