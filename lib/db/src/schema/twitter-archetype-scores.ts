import { pgTable, serial, integer, text, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { twitterAnalysesTable } from "./twitter-analyses";
import { twitterUsersTable } from "./twitter-users";
import { relations } from "drizzle-orm";

export const twitterArchetypeScoresTable = pgTable("twitter_archetype_scores", {
  id: serial("id").primaryKey(),
  analysisId: integer("analysis_id").notNull().references(() => twitterAnalysesTable.id),
  userId: integer("user_id").notNull().references(() => twitterUsersTable.id),
  archetypeKey: text("archetype_key").notNull(),
  archetypeName: text("archetype_name").notNull(),
  score: integer("score").notNull().default(0),
  confidence: integer("confidence").notNull().default(0),
  explanation: text("explanation"),
  evidence: text("evidence").array().notNull().default([]),
  isLatest: boolean("is_latest").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const twitterArchetypeScoresRelations = relations(twitterArchetypeScoresTable, ({ one }) => ({
  analysis: one(twitterAnalysesTable, {
    fields: [twitterArchetypeScoresTable.analysisId],
    references: [twitterAnalysesTable.id],
  }),
  user: one(twitterUsersTable, {
    fields: [twitterArchetypeScoresTable.userId],
    references: [twitterUsersTable.id],
  }),
}));

export const insertTwitterArchetypeScoreSchema = createInsertSchema(twitterArchetypeScoresTable).omit({ id: true, createdAt: true });
export type InsertTwitterArchetypeScore = z.infer<typeof insertTwitterArchetypeScoreSchema>;
export type TwitterArchetypeScore = typeof twitterArchetypeScoresTable.$inferSelect;
