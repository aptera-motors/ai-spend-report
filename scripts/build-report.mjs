#!/usr/bin/env node
/**
 * Build a weekly report JSON from raw Anthropic top-up rows.
 *
 * Usage: node scripts/build-report.mjs <topups.json> <asOfDate YYYY-MM-DD>
 *
 * Input file: JSON array of { "date": "YYYY-MM-DD", "amount": 995.17 }
 * Output: src/data/reports/<asOfDate>.json (validated by src/content.config.ts)
 *
 * Projection methodology (Jake Davis):
 * - Growth increment = difference between the two most recent COMPLETE months.
 * - Months through PROJ_FULL_END grow by the full increment each month.
 * - Months after that, through PROJ_END, grow by half the increment.
 * - Projections are recomputed fresh from actuals every run — never anchored
 *   to a previous run's projections.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROJ_FULL_END = "2026-07"; // last month projected at full increment
const PROJ_END = "2026-09";      // last projected month

const [, , inputPath, asOfArg] = process.argv;
if (!inputPath || !/^\d{4}-\d{2}-\d{2}$/.test(asOfArg ?? "")) {
  console.error("Usage: node scripts/build-report.mjs <topups.json> <asOfDate YYYY-MM-DD>");
  process.exit(1);
}

const topups = JSON.parse(readFileSync(inputPath, "utf8"))
  .map((t) => ({ date: t.date, amount: Number(t.amount) }))
  .sort((a, b) => a.date.localeCompare(b.date));
if (topups.length === 0) {
  console.error("No top-up rows in input — refusing to build an empty report.");
  process.exit(1);
}

const asOf = asOfArg;
const r2 = (n) => Math.round(n * 100) / 100;
const d = (s) => new Date(s + "T00:00:00Z");
const iso = (dt) => dt.toISOString().slice(0, 10);
const monthOf = (s) => s.slice(0, 7);
const daysInMonth = (ym) => {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};
const nextMonth = (ym) => {
  const [y, m] = ym.split("-").map(Number);
  return `${m === 12 ? y + 1 : y}-${String((m % 12) + 1).padStart(2, "0")}`;
};
const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const label = (ym) => `${MONTH_LABELS[Number(ym.slice(5)) - 1]} ${ym.slice(0, 4)}`;
const dayDiff = (a, b) => Math.round((d(b) - d(a)) / 86400000);

// ---- monthly actuals -------------------------------------------------------
const asOfMonth = monthOf(asOf);
const asOfDay = Number(asOf.slice(8));
const byMonth = new Map();
for (const t of topups) {
  const ym = monthOf(t.date);
  if (!byMonth.has(ym)) byMonth.set(ym, { total: 0, count: 0 });
  const m = byMonth.get(ym);
  m.total += t.amount;
  m.count += 1;
}
const actualMonths = [...byMonth.keys()].sort();

const monthly = [];
let cumActual = 0;
let prevTotal = null;
for (const ym of actualMonths) {
  const { total, count } = byMonth.get(ym);
  const isPartial = ym === asOfMonth && asOfDay < daysInMonth(ym);
  cumActual += total;
  monthly.push({
    month: ym,
    label: label(ym),
    kind: isPartial ? "actual-partial" : "actual",
    topups: count,
    total: r2(total),
    momChange: prevTotal === null || isPartial ? null : r2(total - prevTotal),
    dailyBurn: r2(total / (isPartial ? asOfDay : daysInMonth(ym))),
    cumulative: r2(cumActual),
  });
  if (!isPartial) prevTotal = total;
}

// ---- projections -----------------------------------------------------------
const complete = monthly.filter((m) => m.kind === "actual");
if (complete.length < 2) {
  console.error("Need at least two complete months to compute the growth increment.");
  process.exit(1);
}
const basisA = complete[complete.length - 2];
const basisB = complete[complete.length - 1];
const fullIncrement = r2(basisB.total - basisA.total);
const halfIncrement = r2(fullIncrement / 2);

const projections = [];
let cumProj = basisB.cumulative; // cumulative timeline: complete actuals + projected months
let lastTotal = basisB.total;
let ym = nextMonth(basisB.month);
while (ym <= PROJ_END) {
  const half = ym > PROJ_FULL_END;
  lastTotal = r2(lastTotal + (half ? halfIncrement : fullIncrement));
  cumProj = r2(cumProj + lastTotal);
  projections.push({
    month: ym,
    label: label(ym),
    kind: half ? "proj-half" : "proj-full",
    topups: null,
    total: lastTotal,
    momChange: half ? halfIncrement : fullIncrement,
    dailyBurn: r2(lastTotal / daysInMonth(ym)),
    cumulative: cumProj,
  });
  ym = nextMonth(ym);
}
monthly.push(...projections);

// ---- weekly actuals (ISO weeks, Mon–Sun) -----------------------------------
const isoWeek = (s) => {
  const dt = d(s);
  const day = (dt.getUTCDay() + 6) % 7; // Mon=0
  const monday = new Date(dt);
  monday.setUTCDate(dt.getUTCDate() - day);
  const thursday = new Date(monday);
  thursday.setUTCDate(monday.getUTCDate() + 3);
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((thursday - yearStart) / 86400000 + 1) / 7);
  return { key: `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`, monday };
};
const byWeek = new Map();
for (const t of topups) {
  const { key, monday } = isoWeek(t.date);
  if (!byWeek.has(key)) {
    const sunday = new Date(monday);
    sunday.setUTCDate(monday.getUTCDate() + 6);
    byWeek.set(key, { start: iso(monday), end: iso(sunday), dates: [], total: 0 });
  }
  const w = byWeek.get(key);
  w.dates.push(t.date);
  w.total += t.amount;
}
const weekly = [...byWeek.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([week, w]) => ({ week, start: w.start, end: w.end, dates: w.dates, count: w.dates.length, total: r2(w.total) }));

// ---- top-up cadence --------------------------------------------------------
const cadence = topups.map((t, i) => ({
  date: t.date,
  daysSincePrev: i === 0 ? null : dayDiff(topups[i - 1].date, t.date),
}));
const cutoff = new Date(d(asOf));
cutoff.setUTCDate(cutoff.getUTCDate() - 28);
const recentGaps = cadence.filter((c) => c.daysSincePrev !== null && d(c.date) >= cutoff).map((c) => c.daysSincePrev);
const avgGap = recentGaps.length ? r2(recentGaps.reduce((a, b) => a + b, 0) / recentGaps.length) : null;

// ---- metrics ---------------------------------------------------------------
const totalActual = r2(topups.reduce((a, t) => a + t.amount, 0));
const currentRow = monthly.find((m) => m.month === asOfMonth && m.kind.startsWith("actual"));
const currentMonthProjected =
  projections.find((p) => p.month === asOfMonth)?.total ?? currentRow?.total ?? 0;
const currentDailyBurn = currentRow?.dailyBurn ?? 0;
const lastProj = projections[projections.length - 1];

const report = {
  date: asOf,
  title: `Report for ${label(asOfMonth)} ${asOfDay}, ${asOf.slice(0, 4)}`.replace(` ${asOf.slice(0, 4)} `, " "),
  generatedAt: new Date().toISOString(),
  dataStart: topups[0].date,
  dataEnd: topups[topups.length - 1].date,
  topups: topups.map((t) => ({ date: t.date, amount: r2(t.amount) })),
  monthly,
  weekly,
  cadence,
  metrics: {
    totalActual,
    totalTopups: topups.length,
    currentMonthProjected: r2(currentMonthProjected),
    currentDailyBurn,
    lastProjectedMonth: lastProj.month,
    lastProjectedMonthTotal: lastProj.total,
    cumulativeProjected: r2(projections.reduce((a, p) => a + p.total, 0)),
    annualizedRunRate: r2(currentDailyBurn * 365),
    avgDaysBetweenTopupsLast4Weeks: avgGap,
  },
  methodology: {
    basisMonths: [basisA.month, basisB.month],
    fullIncrement,
    halfIncrement,
    note:
      `Growth increment of $${fullIncrement.toLocaleString("en-US")} / month is the ` +
      `${label(basisA.month)} → ${label(basisB.month)} change in actual spend. Months through ` +
      `${label(PROJ_FULL_END)} are projected at the full increment; ` +
      `months after that through ${label(PROJ_END)} at half the increment ($${halfIncrement.toLocaleString("en-US")}/month). ` +
      `Projections are recomputed fresh from actuals each week.`,
  },
};

// fix title formatting (e.g. "Report for Jun 11, 2026")
report.title = `Report for ${MONTH_LABELS[Number(asOfMonth.slice(5)) - 1]} ${asOfDay}, ${asOf.slice(0, 4)}`;

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outPath = join(repoRoot, "src", "data", "reports", `${asOf}.json`);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n");
console.log(`Wrote ${outPath}`);
console.log(`  topups=${report.metrics.totalTopups} totalActual=$${totalActual} increment=$${fullIncrement}`);
