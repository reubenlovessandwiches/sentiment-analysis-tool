import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { youtubePostsTable } from "./youtube-posts";
import { relations } from "drizzle-orm";

export const youtubeCommentsTable = pgTable("youtube_comments", {
  id: serial("id").primaryKey(),
  ytCommentId: text("yt_comment_id").notNull().unique(),
  postId: integer("post_id").references(() => youtubePostsTable.id),
  authorUsername: text("author_username").notNull(),
  authorName: text("author_name").notNull(),
  body: text("body").notNull(),
  likes: integer("likes").notNull().default(0),
  commentUrl: text("comment_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  postedAt: timestamp("posted_at", { withTimezone: true }),
});

export const youtubeCommentsRelations = relations(youtubeCommentsTable, ({ one }) => ({
  post: one(youtubePostsTable, {
    fields: [youtubeCommentsTable.postId],
    references: [youtubePostsTable.id],
  }),
}));

export const insertYoutubeCommentSchema = createInsertSchema(youtubeCommentsTable).omit({ id: true });
export type InsertYoutubeComment = z.infer<typeof insertYoutubeCommentSchema>;
export type YoutubeComment = typeof youtubeCommentsTable.$inferSelect;
