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
  rota: {
    alt: 'Preshift Rota weekly grid with forecast sales, loaded labour cost, labour percentage against target and compliance flags',
    caption:
      'The week at a glance: forecast sales, fully loaded labour, labour % against the site target and anything that needs a second look before you publish.',
  },
  demand: {
    alt: 'Demand view showing hourly forecast sales and covers converted into required headcount per role',
    caption:
      'Hourly sales and covers turned into headcount per role, with the rules that drive it. This is the brief the build has to meet.',
  },
  editor: {
    alt: 'Shift editor showing the marginal cost a shift adds to the week, split into pay, holiday, NI and pension',
    caption:
      'The shift editor shows what a shift adds to the week, not rate times hours, and flags any rule it would break before you save it.',
  },
  close: {
    alt: 'Close view showing the labour accrual journal by role nominal and site tracking category, ready for Xero',
    caption:
      'Publish the rota and the labour accrual is ready to post: by role nominal and site, in Xero manual journal format, with hours for payroll.',
  },
};
const img = document.getElementById('shot-img');
const caption = document.getElementById('shot-caption');
document.querySelectorAll('.shot-tabs button').forEach((btn) => {
  btn.addEventListener('click', () => {
    const key = btn.dataset.shot;
    document.querySelectorAll('.shot-tabs button').forEach((b) => b.setAttribute('aria-selected', String(b === btn)));
    img.src = `img/${key}.webp`;
    img.alt = shots[key].alt;
    caption.textContent = shots[key].caption;
  });
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
