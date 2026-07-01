import { pgTable, serial, integer, text, timestamp, boolean, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { twitterUsersTable } from "./twitter-users";
import { relations, sql } from "drizzle-orm";

export const twitterAnalysesTable = pgTable(
  "twitter_analyses",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull().references(() => twitterUsersTable.id),
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
    uniqueIndex("one_latest_twitter_analysis_per_user")
      .on(table.userId)
      .where(sql`${table.isLatest}`),
  ],
);

export const twitterAnalysesRelations = relations(twitterAnalysesTable, ({ one }) => ({
  user: one(twitterUsersTable, {
    fields: [twitterAnalysesTable.userId],
    references: [twitterUsersTable.id],
  }),
}));

export const insertTwitterAnalysisSchema = createInsertSchema(twitterAnalysesTable).omit({ id: true, createdAt: true });
export type InsertTwitterAnalysis = z.infer<typeof insertTwitterAnalysisSchema>;
export type TwitterAnalysis = typeof twitterAnalysesTable.$inferSelect;
