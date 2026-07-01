import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const facebookUsersTable = pgTable("facebook_users", {
  id: serial("id").primaryKey(),
  profileId: text("profile_id").notNull().unique(),
  displayName: text("display_name").notNull(),
  profileUrl: text("profile_url"),
  firstSeen: timestamp("first_seen", { withTimezone: true }),
  lastSeen: timestamp("last_seen", { withTimezone: true }),
  totalComments: integer("total_comments").notNull().default(0),
  totalPosts: integer("total_posts").notNull().default(0),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertFacebookUserSchema = createInsertSchema(facebookUsersTable).omit({ id: true, createdAt: true });
export type InsertFacebookUser = z.infer<typeof insertFacebookUserSchema>;
export type FacebookUser = typeof facebookUsersTable.$inferSelect;
