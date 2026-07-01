import { pgTable, text, boolean, timestamp, serial } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const loginAttemptsTable = pgTable("login_attempts", {
  id: serial("id").primaryKey(),
  username: text("username").notNull(),
  success: boolean("success").notNull(),
  ipAddress: text("ip_address"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertLoginAttemptSchema = createInsertSchema(loginAttemptsTable);
export type InsertLoginAttempt = z.infer<typeof insertLoginAttemptSchema>;
export type LoginAttempt = typeof loginAttemptsTable.$inferSelect;
