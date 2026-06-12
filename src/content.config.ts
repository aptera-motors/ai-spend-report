import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

const monthKind = z.enum(["actual", "actual-partial", "proj-full", "proj-half"]);

const reports = defineCollection({
  // One JSON file per weekly run: src/data/reports/YYYY-MM-DD.json
  loader: glob({ pattern: "*.json", base: "./src/data/reports" }),
  schema: z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    title: z.string(),
    generatedAt: z.string(),
    dataStart: z.string(),
    dataEnd: z.string(),
    topups: z.array(
      z.object({
        date: z.string(),
        amount: z.number(),
      })
    ),
    monthly: z.array(
      z.object({
        month: z.string().regex(/^\d{4}-\d{2}$/),
        label: z.string(),
        kind: monthKind,
        topups: z.number().int().nullable(),
        total: z.number(),
        momChange: z.number().nullable(),
        dailyBurn: z.number(),
        cumulative: z.number(),
      })
    ),
    weekly: z.array(
      z.object({
        week: z.string(),
        start: z.string(),
        end: z.string(),
        dates: z.array(z.string()),
        count: z.number().int(),
        total: z.number(),
      })
    ),
    cadence: z.array(
      z.object({
        date: z.string(),
        daysSincePrev: z.number().nullable(),
      })
    ),
    metrics: z.object({
      totalActual: z.number(),
      totalTopups: z.number().int(),
      currentMonthProjected: z.number(),
      currentDailyBurn: z.number(),
      lastProjectedMonth: z.string(),
      lastProjectedMonthTotal: z.number(),
      cumulativeProjected: z.number(),
      annualizedRunRate: z.number(),
      avgDaysBetweenTopupsLast4Weeks: z.number().nullable(),
    }),
    methodology: z.object({
      basisMonths: z.array(z.string()),
      fullIncrement: z.number(),
      halfIncrement: z.number(),
      note: z.string(),
    }),
  }),
});

export const collections = { reports };
