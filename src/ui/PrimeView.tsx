import { useEffect, useMemo, useState } from 'react';
import { MENU_ACTION, menuEngineering, weekPrime, type CategoryCost, type MenuClass } from '../engine/prime';
import { addDays, weekDates, weekStart } from '../engine/time';
import type { Dish, DishSales, Purchase, RotaState, StockCount, TimeEntry } from '../engine/types';
import { api } from './api';
import { dayLabel, money, money2, pct } from './format';
import { Kpi } from './Kpi';
import { useTimeEntries } from './useTimeEntries';

interface Props {
  state: RotaState;
  siteId: string;
  week: string;
  asOf: string;
}

const CLASS_TONE: Record<MenuClass, string> = { Star: 'good', Plowhorse: 'warn', Puzzle: '', Dog: 'bad' };

type CostOfSales = { dishes: Dish[]; dishSales: DishSales[]; purchases: Purchase[]; stockCounts: StockCount[] };

export function PrimeView(props: Props) {
  const [feed, setFeed] = useState<CostOfSales | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    api.get<CostOfSales>('/v1/prime').then(setFeed, (e: Error) => setFailed(e.message));
  }, []);
  // The stock count closes the week, so the full view is for a closed week; the open week runs on recipe cost.
  const closedWeek = weekDates(props.week).every((d) => d < props.asOf) ? props.week : addDays(weekStart(props.asOf), -7);
  const { entries, error } = useTimeEntries(props.siteId, closedWeek, props.asOf);
  if (failed || error) return <p className="muted">{failed ?? error}</p>;
  if (!feed || !entries) return <p className="muted">Loading cost of sales and clocked hours.</p>;
  if (feed.dishes.length === 0 && feed.purchases.length === 0) {
    return <p className="muted">No menu, purchases or stock counts recorded for this site yet. Prime cost needs the till's dish sales, supplier invoices and the weekly stock count.</p>;
  }
  return <Prime {...props} state={{ ...props.state, ...feed }} entries={entries} closedWeek={closedWeek} />;
}

function Prime({ state, siteId, asOf, entries, closedWeek }: Props & { entries: TimeEntry[]; closedWeek: string }) {
  const p = useMemo(() => weekPrime(state, entries, siteId, closedWeek, asOf), [state, entries, siteId, closedWeek, asOf]);
  const live = useMemo(() => weekPrime(state, entries, siteId, weekStart(asOf), asOf), [state, entries, siteId, asOf]);
  const menu = useMemo(() => menuEngineering(state, siteId, closedWeek, asOf), [state, siteId, closedWeek, asOf]);
  const over = p.varianceToTarget > 0;
  const leakage = (p.food.leakage ?? 0) + (p.drink.leakage ?? 0);

  if (p.sales === 0) return <p className="muted">No traded sales for this week yet.</p>;

  return (
    <div className="prime">
      <p className="muted intro">
        Prime cost is labour plus cost of sales: what the two costs a site controls take from every pound sold. Week
        commencing {dayLabel(closedWeek).date}, cost of sales{' '}
        {p.costBasis === 'actual' ? 'from the stock counts and invoices' : 'from recipe cost until the stock count is in'}.
      </p>

      <section className="kpis">
        <Kpi label="Prime cost" value={pct(p.primePct)} hint={`Target ${pct(p.targetPct)} · ${over ? '+' : ''}${money(p.varianceToTarget)}`} tone={over ? 'bad' : 'good'} />
        <Kpi label="Food GP" value={p.food.gpPct === null ? 'n/a' : pct(p.food.gpPct)} hint={`Recipes say ${pct(p.food.theoreticalGpPct)}`} tone={gpTone(p.food)} />
        <Kpi label="Drink GP" value={p.drink.gpPct === null ? 'n/a' : pct(p.drink.gpPct)} hint={`Recipes say ${pct(p.drink.theoreticalGpPct)}`} tone={gpTone(p.drink)} />
        <Kpi label="Leakage" value={`${money(leakage)}/wk`} hint={`${money(leakage * 52)} a year`} tone={leakage > 0 ? 'bad' : 'good'} />
        <Kpi label="Labour" value={pct(p.labour / p.sales)} hint={money(p.labour)} />
        <Kpi label="This week so far" value={live.sales ? pct(live.primePct) : 'n/a'} hint="On recipe cost, days traded" />
      </section>

      <div className="bench-grid">
        <div className="panel">
          <h3>The week</h3>
          <div className="grid-wrap flat">
          <table className="table">
            <thead>
              <tr>
                <th />
                <th className="num">Food</th>
                <th className="num">Drink</th>
                <th className="num">Total</th>
              </tr>
            </thead>
            <tbody>
              <Line label="Sales" food={p.food.sales} drink={p.drink.sales} strong />
              <Line label="Opening stock" food={p.food.opening} drink={p.drink.opening} />
              <Line label="Purchases" food={p.food.purchases} drink={p.drink.purchases} />
              <Line label="Less closing stock" food={neg(p.food.closing)} drink={neg(p.drink.closing)} />
              <Line label="Cost of sales" food={p.food.actualCost} drink={p.drink.actualCost} strong />
              <Line label="Recipes say" food={p.food.theoreticalCost} drink={p.drink.theoreticalCost} muted />
              <Line label="Leakage" food={p.food.leakage} drink={p.drink.leakage} bad />
              <tr>
                <td>Gross profit</td>
                <td className="num">{p.food.gpPct === null ? '' : pct(p.food.gpPct)}</td>
                <td className="num">{p.drink.gpPct === null ? '' : pct(p.drink.gpPct)}</td>
                <td className="num">{pct((p.sales - p.costOfSales) / p.sales)}</td>
              </tr>
            </tbody>
            <tfoot>
              <tr>
                <th>Labour</th>
                <td colSpan={2} className="muted small num">
                  Kitchen {money(p.labourByDepartment.BOH)} · bar {money(p.labourByDepartment.BAR)} · floor {money(p.labourByDepartment.FOH)} ·
                  management {money(p.labourByDepartment.MGMT)}
                </td>
                <td className="num">{money2(p.labour)}</td>
              </tr>
              <tr>
                <th>Prime cost</th>
                <td colSpan={2} />
                <td className="num strong">{money2(p.primeCost)}</td>
              </tr>
            </tfoot>
          </table>
          </div>
        </div>

        <div className="panel">
          <h3>Who owns which number</h3>
          <div className="grid-wrap flat">
            <table className="table">
              <thead>
                <tr>
                  <th>Team</th>
                  <th className="num">Labour</th>
                  <th className="num">Cost of sales</th>
                  <th className="num">Of their sales</th>
                </tr>
              </thead>
              <tbody>
                {p.owners.map((o) => (
                  <tr key={o.owner}>
                    <td>
                      {o.owner}
                      <div className="muted small">{o.role}</div>
                    </td>
                    <td className="num">{money(o.labour)}</td>
                    <td className="num">{o.costOfSales ? money(o.costOfSales) : ''}</td>
                    <td className="num strong">{pct(o.primePct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="small muted">
            The kitchen's number is kitchen labour and food cost over food sales; the bar's is bar labour and drink cost over
            drink sales. A head chef who trades two hours of prep for a cheaper cut can see whether the kitchen came out ahead.
          </p>
          <h4>Day by day</h4>
          <div className="grid-wrap flat">
            <table className="table">
              <tbody>
                {p.days.map((d) => (
                  <tr key={d.date}>
                    <td>{dayLabel(d.date).short}</td>
                    <td className="num">{money(d.sales)}</td>
                    <td className={`num ${d.primePct > p.targetPct ? 'bad-text' : ''}`}>{d.sales ? pct(d.primePct) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="small muted">Daily prime cost uses recipe cost, the only cost of sales known each day. The week closes on the count.</p>
        </div>
      </div>

      <h3 className="section">Menu engineering</h3>
      <div className="grid-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Dish</th>
              <th className="num">Sold</th>
              <th className="num">Mix</th>
              <th className="num">Price</th>
              <th className="num">Recipe cost</th>
              <th className="num">GP</th>
              <th className="num">Cash margin</th>
              <th className="num">Week's margin</th>
              <th>Class</th>
            </tr>
          </thead>
          <tbody>
            {menu.map((m) => (
              <tr key={m.dishId}>
                <td>
                  {m.name}
                  <div className="muted small">{m.category === 'food' ? 'Food' : 'Drink'}</div>
                </td>
                <td className="num">{m.units}</td>
                <td className="num">{pct(m.mix, 0)}</td>
                <td className="num">{money2(m.price)}</td>
                <td className="num">{money2(m.recipeCost)}</td>
                <td className="num">{pct(m.gpPct, 0)}</td>
                <td className="num">{money2(m.margin)}</td>
                <td className="num strong">{money(m.totalMargin)}</td>
                <td className={`${CLASS_TONE[m.menuClass]}-text`} title={MENU_ACTION[m.menuClass]}>
                  {m.menuClass}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="small muted legend">
        {(Object.keys(MENU_ACTION) as MenuClass[]).map((c) => (
          <li key={c}>
            <span className={`${CLASS_TONE[c]}-text strong`}>{c}</span>: {MENU_ACTION[c]}
          </li>
        ))}
      </ul>
      <p className="small muted">
        GP percentage and cash margin tell different stories. The lamb for two runs at a lower GP than the soup and earns
        many times more per plate: guests pay in pounds, not percentages. Prices are net of VAT.
      </p>
    </div>
  );
}

function gpTone(c: CategoryCost) {
  if (c.gpPct === null) return '';
  return 1 - c.gpPct > c.targetCostPct ? 'bad' : 'good';
}

const neg = (v: number | null) => (v === null ? null : -v);

function Line(props: { label: string; food: number | null; drink: number | null; strong?: boolean; muted?: boolean; bad?: boolean }) {
  const { label, food, drink } = props;
  const total = food === null || drink === null ? null : food + drink;
  const cls = `num ${props.strong ? 'strong' : ''} ${props.muted ? 'muted' : ''} ${props.bad && (total ?? 0) > 0 ? 'bad-text' : ''}`;
  const cell = (v: number | null) => (v === null ? <span className="muted">Awaiting count</span> : money2(v));
  return (
    <tr>
      <td className={props.muted ? 'muted' : ''}>{label}</td>
      <td className={cls}>{cell(food)}</td>
      <td className={cls}>{cell(drink)}</td>
      <td className={cls}>{cell(total)}</td>
    </tr>
  );
}
