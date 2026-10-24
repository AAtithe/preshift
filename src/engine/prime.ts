import type { Department, RotaState, SalesCategory, TimeEntry } from './types';
import { actualSalesForDay, blendedShifts } from './actuals';
import { weekCost } from './cost';
import { addDays, weekDates } from './time';

export interface CategoryCost {
  sales: number;
  opening: number | null;
  purchases: number;
  closing: number | null;
  /** Opening stock plus purchases less closing stock. Null until both counts are in. */
  actualCost: number | null;
  /** What the recipes say the dishes sold should have cost. */
  theoreticalCost: number;
  /** Actual less theoretical: waste, over-portioning, over-pouring, theft, and price rises not on the recipe. */
  leakage: number | null;
  /** Gross profit as a share of sales on actual cost. */
  gpPct: number | null;
  theoreticalGpPct: number;
  targetCostPct: number;
}

export interface PrimeDay {
  date: string;
  traded: boolean;
  sales: number;
  /** Theoretical cost of sales from the till: the only cost of sales known daily. */
  theoreticalCost: number;
  labour: number;
  primePct: number;
}

export interface Owner {
  owner: 'Kitchen' | 'Bar' | 'Floor' | 'Management';
  /** The person whose number this is. */
  role: string;
  sales: number;
  labour: number;
  costOfSales: number;
  /** Labour plus cost of sales over the sales this team serves. */
  primePct: number;
}

export interface WeekPrime {
  weekStartDate: string;
  closed: boolean;
  food: CategoryCost;
  drink: CategoryCost;
  sales: number;
  /** Actual where stock counts allow, theoretical otherwise. */
  costOfSales: number;
  costBasis: 'actual' | 'theoretical';
  labour: number;
  labourByDepartment: Record<Department, number>;
  primeCost: number;
  primePct: number;
  targetPct: number;
  /** Prime cost over what the targets allow on these sales. Positive is over. */
  varianceToTarget: number;
  days: PrimeDay[];
  owners: Owner[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const ratio = (a: number, b: number) => (b > 0 ? a / b : 0);

/**
 * Sales by category for the days that have traded. The till's dish sales give
 * the food and drink mix, applied to the day's net sales so the split always
 * adds back to the sales the rest of the product reports.
 */
function salesByCategory(state: RotaState, siteId: string, date: string) {
  const total = actualSalesForDay(state, siteId, date);
  const mix = { food: 0, drink: 0, foodCost: 0, drinkCost: 0 };
  for (const s of (state.dishSales ?? []).filter((x) => x.siteId === siteId && x.date === date)) {
    const dish = (state.dishes ?? []).find((d) => d.id === s.dishId);
    if (!dish) continue;
    mix[dish.category] += s.units * dish.price;
    mix[dish.category === 'food' ? 'foodCost' : 'drinkCost'] += s.units * dish.recipeCost;
  }
  const tillTotal = mix.food + mix.drink;
  const drinkShare = tillTotal > 0 ? mix.drink / tillTotal : 0;
  return { total, food: total * (1 - drinkShare), drink: total * drinkShare, foodCost: mix.foodCost, drinkCost: mix.drinkCost };
}

/**
 * Prime cost for a week: what labour and cost of sales together take out of
 * every pound sold. Cost of sales is worked the accountant's way, opening
 * stock plus purchases less closing stock, and set against what the recipes
 * say it should have been, so the gap between the two is visible as money.
 * Labour is the clocked, loaded figure from the actuals loop. Each number is
 * also split to the person who controls it: the head chef owns kitchen labour
 * and food cost, the bar manager owns bar labour and drink cost.
 */
export function weekPrime(state: RotaState, entries: TimeEntry[], siteId: string, weekStartDate: string, asOf: string): WeekPrime {
  const site = state.sites.find((s) => s.id === siteId);
  const dates = weekDates(weekStartDate);
  const traded = dates.filter((d) => d < asOf);
  const closed = traded.length === 7;

  const daily = dates.map((date) => ({ date, traded: date < asOf, ...(date < asOf ? salesByCategory(state, siteId, date) : { total: 0, food: 0, drink: 0, foodCost: 0, drinkCost: 0 }) }));

  // Labour on clocked hours, costed on each person's whole week, by department of the role worked.
  const shifts = blendedShifts(state, entries, asOf);
  const cost = weekCost({ employees: state.employees, shifts }, weekStartDate, siteId);
  const department = (roleId: string): Department => state.roles.find((r) => r.id === roleId)?.department ?? 'FOH';
  const labourByDepartment: Record<Department, number> = { FOH: 0, BAR: 0, BOH: 0, MGMT: 0 };
  const labourByDay = new Map<string, number>();
  for (const s of shifts) {
    const c = cost.shifts.get(s.id);
    if (!c || !traded.includes(s.date)) continue;
    labourByDepartment[department(s.roleId)] += c.total;
    labourByDay.set(s.date, (labourByDay.get(s.date) ?? 0) + c.total);
  }
  // Paid but not on the clock (salaried, guaranteed hours): their primary role, spread over the days traded.
  for (const [employeeId, ec] of cost.employees) {
    if (shifts.some((s) => s.employeeId === employeeId && cost.shifts.has(s.id))) continue;
    const employee = state.employees.find((e) => e.id === employeeId);
    const share = (ec.total * traded.length) / 7;
    labourByDepartment[department(employee?.roleIds[0] ?? '')] += share;
    for (const d of traded) labourByDay.set(d, (labourByDay.get(d) ?? 0) + share / traded.length);
  }

  const category = (c: SalesCategory): CategoryCost => {
    const sales = daily.reduce((s, d) => s + d[c], 0);
    const theoreticalCost = daily.reduce((s, d) => s + d[c === 'food' ? 'foodCost' : 'drinkCost'], 0);
    const count = (date: string) => (state.stockCounts ?? []).find((x) => x.siteId === siteId && x.category === c && x.date === date)?.value ?? null;
    const opening = count(addDays(weekStartDate, -1));
    const closing = closed ? count(addDays(weekStartDate, 6)) : null;
    const purchases = (state.purchases ?? [])
      .filter((p) => p.siteId === siteId && p.category === c && p.date >= weekStartDate && p.date <= addDays(weekStartDate, 6) && p.date < asOf)
      .reduce((s, p) => s + p.amount, 0);
    const actualCost = opening !== null && closing !== null ? opening + purchases - closing : null;
    const target = c === 'food' ? site?.foodCostTargetPct ?? 0.28 : site?.drinkCostTargetPct ?? 0.22;
    return {
      sales: round2(sales),
      opening,
      purchases: round2(purchases),
      closing,
      actualCost: actualCost === null ? null : round2(actualCost),
      theoreticalCost: round2(theoreticalCost),
      leakage: actualCost === null ? null : round2(actualCost - theoreticalCost),
      gpPct: actualCost === null ? null : ratio(sales - actualCost, sales),
      theoreticalGpPct: ratio(sales - theoreticalCost, sales),
      targetCostPct: target,
    };
  };

  const food = category('food');
  const drink = category('drink');
  const sales = food.sales + drink.sales;
  const actual = food.actualCost !== null && drink.actualCost !== null;
  const foodCost = food.actualCost ?? food.theoreticalCost;
  const drinkCost = drink.actualCost ?? drink.theoreticalCost;
  const costOfSales = foodCost + drinkCost;
  const labour = Object.values(labourByDepartment).reduce((s, v) => s + v, 0);
  const primeCost = costOfSales + labour;
  const targetPct = ratio(food.targetCostPct * food.sales + drink.targetCostPct * drink.sales, sales) + (site?.labourTargetPct ?? 0);

  const days: PrimeDay[] = daily.map((d) => {
    const theoreticalCost = d.foodCost + d.drinkCost;
    const dayLabour = labourByDay.get(d.date) ?? 0;
    return { date: d.date, traded: d.traded, sales: round2(d.total), theoreticalCost: round2(theoreticalCost), labour: round2(dayLabour), primePct: ratio(theoreticalCost + dayLabour, d.total) };
  });

  const owners: Owner[] = ([
    { owner: 'Kitchen', role: 'Head chef', sales: food.sales, labour: labourByDepartment.BOH, costOfSales: foodCost, primePct: 0 },
    { owner: 'Bar', role: 'Bar manager', sales: drink.sales, labour: labourByDepartment.BAR, costOfSales: drinkCost, primePct: 0 },
    { owner: 'Floor', role: 'General manager', sales, labour: labourByDepartment.FOH, costOfSales: 0, primePct: 0 },
    { owner: 'Management', role: 'Operations', sales, labour: labourByDepartment.MGMT, costOfSales: 0, primePct: 0 },
  ] as Owner[]).map((o) => ({ ...o, labour: round2(o.labour), costOfSales: round2(o.costOfSales), primePct: ratio(o.labour + o.costOfSales, o.sales) }));

  return {
    weekStartDate,
    closed,
    food,
    drink,
    sales: round2(sales),
    costOfSales: round2(costOfSales),
    costBasis: actual ? 'actual' : 'theoretical',
    labour: round2(labour),
    labourByDepartment: {
      FOH: round2(labourByDepartment.FOH),
      BAR: round2(labourByDepartment.BAR),
      BOH: round2(labourByDepartment.BOH),
      MGMT: round2(labourByDepartment.MGMT),
    },
    primeCost: round2(primeCost),
    primePct: ratio(primeCost, sales),
    targetPct,
    varianceToTarget: round2(primeCost - targetPct * sales),
    days,
    owners,
  };
}

export type MenuClass = 'Star' | 'Plowhorse' | 'Puzzle' | 'Dog';

export interface MenuItem {
  dishId: string;
  name: string;
  category: SalesCategory;
  units: number;
  price: number;
  recipeCost: number;
  /** Cash gross profit per unit. */
  margin: number;
  gpPct: number;
  /** Share of units sold within its category. */
  mix: number;
  totalMargin: number;
  menuClass: MenuClass;
}

export const MENU_ACTION: Record<MenuClass, string> = {
  Star: 'Popular and profitable. Protect the recipe and the price; feature it.',
  Plowhorse: 'Popular, thin margin. Re-cost the recipe or nudge the price before touching anything else.',
  Puzzle: 'Profitable, slow. Move it up the menu, rename it, have the team recommend it.',
  Dog: 'Slow and thin. Replace it unless it earns its place another way.',
};

/**
 * Menu engineering for the week, by category: popularity against the classic
 * 70% of an even share, cash margin against the category's weighted average.
 * Chefs see which dishes carry the gross profit and which only carry volume.
 */
export function menuEngineering(state: RotaState, siteId: string, weekStartDate: string, asOf: string): MenuItem[] {
  const dates = new Set(weekDates(weekStartDate).filter((d) => d < asOf));
  const units = new Map<string, number>();
  for (const s of (state.dishSales ?? []).filter((x) => x.siteId === siteId && dates.has(x.date))) units.set(s.dishId, (units.get(s.dishId) ?? 0) + s.units);
  const items: MenuItem[] = [];
  for (const category of ['food', 'drink'] as const) {
    const menu = (state.dishes ?? []).filter((d) => d.siteId === siteId && d.category === category);
    const sold = menu.reduce((s, d) => s + (units.get(d.id) ?? 0), 0);
    if (sold === 0) continue;
    const averageMargin = menu.reduce((s, d) => s + (units.get(d.id) ?? 0) * (d.price - d.recipeCost), 0) / sold;
    const popularThreshold = (1 / menu.length) * 0.7;
    for (const d of menu) {
      const u = units.get(d.id) ?? 0;
      const margin = d.price - d.recipeCost;
      const mix = u / sold;
      const popular = mix >= popularThreshold;
      const profitable = margin >= averageMargin;
      items.push({
        dishId: d.id,
        name: d.name,
        category,
        units: u,
        price: d.price,
        recipeCost: d.recipeCost,
        margin: round2(margin),
        gpPct: ratio(margin, d.price),
        mix,
        totalMargin: round2(margin * u),
        menuClass: popular ? (profitable ? 'Star' : 'Plowhorse') : profitable ? 'Puzzle' : 'Dog',
      });
    }
  }
  // Food first, then drink; within each, the dishes earning the most margin first.
  return items.sort((a, b) => b.category.localeCompare(a.category) || b.totalMargin - a.totalMargin);
}
