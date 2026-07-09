import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

// "proj" is the current run-rate projection kind; "proj-full"/"proj-half" are
// retained for backward compatibility with archived reports built under the
// older growth-increment methodology.
const monthKind = z.enum(["actual", "actual-partial", "proj", "proj-full", "proj-half"]);

const reports = defineCollection({
  // One JSON file per weekly run: src/data/reports/YYYY-MM-DD.json
  loader: glob({ pattern: "*.json", base: "./src/data/reports" }),
  schema: z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    source: z.string().optional(), // "analytics" (Enterprise Analytics API) or legacy Ramp top-ups
    title: z.string(),
    generatedAt: z.string(),
    dataStart: z.string(),
    dataEnd: z.string(),
    analysis: z.string().optional(),
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
    // Analytics-report extras (absent on legacy reports).
    byModel: z
      .array(z.object({ date: z.string(), family: z.string(), amount: z.number() }))
      .optional(),
    activeUsers: z
      .array(
        z.object({
          date: z.string(),
          dau: z.number().nullable(),
          wau: z.number().nullable(),
          mau: z.number().nullable(),
          seats: z.number().nullable(),
        })
      )
      .optional(),
    topUsersMonth: z.array(z.object({ name: z.string(), amount: z.number() })).optional(),
    topUsersAllTime: z.array(z.object({ name: z.string(), amount: z.number() })).optional(),
    licenses: z
      .object({
        assignedSeats: z.number().nullable(),
        activeLast30: z.number(),
        unusedLast30: z.number().nullable(),
        inactiveUsers: z.array(z.object({ name: z.string(), totalSpend: z.number() })),
      })
      .nullable()
      .optional(),
    // Only present on legacy top-up reports; analytics reports omit cadence.
    cadence: z
      .array(
        z.object({
          date: z.string(),
          daysSincePrev: z.number().nullable(),
        })
      )
      .optional(),
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
      twoWeekDailyRate: z.number().nullable().optional(),
      // "all seats active at current per-user intensity" weekday reference line
      saturationDailyReference: z.number().nullable().optional(),
    }),
    methodology: z.object({
      // current-month basis (trailing two-week run rate)
      currentMonthMethod: z.string().optional(),
      rollingWindowDays: z.number().optional(),
      twoWeekDailyRate: z.number().nullable().optional(),
      currentMonthActualToDate: z.number().optional(),
      // future-month basis (trailing 45-day run rate; or damped-weekly-growth)
      futureMonthMethod: z.string().optional(),
      growthWindowDays: z.number().optional(),
      growthWindowDailyRate: z.number().nullable().optional(),
      // damped-growth model fields
      weekdayLookback: z.number().optional(),
      weekdayLevel: z.number().optional(),
      growthFitWeeks: z.number().optional(),
      weeklyGrowthRate: z.number().optional(), // % per week
      dampingPhi: z.number().optional(),
      saturationWeekdayLevel: z.number().nullable().optional(),
      perActiveUserWeekday: z.number().nullable().optional(),
      // legacy growth-increment fields (archived reports)
      basisMonths: z.array(z.string()).optional(),
      fullIncrement: z.number().optional(),
      halfIncrement: z.number().optional(),
      note: z.string(),
    }),
  }),
});

export const collections = { reports };
