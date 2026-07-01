import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const instagramUsersTable = pgTable("instagram_users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  displayName: text("display_name").notNull(),
  profileUrl: text("profile_url"),
  firstSeen: timestamp("first_seen", { withTimezone: true }),
  lastSeen: timestamp("last_seen", { withTimezone: true }),
  totalComments: integer("total_comments").notNull().default(0),
  totalPosts: integer("total_posts").notNull().default(0),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertInstagramUserSchema = createInsertSchema(instagramUsersTable).omit({ id: true, createdAt: true });
export type InsertInstagramUser = z.infer<typeof insertInstagramUserSchema>;
export type InstagramUser = typeof instagramUsersTable.$inferSelect;
