import { useState } from "react";
import { fmtDate, fmtDateShort } from "@/lib/utils";
import {
  useGetTikTokDashboard,
  getGetTikTokDashboardQueryKey,
  useGetTikTokDashboardThemeDetails,
  getGetTikTokDashboardThemeDetailsQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { TikTokUserLink } from "@/components/tiktok-user-link";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  LineChart,
  Line,
} from "recharts";
import { Users, MessageSquare, FileText, ChevronRight } from "lucide-react";

function ThemeDetailDialog({ label, open, onClose }: { label: string | null; open: boolean; onClose: () => void }) {
  const params = { label: label ?? "" };
  const { data, isLoading } = useGetTikTokDashboardThemeDetails(params, {
    query: {
      queryKey: getGetTikTokDashboardThemeDetailsQueryKey(params),
      enabled: open && !!label,
    },
  });

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm tracking-wider">{label}</DialogTitle>
          <DialogDescription>
            Elaborated theme descriptions from individual profiles
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 mt-2">
          {isLoading && (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => <Skeleton key={i} className="h-16 w-full" />)}
            </div>
          )}
          {!isLoading && data?.items?.length === 0 && (
            <p className="text-sm text-muted-foreground">No detailed descriptions available yet — re-analyse profiles to populate this.</p>
          )}
          {data?.items?.map((item, i) => (
            <div key={i} className="p-3 rounded-md bg-muted/20 border border-border/50 space-y-1">
              <div className="flex items-center gap-2">
                <TikTokUserLink
                  username={item.username}
                  displayName={item.displayName}
                  className="text-xs font-mono font-medium"
                />
              </div>
              <p className="text-sm text-muted-foreground leading-relaxed">{item.description}</p>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function TikTokDashboard() {
  const [selectedTheme, setSelectedTheme] = useState<string | null>(null);

  const { data, isLoading } = useGetTikTokDashboard({
    query: {
      queryKey: getGetTikTokDashboardQueryKey(),
    },
  });

  if (isLoading) {
    return (
      <div className="p-8 space-y-8 animate-in fade-in duration-500">
        <div className="flex justify-between items-center">
          <div>
            <Skeleton className="h-8 w-48 mb-2" />
            <Skeleton className="h-4 w-64" />
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-32 w-full glass" />
          ))}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          <Skeleton className="h-96 w-full glass" />
          <Skeleton className="h-96 w-full glass" />
        </div>
      </div>
    );
  }

  const stats = data;

  return (
    <div className="p-8 space-y-8 animate-in fade-in duration-500">
      <ThemeDetailDialog
        label={selectedTheme}
        open={!!selectedTheme}
        onClose={() => setSelectedTheme(null)}
      />

      <div className="flex flex-wrap justify-between items-end gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">TikTok Intelligence Overview</h1>
          <p className="text-muted-foreground mt-1 font-mono text-sm">TIKTOK COMMUNITY DYNAMICS ANALYSIS</p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card className="glass border-primary/20">
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-1">Total Users</p>
                <h3 className="text-3xl font-bold font-mono">{stats?.totalUsers.toLocaleString()}</h3>
              </div>
              <div className="p-3 bg-primary/10 rounded-full">
                <Users className="w-5 h-5 text-primary" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="glass border-border">
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-1">Posts Analyzed</p>
                <h3 className="text-3xl font-bold font-mono">{stats?.totalPosts.toLocaleString()}</h3>
              </div>
              <div className="p-3 bg-secondary rounded-full">
                <FileText className="w-5 h-5 text-muted-foreground" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="glass border-border">
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-1">Comments Analyzed</p>
                <h3 className="text-3xl font-bold font-mono">{stats?.totalComments.toLocaleString()}</h3>
              </div>
              <div className="p-3 bg-secondary rounded-full">
                <MessageSquare className="w-5 h-5 text-muted-foreground" />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <Card className="glass col-span-1">
          <CardHeader>
            <CardTitle className="font-mono text-sm text-muted-foreground tracking-wider">ARCHETYPE DISTRIBUTION</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-[300px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={stats?.archetypeDistribution}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                  <XAxis
                    dataKey="archetypeName"
                    stroke="hsl(var(--muted-foreground))"
                    fontSize={11}
                    tickFormatter={(value) => (value.length > 15 ? value.substring(0, 15) + "..." : value)}
                  />
                  <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} />
                  <Tooltip
                    contentStyle={{ backgroundColor: "hsl(var(--card))", borderColor: "hsl(var(--border))" }}
                    itemStyle={{ color: "hsl(var(--primary))" }}
                  />
                  <Bar dataKey="userCount" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <Card className="glass col-span-1">
          <CardHeader>
            <CardTitle className="font-mono text-sm text-muted-foreground tracking-wider">ACTIVITY VOLUME (30 DAYS)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-[300px]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={stats?.activityByDay}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                  <XAxis
                    dataKey="date"
                    stroke="hsl(var(--muted-foreground))"
                    fontSize={11}
                    tickFormatter={(val) => fmtDateShort(val)}
                  />
                  <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} />
                  <Tooltip
                    contentStyle={{ backgroundColor: "hsl(var(--card))", borderColor: "hsl(var(--border))" }}
                    labelFormatter={(val) => fmtDate(val)}
                  />
                  <Line type="monotone" dataKey="comments" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} name="Comments" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <Card className="glass">
          <CardHeader>
            <CardTitle className="font-mono text-sm text-muted-foreground tracking-wider">HIGH-CONFIDENCE PROFILES</CardTitle>
            <CardDescription>Top users ranked by archetype confidence scores</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {stats?.topUsers?.map((u) => (
                <div
                  key={u.user.id}
                  className="flex items-center justify-between p-3 rounded-md bg-muted/20 border border-border/50 hover:border-primary/50 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded bg-primary/20 flex items-center justify-center font-mono font-bold text-primary text-xs">
                      {u.user.displayName.substring(0, 2).toUpperCase()}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <TikTokUserLink
                          username={u.user.username}
                          displayName={u.user.displayName}
                          profileUrl={u.user.profileUrl}
                          className="font-medium"
                        />
                      </div>
                      {u.dominantArchetype && u.dominantArchetype !== "Mixed / Unclassified" && (
                        <p className="text-xs text-muted-foreground">{u.dominantArchetype}</p>
                      )}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-mono font-bold text-accent">{u.topScore}% Match</div>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card className="glass">
          <CardHeader>
            <CardTitle className="font-mono text-sm text-muted-foreground tracking-wider">RECURRING NARRATIVE THEMES</CardTitle>
            <CardDescription>Click any theme to see elaborated descriptions per profile</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {stats?.topThemes?.map((t, idx) => (
                <button
                  key={idx}
                  onClick={() => setSelectedTheme(t.theme)}
                  className="w-full text-left group"
                >
                  <div className="flex items-center gap-3 w-full">
                    <span className="font-mono text-xs text-muted-foreground w-4">
                      {(idx + 1).toString().padStart(2, "0")}
                    </span>
                    <div className="flex-1">
                      <div className="flex justify-between items-center mb-1">
                        <span className="text-sm font-medium group-hover:text-primary transition-colors">{t.theme}</span>
                        <div className="flex items-center gap-1">
                          <span className="text-xs text-muted-foreground font-mono">{t.count} hits</span>
                          <ChevronRight className="w-3 h-3 text-muted-foreground group-hover:text-primary transition-colors" />
                        </div>
                      </div>
                      <div className="h-1.5 w-full bg-secondary rounded-full overflow-hidden">
                        <div
                          className="h-full bg-primary/70 rounded-full group-hover:bg-primary transition-colors"
                          style={{ width: `${Math.min(100, (t.count / (stats.topThemes?.[0]?.count || 1)) * 100)}%` }}
                        />
                      </div>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
