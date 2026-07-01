import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const youtubePostsTable = pgTable("youtube_posts", {
  id: serial("id").primaryKey(),
  ytPostId: text("yt_post_id").notNull().unique(),
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

export const insertYoutubePostSchema = createInsertSchema(youtubePostsTable).omit({ id: true });
export type InsertYoutubePost = z.infer<typeof insertYoutubePostSchema>;
export type YoutubePost = typeof youtubePostsTable.$inferSelect;
