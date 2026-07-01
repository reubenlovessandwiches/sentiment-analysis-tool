import { pgTable, serial, integer, text, timestamp, boolean, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { youtubeUsersTable } from "./youtube-users";
import { relations, sql } from "drizzle-orm";

export const youtubeAnalysesTable = pgTable(
  "youtube_analyses",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull().references(() => youtubeUsersTable.id),
    dominantArchetypes: text("dominant_archetypes").array().notNull().default([]),
    summary: text("summary").notNull().default(""),
    recurringThemes: text("recurring_themes").array().notNull().default([]),
    themeLabels: text("theme_labels").array().notNull().default([]),
    confidenceNotes: text("confidence_notes").notNull().default(""),
    rawResponse: text("raw_response"),
    isLatest: boolean("is_latest").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("one_latest_youtube_analysis_per_user")
      .on(table.userId)
      .where(sql`${table.isLatest}`),
  ],
);

export const youtubeAnalysesRelations = relations(youtubeAnalysesTable, ({ one }) => ({
  user: one(youtubeUsersTable, {
    fields: [youtubeAnalysesTable.userId],
    references: [youtubeUsersTable.id],
  }),
}));

export const insertYoutubeAnalysisSchema = createInsertSchema(youtubeAnalysesTable).omit({ id: true, createdAt: true });
export type InsertYoutubeAnalysis = z.infer<typeof insertYoutubeAnalysisSchema>;
export type YoutubeAnalysis = typeof youtubeAnalysesTable.$inferSelect;
