import { pgTable, serial, text, integer, real, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Ledger of third-party costs incurred by the app, attributed to the app account
 * (`app_users.username`) that initiated the work. Two services are recorded:
 *
 * - "apify"  — actual run cost (`usageTotalUsd`) of a crawl. Only Topic/Sentiment
 *              report crawls are per-user; subreddit/platform crawls have a null
 *              appUser (platform/shared bucket).
 * - "openai" — estimated cost of a chat completion, computed from the response's
 *              token usage × a configurable per-model price. an OpenAI-compatible API
 *              pass OpenAI tokens through at OpenAI's public list price (no per-token
 *              markup), so this estimate tracks the real per-call charge closely.
 *
 * `appUser` is null for platform/shared operations (e.g. batch classification,
 * subreddit crawls) that aren't attributable to a single initiating account.
 */
export const costEventsTable = pgTable("cost_events", {
  id: serial("id").primaryKey(),
  // "apify" | "openai"
  service: text("service").notNull(),
  // Operation bucket: "topic_analysis" | "investigate" | "subreddit" | "batch_classify" | "other"
  category: text("category").notNull().default("other"),
  // app_users.username that initiated the work; null = platform/shared.
  appUser: text("app_user"),
  // Actual (apify) or estimated (openai) cost in USD.
  amountUsd: real("amount_usd").notNull().default(0),
  // OpenAI token counts (null for apify rows).
  tokensInput: integer("tokens_input"),
  tokensOutput: integer("tokens_output"),
  // Free-form reference to the originating entity, e.g. "topic_analysis" / id, or
  // an Apify run id, for traceability.
  refType: text("ref_type"),
  refId: text("ref_id"),
  meta: jsonb("meta").$type<Record<string, unknown>>(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertCostEventSchema = createInsertSchema(costEventsTable).omit({ id: true, occurredAt: true });
export type InsertCostEvent = z.infer<typeof insertCostEventSchema>;
export type CostEvent = typeof costEventsTable.$inferSelect;
