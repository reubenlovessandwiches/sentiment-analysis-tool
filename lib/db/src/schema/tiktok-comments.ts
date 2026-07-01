import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { tiktokPostsTable } from "./tiktok-posts";
import { relations } from "drizzle-orm";

export const tiktokCommentsTable = pgTable("tiktok_comments", {
  id: serial("id").primaryKey(),
  ttCommentId: text("tt_comment_id").notNull().unique(),
  postId: integer("post_id").references(() => tiktokPostsTable.id),
  authorUsername: text("author_username").notNull(),
  authorName: text("author_name").notNull(),
  body: text("body").notNull(),
  likes: integer("likes").notNull().default(0),
  commentUrl: text("comment_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  postedAt: timestamp("posted_at", { withTimezone: true }),
});

export const tiktokCommentsRelations = relations(tiktokCommentsTable, ({ one }) => ({
  post: one(tiktokPostsTable, {
    fields: [tiktokCommentsTable.postId],
    references: [tiktokPostsTable.id],
  }),
}));

export const insertTikTokCommentSchema = createInsertSchema(tiktokCommentsTable).omit({ id: true });
export type InsertTikTokComment = z.infer<typeof insertTikTokCommentSchema>;
export type TikTokComment = typeof tiktokCommentsTable.$inferSelect;
