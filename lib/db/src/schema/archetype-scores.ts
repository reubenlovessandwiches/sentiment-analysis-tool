import { pgTable, serial, integer, text, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { analysesTable } from "./analyses";
import { redditUsersTable } from "./reddit-users";
import { relations } from "drizzle-orm";

export const archetypeScoresTable = pgTable("archetype_scores", {
  id: serial("id").primaryKey(),
  analysisId: integer("analysis_id").notNull().references(() => analysesTable.id),
  userId: integer("user_id").notNull().references(() => redditUsersTable.id),
  archetypeKey: text("archetype_key").notNull(),
  archetypeName: text("archetype_name").notNull(),
  score: integer("score").notNull().default(0),
  confidence: integer("confidence").notNull().default(0),
  explanation: text("explanation"),
  evidence: text("evidence").array().notNull().default([]),
  // Mirrors analyses.isLatest: true only for scores belonging to the user's
  // current analysis, so aggregate reads can exclude superseded history rows.
  isLatest: boolean("is_latest").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const archetypeScoresRelations = relations(archetypeScoresTable, ({ one }) => ({
  analysis: one(analysesTable, {
    fields: [archetypeScoresTable.analysisId],
    references: [analysesTable.id],
  }),
  user: one(redditUsersTable, {
    fields: [archetypeScoresTable.userId],
    references: [redditUsersTable.id],
  }),
}));

export const insertArchetypeScoreSchema = createInsertSchema(archetypeScoresTable).omit({ id: true, createdAt: true });
export type InsertArchetypeScore = z.infer<typeof insertArchetypeScoreSchema>;
export type ArchetypeScore = typeof archetypeScoresTable.$inferSelect;
