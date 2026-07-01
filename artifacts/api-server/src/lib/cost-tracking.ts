import { db, costEventsTable } from "@workspace/db";
import { logger } from "./logger";
import { getCostContext } from "./cost-context";
import {
  getSetting,
  SETTING_OPENAI_INPUT_PRICE,
  SETTING_OPENAI_OUTPUT_PRICE,
  DEFAULT_OPENAI_INPUT_PRICE,
  DEFAULT_OPENAI_OUTPUT_PRICE,
} from "./settings";

const APIFY_BASE = "https://api.apify.com/v2";

// Cache OpenAI prices briefly so high-volume runs don't hit the settings table on
// every single completion.
let priceCache: { input: number; output: number; at: number } | null = null;
const PRICE_TTL_MS = 60_000;

async function getOpenAiPrices(): Promise<{ input: number; output: number }> {
  if (priceCache && Date.now() - priceCache.at < PRICE_TTL_MS) {
    return { input: priceCache.input, output: priceCache.output };
  }
  const [rawIn, rawOut] = await Promise.all([
    getSetting(SETTING_OPENAI_INPUT_PRICE),
    getSetting(SETTING_OPENAI_OUTPUT_PRICE),
  ]);
  const input = rawIn != null && !Number.isNaN(Number(rawIn)) ? Number(rawIn) : DEFAULT_OPENAI_INPUT_PRICE;
  const output = rawOut != null && !Number.isNaN(Number(rawOut)) ? Number(rawOut) : DEFAULT_OPENAI_OUTPUT_PRICE;
  priceCache = { input, output, at: Date.now() };
  return { input, output };
}

export function invalidatePriceCache(): void {
  priceCache = null;
}

interface OpenAiResponseLike {
  model?: string;
  usage?: {
    prompt_tokens?: number | null;
    completion_tokens?: number | null;
  } | null;
}

/**
 * Record the estimated USD cost of one OpenAI chat completion, attributed to the
 * app account in the current cost context (null = platform/shared). Fire-and-forget
 * and fully non-fatal: a tracking failure must never break analysis.
 */
export function recordOpenAiCost(response: OpenAiResponseLike): void {
  const usage = response.usage;
  if (!usage) return;
  const tokensInput = usage.prompt_tokens ?? 0;
  const tokensOutput = usage.completion_tokens ?? 0;
  if (tokensInput === 0 && tokensOutput === 0) return;

  const ctx = getCostContext();
  void (async () => {
    try {
      const prices = await getOpenAiPrices();
      const amountUsd = (tokensInput / 1_000_000) * prices.input + (tokensOutput / 1_000_000) * prices.output;
      await db.insert(costEventsTable).values({
        service: "openai",
        category: ctx?.category ?? "other",
        appUser: ctx?.appUser ?? null,
        amountUsd,
        tokensInput,
        tokensOutput,
        refType: "openai",
        refId: response.model ?? null,
      });
    } catch (err) {
      logger.error({ err }, "Failed to record OpenAI cost (non-fatal)");
    }
  })();
}

/**
 * Fetch the actual USD cost (`usageTotalUsd`) of a finished Apify run and record
 * it, attributed to the app account in the current cost context. Apify's cost
 * figure is eventually-consistent, so we retry once after a short delay if it's
 * not yet populated. Non-fatal: a tracking failure must never break a crawl.
 */
export async function recordApifyCost(token: string, runId: string): Promise<void> {
  const ctx = getCostContext();
  const authHeaders = { Authorization: `Bearer ${token}` };

  const fetchCost = async (): Promise<number | null> => {
    const res = await fetch(`${APIFY_BASE}/actor-runs/${runId}`, { headers: authHeaders });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: { usageTotalUsd?: number | null } };
    const v = body.data?.usageTotalUsd;
    return typeof v === "number" ? v : null;
  };

  try {
    let amountUsd = await fetchCost();
    if (amountUsd == null || amountUsd === 0) {
      await new Promise((r) => setTimeout(r, 8000));
      amountUsd = await fetchCost();
    }
    if (amountUsd == null) {
      logger.warn({ runId }, "Apify run cost (usageTotalUsd) unavailable; cost not recorded");
      return;
    }
    await db.insert(costEventsTable).values({
      service: "apify",
      category: ctx?.category ?? "other",
      appUser: ctx?.appUser ?? null,
      amountUsd,
      refType: "apify_run",
      refId: runId,
    });
  } catch (err) {
    logger.error({ err, runId }, "Failed to record Apify cost (non-fatal)");
  }
}
