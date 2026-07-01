import { pgTable, serial, integer, text, timestamp, boolean, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { facebookUsersTable } from "./facebook-users";
import { relations, sql } from "drizzle-orm";

export const facebookAnalysesTable = pgTable(
  "facebook_analyses",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull().references(() => facebookUsersTable.id),
    dominantArchetypes: text("dominant_archetypes").array().notNull().default([]),
    summary: text("summary").notNull().default(""),
    recurringThemes: text("recurring_themes").array().notNull().default([]),
    themeLabels: text("theme_labels").array().notNull().default([]),
    confidenceNotes: text("confidence_notes").notNull().default(""),
    rawResponse: text("raw_response"),
    // Mirror of the Reddit analyses table: a user accumulates one analysis per
    // (re)classification; `isLatest` marks the current profile so aggregate reads
    // use only the newest analysis while older rows are kept for history.
    isLatest: boolean("is_latest").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("one_latest_facebook_analysis_per_user")
      .on(table.userId)
      .where(sql`${table.isLatest}`),
  ],
);

export const facebookAnalysesRelations = relations(facebookAnalysesTable, ({ one }) => ({
  user: one(facebookUsersTable, {
    fields: [facebookAnalysesTable.userId],
    references: [facebookUsersTable.id],
  }),
}));

export const insertFacebookAnalysisSchema = createInsertSchema(facebookAnalysesTable).omit({ id: true, createdAt: true });
export type InsertFacebookAnalysis = z.infer<typeof insertFacebookAnalysisSchema>;
export type FacebookAnalysis = typeof facebookAnalysesTable.$inferSelect;
