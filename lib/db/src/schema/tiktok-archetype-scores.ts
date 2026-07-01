import { pgTable, serial, integer, text, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { tiktokAnalysesTable } from "./tiktok-analyses";
import { tiktokUsersTable } from "./tiktok-users";
import { relations } from "drizzle-orm";

export const tiktokArchetypeScoresTable = pgTable("tiktok_archetype_scores", {
  id: serial("id").primaryKey(),
  analysisId: integer("analysis_id").notNull().references(() => tiktokAnalysesTable.id),
  userId: integer("user_id").notNull().references(() => tiktokUsersTable.id),
  archetypeKey: text("archetype_key").notNull(),
  archetypeName: text("archetype_name").notNull(),
  score: integer("score").notNull().default(0),
  confidence: integer("confidence").notNull().default(0),
  explanation: text("explanation"),
  evidence: text("evidence").array().notNull().default([]),
  isLatest: boolean("is_latest").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const tiktokArchetypeScoresRelations = relations(tiktokArchetypeScoresTable, ({ one }) => ({
  analysis: one(tiktokAnalysesTable, {
    fields: [tiktokArchetypeScoresTable.analysisId],
    references: [tiktokAnalysesTable.id],
  }),
  user: one(tiktokUsersTable, {
    fields: [tiktokArchetypeScoresTable.userId],
    references: [tiktokUsersTable.id],
  }),
}));

export const insertTikTokArchetypeScoreSchema = createInsertSchema(tiktokArchetypeScoresTable).omit({ id: true, createdAt: true });
export type InsertTikTokArchetypeScore = z.infer<typeof insertTikTokArchetypeScoreSchema>;
export type TikTokArchetypeScore = typeof tiktokArchetypeScoresTable.$inferSelect;
