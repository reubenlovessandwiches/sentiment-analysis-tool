import { pgTable, serial, integer, text, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { facebookAnalysesTable } from "./facebook-analyses";
import { facebookUsersTable } from "./facebook-users";
import { relations } from "drizzle-orm";

export const facebookArchetypeScoresTable = pgTable("facebook_archetype_scores", {
  id: serial("id").primaryKey(),
  analysisId: integer("analysis_id").notNull().references(() => facebookAnalysesTable.id),
  userId: integer("user_id").notNull().references(() => facebookUsersTable.id),
  archetypeKey: text("archetype_key").notNull(),
  archetypeName: text("archetype_name").notNull(),
  score: integer("score").notNull().default(0),
  confidence: integer("confidence").notNull().default(0),
  explanation: text("explanation"),
  evidence: text("evidence").array().notNull().default([]),
  isLatest: boolean("is_latest").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const facebookArchetypeScoresRelations = relations(facebookArchetypeScoresTable, ({ one }) => ({
  analysis: one(facebookAnalysesTable, {
    fields: [facebookArchetypeScoresTable.analysisId],
    references: [facebookAnalysesTable.id],
  }),
  user: one(facebookUsersTable, {
    fields: [facebookArchetypeScoresTable.userId],
    references: [facebookUsersTable.id],
  }),
}));

export const insertFacebookArchetypeScoreSchema = createInsertSchema(facebookArchetypeScoresTable).omit({ id: true, createdAt: true });
export type InsertFacebookArchetypeScore = z.infer<typeof insertFacebookArchetypeScoreSchema>;
export type FacebookArchetypeScore = typeof facebookArchetypeScoresTable.$inferSelect;
