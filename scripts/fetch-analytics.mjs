#!/usr/bin/env node
/**
 * Pull actual daily token-consumption cost from the Claude Enterprise Analytics
 * API (cost_report) and write it in the {date, amount} shape build-report.mjs
 * consumes. This replaces the old Ramp top-up pull as the report's data source.
 *
 * Usage:
 *   node scripts/fetch-analytics.mjs <asOfDate YYYY-MM-DD> [startDate]
 * Defaults: start = 2026-02-01 (first month of meaningful enterprise usage).
 * Writes scripts/usage-<asOfDate>.json = [{ "date": "YYYY-MM-DD", "amount": <usd> }].
 *
 * Key is read from .analytics-key (gitignored) or ANTHROPIC_ANALYTICS_KEY.
 * Amounts from the API are decimal strings in cents; we divide by 100 for USD.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// Key comes only from the environment. The scheduled task decrypts the
// DPAPI-protected file (%USERPROFILE%\.secrets\anthropic-analytics-key.dpapi)
// into ANTHROPIC_ANALYTICS_KEY for the run — no plaintext key on disk.
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

const BASE = "https://api.anthropic.com/v1/organizations/analytics/cost_report";
const d = (s) => new Date(s + "T00:00:00Z");
const iso = (dt) => dt.toISOString();
const ymd = (dt) => dt.toISOString().slice(0, 10);
const r2 = (n) => Math.round(n * 100) / 100;

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

// Walk the response, accumulating per-day cost in cents. Robust to nesting:
// a bucket carries starting_at; cost lives in `amount` on bucket results.
function collect(node, perDay, dayKey) {
  if (Array.isArray(node)) {
    for (const item of node) collect(item, perDay, dayKey);
    return;
  }
  if (!node || typeof node !== "object") return;
  const day = (node.starting_at || "").slice(0, 10) || dayKey;
  if (node.amount != null && !Number.isNaN(Number(node.amount)) && day) {
    perDay.set(day, (perDay.get(day) || 0) + Number(node.amount));
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === "amount" || k === "list_amount") continue;
    if (v && typeof v === "object") collect(v, perDay, day);
  }
}

const perDay = new Map();
for (const [s, e] of windows(START, ASOF)) {
  let page = null;
  do {
    const params = new URLSearchParams({ starting_at: iso(s), ending_at: iso(e), bucket_width: "1d" });
    if (page) params.set("page", page);
    const res = await fetch(`${BASE}?${params}`, {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
    });
    const text = await res.text();
    if (!res.ok) {
      console.error(`HTTP ${res.status} for ${ymd(s)}..${ymd(e)}:\n${text}`);
      process.exit(1);
    }
    const json = JSON.parse(text);
    collect(json.data ?? json, perDay, null);
    page = json.has_more ? json.next_page : null;
  } while (page);
}

// Emit one record per day that had spend, in date order, USD rounded to cents.
const daily = [...perDay.entries()]
  .filter(([, cents]) => cents > 0)
  .map(([date, cents]) => ({ date, amount: r2(cents / 100) }))
  .sort((a, b) => a.date.localeCompare(b.date));

if (daily.length === 0) {
  console.error("No consumption rows returned — refusing to write an empty dataset.");
  process.exit(1);
}

const outPath = join(repoRoot, "scripts", `usage-${ASOF}.json`);
writeFileSync(outPath, JSON.stringify(daily, null, 2) + "\n");
const total = r2(daily.reduce((a, t) => a + t.amount, 0));
console.log(`Wrote ${outPath}`);
console.log(`  days=${daily.length} range=${daily[0].date}..${daily[daily.length - 1].date} total=$${total}`);
