import { pgTable, serial, integer, text, timestamp, boolean, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { tiktokUsersTable } from "./tiktok-users";
import { relations, sql } from "drizzle-orm";

export const tiktokAnalysesTable = pgTable(
  "tiktok_analyses",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull().references(() => tiktokUsersTable.id),
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
    uniqueIndex("one_latest_tiktok_analysis_per_user")
      .on(table.userId)
      .where(sql`${table.isLatest}`),
  ],
);

export const tiktokAnalysesRelations = relations(tiktokAnalysesTable, ({ one }) => ({
  user: one(tiktokUsersTable, {
    fields: [tiktokAnalysesTable.userId],
    references: [tiktokUsersTable.id],
  }),
}));

export const insertTikTokAnalysisSchema = createInsertSchema(tiktokAnalysesTable).omit({ id: true, createdAt: true });
export type InsertTikTokAnalysis = z.infer<typeof insertTikTokAnalysisSchema>;
export type TikTokAnalysis = typeof tiktokAnalysesTable.$inferSelect;
