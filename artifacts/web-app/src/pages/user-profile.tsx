import { useState, useEffect, useRef, useMemo } from "react";
import { fmtDate, fmtDateShort, fmtDateTime } from "@/lib/utils";
import { 
  useGetUser, 
  getGetUserQueryKey,
  useGetUserTrends,
  getGetUserTrendsQueryKey,
  useAnalyzeUser,
  useReanalyzeUser,
  useUpdateUserNotes
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useParams } from "wouter";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { RedditUserLink } from "@/components/reddit-user-link";
import { PaginatedContentCard } from "@/components/paginated-content-card";
import { DossierPrintButton } from "@/components/profile/dossier-print-button";
import { IdentityDossier } from "@/components/profile/identity-dossier";
import { FlaggedCommentsCard } from "@/components/profile/flagged-comments-card";
import type { ProfilePdfData } from "@/components/profile/profile-pdf-document";
import { 
  RadarChart, 
  PolarGrid, 
  PolarAngleAxis, 
  PolarRadiusAxis, 
  Radar, 
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend
} from "recharts";
import { AlertCircle, BrainCircuit, Activity, FileText, MessageSquare, Clock, ExternalLink, CheckCheck, Archive, DownloadCloud } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip as UiTooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from "@/components/ui/tooltip";

// 14 distinct hues — one per archetype — since the theme only ships 5 chart
// colors. Each archetype maps to a color by a stable hash of its key, so the
// same archetype always renders the same color regardless of which others are
// present or how the 20-analysis window slides.
const ARCHETYPE_LINE_COLORS = [
  "hsl(173 80% 40%)",
  "hsl(38 92% 50%)",
  "hsl(199 89% 48%)",
  "hsl(280 65% 60%)",
  "hsl(340 75% 55%)",
  "hsl(95 60% 50%)",
  "hsl(15 80% 55%)",
  "hsl(220 70% 60%)",
  "hsl(50 90% 55%)",
  "hsl(260 60% 65%)",
  "hsl(160 70% 45%)",
  "hsl(0 70% 60%)",
  "hsl(125 50% 50%)",
  "hsl(300 60% 60%)",
];

function colorForArchetype(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0;
  return ARCHETYPE_LINE_COLORS[Math.abs(hash) % ARCHETYPE_LINE_COLORS.length];
}

export default function UserProfile() {
  const { username } = useParams<{ username: string }>();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: profile, isLoading } = useGetUser(username || "", {
    query: {
      enabled: !!username,
      queryKey: getGetUserQueryKey(username || "")
    }
  });

  const { data: trends, isLoading: isLoadingTrends } = useGetUserTrends(username || "", {
    query: {
      enabled: !!username,
      queryKey: getGetUserTrendsQueryKey(username || "")
    }
  });

  // Pivot the flat trend points (one row per archetype per date) into one row
  // per date with each archetype as a column, so we can draw one line each.
  // Archetypes that never exceed 0% for this user are dropped entirely.
  const { chartData, activeArchetypes } = useMemo(() => {
    if (!trends || trends.length === 0) {
      return { chartData: [] as Array<Record<string, number | string>>, activeArchetypes: [] as Array<{ key: string; name: string }> };
    }
    const maxByKey = new Map<string, { name: string; max: number }>();
    for (const t of trends) {
      const cur = maxByKey.get(t.archetypeKey);
      const name = t.archetypeName ?? t.archetypeKey;
      if (!cur || t.score > cur.max) maxByKey.set(t.archetypeKey, { name, max: t.score });
    }
    const active = [...maxByKey.entries()]
      .filter(([, v]) => v.max > 0)
      .map(([key, v]) => ({ key, name: v.name }));

    const byDate = new Map<string, Record<string, number | string>>();
    for (const t of trends) {
      if (!maxByKey.get(t.archetypeKey) || maxByKey.get(t.archetypeKey)!.max <= 0) continue;
      let row = byDate.get(t.date);
      if (!row) {
        row = { date: t.date };
        byDate.set(t.date, row);
      }
      row[t.archetypeKey] = t.score;
    }
    const data = [...byDate.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
    return { chartData: data, activeArchetypes: active };
  }, [trends]);

  const analyzeMutation = useAnalyzeUser();
  const reanalyzeMutation = useReanalyzeUser();
  const notesMutation = useUpdateUserNotes();

  // After either action button is clicked, keep both disabled for ~30s so the
  // user can't accidentally re-queue a costly crawl/analysis in quick succession.
  const [cooldown, setCooldown] = useState(false);
  const cooldownTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startCooldown = () => {
    setCooldown(true);
    if (cooldownTimer.current) clearTimeout(cooldownTimer.current);
    cooldownTimer.current = setTimeout(() => setCooldown(false), 30000);
  };
  useEffect(() => () => {
    if (cooldownTimer.current) clearTimeout(cooldownTimer.current);
  }, []);
  const actionsDisabled =
    analyzeMutation.isPending || reanalyzeMutation.isPending || cooldown;

  const [notesValue, setNotesValue] = useState("");
  const [notesSaved, setNotesSaved] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setNotesValue(profile?.user?.notes ?? "");
  }, [profile?.user?.notes]);

  const handleNotesChange = (val: string) => {
    setNotesValue(val);
    setNotesSaved(false);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      if (!username) return;
      notesMutation.mutate(
        { username, data: { notes: val } },
        {
          onSuccess: () => {
            setNotesSaved(true);
            queryClient.invalidateQueries({ queryKey: getGetUserQueryKey(username) });
          },
        }
      );
    }, 900);
  };

  const handleFetchNewData = () => {
    if (!username) return;
    startCooldown();
    analyzeMutation.mutate({ username }, {
      onSuccess: () => {
        toast({
          title: "Fetch New Data Queued",
          description: `Crawling the latest Arctic Shift data for ${username}, then rebuilding the profile. This may take a few minutes.`,
        });
      },
      onError: () => {
        toast({
          title: "Fetch Failed",
          description: "Could not queue the fetch & analysis job.",
          variant: "destructive"
        });
      }
    });
  };

  const handleReanalyze = () => {
    if (!username) return;
    startCooldown();
    reanalyzeMutation.mutate({ username }, {
      onSuccess: () => {
        toast({
          title: "Re-analysis Queued",
          description: `Rebuilding ${username}'s profile from data already stored. No new Reddit data is fetched.`,
        });
      },
      onError: () => {
        toast({
          title: "Re-analysis Failed",
          description: "Could not queue the re-analysis job.",
          variant: "destructive"
        });
      }
    });
  };

  if (isLoading) {
    return (
      <div className="p-8 space-y-6">
        <Skeleton className="h-12 w-64 mb-4" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <Skeleton className="h-96 glass col-span-1" />
          <Skeleton className="h-96 glass col-span-2" />
        </div>
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="p-8 flex flex-col items-center justify-center h-full">
        <AlertCircle className="w-16 h-16 text-muted-foreground opacity-50 mb-4" />
        <h2 className="text-xl font-mono text-muted-foreground">ENTITY NOT FOUND</h2>
      </div>
    );
  }

  // Format data for radar chart
  const radarData = profile.archetypeScores.map(score => ({
    subject: score.archetypeName,
    score: score.score,
    fullMark: 100,
  }));

  const pdfData = {
    title: `u/${profile.user.username}`,
    subtitle: "Reddit user dossier",
    stats: [
      { label: "Posts", value: String(profile.user.totalPosts) },
      { label: "Comments", value: String(profile.user.totalComments) },
      { label: "Last Crawled", value: profile.user.arcticCrawledAt ? fmtDate(profile.user.arcticCrawledAt) : "Never" },
      { label: "Last Analyzed", value: profile.latestAnalysis?.createdAt ? fmtDate(profile.latestAnalysis.createdAt) : "Never" },
    ],
    archetypeScores: profile.archetypeScores,
    summary: profile.latestAnalysis?.summary,
    recurringThemes: profile.latestAnalysis?.recurringThemes,
    identifiers: profile.identifiers,
    flagged: (profile.flaggedComments ?? []).map((f) => ({
      issue: f.issue,
      excerpt: f.excerpt,
      permalink: f.permalink,
      meta: f.subreddit ? `r/${f.subreddit} · ${fmtDate(f.createdAt)}` : fmtDate(f.createdAt),
    })),
    trends: (trends ?? []).map((t) => ({ date: t.date, score: t.score })),
    postsLabel: "Posts",
    posts: (profile.recentPosts ?? []).map((p) => ({
      id: p.id,
      text: p.title,
      url: p.permalink,
      date: fmtDate(p.createdAt),
    })),
    commentsLabel: "Comments",
    comments: (profile.recentComments ?? []).map((c) => ({
      id: c.id,
      text: `"${c.body}"`,
      url: c.permalink,
      meta: c.subreddit ? `r/${c.subreddit}` : null,
      date: fmtDate(c.createdAt),
    })),
  } satisfies ProfilePdfData;

  return (
    <div className="p-8 space-y-6 print-report">
      <div className="flex justify-between items-end">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <h1 className="text-4xl font-bold tracking-tight">
              <RedditUserLink username={profile.user.username} dossier={false} />
            </h1>
            <Badge variant="outline" className="bg-primary/10 text-primary border-primary/20 font-mono">
              TARGET PROFILED
            </Badge>
          </div>
          <div className="flex items-center gap-4 text-sm text-muted-foreground font-mono">
            <span className="flex items-center gap-1"><FileText className="w-4 h-4" /> {profile.user.totalPosts} Posts</span>
            <span className="flex items-center gap-1"><MessageSquare className="w-4 h-4" /> {profile.user.totalComments} Comments</span>
          </div>
          <div className="flex items-center gap-4 text-xs text-muted-foreground/80 font-mono mt-1.5">
            <span>Last Crawled: {profile.user.arcticCrawledAt ? fmtDateTime(profile.user.arcticCrawledAt) : "Never"}</span>
            <span>Last Analyzed: {profile.latestAnalysis?.createdAt ? fmtDateTime(profile.latestAnalysis.createdAt) : "Never"}</span>
          </div>
        </div>
        <div className="flex items-center gap-2 no-print">
          <TooltipProvider delayDuration={150}>
            <UiTooltip>
              <TooltipTrigger asChild>
                <span tabIndex={0}>
                  <Button
                    variant="secondary"
                    onClick={handleReanalyze}
                    disabled={actionsDisabled}
                    className="font-mono"
                  >
                    <BrainCircuit className="w-4 h-4 mr-2" />
                    {reanalyzeMutation.isPending ? 'PROCESSING...' : 'RE-ANALYZE'}
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                <p>
                  Re-runs the AI analysis using the posts and comments already
                  stored in the database. Does <strong>not</strong> crawl Reddit,
                  so no new data is fetched and no crawl cost is incurred. Use this
                  to rebuild the profile after analysis logic changes.
                </p>
              </TooltipContent>
            </UiTooltip>
            <UiTooltip>
              <TooltipTrigger asChild>
                <span tabIndex={0}>
                  <Button
                    variant="secondary"
                    onClick={handleFetchNewData}
                    disabled={actionsDisabled}
                    className="font-mono"
                  >
                    <DownloadCloud className="w-4 h-4 mr-2" />
                    {analyzeMutation.isPending ? 'PROCESSING...' : 'FETCH NEW DATA'}
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                <p>
                  Crawls Reddit (via Arctic Shift) to expand the dataset, then
                  re-analyzes. If this user has never been crawled, it runs a full
                  historical crawl; otherwise it runs an incremental crawl that
                  fetches activity <strong>newer</strong> than what is already
                  stored. This may take a few minutes.
                </p>
              </TooltipContent>
            </UiTooltip>
          </TooltipProvider>
          <DossierPrintButton data={pdfData} />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="glass col-span-1 border-primary/20">
          <CardHeader>
            <CardTitle className="font-mono text-sm tracking-wider text-muted-foreground">ARCHETYPE SIGNATURE</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-[300px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <RadarChart cx="50%" cy="50%" outerRadius="70%" data={radarData}>
                  <PolarGrid stroke="hsl(var(--border))" />
                  <PolarAngleAxis 
                    dataKey="subject" 
                    tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }} 
                  />
                  <PolarRadiusAxis angle={30} domain={[0, 100]} tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }} />
                  <Radar name={profile.user.username} dataKey="score" stroke="hsl(var(--primary))" fill="hsl(var(--primary))" fillOpacity={0.3} />
                  <Tooltip contentStyle={{ backgroundColor: 'hsl(var(--card))', borderColor: 'hsl(var(--border))' }} />
                </RadarChart>
              </ResponsiveContainer>
            </div>
            
            <div className="mt-4 space-y-3">
              {profile.archetypeScores.slice(0, 3).map((score, i) => (
                <div key={score.archetypeKey} className="flex justify-between items-center bg-muted/20 p-2 rounded border border-border/50">
                  <span className="text-sm font-medium">{score.archetypeName}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground font-mono">CONF: {score.confidence}%</span>
                    <span className={`text-sm font-bold font-mono ${i === 0 ? 'text-accent' : 'text-foreground'}`}>{score.score}</span>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card className="glass col-span-1 lg:col-span-2">
          <CardHeader>
            <CardTitle className="font-mono text-sm tracking-wider text-muted-foreground">INTELLIGENCE SUMMARY</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="bg-muted/10 p-4 rounded-md border border-border/50 text-sm leading-relaxed">
              {profile.latestAnalysis?.summary || "No summary available."}
            </div>

            <div>
              <h3 className="font-mono text-xs text-muted-foreground mb-3 tracking-wider">RECURRING THEMES</h3>
              <div className="flex flex-wrap gap-2">
                {profile.latestAnalysis?.recurringThemes.map((theme, i) => (
                  <Badge key={i} variant="secondary" className="font-mono text-xs bg-secondary/50 border-secondary-border whitespace-normal break-words text-left max-w-full">
                    {theme}
                  </Badge>
                ))}
                {!profile.latestAnalysis?.recurringThemes?.length && (
                  <span className="text-sm text-muted-foreground">No themes detected.</span>
                )}
              </div>
            </div>

            <div>
              <h3 className="font-mono text-xs text-muted-foreground mb-3 tracking-wider">SIGNATURE EVOLUTION</h3>
              <div className="h-[280px] w-full bg-background/50 rounded-md border border-border/50 p-2">
                {isLoadingTrends ? (
                  <div className="h-full flex items-center justify-center text-muted-foreground"><Activity className="animate-pulse w-8 h-8" /></div>
                ) : chartData.length > 0 && activeArchetypes.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chartData} margin={{ top: 5, right: 8, left: -16, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                      <XAxis dataKey="date" stroke="hsl(var(--muted-foreground))" fontSize={10} tickFormatter={(val) => fmtDateShort(val)} />
                      <YAxis stroke="hsl(var(--muted-foreground))" fontSize={10} domain={[0, 100]} />
                      <Tooltip contentStyle={{ backgroundColor: 'hsl(var(--card))', borderColor: 'hsl(var(--border))' }} />
                      <Legend wrapperStyle={{ fontSize: 10 }} />
                      {activeArchetypes.map((a) => (
                        <Line
                          key={a.key}
                          type="monotone"
                          dataKey={a.key}
                          name={a.name}
                          stroke={colorForArchetype(a.key)}
                          strokeWidth={2}
                          dot={false}
                          connectNulls
                        />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="h-full flex items-center justify-center text-muted-foreground font-mono text-xs">NO TREND DATA AVAILABLE</div>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <IdentityDossier identifiers={profile.identifiers} />

      <FlaggedCommentsCard items={profile.flaggedComments ?? []} />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <PaginatedContentCard
          key={`posts-${username}`}
          title="POSTS"
          items={profile.recentPosts ?? []}
          getKey={(post) => post.id}
          emptyText="No posts."
          renderItem={(post) => (
            <div className="pb-3 border-b border-border/50 last:border-0 last:pb-0">
              <a href={post.permalink} target="_blank" rel="noreferrer" className="text-sm font-medium hover:text-primary transition-colors block mb-1">
                {post.title}
              </a>
              <div className="flex items-center justify-between text-xs text-muted-foreground font-mono">
                {post.recoveredAt ? (
                  <Badge variant="outline" className="bg-amber-500/10 text-amber-500 border-amber-500/20 font-mono text-[10px] gap-1">
                    <Archive className="w-3 h-3" />
                    RECOVERED
                  </Badge>
                ) : (
                  <span />
                )}
                <span>{fmtDate(post.createdAt)}</span>
              </div>
            </div>
          )}
        />

        <PaginatedContentCard
          key={`comments-${username}`}
          title="COMMENTS"
          items={profile.recentComments ?? []}
          getKey={(comment) => comment.id}
          emptyText="No comments."
          renderItem={(comment) => (
            <div className="pb-3 border-b border-border/50 last:border-0 last:pb-0">
              {comment.permalink ? (
                <a
                  href={comment.permalink}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm text-muted-foreground mb-1 line-clamp-2 hover:text-primary transition-colors block"
                >
                  "{comment.body}"
                </a>
              ) : (
                <p className="text-sm text-muted-foreground mb-1 line-clamp-2">
                  "{comment.body}"
                </p>
              )}
              <div className="flex items-center justify-between text-xs text-muted-foreground font-mono">
                <span className="flex items-center gap-2">
                  {comment.subreddit && (
                    comment.permalink ? (
                      <a
                        href={comment.permalink}
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-center gap-1 text-primary hover:underline"
                      >
                        r/{comment.subreddit}
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    ) : (
                      <span>r/{comment.subreddit}</span>
                    )
                  )}
                  {comment.recoveredAt && (
                    <Badge variant="outline" className="bg-amber-500/10 text-amber-500 border-amber-500/20 font-mono text-[10px] gap-1">
                      <Archive className="w-3 h-3" />
                      RECOVERED
                    </Badge>
                  )}
                </span>
                <span>{fmtDate(comment.createdAt)}</span>
              </div>
            </div>
          )}
        />
      </div>

      <Card className="glass no-print">
        <CardHeader>
          <CardTitle className="font-mono text-sm tracking-wider text-muted-foreground flex items-center justify-between">
            <span>ANALYST NOTES</span>
            {notesSaved && (
              <span className="flex items-center gap-1 text-primary text-[10px]">
                <CheckCheck className="w-3 h-3" /> SAVED
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Textarea
            value={notesValue}
            onChange={(e) => handleNotesChange(e.target.value)}
            placeholder="Add internal analyst notes about this user…"
            className="min-h-[120px] bg-background/50 font-mono text-sm resize-y"
          />
          <p className="text-[10px] text-muted-foreground mt-2 font-mono">Auto-saved · Internal only · Not included in print output</p>
        </CardContent>
      </Card>

      <div className="p-4 bg-muted/20 rounded-md border border-border/50">
        <p className="text-xs text-muted-foreground text-center">
          Classifications are probabilistic estimates based on observed discussion patterns. Confidence scores indicate reliability. Users may fit multiple archetypes. This analysis does not infer protected characteristics.
        </p>
      </div>
    </div>
  );
}