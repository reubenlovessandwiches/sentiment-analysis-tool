import { pgTable, serial, integer, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const jobsTable = pgTable(
  "jobs",
  {
    id: serial("id").primaryKey(),
    jobType: text("job_type").notNull(),
    status: text("status").notNull().default("pending"),
    subredditId: integer("subreddit_id"),
    targetUsername: text("target_username"),
    postUrl: text("post_url"),
    progress: integer("progress").default(0),
    total: integer("total").default(0),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdBy: text("created_by"),
  },
  (t) => [
    // Atomic concurrency guard: at most one running analyze_batch at a time.
    // The classification job insert relies on this via ON CONFLICT DO NOTHING.
    uniqueIndex("one_running_analyze_batch")
      .on(t.jobType)
      .where(sql`${t.status} = 'running' and ${t.jobType} = 'analyze_batch'`),
    // Same guard for the Facebook classification batch so FB sentiment crawls
    // can't spawn overlapping passes.
    uniqueIndex("one_running_analyze_facebook_batch")
      .on(t.jobType)
      .where(sql`${t.status} = 'running' and ${t.jobType} = 'analyze_facebook_batch'`),
    // Same guard for the Instagram classification batch.
    uniqueIndex("one_running_analyze_instagram_batch")
      .on(t.jobType)
      .where(sql`${t.status} = 'running' and ${t.jobType} = 'analyze_instagram_batch'`),
    // Same guard for the TikTok classification batch.
    uniqueIndex("one_running_analyze_tiktok_batch")
      .on(t.jobType)
      .where(sql`${t.status} = 'running' and ${t.jobType} = 'analyze_tiktok_batch'`),
    // Same guard for the Twitter classification batch.
    uniqueIndex("one_running_analyze_twitter_batch")
      .on(t.jobType)
      .where(sql`${t.status} = 'running' and ${t.jobType} = 'analyze_twitter_batch'`),
    // Same guard for the YouTube classification batch.
    uniqueIndex("one_running_analyze_youtube_batch")
      .on(t.jobType)
      .where(sql`${t.status} = 'running' and ${t.jobType} = 'analyze_youtube_batch'`),
  ],
);

export const insertJobSchema = createInsertSchema(jobsTable).omit({ id: true, createdAt: true });
export type InsertJob = z.infer<typeof insertJobSchema>;
export type Job = typeof jobsTable.$inferSelect;
