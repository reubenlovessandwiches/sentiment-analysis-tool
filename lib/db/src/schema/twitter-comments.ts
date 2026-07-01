import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { twitterPostsTable } from "./twitter-posts";
import { relations } from "drizzle-orm";

export const twitterCommentsTable = pgTable("twitter_comments", {
  id: serial("id").primaryKey(),
  twCommentId: text("tw_comment_id").notNull().unique(),
  postId: integer("post_id").references(() => twitterPostsTable.id),
  authorUsername: text("author_username").notNull(),
  authorName: text("author_name").notNull(),
  body: text("body").notNull(),
  likes: integer("likes").notNull().default(0),
  commentUrl: text("comment_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  postedAt: timestamp("posted_at", { withTimezone: true }),
});

export const twitterCommentsRelations = relations(twitterCommentsTable, ({ one }) => ({
  post: one(twitterPostsTable, {
    fields: [twitterCommentsTable.postId],
    references: [twitterPostsTable.id],
  }),
}));

export const insertTwitterCommentSchema = createInsertSchema(twitterCommentsTable).omit({ id: true });
export type InsertTwitterComment = z.infer<typeof insertTwitterCommentSchema>;
export type TwitterComment = typeof twitterCommentsTable.$inferSelect;
