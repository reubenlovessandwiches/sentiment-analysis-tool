import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { subredditsTable } from "./subreddits";
import { redditUsersTable } from "./reddit-users";
import { relations } from "drizzle-orm";

export const clustersTable = pgTable("clusters", {
  id: serial("id").primaryKey(),
  subredditId: integer("subreddit_id").references(() => subredditsTable.id),
  label: text("label").notNull(),
  dominantArchetype: text("dominant_archetype"),
  averageScore: integer("average_score"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const clusterMembersTable = pgTable("cluster_members", {
  id: serial("id").primaryKey(),
  clusterId: integer("cluster_id").notNull().references(() => clustersTable.id),
  userId: integer("user_id").notNull().references(() => redditUsersTable.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const clustersRelations = relations(clustersTable, ({ one, many }) => ({
  subreddit: one(subredditsTable, {
    fields: [clustersTable.subredditId],
    references: [subredditsTable.id],
  }),
  members: many(clusterMembersTable),
}));

export const clusterMembersRelations = relations(clusterMembersTable, ({ one }) => ({
  cluster: one(clustersTable, {
    fields: [clusterMembersTable.clusterId],
    references: [clustersTable.id],
  }),
  user: one(redditUsersTable, {
    fields: [clusterMembersTable.userId],
    references: [redditUsersTable.id],
  }),
}));

export const insertClusterSchema = createInsertSchema(clustersTable).omit({ id: true, createdAt: true });
export type InsertCluster = z.infer<typeof insertClusterSchema>;
export type Cluster = typeof clustersTable.$inferSelect;
