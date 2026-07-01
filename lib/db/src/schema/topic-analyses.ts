import { pgTable, serial, integer, text, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { postsTable } from "./posts";
import { relations } from "drizzle-orm";

// Shape of the AI-generated report stored in `result`. Kept as a typed JSON blob
// so the whole report can be persisted and re-rendered without re-running the AI.
export const topicThemeSchema = z.object({
  name: z.string(),
  commentCount: z.number().int().nonnegative(),
  percentage: z.number(),
  summary: z.array(z.string()),
  representativeComments: z.array(
    z.object({
      author: z.string(),
      excerpt: z.string(),
      permalink: z.string(),
    }),
  ),
  comments: z.array(
    z.object({
      author: z.string(),
      excerpt: z.string(),
      permalink: z.string(),
    }),
  ),
});
export type TopicTheme = z.infer<typeof topicThemeSchema>;

export const flaggedCommentSchema = z.object({
  issue: z.string(),
  excerpt: z.string(),
  author: z.string(),
  permalink: z.string(),
});
export type FlaggedComment = z.infer<typeof flaggedCommentSchema>;

export const topicAnalysisResultSchema = z.object({
  executiveSummary: z.string(),
  themes: z.array(topicThemeSchema),
  flagged: z.array(flaggedCommentSchema),
  otherComments: z.array(
    z.object({
      author: z.string(),
      excerpt: z.string(),
      permalink: z.string(),
    }),
  ),
});
export type TopicAnalysisResult = z.infer<typeof topicAnalysisResultSchema>;

// A single comment from the de-duplicated analysis pool, persisted on the run so
// the AI grouping step can be re-run later without re-crawling Apify.
export type TopicGatheredComment = {
  author: string;
  body: string;
  permalink: string;
  score: number;
  commentKey?: string;
};

export const topicAnalysesTable = pgTable("topic_analyses", {
  id: serial("id").primaryKey(),
  // Free-text description of the topic under investigation, supplied by the user.
  topicSummary: text("topic_summary").notNull(),
  // pending -> running -> completed | failed
  status: text("status").notNull().default("pending"),
  // Username of the account that created this analysis. Null for rows created
  // before this column existed.
  createdBy: text("created_by"),
  // The raw Reddit post URLs the user submitted (up to 10).
  inputUrls: jsonb("input_urls").$type<string[]>().notNull().default([]),
  // Analyst steering saved with the run so investigations can be re-run with the
  // same settings and the report can show what steering produced it.
  themeHints: jsonb("theme_hints").$type<string[]>().notNull().default([]),
  themeCount: integer("theme_count"),
  postCount: integer("post_count").notNull().default(0),
  commentCount: integer("comment_count").notNull().default(0),
  // Live crawl progress, updated incrementally while status is "running" so the
  // UI can show how far along a run is (X of N threads, comments gathered).
  threadsTotal: integer("threads_total").notNull().default(0),
  threadsDone: integer("threads_done").notNull().default(0),
  commentsGathered: integer("comments_gathered").notNull().default(0),
  // De-duplicated comment pool fed to the AI, persisted so a failed run can be
  // re-analysed without re-crawling Apify. Null for runs that never reached the
  // grouping step (or predate this column).
  gatheredComments: jsonb("gathered_comments").$type<TopicGatheredComment[]>(),
  // Full AI report; null until the run completes.
  result: jsonb("result").$type<TopicAnalysisResult>(),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

// Per-post breakdown for an analysis run: how many comments each submitted post
// contributed and its score, for the "posts analysed" list in the report.
export const topicAnalysisPostsTable = pgTable("topic_analysis_posts", {
  id: serial("id").primaryKey(),
  analysisId: integer("analysis_id")
    .notNull()
    .references(() => topicAnalysesTable.id, { onDelete: "cascade" }),
  postId: integer("post_id").references(() => postsTable.id),
  url: text("url").notNull(),
  title: text("title"),
  commentCount: integer("comment_count").notNull().default(0),
  score: integer("score").notNull().default(0),
});

export const topicAnalysesRelations = relations(topicAnalysesTable, ({ many }) => ({
  posts: many(topicAnalysisPostsTable),
}));

export const topicAnalysisPostsRelations = relations(topicAnalysisPostsTable, ({ one }) => ({
  analysis: one(topicAnalysesTable, {
    fields: [topicAnalysisPostsTable.analysisId],
    references: [topicAnalysesTable.id],
  }),
  post: one(postsTable, {
    fields: [topicAnalysisPostsTable.postId],
    references: [postsTable.id],
  }),
}));

export const insertTopicAnalysisSchema = createInsertSchema(topicAnalysesTable).omit({ id: true, createdAt: true });
export type InsertTopicAnalysis = z.infer<typeof insertTopicAnalysisSchema>;
export type TopicAnalysis = typeof topicAnalysesTable.$inferSelect;

export const insertTopicAnalysisPostSchema = createInsertSchema(topicAnalysisPostsTable).omit({ id: true });
export type InsertTopicAnalysisPost = z.infer<typeof insertTopicAnalysisPostSchema>;
export type TopicAnalysisPost = typeof topicAnalysisPostsTable.$inferSelect;
