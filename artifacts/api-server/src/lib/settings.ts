import { db, settingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

export const SETTING_APIFY_TOKEN = "apify_token";
export const SETTING_APIFY_ACTOR_ID = "apify_actor_id";
export const SETTING_APIFY_FACEBOOK_ACTOR_ID = "apify_facebook_actor_id";
export const SETTING_APIFY_INSTAGRAM_ACTOR_ID = "apify_instagram_actor_id";
export const SETTING_APIFY_TIKTOK_ACTOR_ID = "apify_tiktok_actor_id";
export const SETTING_APIFY_TWITTER_ACTOR_ID = "apify_twitter_actor_id";
export const SETTING_APIFY_YOUTUBE_ACTOR_ID = "apify_youtube_actor_id";
export const SETTING_ARCTIC_FALLBACK = "arctic_fallback_enabled";
export const SETTING_ARCHETYPES = "archetypes_json";

// Finance / cost tracking. OpenAI prices are USD per 1,000,000 tokens. the OpenAI-compatible API
// Integrations pass OpenAI tokens through at OpenAI's public list price (no
// per-token markup), so these list prices yield a close per-call estimate. They
// are editable in the Finance page so they can be updated when rates change.
export const SETTING_OPENAI_INPUT_PRICE = "openai_input_usd_per_mtok";
export const SETTING_OPENAI_OUTPUT_PRICE = "openai_output_usd_per_mtok";
// Platform subscription accounting (no billing API exists — supplied manually).
export const SETTING_PLATFORM_ANNUAL = "platform_annual_usd";
export const SETTING_PLATFORM_TOPUPS = "platform_topups_usd";
export const SETTING_PLATFORM_NEXT_PAYMENT = "platform_next_payment";

export const DEFAULT_OPENAI_INPUT_PRICE = 1.25;
export const DEFAULT_OPENAI_OUTPUT_PRICE = 10;

export const DEFAULT_APIFY_ACTOR_ID = "trudax~reddit-scraper-lite";
export const DEFAULT_FACEBOOK_ACTOR_ID = "apify~facebook-comments-scraper";
export const DEFAULT_INSTAGRAM_ACTOR_ID = "apify~instagram-comment-scraper";
export const DEFAULT_TIKTOK_ACTOR_ID = "clockworks~tiktok-comments-scraper";
export const DEFAULT_TWITTER_ACTOR_ID = "kaitoeasyapi~twitter-reply";
export const DEFAULT_YOUTUBE_ACTOR_ID = "streamers~youtube-comments-scraper";

export async function getSetting(key: string): Promise<string | null> {
  const [row] = await db.select().from(settingsTable).where(eq(settingsTable.key, key));
  return row?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await db
    .insert(settingsTable)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settingsTable.key, set: { value, updatedAt: new Date() } });
}

export async function deleteSetting(key: string): Promise<void> {
  await db.delete(settingsTable).where(eq(settingsTable.key, key));
}

/**
 * Whether deleted/removed Reddit bodies should be recovered from the Arctic Shift
 * archive during crawls. Defaults to ON: only an explicit stored "false" disables
 * it, so the feature is active out of the box (including before the row exists).
 */
export async function isArcticFallbackEnabled(): Promise<boolean> {
  return (await getSetting(SETTING_ARCTIC_FALLBACK)) !== "false";
}

export function maskKey(key: string | null): string | null {
  if (!key) return null;
  if (key.length <= 8) return "****";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}
