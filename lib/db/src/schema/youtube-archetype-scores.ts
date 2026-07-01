import { pgTable, serial, integer, text, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { youtubeAnalysesTable } from "./youtube-analyses";
import { youtubeUsersTable } from "./youtube-users";
import { relations } from "drizzle-orm";

export const youtubeArchetypeScoresTable = pgTable("youtube_archetype_scores", {
  id: serial("id").primaryKey(),
  analysisId: integer("analysis_id").notNull().references(() => youtubeAnalysesTable.id),
  userId: integer("user_id").notNull().references(() => youtubeUsersTable.id),
  archetypeKey: text("archetype_key").notNull(),
  archetypeName: text("archetype_name").notNull(),
  score: integer("score").notNull().default(0),
  confidence: integer("confidence").notNull().default(0),
  explanation: text("explanation"),
  evidence: text("evidence").array().notNull().default([]),
  isLatest: boolean("is_latest").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const youtubeArchetypeScoresRelations = relations(youtubeArchetypeScoresTable, ({ one }) => ({
  analysis: one(youtubeAnalysesTable, {
    fields: [youtubeArchetypeScoresTable.analysisId],
    references: [youtubeAnalysesTable.id],
  }),
  user: one(youtubeUsersTable, {
    fields: [youtubeArchetypeScoresTable.userId],
    references: [youtubeUsersTable.id],
  }),
}));

export const insertYoutubeArchetypeScoreSchema = createInsertSchema(youtubeArchetypeScoresTable).omit({ id: true, createdAt: true });
export type InsertYoutubeArchetypeScore = z.infer<typeof insertYoutubeArchetypeScoreSchema>;
export type YoutubeArchetypeScore = typeof youtubeArchetypeScoresTable.$inferSelect;
