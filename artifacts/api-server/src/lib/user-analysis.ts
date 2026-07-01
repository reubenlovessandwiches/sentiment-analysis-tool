import {
  db,
  redditUsersTable,
  analysesTable,
  archetypeScoresTable,
  postsTable,
  commentsTable,
  subredditsTable,
  flaggedCommentsTable,
} from "@workspace/db";
import { eq, and, sql, desc, asc, gt } from "drizzle-orm";
import {
  analyzeUserContent,
  extractUserIdentifiers,
  mergeIdentifierEntries,
  flagConcerningComments,
  type IdentifierSourceInput,
  type TopicCommentInput,
} from "./analysis";
import { ARCHETYPES } from "./archetypes";
import { logger } from "./logger";
import { buildCommentPermalink } from "./crawl";

export { buildCommentPermalink };

/**
 * Resolve a user's numeric id from a (case-insensitive) username. Reddit usernames
 * are case-insensitive but stored as-entered, so always match on lower(username).
 * Returns null if the user row does not exist.
 */
export async function findUserIdByUsername(username: string): Promise<number | null> {
  const [row] = await db
    .select({ id: redditUsersTable.id })
    .from(redditUsersTable)
    .where(sql`lower(${redditUsersTable.username}) = lower(${username})`)
    .limit(1);
  return row?.id ?? null;
}

/**
 * Run the full analysis pipeline (archetype classification + self-disclosed
 * identifier extraction) over a user's already-ingested corpus and persist it as
 * the new latest analysis, superseding the previous one. This is the single
 * source of truth shared by both the manual "Request Re-Analysis" button and the
 * Investigate-page crawl flow, so both produce an identical, fully-analyzed
 * profile (identifiers included).
 *
 * Does NOT crawl and does NOT manage any job record — callers own the crawl step
 * and the job lifecycle. Throws on archetype-analysis failure so the caller can
 * mark its job failed; identifier-extraction failure is non-fatal (stored empty).
 */
export async function analyzeAndPersistUser(userId: number, username: string): Promise<void> {
  // Fetch the user's full corpus. Archetype analysis uses a bounded sample
  // (slices below), but identifier extraction pre-filters across EVERYTHING so
  // a single "23M" buried among hundreds of posts is not silently dropped.
  // Case-insensitive author match: Arctic Shift ingests under the archive's
  // author casing, which may differ from the reddit_users row.
  const posts = await db
    .select({
      title: postsTable.title,
      body: postsTable.body,
      permalink: postsTable.permalink,
      postedAt: postsTable.postedAt,
    })
    .from(postsTable)
    .where(sql`lower(${postsTable.author}) = lower(${username})`)
    .orderBy(desc(postsTable.postedAt), desc(postsTable.id))
    .limit(1000);

  const comments = await db
    .select({
      body: commentsTable.body,
      redditCommentId: commentsTable.redditCommentId,
      parentId: commentsTable.parentId,
      permalink: commentsTable.permalink,
      subredditName: subredditsTable.subredditName,
      postedAt: commentsTable.postedAt,
    })
    .from(commentsTable)
    .leftJoin(subredditsTable, eq(commentsTable.subredditId, subredditsTable.id))
    .where(sql`lower(${commentsTable.author}) = lower(${username})`)
    .orderBy(desc(commentsTable.postedAt), desc(commentsTable.id))
    .limit(3000);

  const result = await analyzeUserContent(username, posts.slice(0, 30), comments.slice(0, 100));

  // Self-disclosed identifier extraction across the full corpus, each backed by a
  // verbatim quote and a direct source link. Never fail the whole analysis if
  // identifier extraction errors — fall back to an empty list.
  const identifierSources: IdentifierSourceInput[] = [
    ...posts.map((p) => ({
      sourceType: "post" as const,
      text: `${p.title}${p.body ? `: ${p.body}` : ""}`,
      permalink: p.permalink,
      postedAt: p.postedAt,
    })),
    ...comments.map((c) => ({
      sourceType: "comment" as const,
      text: c.body,
      permalink: buildCommentPermalink(c.permalink, c.subredditName, c.parentId, c.redditCommentId),
      postedAt: c.postedAt,
    })),
  ];
  let identifiers: Awaited<ReturnType<typeof extractUserIdentifiers>> = [];
  try {
    identifiers = await extractUserIdentifiers(identifierSources, new Date().getFullYear());
  } catch (err) {
    logger.error({ err, username }, "Identifier extraction failed; storing empty list");
  }

  // Supersede the old profile and write the new one atomically: a mid-write
  // failure rolls back so the user never ends up with zero current-profile rows.
  // History rows are retained (isLatest=false) for the trends view.
  await db.transaction(async (tx) => {
    // Persistent identifiers: union this run's extraction with whatever the
    // previous latest analysis already had, so a (re)analysis can only ADD
    // identifiers, never erase ones an earlier run captured. Also means an
    // empty/failed extraction carries the prior set forward instead of wiping it.
    // FOR UPDATE locks the prior latest row so two concurrent analyses for the
    // same user serialize here: the second blocks, then re-reads the first's
    // freshly-inserted latest row, preventing a lost-update of its additions.
    const [prev] = await tx
      .select({ identifiers: analysesTable.identifiers })
      .from(analysesTable)
      .where(and(eq(analysesTable.userId, userId), eq(analysesTable.isLatest, true)))
      .limit(1)
      .for("update");
    const mergedIdentifiers = mergeIdentifierEntries(prev?.identifiers ?? [], identifiers);

    await tx
      .update(archetypeScoresTable)
      .set({ isLatest: false })
      .where(and(eq(archetypeScoresTable.userId, userId), eq(archetypeScoresTable.isLatest, true)));
    await tx
      .update(analysesTable)
      .set({ isLatest: false })
      .where(and(eq(analysesTable.userId, userId), eq(analysesTable.isLatest, true)));

    const [analysis] = await tx
      .insert(analysesTable)
      .values({
        userId,
        dominantArchetypes: result.dominant_archetypes,
        summary: result.summary,
        recurringThemes: result.recurring_themes,
        themeLabels: result.theme_labels ?? [],
        confidenceNotes: result.confidence_notes,
        identifiers: mergedIdentifiers,
        rawResponse: JSON.stringify(result),
      })
      .returning();

    const scoreInserts = Object.entries(result.archetypes)
      .filter(([, v]) => v.score > 0)
      .map(([key, val]) => {
        const archetype = ARCHETYPES.find((a) => a.key === key);
        return {
          analysisId: analysis.id,
          userId,
          archetypeKey: key,
          archetypeName: archetype?.name ?? key,
          score: val.score,
          confidence: val.confidence,
          evidence: val.evidence,
        };
      });

    if (scoreInserts.length > 0) {
      await tx.insert(archetypeScoresTable).values(scoreInserts);
    }
  });
}

/**
 * Flag concerning comments from a Reddit user's history and persist them to
 * `flagged_comments`, surfaced on the profile page + PDF dossier. Reuses the
 * Topic Analysis flag pass (analysis.ts) — same model, batching, and prompt
 * categories — but with NO theme grouping and NO severity ranking; each flag is
 * just a short issue/reason.
 *
 * Incremental: scans only comments newer (greater comments.id) than the user's
 * `flaggedThroughCommentId` watermark. First run (null watermark) scans the
 * ENTIRE history. Arctic Shift backfills old comments with NEW ids, so id order
 * — not posted_at — is the reliable "new since last run" cursor. The watermark
 * advances to the highest id scanned, so successfully-scanned comments are never
 * re-billed on a later run.
 *
 * Supplementary by design: callers run this in their own try/catch so a flag
 * failure never fails the crawl/analysis it follows.
 */
export async function flagUserComments(userId: number, username: string): Promise<void> {
  const [userRow] = await db
    .select({ watermark: redditUsersTable.flaggedThroughCommentId })
    .from(redditUsersTable)
    .where(eq(redditUsersTable.id, userId))
    .limit(1);
  const watermark = userRow?.watermark ?? 0;

  // Case-insensitive author match: Arctic Shift ingests under the archive's
  // author casing, which may differ from the reddit_users row.
  const rows = await db
    .select({
      id: commentsTable.id,
      body: commentsTable.body,
      score: commentsTable.score,
      redditCommentId: commentsTable.redditCommentId,
      parentId: commentsTable.parentId,
      permalink: commentsTable.permalink,
      subredditName: subredditsTable.subredditName,
    })
    .from(commentsTable)
    .leftJoin(subredditsTable, eq(commentsTable.subredditId, subredditsTable.id))
    .where(and(sql`lower(${commentsTable.author}) = lower(${username})`, gt(commentsTable.id, watermark)))
    .orderBy(asc(commentsTable.id));

  if (rows.length === 0) return;

  const inputs: TopicCommentInput[] = rows.map((c) => ({
    author: username,
    body: c.body,
    permalink: buildCommentPermalink(c.permalink, c.subredditName, c.parentId, c.redditCommentId) ?? "",
    score: c.score,
  }));

  const flagged = await flagConcerningComments(inputs);

  if (flagged.length > 0) {
    await db
      .insert(flaggedCommentsTable)
      .values(flagged.map((f) => ({ userId, commentId: rows[f.index].id, issue: f.issue })))
      .onConflictDoNothing({ target: flaggedCommentsTable.commentId });
  }

  // Advance the watermark to the highest comment id scanned (rows are ascending),
  // so the next run only sees comments ingested afterwards.
  const maxScannedId = rows[rows.length - 1].id;
  await db
    .update(redditUsersTable)
    .set({ flaggedThroughCommentId: maxScannedId })
    .where(eq(redditUsersTable.id, userId));

  logger.info({ userId, username, scanned: rows.length, flagged: flagged.length }, "User comment flagging complete");
}
