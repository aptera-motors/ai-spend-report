#!/usr/bin/env node
/**
 * Spike: pull actual consumption cost from the Claude Enterprise Analytics API
 * (cost_report) and compare it against the Ramp top-up total the report uses today.
 *
 * Read-only. Does NOT modify any report data. Safe to run repeatedly.
 *
 * Usage:
 *   node scripts/analytics-compare.mjs [startDate] [endDate] [topupsFile]
 * Defaults: 2026-02-25 .. 2026-06-16, scripts/topups-2026-06-17.json
 *
 * The Analytics API key is read from .analytics-key (gitignored) or the
 * ANTHROPIC_ANALYTICS_KEY env var.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// Key comes only from the environment (decrypt the DPAPI file into
// ANTHROPIC_ANALYTICS_KEY before running). No plaintext key on disk.
const key = process.env.ANTHROPIC_ANALYTICS_KEY;
if (!key) {
  console.error("ANTHROPIC_ANALYTICS_KEY is not set. Decrypt the DPAPI key file into the env first.");
  process.exit(1);
}

const [, , startArg, endArg, topupsArg] = process.argv;
const START = startArg || "2026-02-25";
const END = endArg || "2026-06-16"; // exclusive upper bound
const topupsFile = topupsArg || "scripts/topups-2026-06-17.json";

const BASE = "https://api.anthropic.com/v1/organizations/analytics/cost_report";
const d = (s) => new Date(s + "T00:00:00Z");
const iso = (dt) => dt.toISOString();
const ymd = (dt) => dt.toISOString().slice(0, 10);

// Split [start, end) into <=31-day windows (API limit is a 31-day span per query).
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

// Recursively collect numeric `amount` / `list_amount` (decimal strings in cents)
// plus per-day totals, robust to minor response-shape differences.
function sumAmounts(node, perDay, dayKey) {
  let amount = 0;
  let listAmount = 0;
  if (Array.isArray(node)) {
    for (const item of node) {
      const r = sumAmounts(item, perDay, dayKey);
      amount += r.amount;
      listAmount += r.listAmount;
    }
  } else if (node && typeof node === "object") {
    const localDay = (node.starting_at || "").slice(0, 10) || dayKey;
    if (node.amount != null && !Number.isNaN(Number(node.amount))) {
      amount += Number(node.amount);
      if (localDay) perDay.set(localDay, (perDay.get(localDay) || 0) + Number(node.amount));
    }
    if (node.list_amount != null && !Number.isNaN(Number(node.list_amount))) {
      listAmount += Number(node.list_amount);
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === "amount" || k === "list_amount") continue;
      if (v && typeof v === "object") {
        const r = sumAmounts(v, perDay, localDay);
        amount += r.amount;
        listAmount += r.listAmount;
      }
    }
  }
  return { amount, listAmount };
}

async function fetchWindow(startDt, endDt) {
  let page = null;
  let amount = 0;
  let listAmount = 0;
  const perDay = new Map();
  let firstRaw = null;
  do {
    const params = new URLSearchParams({
      starting_at: iso(startDt),
      ending_at: iso(endDt),
      bucket_width: "1d",
    });
    if (page) params.set("page", page);
    const res = await fetch(`${BASE}?${params}`, {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
    });
    const text = await res.text();
    if (!res.ok) {
      console.error(`HTTP ${res.status} for ${ymd(startDt)}..${ymd(endDt)}:\n${text}`);
      process.exit(1);
    }
    const json = JSON.parse(text);
    if (!firstRaw) firstRaw = json;
    const r = sumAmounts(json.data ?? json, perDay, null);
    amount += r.amount;
    listAmount += r.listAmount;
    page = json.has_more ? json.next_page : null;
  } while (page);
  return { amount, listAmount, perDay, firstRaw };
}

const usd = (cents) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

console.log(`Analytics cost_report  ${START} .. ${END}  (actual consumption, USD)\n`);

let grandAmount = 0;
let grandList = 0;
const allDays = new Map();
let sampleShown = false;

for (const [s, e] of windows(START, END)) {
  const { amount, listAmount, perDay, firstRaw } = await fetchWindow(s, e);
  grandAmount += amount;
  grandList += listAmount;
  for (const [day, c] of perDay) allDays.set(day, (allDays.get(day) || 0) + c);
  console.log(`  ${ymd(s)} .. ${ymd(e)}   net ${usd(amount)}   list ${usd(listAmount)}`);
  if (!sampleShown && amount === 0) {
    console.log("\n  [debug] amount summed to 0 — first bucket of raw response:");
    console.log("  " + JSON.stringify((firstRaw.data ?? firstRaw)?.[0] ?? firstRaw).slice(0, 800));
    sampleShown = true;
  }
}

// Monthly rollup from per-day
const byMonth = new Map();
for (const [day, c] of [...allDays].sort()) {
  const m = day.slice(0, 7);
  byMonth.set(m, (byMonth.get(m) || 0) + c);
}

console.log(`\nPer-month (actual consumption):`);
for (const [m, c] of [...byMonth].sort()) console.log(`  ${m}   ${usd(c)}`);

// Compare to Ramp top-ups in the same window
const topups = JSON.parse(readFileSync(join(repoRoot, topupsFile), "utf8"))
  .filter((t) => t.date >= START && t.date < END);
const topupTotal = topups.reduce((a, t) => a + t.amount, 0);

console.log(`\n${"=".repeat(56)}`);
console.log(`Analytics net cost (window):   ${usd(grandAmount)}`);
console.log(`Analytics list cost (window):  ${usd(grandList)}`);
console.log(`Ramp top-ups (window):         $${topupTotal.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}  (${topups.length} top-ups)`);
const deltaPct = topupTotal ? ((grandAmount / 100 - topupTotal) / topupTotal) * 100 : 0;
console.log(`Delta (analytics net − ramp):  $${(grandAmount / 100 - topupTotal).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}  (${deltaPct.toFixed(1)}%)`);
console.log(`${"=".repeat(56)}`);
