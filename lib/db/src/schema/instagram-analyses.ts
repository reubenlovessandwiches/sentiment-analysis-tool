import { pgTable, serial, integer, text, timestamp, boolean, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { instagramUsersTable } from "./instagram-users";
import { relations, sql } from "drizzle-orm";

export const instagramAnalysesTable = pgTable(
  "instagram_analyses",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull().references(() => instagramUsersTable.id),
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
    uniqueIndex("one_latest_instagram_analysis_per_user")
      .on(table.userId)
      .where(sql`${table.isLatest}`),
  ],
);

export const instagramAnalysesRelations = relations(instagramAnalysesTable, ({ one }) => ({
  user: one(instagramUsersTable, {
    fields: [instagramAnalysesTable.userId],
    references: [instagramUsersTable.id],
  }),
}));

export const insertInstagramAnalysisSchema = createInsertSchema(instagramAnalysesTable).omit({ id: true, createdAt: true });
export type InsertInstagramAnalysis = z.infer<typeof insertInstagramAnalysisSchema>;
export type InstagramAnalysis = typeof instagramAnalysesTable.$inferSelect;
