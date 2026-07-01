import {
  db,
  facebookUsersTable,
  facebookPostsTable,
  facebookCommentsTable,
  facebookAnalysesTable,
  facebookArchetypeScoresTable,
  jobsTable,
} from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { logger } from "./logger";
import { analyzeFacebookUserContent } from "./analysis";
import { ARCHETYPES } from "./archetypes";

/** Safety cap on how many Facebook users a single classification pass handles. */
const MAX_CLASSIFY_PER_RUN = 500;

/**
 * Classify every Facebook user that has ingested content but no current analysis
 * (or new content since their last one). Runs the same 14-archetype OpenAI
 * analysis as Reddit, sequentially to bound API load and cost. Each user is
 * written in its own transaction so a single failure doesn't roll back others;
 * failures leave the user unanalyzed to be retried on the next pass.
 */
export async function classifyUnanalyzedFacebookUsers(launchedBy: string | null = null): Promise<void> {
  const targetRows = await db.execute<{ id: number; profile_id: string; display_name: string }>(
    sql`
      SELECT u.id, u.profile_id, u.display_name
      FROM facebook_users u
      LEFT JOIN LATERAL (
        SELECT MAX(created_at) AS last_at FROM facebook_analyses WHERE user_id = u.id
      ) la ON TRUE
      WHERE la.last_at IS NULL
         OR EXISTS (
           SELECT 1 FROM facebook_comments c
           WHERE c.author_profile_id = u.profile_id AND c.created_at > la.last_at
         )
    `,
  );

  const targets = (targetRows.rows ?? []).map((r) => ({
    id: Number(r.id),
    profileId: r.profile_id,
    displayName: r.display_name,
  }));

  if (targets.length === 0) return;

  const capped = targets.slice(0, MAX_CLASSIFY_PER_RUN);

  // Surface this pass in the system pipeline queue (jobs table), mirroring the
  // Reddit analyze_batch flow. The `one_running_analyze_facebook_batch` partial
  // unique index makes the insert an atomic concurrency guard: if another FB
  // pass is already running, this conflicts and returns nothing, so we skip.
  const [job] = await db
    .insert(jobsTable)
    .values({ jobType: "analyze_facebook_batch", status: "running", total: capped.length, progress: 0, createdBy: launchedBy })
    .onConflictDoNothing()
    .returning();

  if (!job) {
    logger.info("Facebook auto-classification already in progress; skipping");
    return;
  }

  logger.info(
    { jobId: job.id, count: capped.length, totalQueued: targets.length },
    "Facebook classification started",
  );

  let classified = 0;
  let failed = 0;

  for (const t of capped) {
    try {
      const posts = await db
        .select({ title: facebookPostsTable.title, text: facebookPostsTable.text })
        .from(facebookPostsTable)
        .where(eq(facebookPostsTable.authorProfileId, t.profileId))
        .limit(30);

      const comments = await db
        .select({ body: facebookCommentsTable.body })
        .from(facebookCommentsTable)
        .where(eq(facebookCommentsTable.authorProfileId, t.profileId))
        .limit(100);

      const result = await analyzeFacebookUserContent(t.displayName, posts, comments);

      await db.transaction(async (tx) => {
        await tx
          .update(facebookArchetypeScoresTable)
          .set({ isLatest: false })
          .where(and(eq(facebookArchetypeScoresTable.userId, t.id), eq(facebookArchetypeScoresTable.isLatest, true)));
        await tx
          .update(facebookAnalysesTable)
          .set({ isLatest: false })
          .where(and(eq(facebookAnalysesTable.userId, t.id), eq(facebookAnalysesTable.isLatest, true)));

        const [analysis] = await tx
          .insert(facebookAnalysesTable)
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
          await tx.insert(facebookArchetypeScoresTable).values(scoreInserts);
        }
      });

      classified++;
    } catch (err) {
      failed++;
      logger.error({ err, profileId: t.profileId }, "Facebook classification failed for user");
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

  logger.info({ jobId: job.id, classified, failed }, "Facebook classification completed");
}
