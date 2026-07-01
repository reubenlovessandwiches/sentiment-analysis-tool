import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const tiktokPostsTable = pgTable("tiktok_posts", {
  id: serial("id").primaryKey(),
  ttPostId: text("tt_post_id").notNull().unique(),
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

export const insertTikTokPostSchema = createInsertSchema(tiktokPostsTable).omit({ id: true });
export type InsertTikTokPost = z.infer<typeof insertTikTokPostSchema>;
export type TikTokPost = typeof tiktokPostsTable.$inferSelect;
