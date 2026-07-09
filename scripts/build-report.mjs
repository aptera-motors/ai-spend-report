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
 * Projection methodology (revised 2026-07-08 — "damped-growth"):
 * Spend is compounding week over week (adoption-driven), so a flat trailing
 * run-rate structurally under-projects. This model instead:
 *  - Builds a day-of-week profile: the average of the last WEEKDAY_LOOKBACK
 *    occurrences of each weekday (holidays excluded so they don't drag the level).
 *  - Fits a weekly compound growth factor g by log-linear regression on the last
 *    GROWTH_FIT_WEEKS full weeks, clamped to [G_FLOOR, G_CAP].
 *  - Extends g forward with geometric damping (φ = DAMPING_PHI per week) so the
 *    growth increment decays toward zero rather than compounding without bound.
 *    The damped series has a finite asymptote (~1 + (g−1)/(1−φ)× current level),
 *    which is a natural, self-limiting ceiling.
 *  - Projects every future day as weekday-profile × damped-growth-multiplier,
 *    treating known US holidays as Sunday-level. Current (partial) month =
 *    month-to-date actual + the projected remaining days.
 *  - Records a seat-saturation reference line (assigned seats × current
 *    per-active-user weekday intensity) as a sanity check on the ceiling.
 *  - Projections are recomputed fresh from actuals every run — never anchored
 *    to a previous run's projections. Realized error is surfaced automatically
 *    on the site's projection-accuracy table once a projected month closes.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROJ_END = "2026-09";          // last projected month
const ROLL_DAYS = 14;                // trailing window for the reported two-week run rate
const GROWTH_WINDOW_DAYS = 45;       // trailing window for the reference flat run rate
const WEEKDAY_LOOKBACK = 4;          // occurrences per weekday used to build the day-of-week profile
const GROWTH_FIT_WEEKS = 8;          // full weeks used to fit the weekly growth factor
const DAMPING_PHI = 0.85;            // per-week decay of the growth increment (0=flat, 1=undamped)
const G_CAP = 1.10;                  // clamp: no more than +10%/week sustained
const G_FLOOR = 0.95;                // clamp: no worse than −5%/week (guards against noise-driven decline)

// US holidays that materially depress usage. Federal + observed dates through the
// projection horizon. Projected on these days falls to Sunday-level.
const US_HOLIDAYS = new Set([
  "2026-01-01", // New Year's Day
  "2026-01-19", // MLK Jr. Day
  "2026-02-16", // Presidents' Day
  "2026-05-25", // Memorial Day
  "2026-06-19", // Juneteenth
  "2026-07-03", // Independence Day (observed, Fri)
  "2026-07-04", // Independence Day
  "2026-09-07", // Labor Day
  "2026-11-11", // Veterans Day
  "2026-11-26", // Thanksgiving
  "2026-11-27", // Day after Thanksgiving
  "2026-12-24", // Christmas Eve
  "2026-12-25", // Christmas Day
  "2026-12-31", // New Year's Eve
]);

const [, , inputPath, asOfArg] = process.argv;
if (!inputPath || !/^\d{4}-\d{2}-\d{2}$/.test(asOfArg ?? "")) {
  console.error("Usage: node scripts/build-report.mjs <usage.json> <asOfDate YYYY-MM-DD>");
  process.exit(1);
}

// Input is either a bare [{date,amount}] array (legacy) or an object with a
// `daily` array plus extra sections (byModel, activeUsers, top spenders).
const input = JSON.parse(readFileSync(inputPath, "utf8"));
const extra = Array.isArray(input) ? {} : input;
// `topups` = daily actual-spend rows (legacy field name; see header note).
const topups = (Array.isArray(input) ? input : input.daily ?? [])
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
const dowOf = (s) => d(s).getUTCDay(); // 0=Sun … 6=Sat

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

// ---- weekly actuals (ISO weeks, Mon–Sun) -----------------------------------
// Computed before projections because the weekly totals feed the growth fit.
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

// ---- run-rate helpers (reference metrics, not the projection basis) --------
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
const twoWeekDailyRate = dailyRateOverTrailing(ROLL_DAYS);
const growthWindowDailyRate = dailyRateOverTrailing(GROWTH_WINDOW_DAYS);

// ---- day-of-week profile ---------------------------------------------------
// Average of the last WEEKDAY_LOOKBACK non-holiday occurrences of each weekday.
const weekdayAvg = (() => {
  const buckets = [[], [], [], [], [], [], []];
  for (const t of topups) {
    if (US_HOLIDAYS.has(t.date)) continue;
    buckets[dowOf(t.date)].push(t.amount);
  }
  return buckets.map((b) => {
    const last = b.slice(-WEEKDAY_LOOKBACK);
    return last.length ? last.reduce((a, x) => a + x, 0) / last.length : 0;
  });
})();
// Mon–Fri level (the number quoted in prose / the saturation reference).
const weekdayLevel = r2((weekdayAvg[1] + weekdayAvg[2] + weekdayAvg[3] + weekdayAvg[4] + weekdayAvg[5]) / 5);

// ---- weekly compound growth factor (log-linear fit, clamped) ---------------
const weeklyGrowth = (() => {
  const fw = weekly.filter((w) => w.count === 7).slice(-GROWTH_FIT_WEEKS);
  if (fw.length < 3) return 1; // not enough history to infer a trend
  const xs = fw.map((_, i) => i);
  const ys = fw.map((w) => Math.log(w.total));
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  const num = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0);
  const den = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
  const slope = den ? num / den : 0;
  return Math.min(G_CAP, Math.max(G_FLOOR, Math.exp(slope)));
})();

// Damped cumulative growth multiplier `w` weeks ahead of asOf's week (w=0 → 1).
// Increment (g−1) decays by φ each week, so the multiplier has a finite limit.
const growthMult = (w) => {
  let m = 1;
  let inc = weeklyGrowth - 1;
  for (let k = 1; k <= w; k++) {
    m *= 1 + inc;
    inc *= DAMPING_PHI;
  }
  return m;
};
const asOfMonday = (() => {
  const dt = d(asOf);
  const day = (dt.getUTCDay() + 6) % 7;
  const m = new Date(dt);
  m.setUTCDate(dt.getUTCDate() - day);
  return m;
})();
const weeksAhead = (s) => {
  const dt = d(s);
  const day = (dt.getUTCDay() + 6) % 7;
  const m = new Date(dt);
  m.setUTCDate(dt.getUTCDate() - day);
  return Math.max(0, Math.round((m.getTime() - asOfMonday.getTime()) / (7 * 86400000)));
};

// Projected spend for one future day: weekday profile × damped growth,
// holidays dropped to Sunday level.
const projectDay = (s) => {
  const base = US_HOLIDAYS.has(s) ? weekdayAvg[0] : weekdayAvg[dowOf(s)];
  return base * growthMult(weeksAhead(s));
};
const daysOfMonth = (ym, fromDay = 1) => {
  const out = [];
  for (let day = fromDay; day <= daysInMonth(ym); day++) out.push(`${ym}-${String(day).padStart(2, "0")}`);
  return out;
};
const projectMonth = (ym) => r2(daysOfMonth(ym).reduce((a, s) => a + projectDay(s), 0));

// Current (partial) month = month-to-date actual + projected remaining days.
const currentMonthActual = byMonth.has(asOfMonth) ? byMonth.get(asOfMonth).total : 0;
const daysRemainingInMonth = Math.max(0, daysInMonth(asOfMonth) - asOfDay);
const currentMonthRemainingProj = daysOfMonth(asOfMonth, asOfDay + 1).reduce((a, s) => a + projectDay(s), 0);
const rollingMonthProjection = r2(currentMonthActual + currentMonthRemainingProj);

// ---- seat-saturation reference (sanity check, not a hard cap) --------------
const assignedSeats = extra.licenses?.assignedSeats ?? null;
const activeSeats = extra.licenses?.activeLast30 ?? null;
const perActiveUserWeekday = activeSeats && activeSeats > 0 ? r2(weekdayLevel / activeSeats) : null;
// If every assigned seat were as active as today's active users, this is the
// weekday spend level implied — a floor on the eventual ceiling.
const saturationWeekdayLevel =
  perActiveUserWeekday != null && assignedSeats ? r2(perActiveUserWeekday * assignedSeats) : null;

// ---- projections -----------------------------------------------------------
const complete = monthly.filter((m) => m.kind === "actual");
if (complete.length < 1) {
  console.error("Need at least one complete month to anchor the projection timeline.");
  process.exit(1);
}
const lastComplete = complete[complete.length - 1];

const projections = [];
let cumProj = lastComplete.cumulative; // timeline: complete actuals + projected months
let prevTimelineTotal = lastComplete.total;
let ym = nextMonth(lastComplete.month);
while (ym <= PROJ_END) {
  const isCurrentMonth = ym === asOfMonth;
  const total = isCurrentMonth ? rollingMonthProjection : projectMonth(ym);
  const dim = daysInMonth(ym);
  cumProj = r2(cumProj + total);
  projections.push({
    month: ym,
    label: label(ym),
    kind: "proj",
    topups: null,
    // Modeled month-over-month increment (damped growth); null if not increasing.
    momChange: isCurrentMonth || total <= prevTimelineTotal ? null : r2(total - prevTimelineTotal),
    total,
    dailyBurn: r2(total / dim),
    cumulative: cumProj,
  });
  prevTimelineTotal = total;
  ym = nextMonth(ym);
}
monthly.push(...projections);

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
  byModel: extra.byModel ?? [],
  activeUsers: extra.activeUsers ?? [],
  topUsersMonth: extra.topUsersMonth ?? [],
  topUsersAllTime: extra.topUsersAllTime ?? [],
  licenses: extra.licenses ?? null,
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
    saturationDailyReference: saturationWeekdayLevel,
  },
  methodology: {
    // current-month basis
    currentMonthMethod: "day-of-week-profile + damped-growth",
    rollingWindowDays: ROLL_DAYS,
    twoWeekDailyRate,
    currentMonthActualToDate: r2(currentMonthActual),
    // future-month basis
    futureMonthMethod: "damped-weekly-growth",
    growthWindowDays: GROWTH_WINDOW_DAYS,
    growthWindowDailyRate,
    weekdayLookback: WEEKDAY_LOOKBACK,
    weekdayLevel,
    growthFitWeeks: GROWTH_FIT_WEEKS,
    weeklyGrowthRate: Math.round((weeklyGrowth - 1) * 1000) / 10, // % per week, 1dp
    dampingPhi: DAMPING_PHI,
    saturationWeekdayLevel,
    perActiveUserWeekday,
    note:
      `${label(asOfMonth)} is projected as month-to-date actual ` +
      `($${r2(currentMonthActual).toLocaleString("en-US")}) plus a day-of-week spend profile ` +
      `(avg of the last ${WEEKDAY_LOOKBACK} of each weekday, ~$${weekdayLevel.toLocaleString("en-US")}/weekday) ` +
      `applied to the ${daysRemainingInMonth} remaining day(s). Future months (through ${label(PROJ_END)}) extend ` +
      `that profile at the fitted weekly growth rate of ${(((weeklyGrowth - 1) * 100)).toFixed(1)}%/week ` +
      `(log-linear fit over the last ${GROWTH_FIT_WEEKS} full weeks), damped by φ=${DAMPING_PHI} per week so the ` +
      `growth increment decays toward zero rather than compounding without bound. Known US holidays are modeled at ` +
      `Sunday level. ` +
      (saturationWeekdayLevel
        ? `Sanity check: if all ${assignedSeats} assigned seats were as active as today's ${activeSeats} active users, ` +
          `weekday spend would be ~$${saturationWeekdayLevel.toLocaleString("en-US")}/day. `
        : "") +
      `Projections are recomputed fresh from actuals each week; realized accuracy is tracked on the site as ` +
      `projected months close out.`,
  },
};

// fix title formatting (e.g. "Report for Jun 11, 2026")
report.title = `Report for ${MONTH_LABELS[Number(asOfMonth.slice(5)) - 1]} ${asOfDay}, ${asOf.slice(0, 4)}`;

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
// REPORTS_DIR overrides the output/lookup dir (used for backtesting so runs
// never touch the live src/data/reports files); defaults to the live dir.
const reportsDir = process.env.REPORTS_DIR || join(repoRoot, "src", "data", "reports");

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
const monthlyRunRate = r2(weekdayLevel * 30); // rough monthly level for prose
const futureMonths = projections.filter((p) => p.month !== asOfMonth);
const lastCompleteBurn = r2(lastComplete.total / daysInMonth(lastComplete.month));
const trendWord =
  Math.abs(weeklyGrowth - 1) < 0.01 ? "roughly flat"
  : weeklyGrowth > 1 ? `growing about ${((weeklyGrowth - 1) * 100).toFixed(1)}%/week`
  : `declining about ${((1 - weeklyGrowth) * 100).toFixed(1)}%/week`;

// One-time methodology-change note: shown only when the previous report used a
// different future-month method (i.e. the first report on the new model). It
// auto-disappears next week once the prior report also carries the new marker.
const isMethodologyChange = prevReport && prevReport.methodology?.futureMonthMethod !== "damped-weekly-growth";
const changeNote = isMethodologyChange
  ? `Methodology update (${fmtLong(asOf)}): projections now use a day-of-week spend profile extended at the ` +
    `fitted weekly growth rate with damping, replacing the flat trailing run-rate. The prior method assumed a ` +
    `constant daily rate, which structurally under-projected a spend base that has been compounding week over ` +
    `week — May and June both finished roughly 10%+ above their run-rate projections, and future months no longer ` +
    `step down on calendar-day count alone. Forward figures are correspondingly higher and now trend upward month ` +
    `over month. `
  : "";

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
  ? `the model putting ${futureMonths.map((p) => `${usd(p.total)} in ${p.label}`).join(", ")}`
  : "";

report.analysis =
  changeNote +
  transitionNote +
  `Anthropic token spend totals ${usd(totalActual)} across ${topups.length} days of metered usage from ` +
  `${fmtLong(report.dataStart)} through ${fmtLong(report.dataEnd)}. ${weekClause}` +
  `Recent spend runs near ${usd(weekdayLevel)}/weekday (roughly ${usd(monthlyRunRate)}/month) and is ${trendWord}. ` +
  `${label(asOfMonth)} is projected to finish around ${usd(report.metrics.currentMonthProjected)} ` +
  `(${usd(currentMonthActual)} booked to date)` +
  (futureClause ? `, with ${futureClause}. ` : `. `) +
  `Cumulative spend through ${label(PROJ_END)} is projected at roughly ${usd(lastProj.cumulative)}.`;

const outPath = join(reportsDir, `${asOf}.json`);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n");
console.log(`Wrote ${outPath}`);
console.log(
  `  days=${report.metrics.totalTopups} totalActual=$${totalActual} ` +
    `weekdayLevel=$${weekdayLevel}/wd g=${(((weeklyGrowth - 1) * 100)).toFixed(1)}%/wk φ=${DAMPING_PHI} ` +
    `currentMonthProj=$${report.metrics.currentMonthProjected} ` +
    `Aug=$${projections.find((p) => p.month === "2026-08")?.total ?? "-"} ` +
    `Sep=$${projections.find((p) => p.month === "2026-09")?.total ?? "-"}`
);
