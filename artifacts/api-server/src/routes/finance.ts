import { Router, type IRouter } from "express";
import { db, costEventsTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import {
  getSetting,
  SETTING_OPENAI_INPUT_PRICE,
  SETTING_OPENAI_OUTPUT_PRICE,
  SETTING_PLATFORM_ANNUAL,
  SETTING_PLATFORM_TOPUPS,
  SETTING_PLATFORM_NEXT_PAYMENT,
  DEFAULT_OPENAI_INPUT_PRICE,
  DEFAULT_OPENAI_OUTPUT_PRICE,
} from "../lib/settings";

const router: IRouter = Router();

// User-supplied figures for the Platform subscription line (no platform billing API
// exists). Fixed defaults — not user-editable from the UI.
const DEFAULT_PLATFORM_ANNUAL = 216;
const DEFAULT_PLATFORM_TOPUPS = 100;
const DEFAULT_PLATFORM_NEXT_PAYMENT = "2027-06-22";

function num(raw: string | null, fallback: number): number {
  if (raw == null) return fallback;
  const n = Number(raw);
  return Number.isNaN(n) ? fallback : n;
}

async function readFinanceSettings() {
  const [rawIn, rawOut, rawAnnual, rawTopups, rawNext] = await Promise.all([
    getSetting(SETTING_OPENAI_INPUT_PRICE),
    getSetting(SETTING_OPENAI_OUTPUT_PRICE),
    getSetting(SETTING_PLATFORM_ANNUAL),
    getSetting(SETTING_PLATFORM_TOPUPS),
    getSetting(SETTING_PLATFORM_NEXT_PAYMENT),
  ]);
  return {
    openaiInputUsdPerMtok: num(rawIn, DEFAULT_OPENAI_INPUT_PRICE),
    openaiOutputUsdPerMtok: num(rawOut, DEFAULT_OPENAI_OUTPUT_PRICE),
    platformAnnualUsd: num(rawAnnual, DEFAULT_PLATFORM_ANNUAL),
    platformTopupsUsd: num(rawTopups, DEFAULT_PLATFORM_TOPUPS),
    platformNextPayment: rawNext ?? DEFAULT_PLATFORM_NEXT_PAYMENT,
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

router.get("/finance/users", async (req, res): Promise<void> => {
  // Optional ?month=YYYY-MM filter so the UI can page through months.
  const monthRaw = typeof req.query.month === "string" ? req.query.month : null;
  const month = monthRaw && /^\d{4}-\d{2}$/.test(monthRaw) ? monthRaw : null;

  const rows = await db
    .select({
      appUser: costEventsTable.appUser,
      apifyUsd: sql<number>`coalesce(sum(case when ${costEventsTable.service} = 'apify' then ${costEventsTable.amountUsd} else 0 end), 0)`,
      openaiUsd: sql<number>`coalesce(sum(case when ${costEventsTable.service} = 'openai' then ${costEventsTable.amountUsd} else 0 end), 0)`,
      tokensInput: sql<number>`coalesce(sum(${costEventsTable.tokensInput}), 0)`,
      tokensOutput: sql<number>`coalesce(sum(${costEventsTable.tokensOutput}), 0)`,
      events: sql<number>`count(*)`,
      estimated: sql<boolean>`coalesce(bool_or((${costEventsTable.meta}->>'backfill') = 'true'), false)`,
    })
    .from(costEventsTable)
    .where(
      month
        ? sql`to_char(${costEventsTable.occurredAt}, 'YYYY-MM') = ${month}`
        : sql`true`,
    )
    .groupBy(costEventsTable.appUser);

  const users = rows
    .map((r) => {
      const apifyUsd = round2(Number(r.apifyUsd));
      const openaiUsd = round2(Number(r.openaiUsd));
      return {
        appUser: r.appUser,
        apifyUsd,
        openaiUsd,
        totalUsd: round2(apifyUsd + openaiUsd),
        tokensInput: Number(r.tokensInput),
        tokensOutput: Number(r.tokensOutput),
        events: Number(r.events),
        estimated: Boolean(r.estimated),
      };
    })
    .sort((a, b) => b.totalUsd - a.totalUsd);

  res.json({ users, month });
});

router.get("/finance/summary", async (_req, res): Promise<void> => {
  const settings = await readFinanceSettings();
  const platformMonthlyUsd = round2(settings.platformAnnualUsd / 12);

  const rows = await db
    .select({
      month: sql<string>`to_char(${costEventsTable.occurredAt}, 'YYYY-MM')`,
      apifyUsd: sql<number>`coalesce(sum(case when ${costEventsTable.service} = 'apify' then ${costEventsTable.amountUsd} else 0 end), 0)`,
      openaiUsd: sql<number>`coalesce(sum(case when ${costEventsTable.service} = 'openai' then ${costEventsTable.amountUsd} else 0 end), 0)`,
      estimated: sql<boolean>`coalesce(bool_or((${costEventsTable.meta}->>'backfill') = 'true'), false)`,
    })
    .from(costEventsTable)
    .groupBy(sql`to_char(${costEventsTable.occurredAt}, 'YYYY-MM')`)
    .orderBy(sql`to_char(${costEventsTable.occurredAt}, 'YYYY-MM') desc`);

  const months = rows.map((r) => {
    const apifyUsd = round2(Number(r.apifyUsd));
    const openaiUsd = round2(Number(r.openaiUsd));
    return {
      month: r.month,
      apifyUsd,
      openaiUsd,
      platformUsd: platformMonthlyUsd,
      totalUsd: round2(apifyUsd + openaiUsd + platformMonthlyUsd),
      estimated: Boolean(r.estimated),
    };
  });

  const nowMonth = new Date().toISOString().slice(0, 7);
  const currentMonth =
    months.find((m) => m.month === nowMonth) ?? {
      month: nowMonth,
      apifyUsd: 0,
      openaiUsd: 0,
      platformUsd: platformMonthlyUsd,
      totalUsd: platformMonthlyUsd,
      estimated: false,
    };

  const allTimeApify = round2(months.reduce((s, m) => s + m.apifyUsd, 0));
  const allTimeOpenai = round2(months.reduce((s, m) => s + m.openaiUsd, 0));

  res.json({
    allTime: {
      apifyUsd: allTimeApify,
      openaiUsd: allTimeOpenai,
      totalUsd: round2(allTimeApify + allTimeOpenai),
    },
    currentMonth,
    months,
    platformMonthlyUsd,
    platformNextPayment: settings.platformNextPayment,
  });
});

export default router;
