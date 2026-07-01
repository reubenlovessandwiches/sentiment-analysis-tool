import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { facebookPostsTable } from "./facebook-posts";
import { relations } from "drizzle-orm";

export const facebookCommentsTable = pgTable("facebook_comments", {
  id: serial("id").primaryKey(),
  fbCommentId: text("fb_comment_id").notNull().unique(),
  postId: integer("post_id").references(() => facebookPostsTable.id),
  authorProfileId: text("author_profile_id").notNull(),
  authorName: text("author_name").notNull(),
  body: text("body").notNull(),
  likes: integer("likes").notNull().default(0),
  commentUrl: text("comment_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  postedAt: timestamp("posted_at", { withTimezone: true }),
});

export const facebookCommentsRelations = relations(facebookCommentsTable, ({ one }) => ({
  post: one(facebookPostsTable, {
    fields: [facebookCommentsTable.postId],
    references: [facebookPostsTable.id],
  }),
}));

export const insertFacebookCommentSchema = createInsertSchema(facebookCommentsTable).omit({ id: true });
export type InsertFacebookComment = z.infer<typeof insertFacebookCommentSchema>;
export type FacebookComment = typeof facebookCommentsTable.$inferSelect;
