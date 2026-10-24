import { describe, expect, it } from 'vitest';
import { weekFlash } from './actuals';
import { menuEngineering, weekPrime } from './prime';
import { addDays } from './time';
import type { DaySales, Dish, DishSales, Employee, Purchase, RotaState, StockCount, TimeEntry } from './types';

const WEEK = '2026-10-12'; // a Monday
const NEXT = addDays(WEEK, 7);
const SUNDAY_BEFORE = addDays(WEEK, -1);
const SUNDAY = addDays(WEEK, 6);

const dish = (id: string, category: Dish['category'], price: number, recipeCost: number): Dish => ({ id, siteId: 'mar', name: id, category, price, recipeCost });
const menu = [dish('steak', 'food', 20, 8), dish('soup', 'food', 6, 1), dish('wine', 'drink', 6, 1.2)];

const chef: Employee = {
  id: 'c',
  name: 'Chef',
  siteId: 'mar',
  entityId: 'co',
  coverSiteIds: [],
  roleIds: ['chef'],
  payBasis: 'hourly',
  hourlyRate: 15,
  annualSalary: 0,
  dateOfBirth: '1990-01-01',
  contractedHours: 0,
  maxWeeklyHours: 60,
  optedOutOf48: true,
  irregularHours: true,
  pensionEnrolled: true,
  availability: [],
  leave: [],
};

/** The chef's clocking for the day, as main records it. */
const entries: TimeEntry[] = [
  { id: 'k1', employeeId: 'c', siteId: 'mar', roleId: 'chef', shiftId: 's1', date: WEEK, clockIn: 600, clockOut: 1080, breakMinutes: 30, status: 'approved', source: 'clock' },
];

/** One trading day: £400 of sales, of which the till shows £340 food and £60 drink. */
function state(over: Partial<RotaState> = {}): RotaState {
  const date = WEEK;
  const sales: DaySales[] = [{ siteId: 'mar', date, netSales: 400, covers: 20, source: 'till' }];
  const dishSales: DishSales[] = [
    { siteId: 'mar', date, dishId: 'steak', units: 14 },
    { siteId: 'mar', date, dishId: 'soup', units: 10 },
    { siteId: 'mar', date, dishId: 'wine', units: 10 },
  ];
  const purchases: Purchase[] = [
    { id: 'p1', siteId: 'mar', date: addDays(WEEK, 1), supplier: 'Butcher', category: 'food', amount: 300 },
    { id: 'p2', siteId: 'mar', date: addDays(WEEK, 2), supplier: 'Butcher', category: 'food', amount: -20 },
    { id: 'p3', siteId: 'mar', date: addDays(WEEK, 1), supplier: 'Wine', category: 'drink', amount: 50 },
  ];
  const stockCounts: StockCount[] = [
    { siteId: 'mar', date: SUNDAY_BEFORE, category: 'food', value: 500 },
    { siteId: 'mar', date: SUNDAY, category: 'food', value: 600 },
    { siteId: 'mar', date: SUNDAY_BEFORE, category: 'drink', value: 1000 },
    { siteId: 'mar', date: SUNDAY, category: 'drink', value: 1030 },
  ];
  const shift = { id: 's1', employeeId: 'c', roleId: 'chef', siteId: 'mar', date, startMinute: 600, endMinute: 1080, breakMinutes: 30 };
  return {
    entities: [{ id: 'co', name: 'Co Ltd', companyNumber: '1', payeReference: '1/A', intercompanyCode: '1990' }],
    sites: [{ id: 'mar', name: 'Marylebone', entityId: 'co', labourTargetPct: 0.28, trackingCode: 'Marylebone', openMinute: 660, closeMinute: 1380, foodCostTargetPct: 0.3, drinkCostTargetPct: 0.2 }],
    roles: [{ id: 'chef', name: 'Chef', department: 'BOH', nominalCode: '7001' }],
    employees: [chef],
    shifts: [shift],
    forecast: [],
    demandRules: [],
    sales,
    dishes: menu,
    dishSales,
    purchases,
    stockCounts,
    ...over,
  };
}

describe('cost of sales', () => {
  const p = weekPrime(state(), entries, 'mar', WEEK, NEXT);

  it('splits sales by the till mix so the categories add back to net sales', () => {
    expect(p.food.sales).toBeCloseTo(340, 2);
    expect(p.drink.sales).toBeCloseTo(60, 2);
    expect(p.sales).toBeCloseTo(400, 2);
  });

  it('works cost of sales as opening plus purchases less closing, credit notes included', () => {
    expect(p.food).toMatchObject({ opening: 500, purchases: 280, closing: 600, actualCost: 180 });
    expect(p.drink.actualCost).toBe(20);
    expect(p.costBasis).toBe('actual');
  });

  it('measures leakage against what the recipes say', () => {
    // 14 steaks at £8 and 10 soups at £1.
    expect(p.food.theoreticalCost).toBe(122);
    expect(p.food.leakage).toBe(58);
    expect(p.food.gpPct).toBeCloseTo((340 - 180) / 340, 5);
  });

  it('falls back to the recipes while the week is open and the closing count is not in', () => {
    const open = weekPrime(state(), entries, 'mar', WEEK, addDays(WEEK, 2));
    expect(open.costBasis).toBe('theoretical');
    expect(open.food.actualCost).toBeNull();
    expect(open.costOfSales).toBeCloseTo(open.food.theoreticalCost + open.drink.theoreticalCost, 2);
  });
});

describe('prime cost', () => {
  const p = weekPrime(state(), entries, 'mar', WEEK, NEXT);

  it('adds clocked, loaded labour to cost of sales', () => {
    expect(p.labour).toBeGreaterThan(7.5 * 15);
    expect(p.labourByDepartment.BOH).toBe(p.labour);
    expect(p.primeCost).toBeCloseTo(p.costOfSales + p.labour, 2);
    expect(p.primePct).toBeCloseTo(p.primeCost / 400, 5);
  });

  it('sets the target from the sales mix', () => {
    expect(p.targetPct).toBeCloseTo((0.3 * 340 + 0.2 * 60) / 400 + 0.28, 5);
    expect(p.varianceToTarget).toBeCloseTo(p.primeCost - p.targetPct * 400, 1);
  });

  it('gives the kitchen its own number: kitchen labour and food cost over food sales', () => {
    const kitchen = p.owners.find((o) => o.owner === 'Kitchen')!;
    expect(kitchen.primePct).toBeCloseTo((p.labourByDepartment.BOH + 180) / 340, 5);
  });

  it('reports a daily figure on recipe cost, the only cost of sales known each day', () => {
    const monday = p.days[0];
    expect(monday.theoreticalCost).toBe(122 + 12);
    expect(p.days.slice(1).every((d) => d.sales === 0)).toBe(true);
  });
});

describe('menu engineering', () => {
  it('classes dishes on popularity and cash margin within their category', () => {
    const four = [dish('a', 'food', 20, 6), dish('b', 'food', 10, 6), dish('c', 'food', 25, 5), dish('d', 'food', 8, 6)];
    const sales: DishSales[] = [
      { siteId: 'mar', date: WEEK, dishId: 'a', units: 40 },
      { siteId: 'mar', date: WEEK, dishId: 'b', units: 40 },
      { siteId: 'mar', date: WEEK, dishId: 'c', units: 5 },
      { siteId: 'mar', date: WEEK, dishId: 'd', units: 5 },
    ];
    const by = Object.fromEntries(menuEngineering(state({ dishes: four, dishSales: sales }), 'mar', WEEK, NEXT).map((m) => [m.dishId, m.menuClass]));
    expect(by).toEqual({ a: 'Star', b: 'Plowhorse', c: 'Puzzle', d: 'Dog' });
  });
});

describe('reconciliation', () => {
  it('reports the same sales and labour as the labour flash', () => {
    const p = weekPrime(state(), entries, 'mar', WEEK, NEXT);
    const f = weekFlash(state(), entries, 'mar', WEEK, NEXT);
    expect(p.sales).toBeCloseTo(f.actualSales, 2);
    expect(p.labour).toBeCloseTo(f.actualCost, 2);
  });
});
