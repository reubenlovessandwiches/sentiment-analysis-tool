import bcrypt from "bcryptjs";
import { db, appUsersTable, loginAttemptsTable } from "@workspace/db";
import { eq, desc, sql } from "drizzle-orm";
import type { Request } from "express";
import { logger } from "./logger";

export type Role = "admin" | "member";

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export async function getUser(username: string) {
  const [row] = await db
    .select()
    .from(appUsersTable)
    .where(eq(appUsersTable.username, username));
  return row ?? null;
}

export async function listAccounts() {
  const lastSeenSub = db
    .select({
      username: loginAttemptsTable.username,
      lastSeen: sql<string | null>`max(${loginAttemptsTable.createdAt})`.as("last_seen"),
    })
    .from(loginAttemptsTable)
    .where(eq(loginAttemptsTable.success, true))
    .groupBy(loginAttemptsTable.username)
    .as("ls");

  return db
    .select({
      username: appUsersTable.username,
      role: appUsersTable.role,
      createdAt: appUsersTable.createdAt,
      lastSeen: lastSeenSub.lastSeen,
    })
    .from(appUsersTable)
    .leftJoin(lastSeenSub, eq(appUsersTable.username, lastSeenSub.username))
    .orderBy(appUsersTable.createdAt);
}

export async function createAccount(
  username: string,
  password: string,
  role: Role,
): Promise<void> {
  const passwordHash = await hashPassword(password);
  await db.insert(appUsersTable).values({ username, passwordHash, role });
}

export async function updateAccount(
  username: string,
  updates: { role?: Role; password?: string },
): Promise<void> {
  const values: { role?: Role; passwordHash?: string } = {};
  if (updates.role) values.role = updates.role;
  if (updates.password) values.passwordHash = await hashPassword(updates.password);
  if (Object.keys(values).length === 0) return;
  await db.update(appUsersTable).set(values).where(eq(appUsersTable.username, username));
}

export async function deleteAccount(username: string): Promise<void> {
  await db.delete(appUsersTable).where(eq(appUsersTable.username, username));
}

export async function countAdmins(): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(appUsersTable)
    .where(eq(appUsersTable.role, "admin"));
  return row?.count ?? 0;
}

/**
 * Real client IP as resolved by Express. The app sits behind the reverse
 * proxy with `trust proxy` enabled, so `req.ip` reflects the proxy-resolved
 * address. We deliberately do NOT parse the raw X-Forwarded-For header, which is
 * client-spoofable and would let an attacker forge audit-log source IPs.
 */
export function clientIp(req: Request): string | null {
  return req.ip ?? null;
}

export async function recordLoginAttempt(
  username: string,
  success: boolean,
  ipAddress: string | null,
): Promise<void> {
  try {
    await db.insert(loginAttemptsTable).values({ username, success, ipAddress });
  } catch (err) {
    logger.error({ err }, "failed to record login attempt");
  }
}

export async function listLoginAttempts(offset: number, limit: number) {
  const rows = await db
    .select()
    .from(loginAttemptsTable)
    .orderBy(desc(loginAttemptsTable.createdAt))
    .offset(offset)
    .limit(limit);
  const [totalRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(loginAttemptsTable);
  return { attempts: rows, total: totalRow?.count ?? 0 };
}

/**
 * Seed the main admin from APP_USERNAME/APP_PASSWORD the first time the app runs
 * against an empty users table, so the operator is never locked out. Once any
 * users exist this is a no-op and the secrets are no longer consulted for login.
 */
export async function seedMainAdmin(): Promise<void> {
  const [existing] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(appUsersTable);
  if ((existing?.count ?? 0) > 0) return;

  const username = process.env["APP_USERNAME"];
  const password = process.env["APP_PASSWORD"];
  if (!username || !password) {
    logger.warn(
      "No app_users exist and APP_USERNAME/APP_PASSWORD not set — cannot seed main admin.",
    );
    return;
  }
  await createAccount(username, password, "admin");
  logger.info({ username }, "Seeded main admin account from APP_USERNAME/APP_PASSWORD");
}
