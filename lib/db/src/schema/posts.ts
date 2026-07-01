import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { subredditsTable } from "./subreddits";
import { relations } from "drizzle-orm";

export const postsTable = pgTable("posts", {
  id: serial("id").primaryKey(),
  subredditId: integer("subreddit_id").notNull().references(() => subredditsTable.id),
  redditPostId: text("reddit_post_id").notNull().unique(),
  title: text("title").notNull(),
  body: text("body"),
  author: text("author").notNull(),
  score: integer("score").notNull().default(0),
  permalink: text("permalink").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  postedAt: timestamp("posted_at", { withTimezone: true }),
  // Set when a deleted/removed body was recovered from the Arctic Shift archive
  // (Apify returns a tombstone like "[ Removed by Reddit ]"; we backfill the
  // real text). Null = original live content, never recovered.
  recoveredAt: timestamp("recovered_at", { withTimezone: true }),
});

export const postsRelations = relations(postsTable, ({ one }) => ({
  subreddit: one(subredditsTable, {
    fields: [postsTable.subredditId],
    references: [subredditsTable.id],
  }),
}));

export const insertPostSchema = createInsertSchema(postsTable).omit({ id: true });
export type InsertPost = z.infer<typeof insertPostSchema>;
export type Post = typeof postsTable.$inferSelect;
