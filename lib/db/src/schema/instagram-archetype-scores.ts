import { pgTable, serial, integer, text, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { instagramAnalysesTable } from "./instagram-analyses";
import { instagramUsersTable } from "./instagram-users";
import { relations } from "drizzle-orm";

export const instagramArchetypeScoresTable = pgTable("instagram_archetype_scores", {
  id: serial("id").primaryKey(),
  analysisId: integer("analysis_id").notNull().references(() => instagramAnalysesTable.id),
  userId: integer("user_id").notNull().references(() => instagramUsersTable.id),
  archetypeKey: text("archetype_key").notNull(),
  archetypeName: text("archetype_name").notNull(),
  score: integer("score").notNull().default(0),
  confidence: integer("confidence").notNull().default(0),
  explanation: text("explanation"),
  evidence: text("evidence").array().notNull().default([]),
  isLatest: boolean("is_latest").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const instagramArchetypeScoresRelations = relations(instagramArchetypeScoresTable, ({ one }) => ({
  analysis: one(instagramAnalysesTable, {
    fields: [instagramArchetypeScoresTable.analysisId],
    references: [instagramAnalysesTable.id],
  }),
  user: one(instagramUsersTable, {
    fields: [instagramArchetypeScoresTable.userId],
    references: [instagramUsersTable.id],
  }),
}));

export const insertInstagramArchetypeScoreSchema = createInsertSchema(instagramArchetypeScoresTable).omit({ id: true, createdAt: true });
export type InsertInstagramArchetypeScore = z.infer<typeof insertInstagramArchetypeScoreSchema>;
export type InstagramArchetypeScore = typeof instagramArchetypeScoresTable.$inferSelect;
