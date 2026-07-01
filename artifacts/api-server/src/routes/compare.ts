import { Router, type IRouter } from "express";
import { db, redditUsersTable, analysesTable, archetypeScoresTable, postsTable, commentsTable, subredditsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { CompareUsersQueryParams } from "@workspace/api-zod";
import { ARCHETYPES } from "../lib/archetypes";
import { buildCommentPermalink } from "../lib/crawl";

function commentSelect() {
  return db
    .select({
      id: commentsTable.id,
      body: commentsTable.body,
      score: commentsTable.score,
      createdAt: commentsTable.createdAt,
      redditCommentId: commentsTable.redditCommentId,
      parentId: commentsTable.parentId,
      permalink: commentsTable.permalink,
      subredditName: subredditsTable.subredditName,
    })
    .from(commentsTable)
    .leftJoin(subredditsTable, eq(commentsTable.subredditId, subredditsTable.id));
}

const router: IRouter = Router();

router.get("/compare", async (req, res): Promise<void> => {
  const params = CompareUsersQueryParams.safeParse(req.query);
  if (!params.success) {
    res.status(400).json({ error: "Missing u1 and u2 parameters" });
    return;
  }

  const { u1, u2 } = params.data;

  const [user1] = await db.select().from(redditUsersTable).where(eq(redditUsersTable.username, u1));
  const [user2] = await db.select().from(redditUsersTable).where(eq(redditUsersTable.username, u2));

  if (!user1) {
    res.status(404).json({ error: `User '${u1}' not found` });
    return;
  }
  if (!user2) {
    res.status(404).json({ error: `User '${u2}' not found` });
    return;
  }

  const [analysis1] = await db.select().from(analysesTable).where(eq(analysesTable.userId, user1.id)).orderBy(desc(analysesTable.createdAt)).limit(1);
  const [analysis2] = await db.select().from(analysesTable).where(eq(analysesTable.userId, user2.id)).orderBy(desc(analysesTable.createdAt)).limit(1);

  const scores1 = analysis1
    ? await db.select().from(archetypeScoresTable).where(eq(archetypeScoresTable.analysisId, analysis1.id)).orderBy(desc(archetypeScoresTable.score))
    : [];

  const scores2 = analysis2
    ? await db.select().from(archetypeScoresTable).where(eq(archetypeScoresTable.analysisId, analysis2.id)).orderBy(desc(archetypeScoresTable.score))
    : [];

  const recentPosts1 = await db.select({ id: postsTable.id, title: postsTable.title, score: postsTable.score, createdAt: postsTable.createdAt, permalink: postsTable.permalink }).from(postsTable).where(eq(postsTable.author, user1.username)).orderBy(desc(postsTable.createdAt)).limit(5);
  const recentPosts2 = await db.select({ id: postsTable.id, title: postsTable.title, score: postsTable.score, createdAt: postsTable.createdAt, permalink: postsTable.permalink }).from(postsTable).where(eq(postsTable.author, user2.username)).orderBy(desc(postsTable.createdAt)).limit(5);
  const recentComments1 = await commentSelect().where(eq(commentsTable.author, user1.username)).orderBy(desc(commentsTable.createdAt)).limit(5);
  const recentComments2 = await commentSelect().where(eq(commentsTable.author, user2.username)).orderBy(desc(commentsTable.createdAt)).limit(5);

  const scoreMap1 = Object.fromEntries(scores1.map((s) => [s.archetypeKey, s.score]));
  const scoreMap2 = Object.fromEntries(scores2.map((s) => [s.archetypeKey, s.score]));

  const archetypeComparison = ARCHETYPES.map((a) => ({
    archetypeKey: a.key,
    archetypeName: a.name,
    scoreUser1: scoreMap1[a.key] ?? 0,
    scoreUser2: scoreMap2[a.key] ?? 0,
  }));

  const sharedThemes = [...new Set([...(analysis1?.recurringThemes ?? []), ...(analysis2?.recurringThemes ?? [])])].filter(
    (t) => (analysis1?.recurringThemes ?? []).includes(t) && (analysis2?.recurringThemes ?? []).includes(t),
  );

  const themes1 = new Set(analysis1?.recurringThemes ?? []);
  const themes2 = new Set(analysis2?.recurringThemes ?? []);
  const majorDifferences = [
    ...[...(analysis1?.recurringThemes ?? [])].filter((t) => !themes2.has(t)).slice(0, 3).map((t) => `${u1}: ${t}`),
    ...[...(analysis2?.recurringThemes ?? [])].filter((t) => !themes1.has(t)).slice(0, 3).map((t) => `${u2}: ${t}`),
  ];

  const dominants1 = new Set(analysis1?.dominantArchetypes ?? []);
  const dominants2 = new Set(analysis2?.dominantArchetypes ?? []);
  const overlap = [...dominants1].filter((d) => dominants2.has(d)).length;
  const total = Math.max(dominants1.size + dominants2.size, 1);
  const similarityScore = Math.round((overlap / total) * 100);

  const formatScores = (scores: typeof scores1) =>
    scores.map((s) => ({
      archetypeKey: s.archetypeKey,
      archetypeName: s.archetypeName,
      score: s.score,
      confidence: s.confidence,
      explanation: s.explanation ?? null,
      evidence: s.evidence,
    }));

  const formatUser = (user: typeof user1) => ({
    id: user.id,
    username: user.username,
    firstSeen: user.firstSeen?.toISOString() ?? null,
    lastSeen: user.lastSeen?.toISOString() ?? null,
    totalComments: user.totalComments,
    totalPosts: user.totalPosts,
  });

  res.json({
    user1: {
      user: formatUser(user1),
      latestAnalysis: analysis1
        ? {
            id: analysis1.id,
            createdAt: analysis1.createdAt.toISOString(),
            dominantArchetypes: analysis1.dominantArchetypes,
            summary: analysis1.summary,
            recurringThemes: analysis1.recurringThemes,
            confidenceNotes: analysis1.confidenceNotes,
            archetypeScores: formatScores(scores1),
          }
        : null,
      archetypeScores: formatScores(scores1),
      recentPosts: recentPosts1.map((p) => ({ ...p, createdAt: p.createdAt.toISOString() })),
      recentComments: recentComments1.map((c) => ({
        id: c.id,
        body: c.body,
        score: c.score,
        createdAt: c.createdAt.toISOString(),
        subreddit: c.subredditName ?? "",
        permalink: buildCommentPermalink(c.permalink, c.subredditName, c.parentId, c.redditCommentId),
      })),
    },
    user2: {
      user: formatUser(user2),
      latestAnalysis: analysis2
        ? {
            id: analysis2.id,
            createdAt: analysis2.createdAt.toISOString(),
            dominantArchetypes: analysis2.dominantArchetypes,
            summary: analysis2.summary,
            recurringThemes: analysis2.recurringThemes,
            confidenceNotes: analysis2.confidenceNotes,
            archetypeScores: formatScores(scores2),
          }
        : null,
      archetypeScores: formatScores(scores2),
      recentPosts: recentPosts2.map((p) => ({ ...p, createdAt: p.createdAt.toISOString() })),
      recentComments: recentComments2.map((c) => ({
        id: c.id,
        body: c.body,
        score: c.score,
        createdAt: c.createdAt.toISOString(),
        subreddit: c.subredditName ?? "",
        permalink: buildCommentPermalink(c.permalink, c.subredditName, c.parentId, c.redditCommentId),
      })),
    },
    similarityScore,
    sharedThemes,
    majorDifferences,
    archetypeComparison,
  });
});

export default router;
