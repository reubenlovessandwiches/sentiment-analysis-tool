import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { relations } from "drizzle-orm";
import { redditUsersTable } from "./reddit-users";
import { commentsTable } from "./comments";

// AI-flagged "comments requiring attention" surfaced from a Reddit user's
// historical comment corpus after an investigate crawl. One row per flagged
// comment; `commentId` is unique so re-runs never duplicate a flag. The
// excerpt/permalink/author are NOT stored here — they are joined from the
// referenced comment row at read time so they stay in sync with any later
// tombstone-recovery backfill.
export const flaggedCommentsTable = pgTable("flagged_comments", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => redditUsersTable.id, { onDelete: "cascade" }),
  commentId: integer("comment_id")
    .notNull()
    .unique()
    .references(() => commentsTable.id, { onDelete: "cascade" }),
  // Short model-written reason the comment was flagged (e.g. "Harassment").
  issue: text("issue").notNull(),
  flaggedAt: timestamp("flagged_at", { withTimezone: true }).notNull().defaultNow(),
});

export const flaggedCommentsRelations = relations(flaggedCommentsTable, ({ one }) => ({
  user: one(redditUsersTable, {
    fields: [flaggedCommentsTable.userId],
    references: [redditUsersTable.id],
  }),
  comment: one(commentsTable, {
    fields: [flaggedCommentsTable.commentId],
    references: [commentsTable.id],
  }),
}));

export const insertFlaggedCommentSchema = createInsertSchema(flaggedCommentsTable).omit({ id: true, flaggedAt: true });
export type InsertFlaggedComment = z.infer<typeof insertFlaggedCommentSchema>;
export type FlaggedCommentRow = typeof flaggedCommentsTable.$inferSelect;
