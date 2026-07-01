import {
  db,
  twitterUsersTable,
  twitterPostsTable,
  twitterCommentsTable,
  twitterAnalysesTable,
  twitterArchetypeScoresTable,
  jobsTable,
} from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { logger } from "./logger";
import { analyzeTwitterUserContent } from "./analysis";
import { ARCHETYPES } from "./archetypes";

/** Safety cap on how many Twitter users a single classification pass handles. */
const MAX_CLASSIFY_PER_RUN = 500;

/**
 * Classify every Twitter user that has ingested content but no current analysis
 * (or new content since their last one). Runs the same 14-archetype OpenAI
 * analysis as Reddit/Facebook, sequentially to bound API load and cost. Each user
 * is written in its own transaction so a single failure doesn't roll back others;
 * failures leave the user unanalyzed to be retried on the next pass.
 */
export async function classifyUnanalyzedTwitterUsers(launchedBy: string | null = null): Promise<void> {
  const targetRows = await db.execute<{ id: number; username: string; display_name: string }>(
    sql`
      SELECT u.id, u.username, u.display_name
      FROM twitter_users u
      LEFT JOIN LATERAL (
        SELECT MAX(created_at) AS last_at FROM twitter_analyses WHERE user_id = u.id
      ) la ON TRUE
      WHERE la.last_at IS NULL
         OR EXISTS (
           SELECT 1 FROM twitter_comments c
           WHERE c.author_username = u.username AND c.created_at > la.last_at
         )
    `,
  );

  const targets = (targetRows.rows ?? []).map((r) => ({
    id: Number(r.id),
    username: r.username,
    displayName: r.display_name,
  }));

  if (targets.length === 0) return;

  const capped = targets.slice(0, MAX_CLASSIFY_PER_RUN);

  // Surface this pass in the system pipeline queue (jobs table). The
  // `one_running_analyze_twitter_batch` partial unique index makes the insert
  // an atomic concurrency guard: if another IG pass is already running, this
  // conflicts and returns nothing, so we skip.
  const [job] = await db
    .insert(jobsTable)
    .values({ jobType: "analyze_twitter_batch", status: "running", total: capped.length, progress: 0, createdBy: launchedBy })
    .onConflictDoNothing()
    .returning();

  if (!job) {
    logger.info("Twitter auto-classification already in progress; skipping");
    return;
  }

  logger.info(
    { jobId: job.id, count: capped.length, totalQueued: targets.length },
    "Twitter classification started",
  );

  let classified = 0;
  let failed = 0;

  for (const t of capped) {
    try {
      const posts = await db
        .select({ title: twitterPostsTable.title, text: twitterPostsTable.text })
        .from(twitterPostsTable)
        .where(eq(twitterPostsTable.authorUsername, t.username))
        .limit(30);

      const comments = await db
        .select({ body: twitterCommentsTable.body })
        .from(twitterCommentsTable)
        .where(eq(twitterCommentsTable.authorUsername, t.username))
        .limit(100);

      const result = await analyzeTwitterUserContent(t.displayName, posts, comments);

      await db.transaction(async (tx) => {
        await tx
          .update(twitterArchetypeScoresTable)
          .set({ isLatest: false })
          .where(and(eq(twitterArchetypeScoresTable.userId, t.id), eq(twitterArchetypeScoresTable.isLatest, true)));
        await tx
          .update(twitterAnalysesTable)
          .set({ isLatest: false })
          .where(and(eq(twitterAnalysesTable.userId, t.id), eq(twitterAnalysesTable.isLatest, true)));

        const [analysis] = await tx
          .insert(twitterAnalysesTable)
          .values({
            userId: t.id,
            dominantArchetypes: result.dominant_archetypes,
            summary: result.summary,
            recurringThemes: result.recurring_themes,
            themeLabels: result.theme_labels ?? [],
            confidenceNotes: result.confidence_notes,
            rawResponse: JSON.stringify(result),
          })
          .returning();

        const scoreInserts = Object.entries(result.archetypes)
          .filter(([, v]) => v.score > 0)
          .map(([key, val]) => {
            const archetype = ARCHETYPES.find((a) => a.key === key);
            return {
              analysisId: analysis.id,
              userId: t.id,
              archetypeKey: key,
              archetypeName: archetype?.name ?? key,
              score: val.score,
              confidence: val.confidence,
              evidence: val.evidence,
            };
          });

        if (scoreInserts.length > 0) {
          await tx.insert(twitterArchetypeScoresTable).values(scoreInserts);
        }
      });

      classified++;
    } catch (err) {
      failed++;
      logger.error({ err, username: t.username }, "Twitter classification failed for user");
    }

    await db
      .update(jobsTable)
      .set({ progress: classified + failed })
      .where(eq(jobsTable.id, job.id));
  }

  await db
    .update(jobsTable)
    .set({
      status: "completed",
      completedAt: new Date(),
      errorMessage:
        failed > 0 ? `${failed} of ${capped.length} users failed to classify (will retry next crawl)` : null,
    })
    .where(eq(jobsTable.id, job.id));

  logger.info({ jobId: job.id, classified, failed }, "Twitter classification completed");
}
