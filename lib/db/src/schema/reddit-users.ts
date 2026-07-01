import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const redditUsersTable = pgTable("reddit_users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  firstSeen: timestamp("first_seen", { withTimezone: true }),
  lastSeen: timestamp("last_seen", { withTimezone: true }),
  totalComments: integer("total_comments").notNull().default(0),
  totalPosts: integer("total_posts").notNull().default(0),
  notes: text("notes"),
  // Set the first time this user's history is pulled from the Arctic Shift
  // archive. Drives full (never crawled) vs incremental (crawled before)
  // re-crawls — distinct from merely having content from a subreddit crawl.
  arcticCrawledAt: timestamp("arctic_crawled_at", { withTimezone: true }),
  // Watermark for incremental "concerning comment" flagging: the highest
  // comments.id scanned by the last flag run. Comments with a greater id (newly
  // ingested since — Arctic Shift backfills old comments with NEW ids, so id
  // order, not posted_at, is the reliable "new since last run" cursor) are
  // scanned on the next run. Null = never flagged (first run scans everything).
  flaggedThroughCommentId: integer("flagged_through_comment_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertRedditUserSchema = createInsertSchema(redditUsersTable).omit({ id: true, createdAt: true });
export type InsertRedditUser = z.infer<typeof insertRedditUserSchema>;
export type RedditUser = typeof redditUsersTable.$inferSelect;
