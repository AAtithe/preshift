// Reports across the whole app: the library of standard and saved reports, and the builder that
// makes new ones. Everything runs on the server, which keeps each person to the sites and fields
// their role opens; this screen only ever shows what came back.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { MeasureFormat, ReportArea, ReportDefinition, ReportFilter, ReportResult, RangeToken } from '../engine/reportBuilder';
import type { StandardReport } from '../engine/standardReports';
import { api, ApiError } from './api';
import { download, hours, money, pct, slug } from './format';

interface Field { id: string; label: string }
export interface CatalogueDataset {
  id: string;
  label: string;
  area: ReportArea;
  areaLabel: string;
  description: string;
  dateLabel: string;
  snapshot: boolean;
  defaultRange: RangeToken | null;
  dimensions: (Field & { type: string })[];
  measures: (Field & { format: MeasureFormat; help: string | null })[];
}
export interface Catalogue {
  areas: Record<ReportArea, string>;
  ranges: Record<RangeToken, string>;
  datasets: CatalogueDataset[];
  standard: StandardReport[];
}
export interface SavedReport {
  id: string;
  name: string;
  description?: string;
  definition: ReportDefinition;
  shared: boolean;
  createdBy: string;
  mine: boolean;
  canEdit: boolean;
  updatedAt: string;
}
type RunResult = ReportResult & { dataset: { id: string; label: string }; from: string | null; to: string | null };

/** What is open in the builder: a fresh report, a standard one, or a saved one. */
export interface Opened {
  definition: ReportDefinition;
  name: string;
  description?: string;
  saved?: SavedReport;
}

const TIME_DIMENSIONS = new Set(['day', 'week', 'month', 'quarter', 'year']);

export function formatValue(v: string | number | null, format?: MeasureFormat) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'string') return v;
  switch (format) {
    case 'money': return money(v);
    case 'percent': return pct(v);
    case 'hours': return hours(v);
    case 'days': return `${v.toFixed(1)} days`;
    case 'minutes': return `${Math.round(v)} min`;
    default: return Number.isInteger(v) ? v.toLocaleString('en-GB') : v.toLocaleString('en-GB', { maximumFractionDigits: 2 });
  }
}

/** The catalogue and saved reports, fetched once per visit. */
export function useCatalogue() {
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  const [saved, setSaved] = useState<SavedReport[]>([]);
  const [error, setError] = useState('');
  const reloadSaved = () => api.get<SavedReport[]>('/v1/reports/saved').then(setSaved).catch(() => setSaved([]));
  useEffect(() => {
    api.get<Catalogue>('/v1/reports/catalogue').then(setCatalogue).catch((e) => setError(e instanceof ApiError ? e.message : 'Reports could not be loaded.'));
    void reloadSaved();
  }, []);
  return { catalogue, saved, reloadSaved, error };
}

/** Standard and saved reports by area, each one a click from opening. */
export function ReportLibrary({ catalogue, saved, onOpen, onNew }: { catalogue: Catalogue; saved: SavedReport[]; onOpen: (o: Opened) => void; onNew: () => void }) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const matches = (name: string, description = '') => !q || `${name} ${description}`.toLowerCase().includes(q);
  const areaOf = (dataset: string) => catalogue.datasets.find((d) => d.id === dataset)?.area;
  const areas = (Object.keys(catalogue.areas) as ReportArea[]).filter((a) => catalogue.datasets.some((d) => d.area === a));
  const mine = saved.filter((r) => matches(r.name, r.description));

  return (
    <div className="report-library">
      <div className="close-actions report-actions">
        <input type="search" placeholder="Find a report" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Find a report" />
        <button className="primary" onClick={onNew}>Build a report</button>
      </div>
      {mine.length > 0 && (
        <section className="report-area">
          <h3>Saved reports</h3>
          <div className="report-cards">
            {mine.map((r) => (
              <button key={r.id} className="report-card" onClick={() => onOpen({ definition: r.definition, name: r.name, description: r.description, saved: r })}>
                <strong>{r.name}</strong>
                <span className="small muted">{r.description || catalogue.datasets.find((d) => d.id === r.definition.dataset)?.label}</span>
                <span className="tag">{r.mine ? (r.shared ? 'Yours, shared' : 'Yours') : `Shared by ${r.createdBy}`}</span>
              </button>
            ))}
          </div>
        </section>
      )}
      {areas.map((area) => {
        const reports = catalogue.standard.filter((r) => (areaOf(r.definition.dataset) ?? r.area) === area && matches(r.name, r.description));
        if (reports.length === 0) return null;
        return (
          <section key={area} className="report-area">
            <h3>{catalogue.areas[area]}</h3>
            <div className="report-cards">
              {reports.map((r) => (
                <button key={r.id} className="report-card" onClick={() => onOpen({ definition: r.definition, name: r.name, description: r.description })}>
                  <strong>{r.name}</strong>
                  <span className="small muted">{r.description}</span>
                </button>
              ))}
            </div>
          </section>
        );
      })}
      {q && mine.length === 0 && !catalogue.standard.some((r) => matches(r.name, r.description)) && <p className="muted">No report matches. Build one instead.</p>}
    </div>
  );
}

interface BuilderProps {
  catalogue: Catalogue;
  opened: Opened;
  /** Site names in the header's scope, when it is narrower than every site: applied as a filter. */
  scopeSites: string[] | null;
  onSaved: () => void;
  onBack: () => void;
}

export function ReportBuilder({ catalogue, opened, scopeSites, onSaved, onBack }: BuilderProps) {
  const [def, setDef] = useState<ReportDefinition>(opened.definition);
  const [result, setResult] = useState<RunResult | null>(null);
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState<null | { name: string; description: string; shared: boolean }>(null);
  const [saved, setSaved] = useState<SavedReport | undefined>(opened.saved);
  const [notice, setNotice] = useState('');
  const ds = catalogue.datasets.find((d) => d.id === def.dataset);

  useEffect(() => {
    setDef(opened.definition);
    setSaved(opened.saved);
    setNotice('');
  }, [opened]);

  // The header's scope narrows any report that splits by site, unless the report already filters on site.
  const effective = useMemo((): ReportDefinition => {
    const bySite = ds?.dimensions.some((d) => d.id === 'site');
    if (!scopeSites || !bySite || def.filters?.some((f) => f.field === 'site')) return def;
    return { ...def, filters: [...(def.filters ?? []), { field: 'site', op: 'is', values: scopeSites }] };
  }, [def, scopeSites, ds]);

  // Runs as the definition changes, after a short pause so typing a filter does not fire a run per key.
  const seq = useRef(0);
  useEffect(() => {
    if (!ds || def.measures.length === 0) return;
    const n = ++seq.current;
    setRunning(true);
    const t = setTimeout(() => {
      api
        .post<RunResult>('/v1/reports/run', effective)
        .then((r) => n === seq.current && (setResult(r), setError('')))
        .catch((e) => n === seq.current && setError(e instanceof ApiError ? e.message : 'The report could not be run.'))
        .finally(() => n === seq.current && setRunning(false));
    }, 250);
    return () => clearTimeout(t);
  }, [effective, ds, def.measures.length]);

  if (!ds) return <p className="muted">This report uses data your role does not open.</p>;

  const set = (patch: Partial<ReportDefinition>) => setDef((d) => ({ ...d, ...patch }));
  const dimLabel = (id: string) => ds.dimensions.find((d) => d.id === id)?.label ?? id;

  function changeDataset(id: string) {
    const next = catalogue.datasets.find((d) => d.id === id)!;
    const firstDim = next.dimensions.find((d) => d.id === 'site') ?? next.dimensions.find((d) => !TIME_DIMENSIONS.has(d.id));
    setDef({ dataset: id, groupBy: firstDim ? [firstDim.id] : [], measures: next.measures.slice(0, 2).map((m) => m.id) });
    setSaved(undefined);
  }

  const toggleMeasure = (id: string) => set({ measures: def.measures.includes(id) ? def.measures.filter((m) => m !== id) : [...def.measures, id].slice(0, 12) });
  const setGroup = (i: number, id: string) => set({ groupBy: id ? def.groupBy.map((g, j) => (j === i ? id : g)) : def.groupBy.filter((_, j) => j !== i) });
  const setFilter = (i: number, f: ReportFilter | null) => set({ filters: f ? (def.filters ?? []).map((x, j) => (j === i ? f : x)) : (def.filters ?? []).filter((_, j) => j !== i) });

  // Dates: a named range, the dataset's own default, as at today for a snapshot, or chosen dates.
  const rangeValue = def.from || def.to ? 'custom' : def.range ?? (ds.snapshot ? 'asat' : '');
  function setRange(v: string) {
    if (v === 'custom') set({ range: undefined, from: result?.from ?? undefined, to: result?.to ?? undefined });
    else set({ range: v === '' || v === 'asat' ? undefined : (v as RangeToken), from: undefined, to: undefined });
  }

  function sortBy(id: string) {
    const direction = def.sort?.by === id && def.sort.direction === 'desc' ? 'asc' : 'desc';
    set({ sort: { by: id, direction } });
  }

  async function csv() {
    const text = await api.post<string>('/v1/reports/run?format=csv', effective);
    download(`preshift-${slug(saved?.name || opened.name || ds!.label)}-${result?.to ?? 'report'}.csv`, text);
  }

  async function save(asNew: boolean) {
    if (!saving) return;
    const body = { name: saving.name, description: saving.description || undefined, shared: saving.shared, definition: def };
    try {
      const r = !asNew && saved?.canEdit ? await api.put<SavedReport>(`/v1/reports/saved/${saved.id}`, body) : await api.post<SavedReport>('/v1/reports/saved', body);
      setSaved({ ...r, mine: saved && !asNew ? saved.mine : true, canEdit: true });
      setSaving(null);
      setNotice(saving.shared ? 'Saved and shared with everyone who can read this data.' : 'Saved. Only you see it.');
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The report could not be saved.');
    }
  }

  async function remove() {
    if (!saved || !window.confirm(`Delete "${saved.name}"${saved.shared ? ' for everyone it is shared with' : ''}?`)) return;
    await api.del(`/v1/reports/saved/${saved.id}`);
    onSaved();
    onBack();
  }

  const datasetsByArea = (Object.keys(catalogue.areas) as ReportArea[]).map((a) => [a, catalogue.datasets.filter((d) => d.area === a)] as const).filter(([, list]) => list.length > 0);
  const groupable = (current?: string) => ds.dimensions.filter((d) => d.id === current || !def.groupBy.includes(d.id));
  const measureCols = result?.columns.filter((c) => c.kind === 'measure') ?? [];
  const firstMeasure = measureCols[0];
  const dimCols = result?.columns.filter((c) => c.kind === 'dimension') ?? [];
  const chartable = result && dimCols.length === 1 && firstMeasure && result.rows.length > 1 && result.rows.length <= 40;

  return (
    <div className="report-builder">
      <div className="close-actions report-actions">
        <div>
          <button className="link" onClick={onBack}>All reports</button>
          <h3 className="report-title">{saved?.name || opened.name || 'New report'}</h3>
          {(saved?.description ?? opened.description) && <p className="muted small report-description">{saved?.description ?? opened.description}</p>}
        </div>
        <div className="close-actions">
          <button onClick={() => setSaving({ name: saved?.name ?? opened.name ?? '', description: saved?.description ?? opened.description ?? '', shared: saved?.shared ?? false })}>{saved?.canEdit ? 'Save changes' : 'Save'}</button>
          {saved?.canEdit && <button onClick={remove}>Delete</button>}
          <button onClick={csv} disabled={!result}>Download CSV</button>
        </div>
      </div>
      {notice && <p className="good-text small">{notice}</p>}

      {saving && (
        <div className="card report-save">
          <label>Name<input value={saving.name} maxLength={120} onChange={(e) => setSaving({ ...saving, name: e.target.value })} autoFocus /></label>
          <label>What it is for<input value={saving.description} maxLength={500} onChange={(e) => setSaving({ ...saving, description: e.target.value })} placeholder="Optional: what to look for and what to do about it" /></label>
          <label className="check"><input type="checkbox" checked={saving.shared} onChange={(e) => setSaving({ ...saving, shared: e.target.checked })} /> Share with everyone who can read this data. Each person still sees only their own sites and fields.</label>
          <div className="close-actions">
            <button className="primary" disabled={!saving.name.trim()} onClick={() => save(false)}>{saved?.canEdit ? 'Save changes' : 'Save'}</button>
            {saved?.canEdit && <button onClick={() => save(true)}>Save as new</button>}
            <button onClick={() => setSaving(null)}>Cancel</button>
          </div>
        </div>
      )}

      <div className="report-controls card">
        <label>
          Data
          <select value={def.dataset} onChange={(e) => changeDataset(e.target.value)}>
            {datasetsByArea.map(([area, list]) => (
              <optgroup key={area} label={catalogue.areas[area]}>
                {list.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
              </optgroup>
            ))}
          </select>
          <span className="small muted">{ds.description}</span>
        </label>

        <label>
          {ds.dateLabel}
          <select value={rangeValue} onChange={(e) => setRange(e.target.value)}>
            {ds.snapshot ? <option value="asat">As at today</option> : <option value="">{catalogue.ranges[ds.defaultRange ?? 'last-12-months']} (usual)</option>}
            {(Object.keys(catalogue.ranges) as RangeToken[]).map((r) => <option key={r} value={r}>{catalogue.ranges[r]}</option>)}
            <option value="custom">Choose dates</option>
          </select>
          {rangeValue === 'custom' && (
            <span className="report-dates">
              <input type="date" value={def.from ?? ''} onChange={(e) => set({ from: e.target.value || undefined })} aria-label="From" />
              <input type="date" value={def.to ?? ''} onChange={(e) => set({ to: e.target.value || undefined })} aria-label="To" />
            </span>
          )}
        </label>

        <div className="report-field">
          <span>Split by</span>
          {def.groupBy.map((g, i) => (
            <select key={i} value={g} onChange={(e) => setGroup(i, e.target.value)} aria-label={`Split ${i + 1}`}>
              <option value="">Remove</option>
              {groupable(g).map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
            </select>
          ))}
          {def.groupBy.length < 4 && (
            <select value="" onChange={(e) => e.target.value && set({ groupBy: [...def.groupBy, e.target.value] })} aria-label="Add a split">
              <option value="">{def.groupBy.length ? 'Then by...' : 'Add a split'}</option>
              {groupable().map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
            </select>
          )}
        </div>

        <fieldset className="report-field report-measures">
          <legend>Figures</legend>
          {ds.measures.map((m) => (
            <label key={m.id} className="check" title={m.help ?? undefined}>
              <input type="checkbox" checked={def.measures.includes(m.id)} onChange={() => toggleMeasure(m.id)} /> {m.label}
            </label>
          ))}
        </fieldset>

        <div className="report-field">
          <span>Only where</span>
          {(def.filters ?? []).map((f, i) => (
            <span key={i} className="report-filter">
              <select value={f.field} onChange={(e) => setFilter(i, { ...f, field: e.target.value, values: [] })} aria-label="Filter field">
                {ds.dimensions.filter((d) => !TIME_DIMENSIONS.has(d.id)).map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
              </select>
              <select value={f.op} onChange={(e) => setFilter(i, { ...f, op: e.target.value as ReportFilter['op'] })} aria-label="Filter test">
                <option value="is">is</option>
                <option value="isNot">is not</option>
              </select>
              <FilterValues field={f.field} values={f.values} result={result} onChange={(values) => setFilter(i, { ...f, values })} />
              <button className="link" onClick={() => setFilter(i, null)} aria-label="Remove filter">Remove</button>
            </span>
          ))}
          {(def.filters ?? []).length < 10 && (
            <button className="link" onClick={() => set({ filters: [...(def.filters ?? []), { field: def.groupBy.find((g) => !TIME_DIMENSIONS.has(g)) ?? ds.dimensions.find((d) => !TIME_DIMENSIONS.has(d.id))!.id, op: 'is', values: [] }] })}>
              Add a filter
            </button>
          )}
          {scopeSites && ds.dimensions.some((d) => d.id === 'site') && !def.filters?.some((f) => f.field === 'site') && (
            <span className="small muted">Sites in scope: {scopeSites.join(', ')}</span>
          )}
        </div>
      </div>

      {error && <p className="bad-text">{error}</p>}
      {def.measures.length === 0 && <p className="muted">Tick at least one figure.</p>}
      {result && result.withheld.length > 0 && (
        <p className="warn-text small">
          Left out because your role does not open them at every site in this report: {result.withheld.map((id) => ds.dimensions.find((d) => d.id === id)?.label ?? ds.measures.find((m) => m.id === id)?.label ?? id).join(', ')}.
        </p>
      )}

      {result && (
        <div className={running ? 'report-result stale' : 'report-result'}>
          <p className="small muted">
            {result.from && result.to ? `${result.from} to ${result.to}. ` : 'As at today. '}
            {result.rowCount.toLocaleString('en-GB')} {result.rowCount === 1 ? 'row' : 'rows'}
            {result.truncated ? `, showing the first ${result.rows.length.toLocaleString('en-GB')}. Download the CSV or narrow the report for the rest.` : '.'}
          </p>
          {chartable && <BarChart labels={result.rows.map((r) => String(r[0] ?? 'Not given'))} values={result.rows.map((r) => r[1] as number | null)} format={firstMeasure.format} title={`${firstMeasure.label} by ${dimLabel(dimCols[0].id).toLowerCase()}`} />}
          <div className="grid-wrap">
            <table className="table report-table">
              <thead>
                <tr>
                  {result.columns.map((c) => (
                    <th key={c.id} className={c.kind === 'measure' ? 'num' : ''} aria-sort={def.sort?.by === c.id ? (def.sort.direction === 'asc' ? 'ascending' : 'descending') : undefined}>
                      <button className="sort" onClick={() => sortBy(c.id)}>
                        {c.label}
                        {def.sort?.by === c.id ? (def.sort.direction === 'asc' ? ' (low first)' : ' (high first)') : ''}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.rows.length === 0 && (
                  <tr><td colSpan={result.columns.length} className="muted">Nothing recorded for this period.</td></tr>
                )}
                {result.rows.map((row, i) => (
                  <tr key={i}>
                    {row.map((v, j) => (
                      <td key={j} className={result.columns[j].kind === 'measure' ? 'num' : ''}>
                        {result.columns[j].kind === 'dimension' && (v === null || v === '') ? <span className="muted">Not given</span> : formatValue(v, result.columns[j].format)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
              {result.rows.length > 1 && (
                <tfoot>
                  <tr>
                    {dimCols.length > 0 && <th colSpan={dimCols.length}>Total</th>}
                    {result.totals.map((v, j) => <td key={j} className="num">{formatValue(v, measureCols[j]?.format)}</td>)}
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>
      )}
      {!result && !error && def.measures.length > 0 && <p className="muted">Running</p>}
    </div>
  );
}

/** Values to filter on, offered from the current result where the field is one of its columns. */
function FilterValues({ field, values, result, onChange }: { field: string; values: string[]; result: RunResult | null; onChange: (v: string[]) => void }) {
  const col = result?.columns.findIndex((c) => c.id === field) ?? -1;
  const seen = col >= 0 ? [...new Set(result!.rows.map((r) => r[col]).filter((v): v is string => typeof v === 'string' && v !== ''))].sort() : [];
  const [text, setText] = useState(values.join(', '));
  useEffect(() => setText(values.join(', ')), [values]);
  const id = `filter-values-${field}`;
  return (
    <>
      <input
        list={id}
        value={text}
        placeholder="Values, separated by commas"
        aria-label="Filter values"
        onChange={(e) => setText(e.target.value)}
        onBlur={() => onChange(text.split(',').map((s) => s.trim()).filter(Boolean))}
        onKeyDown={(e) => e.key === 'Enter' && onChange(text.split(',').map((s) => s.trim()).filter(Boolean))}
      />
      <datalist id={id}>{seen.map((v) => <option key={v} value={v} />)}</datalist>
    </>
  );
}

/** One figure by one split, as horizontal bars: readable at any width, labels never rotate. */
function BarChart({ labels, values, format, title }: { labels: string[]; values: (number | null)[]; format?: MeasureFormat; title: string }) {
  const nums = values.map((v) => v ?? 0);
  const max = Math.max(...nums.map(Math.abs), 0);
  if (max === 0) return null;
  return (
    <figure className="report-chart" aria-label={title}>
      <figcaption className="small muted">{title}</figcaption>
      {labels.map((l, i) => (
        <div key={i} className="report-bar">
          <span className="report-bar-label" title={l}>{l}</span>
          <span className="report-bar-track"><span className={nums[i] < 0 ? 'report-bar-fill neg' : 'report-bar-fill'} style={{ width: `${(Math.abs(nums[i]) / max) * 100}%` }} /></span>
          <span className="report-bar-value">{formatValue(values[i], format)}</span>
        </div>
      ))}
    </figure>
  );
}
