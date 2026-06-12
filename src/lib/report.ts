import type { CollectionEntry } from "astro:content";

export type Report = CollectionEntry<"reports">["data"];
export type MonthRow = Report["monthly"][number];

/** Sort newest-first by report date. */
export function sortReports(entries: CollectionEntry<"reports">[]): CollectionEntry<"reports">[] {
  return [...entries].sort((a, b) => b.data.date.localeCompare(a.data.date));
}

export const fmtUsd = (n: number, digits = 0): string =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits });

export const fmtDate = (isoDate: string): string =>
  new Date(isoDate + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

export interface WowDelta {
  prevDate: string;
  newTopups: number;
  newSpend: number;
  burnNow: number;
  burnPrev: number;
  burnChange: number;
  currentMonthProjNow: number;
  currentMonthProjPrev: number | null; // null when prev report's current month differs
  avgGapNow: number | null;
  avgGapPrev: number | null;
}

/** Week-over-week comparison vs the previous report. Null on the first report. */
export function computeWow(current: Report, prev: Report | null): WowDelta | null {
  if (!prev) return null;
  const prevDates = new Set(prev.topups.map((t) => `${t.date}|${t.amount}`));
  const fresh = current.topups.filter((t) => !prevDates.has(`${t.date}|${t.amount}`));
  const currentMonth = current.date.slice(0, 7);
  const prevSameMonth = prev.date.slice(0, 7) === currentMonth;
  return {
    prevDate: prev.date,
    newTopups: fresh.length,
    newSpend: Math.round(fresh.reduce((a, t) => a + t.amount, 0) * 100) / 100,
    burnNow: current.metrics.currentDailyBurn,
    burnPrev: prev.metrics.currentDailyBurn,
    burnChange: Math.round((current.metrics.currentDailyBurn - prev.metrics.currentDailyBurn) * 100) / 100,
    currentMonthProjNow: current.metrics.currentMonthProjected,
    currentMonthProjPrev: prevSameMonth ? prev.metrics.currentMonthProjected : null,
    avgGapNow: current.metrics.avgDaysBetweenTopupsLast4Weeks,
    avgGapPrev: prev.metrics.avgDaysBetweenTopupsLast4Weeks,
  };
}

export interface AccuracyRow {
  month: string;
  label: string;
  projected: number;
  projectedInReport: string; // date of the report that made the projection
  actual: number;
  errorPct: number; // (projected - actual) / actual * 100
}

/**
 * Projection accuracy: for every month that is now a complete actual in `current`,
 * find the earliest prior report that projected it and compare.
 */
export function computeAccuracy(current: Report, history: Report[]): AccuracyRow[] {
  const rows: AccuracyRow[] = [];
  const actuals = current.monthly.filter((m) => m.kind === "actual");
  const prior = history
    .filter((h) => h.date < current.date)
    .sort((a, b) => a.date.localeCompare(b.date));
  for (const m of actuals) {
    for (const h of prior) {
      const proj = h.monthly.find((p) => p.month === m.month && p.kind.startsWith("proj"));
      if (proj) {
        rows.push({
          month: m.month,
          label: m.label,
          projected: proj.total,
          projectedInReport: h.date,
          actual: m.total,
          errorPct: Math.round(((proj.total - m.total) / m.total) * 1000) / 10,
        });
        break; // earliest projection only
      }
    }
  }
  return rows;
}
