import { fmtDate } from "@/lib/utils";
import { useGetYoutubeUser, getGetYoutubeUserQueryKey } from "@workspace/api-client-react";
import { useParams } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { DossierPrintButton } from "@/components/profile/dossier-print-button";
import type { ProfilePdfData } from "@/components/profile/profile-pdf-document";
import { Badge } from "@/components/ui/badge";
import { PaginatedContentCard } from "@/components/paginated-content-card";
import {
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  Radar,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import { AlertCircle, MessageSquare, Clock, ExternalLink, ThumbsUp } from "lucide-react";

export default function YoutubeUserProfile() {
  const { username } = useParams<{ username: string }>();

  const { data: profile, isLoading } = useGetYoutubeUser(username || "", {
    query: {
      enabled: !!username,
      queryKey: getGetYoutubeUserQueryKey(username || ""),
    },
  });

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

  const radarData = profile.archetypeScores.map((score) => ({
    subject: score.archetypeName,
    score: score.score,
    fullMark: 100,
  }));

  const pdfData = {
    title: profile.user.displayName,
    subtitle: `YouTube · @${profile.user.username}`,
    stats: [
      { label: "Comments", value: String(profile.user.totalComments) },
      { label: "Last Surfaced", value: profile.recentComments?.[0]?.createdAt ? fmtDate(profile.recentComments[0].createdAt) : "—" },
    ],
    archetypeScores: profile.archetypeScores,
    summary: profile.latestAnalysis?.summary,
    recurringThemes: profile.latestAnalysis?.recurringThemes,
    confidenceNotes: profile.latestAnalysis?.confidenceNotes,
    commentsLabel: "Comments",
    comments: (profile.recentComments ?? []).map((c) => ({
      id: c.id,
      text: `"${c.body}"`,
      url: c.commentUrl,
      meta: `${c.likes} likes`,
      date: fmtDate(c.createdAt),
    })),
  } satisfies ProfilePdfData;

  return (
    <div className="p-8 space-y-6 print-report">
      <div className="flex justify-between items-end">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <h1 className="text-4xl font-bold tracking-tight">{profile.user.displayName}</h1>
            <Badge variant="outline" className="bg-primary/10 text-primary border-primary/20 font-mono">
              TARGET PROFILED
            </Badge>
          </div>
          <div className="flex items-center gap-4 text-sm text-muted-foreground font-mono flex-wrap">
            <span className="flex items-center gap-1">
              <MessageSquare className="w-4 h-4" /> {profile.user.totalComments} Comments
            </span>
            <span className="flex items-center gap-1">
              <Clock className="w-4 h-4" /> Last Surfaced: {profile.recentComments?.[0]?.createdAt ? fmtDate(profile.recentComments[0].createdAt) : "—"}
            </span>
            <span className="font-mono text-xs opacity-70">IG: @{profile.user.username}</span>
            {profile.user.profileUrl && (
              <a
                href={profile.user.profileUrl}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 text-primary hover:underline no-print"
              >
                View on Youtube <ExternalLink className="w-3 h-3" />
              </a>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 no-print">
          <DossierPrintButton data={pdfData} />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="glass col-span-1 border-primary/20">
          <CardHeader>
            <CardTitle className="font-mono text-sm tracking-wider text-muted-foreground">
              ARCHETYPE SIGNATURE
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-[300px] w-full">
              {radarData.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <RadarChart cx="50%" cy="50%" outerRadius="70%" data={radarData}>
                    <PolarGrid stroke="hsl(var(--border))" />
                    <PolarAngleAxis
                      dataKey="subject"
                      tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }}
                    />
                    <PolarRadiusAxis
                      angle={30}
                      domain={[0, 100]}
                      tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }}
                    />
                    <Radar
                      name={profile.user.displayName}
                      dataKey="score"
                      stroke="hsl(var(--primary))"
                      fill="hsl(var(--primary))"
                      fillOpacity={0.3}
                    />
                    <Tooltip
                      contentStyle={{ backgroundColor: "hsl(var(--card))", borderColor: "hsl(var(--border))" }}
                    />
                  </RadarChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-full flex items-center justify-center text-muted-foreground font-mono text-xs">
                  NO SIGNATURE DATA
                </div>
              )}
            </div>

            <div className="mt-4 space-y-3">
              {profile.archetypeScores.slice(0, 3).map((score, i) => (
                <div
                  key={score.archetypeKey}
                  className="flex justify-between items-center bg-muted/20 p-2 rounded border border-border/50"
                >
                  <span className="text-sm font-medium">{score.archetypeName}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground font-mono">CONF: {score.confidence}%</span>
                    <span className={`text-sm font-bold font-mono ${i === 0 ? "text-accent" : "text-foreground"}`}>
                      {score.score}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card className="glass col-span-1 lg:col-span-2">
          <CardHeader>
            <CardTitle className="font-mono text-sm tracking-wider text-muted-foreground">
              INTELLIGENCE SUMMARY
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="bg-muted/10 p-4 rounded-md border border-border/50 text-sm leading-relaxed">
              {profile.latestAnalysis?.summary || "No summary available."}
            </div>

            <div>
              <h3 className="font-mono text-xs text-muted-foreground mb-3 tracking-wider">RECURRING THEMES</h3>
              <div className="flex flex-wrap gap-2">
                {profile.latestAnalysis?.recurringThemes.map((theme, i) => (
                  <Badge
                    key={i}
                    variant="secondary"
                    className="font-mono text-xs bg-secondary/50 border-secondary-border whitespace-normal break-words text-left max-w-full"
                  >
                    {theme}
                  </Badge>
                ))}
                {!profile.latestAnalysis?.recurringThemes?.length && (
                  <span className="text-sm text-muted-foreground">No themes detected.</span>
                )}
              </div>
            </div>

            {profile.latestAnalysis?.confidenceNotes && (
              <div>
                <h3 className="font-mono text-xs text-muted-foreground mb-3 tracking-wider">CONFIDENCE NOTES</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {profile.latestAnalysis.confidenceNotes}
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <PaginatedContentCard
        key={`comments-${username}`}
        title="COMMENTS"
        items={profile.recentComments ?? []}
        getKey={(comment) => comment.id}
        emptyText="No comments."
        renderItem={(comment) => (
          <div className="pb-3 border-b border-border/50 last:border-0 last:pb-0">
            {comment.commentUrl ? (
              <a
                href={comment.commentUrl}
                target="_blank"
                rel="noreferrer"
                className="text-sm text-muted-foreground mb-1 line-clamp-3 hover:text-primary transition-colors block"
              >
                "{comment.body}"
              </a>
            ) : (
              <p className="text-sm text-muted-foreground mb-1 line-clamp-3">"{comment.body}"</p>
            )}
            <div className="flex items-center justify-between text-xs text-muted-foreground font-mono">
              <span className="flex items-center gap-1">
                <ThumbsUp className="w-3 h-3" /> {comment.likes}
              </span>
              <span>{fmtDate(comment.createdAt)}</span>
            </div>
          </div>
        )}
      />

      <div className="p-4 bg-muted/20 rounded-md border border-border/50">
        <p className="text-xs text-muted-foreground text-center">
          Classifications are probabilistic estimates based on observed discussion patterns. Confidence scores
          indicate reliability. Users may fit multiple archetypes. This analysis does not infer protected
          characteristics.
        </p>
      </div>
    </div>
  );
}
