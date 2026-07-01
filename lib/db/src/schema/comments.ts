import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { subredditsTable } from "./subreddits";
import { postsTable } from "./posts";
import { relations } from "drizzle-orm";

export const commentsTable = pgTable("comments", {
  id: serial("id").primaryKey(),
  subredditId: integer("subreddit_id").notNull().references(() => subredditsTable.id),
  redditCommentId: text("reddit_comment_id").notNull().unique(),
  author: text("author").notNull(),
  body: text("body").notNull(),
  score: integer("score").notNull().default(0),
  parentId: text("parent_id"),
  postId: integer("post_id").references(() => postsTable.id),
  // Direct deep-link to this exact comment, stored at ingestion from the source
  // (Arctic Shift `permalink` / Apify `url`). Needed because a reply's parent_id
  // is a t1_ comment (not the post), so the post id required to reconstruct a
  // link is unavailable for replies. Null for legacy rows; the read side then
  // reconstructs a best-effort link from parent_id.
  permalink: text("permalink"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  postedAt: timestamp("posted_at", { withTimezone: true }),
  // Set when a deleted/removed body was recovered from the Arctic Shift archive
  // (Apify returns a tombstone like "[ Removed by Reddit ]"; we backfill the
  // real text). Null = original live content, never recovered.
  recoveredAt: timestamp("recovered_at", { withTimezone: true }),
});

export const commentsRelations = relations(commentsTable, ({ one }) => ({
  subreddit: one(subredditsTable, {
    fields: [commentsTable.subredditId],
    references: [subredditsTable.id],
  }),
  post: one(postsTable, {
    fields: [commentsTable.postId],
    references: [postsTable.id],
  }),
}));

export const insertCommentSchema = createInsertSchema(commentsTable).omit({ id: true });
export type InsertComment = z.infer<typeof insertCommentSchema>;
export type Comment = typeof commentsTable.$inferSelect;
