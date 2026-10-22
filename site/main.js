// Preshift Rota marketing site. No dependencies.

// Mobile nav
const toggle = document.querySelector('.nav-toggle');
const links = document.getElementById('nav-links');
toggle.addEventListener('click', () => {
  const open = links.classList.toggle('open');
  toggle.setAttribute('aria-expanded', String(open));
  toggle.textContent = open ? 'Close' : 'Menu';
});
links.addEventListener('click', (e) => {
  if (e.target.tagName === 'A') {
    links.classList.remove('open');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.textContent = 'Menu';
  }
});

// Product screen tabs
const shots = {
  sites: {
    alt: 'Group view of three sites across two companies: forecast sales, loaded labour, labour percentage against target, and the group rota P&L',
    caption:
      'Every site and company on one page: forecast sales, fully loaded labour and labour % against target, with the group rota P&L down to contribution after labour.',
  },
  rota: {
    alt: "Rota service timeline for Marylebone: each day's shifts over its sales curve, hours short or over beneath, day labour percentage and the rota P&L",
    caption:
      "Each day's shifts laid over its sales curve, with the hours short or over beneath and the day's labour % beside it. Drag a shift to move it; the rota P&L on the right updates as you go.",
  },
  editor: {
    alt: 'Shift editor showing what a shift adds to the week, here nothing because it is covered by guaranteed hours already paid',
    caption:
      'The shift editor shows what a shift adds to the week, not rate times hours. This one adds nothing: it sits inside guaranteed hours you already pay for.',
  },
  demand: {
    alt: 'Demand view: hourly forecast sales and covers for one day, and the headcount each role needs against what is rostered',
    caption:
      'Hourly sales and covers turned into headcount per role, with where the rota runs over or short. This is the brief the build has to meet.',
  },
  payroll: {
    alt: 'Payroll view: people set up in TeamPay, clocked hours, manager approval, hours sent and the pay run back, with shifts below the legal break minimum listed',
    caption:
      'From clocked hours to TeamPay and back: approve, send, and reconcile the pay run to the accrual. Shifts below the legal break minimum are listed for a manager to check first.',
  },
  close: {
    alt: 'Close view: labour accrual journals, Employment Allowance used against employer NI, and cross-site labour recharges',
    caption:
      'The labour accrual journal for each company, ready to post before payroll runs, with Employment Allowance and cross-site recharges worked out for you.',
  },
  hr: {
    alt: 'HR overview: headcount, staff turnover, absence and a list of HR actions to close',
    caption:
      'Headcount, turnover and absence for the site, and every open HR action in one list: return to work conversations, expiring licences, missing contracts.',
  },
};
const tabs = [...document.querySelectorAll('.shot-tabs [role="tab"]')];
const img = document.getElementById('shot-img');
const panel = document.getElementById('shot-panel');
const caption = document.getElementById('shot-caption');

function selectShot(tab, focus = false) {
  const key = tab.dataset.shot;
  for (const t of tabs) {
    const on = t === tab;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
  }
  img.src = `img/${key}.webp`;
  img.alt = shots[key].alt;
  caption.textContent = shots[key].caption;
  panel.setAttribute('aria-labelledby', tab.id);
  if (focus) tab.focus();
}

tabs.forEach((tab, i) => {
  tab.addEventListener('click', () => selectShot(tab));
  tab.addEventListener('keydown', (e) => {
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    selectShot(tabs[(next + tabs.length) % tabs.length], true);
  });
});

// Load the other screens once the page has settled, so switching tabs is instant.
window.addEventListener('load', () => {
  for (const key of Object.keys(shots)) new Image().src = `img/${key}.webp`;
});

// Reveal on scroll
const io = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        entry.target.classList.add('in');
        io.unobserve(entry.target);
      }
    }
  },
  { threshold: 0.12 },
);
document.querySelectorAll('.reveal').forEach((el) => io.observe(el));

// True cost calculator. Mirrors employeeWeekCost in src/engine/cost.ts:
// on-costs are worked on the whole week, so the shift's cost is the week
// with it minus the week without it.
const RATES = {
  holiday: 0.1207,
  niRate: 0.15,
  niThreshold: 96,
  pensionLower: 120,
  pensionUpper: 967,
  pensionRate: 0.03,
};

function weekCost(hours, rate, contracted, pension) {
  const gross = Math.max(hours, contracted) * rate;
  const holiday = gross * RATES.holiday;
  const earnings = gross + holiday;
  const ni = Math.max(0, earnings - RATES.niThreshold) * RATES.niRate;
  const pen = pension
    ? Math.max(0, Math.min(earnings, RATES.pensionUpper) - RATES.pensionLower) * RATES.pensionRate
    : 0;
  return { gross, holiday, ni, pension: pen, total: gross + holiday + ni + pen };
}

const $ = (id) => document.getElementById(id);
const gbp = (n) => '£' + n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const gbp0 = (n) => '£' + Math.round(n).toLocaleString('en-GB');

function updateCalc() {
  const rate = Number($('i-rate').value);
  const hours = Number($('i-hours').value);
  const week = Number($('i-week').value);
  const contracted = Number($('i-contract').value);
  const pension = $('i-pension').checked;

  $('o-rate').textContent = gbp(rate);
  $('o-hours').textContent = hours + 'h';
  $('o-week').textContent = week + 'h';
  $('o-contract').textContent = contracted + 'h';

  const before = weekCost(week, rate, contracted, pension);
  const after = weekCost(week + hours, rate, contracted, pension);
  const d = {
    gross: after.gross - before.gross,
    holiday: after.holiday - before.holiday,
    ni: after.ni - before.ni,
    pension: after.pension - before.pension,
    total: after.total - before.total,
  };
  const naive = rate * hours;

  $('r-naive').textContent = gbp0(naive);
  $('r-marginal').textContent = gbp0(d.total);
  $('r-gross').textContent = gbp(d.gross);
  $('r-holiday').textContent = gbp(d.holiday);
  $('r-ni').textContent = gbp(d.ni);
  $('r-pension').textContent = gbp(d.pension);
  $('r-total').textContent = gbp(d.total);

  const diff = d.total - naive;
  const pct = naive > 0 ? Math.round((diff / naive) * 100) : 0;
  let verdict;
  if (d.total < 0.005) {
    verdict = 'This shift sits inside guaranteed contracted hours. You are already paying for it, so it adds <b>nothing</b> to the week. Rate times hours would have told you to cut it.';
  } else if (diff > 0) {
    verdict = `This shift costs <b>${gbp(diff)} more</b> than the rota tool shows, ${pct}% on top of the headline rate. Multiply that across every shift in the week and you have the gap between the rota and the P&L.`;
  } else {
    verdict = `This shift costs <b>${gbp(-diff)} less</b> than rate times hours, because part of it is already covered by guaranteed hours.`;
  }
  $('r-verdict').innerHTML = verdict;
}

['i-rate', 'i-hours', 'i-week', 'i-contract', 'i-pension'].forEach((id) => $(id).addEventListener('input', updateCalc));
updateCalc();
