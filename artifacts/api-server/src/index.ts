import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import app from "./app";
import { logger } from "./lib/logger";
import { cleanupOrphanedJobs } from "./routes/jobs";
import { seedMainAdmin } from "./lib/auth";
import { backfillLegacyReportAuthors } from "./routes/topic-analyses";
import { loadArchetypesFromDb } from "./lib/archetypes";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

async function start(): Promise<void> {
  // Reconcile zombie job rows before serving traffic so a restart can't leave a
  // stale "running" analyze_batch that blocks resume, and so cleanup never races
  // with freshly created jobs.
  try {
    await cleanupOrphanedJobs();
  } catch (cleanupErr) {
    logger.error({ err: cleanupErr }, "Failed to clean up orphaned jobs on startup");
  }

  // Enable trigram similarity so fuzzy entity search ("closest matches") works.
  try {
    await db.execute(sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
  } catch (extErr) {
    logger.error({ err: extErr }, "Failed to ensure pg_trgm extension on startup");
  }

  // Seed the main admin from APP_USERNAME/APP_PASSWORD if no accounts exist yet.
  try {
    await seedMainAdmin();
  } catch (seedErr) {
    logger.error({ err: seedErr }, "Failed to seed main admin on startup");
  }

  // Attribute pre-feature reports (null creator) to the original sole operator.
  try {
    await backfillLegacyReportAuthors();
  } catch (backfillErr) {
    logger.error({ err: backfillErr }, "Failed to backfill legacy report authors on startup");
  }

  // Load a community-specific archetype taxonomy from the DB if one was derived,
  // otherwise the default taxonomy shipped in archetypes.ts stays in effect.
  try {
    await loadArchetypesFromDb();
  } catch (archErr) {
    logger.error({ err: archErr }, "Failed to load archetype taxonomy from DB on startup");
  }

  app.listen(port, (err) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }

    logger.info({ port }, "Server listening");
  });
}

void start();
