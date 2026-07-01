import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { instagramPostsTable } from "./instagram-posts";
import { relations } from "drizzle-orm";

export const instagramCommentsTable = pgTable("instagram_comments", {
  id: serial("id").primaryKey(),
  igCommentId: text("ig_comment_id").notNull().unique(),
  postId: integer("post_id").references(() => instagramPostsTable.id),
  authorUsername: text("author_username").notNull(),
  authorName: text("author_name").notNull(),
  body: text("body").notNull(),
  likes: integer("likes").notNull().default(0),
  commentUrl: text("comment_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  postedAt: timestamp("posted_at", { withTimezone: true }),
});

export const instagramCommentsRelations = relations(instagramCommentsTable, ({ one }) => ({
  post: one(instagramPostsTable, {
    fields: [instagramCommentsTable.postId],
    references: [instagramPostsTable.id],
  }),
}));

export const insertInstagramCommentSchema = createInsertSchema(instagramCommentsTable).omit({ id: true });
export type InsertInstagramComment = z.infer<typeof insertInstagramCommentSchema>;
export type InstagramComment = typeof instagramCommentsTable.$inferSelect;
