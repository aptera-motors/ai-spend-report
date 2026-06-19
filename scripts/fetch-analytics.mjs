#!/usr/bin/env node
/**
 * Pull report data from the Claude Enterprise Analytics API and write it in the
 * shape build-report.mjs consumes.
 *
 * Usage:
 *   node scripts/fetch-analytics.mjs <asOfDate YYYY-MM-DD> [startDate]
 * Defaults: start = 2026-02-01.
 *
 * Writes scripts/usage-<asOfDate>.json — an object with:
 *   daily:           [{ date, amount }]                 actual daily USD consumption
 *   byModel:         [{ date, family, amount }]         daily USD by model family (Opus/Sonnet/Haiku/Fable)
 *   activeUsers:     [{ date, dau, wau, mau, seats }]   daily active-user counts + assigned seats
 *   topUsersMonth:   [{ name, amount }]                 top 10 spenders this calendar month
 *   topUsersAllTime: [{ name, amount }]                 top 10 spenders since `start`
 * (Older reports used a bare [{date,amount}] array; build-report still accepts that.)
 *
 * Names are abbreviated to "First L." here so full names / emails never land in
 * the committed (public) report. Key is read only from ANTHROPIC_ANALYTICS_KEY.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const key = process.env.ANTHROPIC_ANALYTICS_KEY;
if (!key) {
  console.error(
    "ANTHROPIC_ANALYTICS_KEY is not set. Decrypt the DPAPI key file into the env first:\n" +
      '  $sec = Get-Content "$env:USERPROFILE\\.secrets\\anthropic-analytics-key.dpapi" | ConvertTo-SecureString\n' +
      '  $env:ANTHROPIC_ANALYTICS_KEY = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))'
  );
  process.exit(1);
}

const [, , asOfArg, startArg] = process.argv;
if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfArg ?? "")) {
  console.error("Usage: node scripts/fetch-analytics.mjs <asOfDate YYYY-MM-DD> [startDate]");
  process.exit(1);
}
const ASOF = asOfArg;
const START = startArg || "2026-02-01";

const BASE = "https://api.anthropic.com/v1/organizations/analytics";
const d = (s) => new Date(s + "T00:00:00Z");
const isoT = (dt) => dt.toISOString();
const ymd = (dt) => dt.toISOString().slice(0, 10);
const r2 = (n) => Math.round(n * 100) / 100;
const FAMILIES = ["Opus", "Sonnet", "Haiku", "Fable"];
const famOf = (model) => {
  const m = (model || "").toLowerCase();
  if (m.includes("opus")) return "Opus";
  if (m.includes("sonnet")) return "Sonnet";
  if (m.includes("haiku")) return "Haiku";
  if (m.includes("fable")) return "Fable";
  return null; // tools / unknown — counted in daily totals, not in the family breakdown
};

// Split [start, end) into <=31-day windows (API caps a query at a 31-day span).
function windows(start, end) {
  const out = [];
  let cur = d(start);
  const stop = d(end);
  while (cur < stop) {
    const next = new Date(cur);
    next.setUTCDate(next.getUTCDate() + 31);
    out.push([new Date(cur), next < stop ? next : stop]);
    cur = next;
  }
  return out;
}

async function apiGet(path, params, soft = false) {
  const u = new URL(`${BASE}/${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v == null) continue;
    if (Array.isArray(v)) v.forEach((x) => u.searchParams.append(k, x));
    else u.searchParams.set(k, String(v));
  }
  const res = await fetch(u, { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } });
  const text = await res.text();
  if (!res.ok) {
    if (soft) {
      console.warn(`WARN ${res.status} on ${path} (continuing): ${text.slice(0, 160)}`);
      return null;
    }
    console.error(`HTTP ${res.status} on ${path}:\n${text}`);
    process.exit(1);
  }
  return JSON.parse(text);
}

async function apiGetAll(path, params, dataKey, soft = false) {
  let page = null;
  let out = [];
  do {
    const j = await apiGet(path, page ? { ...params, page } : params, soft);
    if (!j) break;
    out = out.concat(j[dataKey] ?? j.data ?? []);
    page = j.has_more ? j.next_page : null;
  } while (page);
  return out;
}

const fmtName = (actor) => {
  const full = (actor?.name || actor?.email?.split("@")[0] || "Unknown").trim();
  const parts = full.split(/\s+/);
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
};

// ---- daily totals (authoritative) ------------------------------------------
const perDayTotal = new Map();
for (const [s, e] of windows(START, ASOF)) {
  const buckets = await apiGetAll("cost_report", { starting_at: isoT(s), ending_at: isoT(e), bucket_width: "1d" }, "data");
  for (const b of buckets) {
    const day = (b.starting_at || "").slice(0, 10);
    if (!day) continue;
    for (const r of b.results || []) perDayTotal.set(day, (perDayTotal.get(day) || 0) + (Number(r.amount) || 0));
  }
}

// ---- daily spend by model family -------------------------------------------
const perDayFamily = new Map(); // day -> { fam: cents }
for (const [s, e] of windows(START, ASOF)) {
  const buckets = await apiGetAll("cost_report", { starting_at: isoT(s), ending_at: isoT(e), bucket_width: "1d", "group_by[]": "model" }, "data");
  for (const b of buckets) {
    const day = (b.starting_at || "").slice(0, 10);
    if (!day) continue;
    for (const r of b.results || []) {
      const fam = famOf(r.model);
      if (!fam) continue;
      if (!perDayFamily.has(day)) perDayFamily.set(day, {});
      const o = perDayFamily.get(day);
      o[fam] = (o[fam] || 0) + (Number(r.amount) || 0);
    }
  }
}

// ---- active users ----------------------------------------------------------
// Engagement data lags ~2-3 days, so cap the window short of asOf and treat the
// call as non-fatal (active users must never block the cost report).
const engEndDt = new Date(d(ASOF));
engEndDt.setUTCDate(engEndDt.getUTCDate() - 2);
const engEnd = ymd(engEndDt); // exclusive
const activeUsers = [];
for (const [s, e] of engEnd > START ? windows(START, engEnd) : []) {
  const arr = await apiGetAll("summaries", { starting_date: ymd(s), ending_date: ymd(e) }, "summaries", true);
  for (const x of arr) {
    activeUsers.push({
      date: (x.starting_at || "").slice(0, 10),
      dau: x.daily_active_user_count ?? null,
      wau: x.weekly_active_user_count ?? null,
      mau: x.monthly_active_user_count ?? null,
      seats: x.assigned_seat_count ?? null,
    });
  }
}
activeUsers.sort((a, b) => a.date.localeCompare(b.date));

// ---- top spenders: this month ----------------------------------------------
const monthStart = `${ASOF.slice(0, 7)}-01`;
const monthRows = await apiGetAll("user_cost_report", { starting_at: isoT(d(monthStart)), ending_at: isoT(d(ASOF)), limit: 1000 }, "data");
const topUsersMonth = monthRows
  .map((r) => ({ name: fmtName(r.actor), amount: r2((Number(r.amount) || 0) / 100) }))
  .sort((a, b) => b.amount - a.amount)
  .slice(0, 10);

// ---- top spenders: all time (sum per user across windows) -------------------
const allByUser = new Map();
for (const [s, e] of windows(START, ASOF)) {
  const rows = await apiGetAll("user_cost_report", { starting_at: isoT(s), ending_at: isoT(e), limit: 1000 }, "data");
  for (const r of rows) {
    const id = r.actor?.user_id || r.actor?.email || fmtName(r.actor);
    const cur = allByUser.get(id) || { actor: r.actor, cents: 0 };
    cur.cents += Number(r.amount) || 0;
    allByUser.set(id, cur);
  }
}
const topUsersAllTime = [...allByUser.values()]
  .map((v) => ({ name: fmtName(v.actor), amount: r2(v.cents / 100) }))
  .sort((a, b) => b.amount - a.amount)
  .slice(0, 10);

// ---- assemble --------------------------------------------------------------
const daily = [...perDayTotal.entries()]
  .filter(([, c]) => c > 0)
  .map(([date, c]) => ({ date, amount: r2(c / 100) }))
  .sort((a, b) => a.date.localeCompare(b.date));

if (daily.length === 0) {
  console.error("No consumption rows returned — refusing to write an empty dataset.");
  process.exit(1);
}

const byModel = [];
for (const date of [...perDayFamily.keys()].sort()) {
  const o = perDayFamily.get(date);
  for (const fam of FAMILIES) {
    if (o[fam] > 0) byModel.push({ date, family: fam, amount: r2(o[fam] / 100) });
  }
}

const out = { daily, byModel, activeUsers, topUsersMonth, topUsersAllTime };
const outPath = join(repoRoot, "scripts", `usage-${ASOF}.json`);
writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
const total = r2(daily.reduce((a, t) => a + t.amount, 0));
console.log(`Wrote ${outPath}`);
console.log(
  `  days=${daily.length} total=$${total} range=${daily[0].date}..${daily[daily.length - 1].date} ` +
    `byModelRows=${byModel.length} activeUserDays=${activeUsers.length} topMonth=${topUsersMonth.length} topAll=${topUsersAllTime.length}`
);
