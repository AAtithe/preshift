/** One headline figure with its label and a line of context, in the house tile. */
export function Kpi({ label, value, hint, tone = '' }: { label: string; value: string; hint: string; tone?: string }) {
  return (
    <div className={`kpi ${tone}`}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      <div className="kpi-hint">{hint}</div>
    </div>
  );
}
