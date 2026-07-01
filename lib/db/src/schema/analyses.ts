import { pgTable, serial, integer, text, timestamp, boolean, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { redditUsersTable } from "./reddit-users";
import { relations, sql } from "drizzle-orm";

/** A single piece of evidence backing a self-disclosed identifier. */
export interface IdentifierSource {
  /** Verbatim quote from the post/comment where the attribute was stated. */
  quote: string;
  /** Direct link to the originating post/comment (null if not resolvable). */
  permalink: string | null;
  sourceType: "post" | "comment";
  /** ISO date the source was posted (null if unknown); powers "last observed". */
  postedAt: string | null;
}

/** A deduplicated self-disclosed identifier with all its supporting sources. */
export interface IdentifierEntry {
  /** e.g. "Age", "Gender", "Location", "Occupation". */
  category: string;
  /** Normalized extracted value, e.g. "23 (as of 2026)", "Male". */
  value: string;
  sources: IdentifierSource[];
}

export const analysesTable = pgTable(
  "analyses",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull().references(() => redditUsersTable.id),
    dominantArchetypes: text("dominant_archetypes").array().notNull().default([]),
    summary: text("summary").notNull().default(""),
    recurringThemes: text("recurring_themes").array().notNull().default([]),
    themeLabels: text("theme_labels").array().notNull().default([]),
    confidenceNotes: text("confidence_notes").notNull().default(""),
    // Self-disclosed personal identifiers extracted from the user's content,
    // deduplicated by (category, value) with every supporting source preserved.
    identifiers: jsonb("identifiers").$type<IdentifierEntry[]>().notNull().default([]),
    rawResponse: text("raw_response"),
    // A user accumulates one analysis per (re)classification, forming a history.
    // `isLatest` marks the current profile so aggregate reads use only the newest
    // analysis while older rows are kept for the trends view.
    isLatest: boolean("is_latest").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Enforce at most one current profile per user. Concurrent reclassifications
    // that both try to insert a latest row will collide here, so one fails and
    // rolls back rather than silently double-counting the user in aggregates.
    uniqueIndex("one_latest_analysis_per_user")
      .on(table.userId)
      .where(sql`${table.isLatest}`),
  ],
);

export const analysesRelations = relations(analysesTable, ({ one }) => ({
  user: one(redditUsersTable, {
    fields: [analysesTable.userId],
    references: [redditUsersTable.id],
  }),
}));

export const insertAnalysisSchema = createInsertSchema(analysesTable).omit({ id: true, createdAt: true });
export type InsertAnalysis = z.infer<typeof insertAnalysisSchema>;
export type Analysis = typeof analysesTable.$inferSelect;
