import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const facebookPostsTable = pgTable("facebook_posts", {
  id: serial("id").primaryKey(),
  fbPostId: text("fb_post_id").notNull().unique(),
  url: text("url").notNull(),
  title: text("title"),
  text: text("text"),
  author: text("author"),
  authorProfileId: text("author_profile_id"),
  likes: integer("likes").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  postedAt: timestamp("posted_at", { withTimezone: true }),
});

export const insertFacebookPostSchema = createInsertSchema(facebookPostsTable).omit({ id: true });
export type InsertFacebookPost = z.infer<typeof insertFacebookPostSchema>;
export type FacebookPost = typeof facebookPostsTable.$inferSelect;
