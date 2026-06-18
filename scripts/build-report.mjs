#!/usr/bin/env node
/**
 * Build a weekly report JSON from daily Anthropic consumption rows.
 *
 * Usage: node scripts/build-report.mjs <usage.json> <asOfDate YYYY-MM-DD>
 *
 * Input file: JSON array of { "date": "YYYY-MM-DD", "amount": 412.80 } — one row
 * per day of actual metered token spend (USD), produced by fetch-analytics.mjs
 * from the Claude Enterprise Analytics cost_report. (Before 2026-06 the source
 * was Ramp credit-card top-ups; the JSON `topups` field name is retained for
 * backward compatibility with archived reports but now holds daily actuals.)
 * Output: src/data/reports/<asOfDate>.json (validated by src/content.config.ts)
 *
 * Projection methodology (Jake Davis):
 * - Current (partial) month = month-to-date actual + trailing-two-week run rate
 *   (sum of the last ROLL_DAYS days of top-ups / ROLL_DAYS) x days left in month.
 * - Future months are projected at the average daily run rate observed over the
 *   trailing GROWTH_WINDOW_DAYS days (each month = rate x days-in-month). This
 *   replaces the older fixed growth-increment schedule: the forward forecast now
 *   tracks the actual recent run rate rather than an assumed monthly escalation.
 * - Projections are recomputed fresh from actuals every run — never anchored
 *   to a previous run's projections.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROJ_END = "2026-09";          // last projected month
const ROLL_DAYS = 14;                // trailing window for the current-month run rate
const GROWTH_WINDOW_DAYS = 45;       // trailing window for the future-month run rate

const [, , inputPath, asOfArg] = process.argv;
if (!inputPath || !/^\d{4}-\d{2}-\d{2}$/.test(asOfArg ?? "")) {
  console.error("Usage: node scripts/build-report.mjs <usage.json> <asOfDate YYYY-MM-DD>");
  process.exit(1);
}

// `topups` = daily actual-spend rows (legacy field name; see header note).
const topups = JSON.parse(readFileSync(inputPath, "utf8"))
  .map((t) => ({ date: t.date, amount: Number(t.amount) }))
  .sort((a, b) => a.date.localeCompare(b.date));
if (topups.length === 0) {
  console.error("No usage rows in input — refusing to build an empty report.");
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
const fmtLong = (s) => `${MONTH_LABELS[Number(s.slice(5, 7)) - 1]} ${Number(s.slice(8, 10))}, ${s.slice(0, 4)}`;

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

// ---- run-rate helpers ------------------------------------------------------
// Average daily spend over the trailing `days` ending at asOf (inclusive).
const dailyRateOverTrailing = (days) => {
  const start = new Date(d(asOf));
  start.setUTCDate(start.getUTCDate() - (days - 1));
  const startIso = iso(start);
  const spend = topups
    .filter((t) => t.date >= startIso && t.date <= asOf)
    .reduce((a, t) => a + t.amount, 0);
  return r2(spend / days);
};

// Current (partial) month: month-to-date actual + trailing two-week run rate
// over the days left in the month. Keeps the near-term number on the freshest signal.
const twoWeekDailyRate = dailyRateOverTrailing(ROLL_DAYS);
const currentMonthActual = byMonth.has(asOfMonth) ? byMonth.get(asOfMonth).total : 0;
const daysRemainingInMonth = Math.max(0, daysInMonth(asOfMonth) - asOfDay);
const rollingMonthProjection = r2(currentMonthActual + twoWeekDailyRate * daysRemainingInMonth);

// Future months: average daily run rate over the trailing 45 days, applied to
// each month's day count. No assumed escalation — the slope is whatever the
// recent run rate implies.
const growthWindowDailyRate = dailyRateOverTrailing(GROWTH_WINDOW_DAYS);

// ---- projections -----------------------------------------------------------
const complete = monthly.filter((m) => m.kind === "actual");
if (complete.length < 1) {
  console.error("Need at least one complete month to anchor the projection timeline.");
  process.exit(1);
}
const lastComplete = complete[complete.length - 1];

const projections = [];
let cumProj = lastComplete.cumulative; // timeline: complete actuals + projected months
let ym = nextMonth(lastComplete.month);
while (ym <= PROJ_END) {
  const isCurrentMonth = ym === asOfMonth;
  const total = isCurrentMonth
    ? rollingMonthProjection
    : r2(growthWindowDailyRate * daysInMonth(ym));
  cumProj = r2(cumProj + total);
  projections.push({
    month: ym,
    label: label(ym),
    kind: "proj",
    topups: null,
    total,
    momChange: null, // run-rate basis carries no assumed month-over-month increment
    dailyBurn: isCurrentMonth ? r2(total / daysInMonth(ym)) : growthWindowDailyRate,
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

// Daily metered data has no meaningful "gap between charges", so the old
// top-up cadence series is not produced for analytics-sourced reports.

// ---- metrics ---------------------------------------------------------------
const totalActual = r2(topups.reduce((a, t) => a + t.amount, 0));
const currentRow = monthly.find((m) => m.month === asOfMonth && m.kind.startsWith("actual"));
const currentMonthProjected =
  projections.find((p) => p.month === asOfMonth)?.total ?? currentRow?.total ?? 0;
const currentDailyBurn = currentRow?.dailyBurn ?? 0;
const lastProj = projections[projections.length - 1];

const report = {
  date: asOf,
  source: "analytics", // Claude Enterprise Analytics cost_report (actual metered consumption)
  title: `Report for ${label(asOfMonth)} ${asOfDay}, ${asOf.slice(0, 4)}`.replace(` ${asOf.slice(0, 4)} `, " "),
  generatedAt: new Date().toISOString(),
  dataStart: topups[0].date,
  dataEnd: topups[topups.length - 1].date,
  topups: topups.map((t) => ({ date: t.date, amount: r2(t.amount) })),
  monthly,
  weekly,
  metrics: {
    totalActual,
    totalTopups: topups.length,
    currentMonthProjected: r2(currentMonthProjected),
    currentDailyBurn,
    lastProjectedMonth: lastProj.month,
    lastProjectedMonthTotal: lastProj.total,
    cumulativeProjected: r2(projections.reduce((a, p) => a + p.total, 0)),
    annualizedRunRate: r2(currentDailyBurn * 365),
    avgDaysBetweenTopupsLast4Weeks: null, // not meaningful for daily metered data
    twoWeekDailyRate,
  },
  methodology: {
    currentMonthMethod: "trailing-two-week-run-rate",
    rollingWindowDays: ROLL_DAYS,
    twoWeekDailyRate,
    currentMonthActualToDate: r2(currentMonthActual),
    futureMonthMethod: "trailing-45-day-run-rate",
    growthWindowDays: GROWTH_WINDOW_DAYS,
    growthWindowDailyRate,
    note:
      `Current month (${label(asOfMonth)}) is projected as month-to-date actual ` +
      `($${r2(currentMonthActual).toLocaleString("en-US")}) plus the trailing ${ROLL_DAYS}-day run rate ` +
      `($${twoWeekDailyRate.toLocaleString("en-US")}/day) over the ${daysRemainingInMonth} day(s) left in the month. ` +
      `Future months (through ${label(PROJ_END)}) are projected at the average daily run rate over the trailing ` +
      `${GROWTH_WINDOW_DAYS} days ($${growthWindowDailyRate.toLocaleString("en-US")}/day) applied to each month's day count, ` +
      `so the forecast tracks the recent run rate rather than an assumed monthly escalation. ` +
      `Projections are recomputed fresh from actuals each week.`,
  },
};

// fix title formatting (e.g. "Report for Jun 11, 2026")
report.title = `Report for ${MONTH_LABELS[Number(asOfMonth.slice(5)) - 1]} ${asOfDay}, ${asOf.slice(0, 4)}`;

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const reportsDir = join(repoRoot, "src", "data", "reports");

// ---- analysis paragraph (exec summary for Teams / leadership) ---------------
// Compare against the previous report (newest file dated before asOf) to surface
// what changed this week. Generated here so it lives in the report data.
let prevReport = null;
try {
  const prevFiles = readdirSync(reportsDir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f.slice(0, 10) < asOf)
    .sort();
  if (prevFiles.length) {
    prevReport = JSON.parse(readFileSync(join(reportsDir, prevFiles[prevFiles.length - 1]), "utf8"));
  }
} catch {
  prevReport = null;
}

const usd = (n) => `$${Math.round(n).toLocaleString("en-US")}`;
const monthlyRunRate = r2(growthWindowDailyRate * 30); // ~monthly run rate for prose
const futureMonths = projections.filter((p) => p.month !== asOfMonth);
const lastCompleteBurn = r2(lastComplete.total / daysInMonth(lastComplete.month));
const ratePctVsLastMonth = lastCompleteBurn ? (growthWindowDailyRate - lastCompleteBurn) / lastCompleteBurn : 0;
const trendWord =
  Math.abs(ratePctVsLastMonth) < 0.05 ? "holding roughly flat"
  : ratePctVsLastMonth > 0 ? `trending up about ${Math.round(ratePctVsLastMonth * 100)}%`
  : `easing about ${Math.round(Math.abs(ratePctVsLastMonth) * 100)}%`;

// Transition note: shown when this report's data source differs from the prior
// report's (e.g. the first report after switching from Ramp top-ups to the
// Analytics API), explaining why the headline numbers differ from past weeks.
const isTransition = !prevReport || prevReport.source !== "analytics";
const transitionNote = isTransition
  ? `Note: starting with this report, figures reflect actual metered token consumption pulled directly ` +
    `from Anthropic's Enterprise Analytics API, replacing the earlier estimate based on credit-card top-ups. ` +
    `Totals therefore differ from prior weeks — actual usage runs a few percent below the prepaid top-ups, ` +
    `and the numbers are now true daily consumption rather than lumpy prepayment charges. `
  : "";

// Week-over-week clause only when the prior report used the same (analytics) basis.
let weekClause = "";
if (prevReport && prevReport.source === "analytics") {
  const prevKeys = new Set((prevReport.topups ?? []).map((t) => `${t.date}|${t.amount}`));
  const fresh = topups.filter((t) => !prevKeys.has(`${t.date}|${r2(t.amount)}`));
  const freshSpend = r2(fresh.reduce((a, t) => a + t.amount, 0));
  weekClause = fresh.length
    ? `Since the ${fmtLong(prevReport.date)} report, ${usd(freshSpend)} of additional usage has posted. `
    : `No additional usage has posted since the ${fmtLong(prevReport.date)} report. `;
}

const futureClause = futureMonths.length
  ? `${futureMonths.map((p) => `${usd(p.total)} in ${p.label}`).join(", ")}`
  : "";

report.analysis =
  transitionNote +
  `Anthropic token spend totals ${usd(totalActual)} across ${topups.length} days of metered usage from ` +
  `${fmtLong(report.dataStart)} through ${fmtLong(report.dataEnd)}. ${weekClause}` +
  `Spend is running near ${usd(growthWindowDailyRate)}/day (about ${usd(monthlyRunRate)}/month) and is ${trendWord} ` +
  `versus ${label(lastComplete.month)}. ${label(asOfMonth)} is projected to finish around ${usd(report.metrics.currentMonthProjected)} ` +
  (futureClause ? `(${usd(currentMonthActual)} booked to date), with the trailing 45-day run rate putting ${futureClause}. ` : `. `) +
  `Cumulative spend through ${label(PROJ_END)} is projected at roughly ${usd(lastProj.cumulative)}.`;

const outPath = join(reportsDir, `${asOf}.json`);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n");
console.log(`Wrote ${outPath}`);
console.log(
  `  days=${report.metrics.totalTopups} totalActual=$${totalActual} ` +
    `2wkRate=$${twoWeekDailyRate}/d 45dRate=$${growthWindowDailyRate}/d currentMonthProj=$${report.metrics.currentMonthProjected}`
);
