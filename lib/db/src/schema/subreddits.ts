import { pgTable, serial, text, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const subredditsTable = pgTable("subreddits", {
  id: serial("id").primaryKey(),
  subredditName: text("subreddit_name").notNull().unique(),
  displayName: text("display_name").notNull(),
  description: text("description"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertSubredditSchema = createInsertSchema(subredditsTable).omit({ id: true, createdAt: true });
export type InsertSubreddit = z.infer<typeof insertSubredditSchema>;
export type Subreddit = typeof subredditsTable.$inferSelect;
