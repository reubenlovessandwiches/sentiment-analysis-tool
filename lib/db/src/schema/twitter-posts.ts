import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const twitterPostsTable = pgTable("twitter_posts", {
  id: serial("id").primaryKey(),
  twPostId: text("tw_post_id").notNull().unique(),
  url: text("url").notNull(),
  shortcode: text("shortcode"),
  title: text("title"),
  text: text("text"),
  author: text("author"),
  authorUsername: text("author_username"),
  likes: integer("likes").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  postedAt: timestamp("posted_at", { withTimezone: true }),
});

export const insertTwitterPostSchema = createInsertSchema(twitterPostsTable).omit({ id: true });
export type InsertTwitterPost = z.infer<typeof insertTwitterPostSchema>;
export type TwitterPost = typeof twitterPostsTable.$inferSelect;
