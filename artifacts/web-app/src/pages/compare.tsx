import { useState } from "react";
import { useCompareUsers, getCompareUsersQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, Radar, ResponsiveContainer, Tooltip as RechartsTooltip, Legend } from "recharts";
import { GitCompare, AlertTriangle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export default function Compare() {
  const [user1, setUser1] = useState("");
  const [user2, setUser2] = useState("");
  const [activeCompare, setActiveCompare] = useState<{u1: string, u2: string} | null>(null);
  const { toast } = useToast();

  const { data: comparison, isLoading, isError } = useCompareUsers(
    activeCompare ? { u1: activeCompare.u1, u2: activeCompare.u2 } : { u1: "", u2: "" }, 
    {
      query: {
        enabled: !!activeCompare,
        queryKey: getCompareUsersQueryKey(activeCompare ? { u1: activeCompare.u1, u2: activeCompare.u2 } : { u1: "", u2: "" }),
        retry: false
      }
    }
  );

  const handleCompare = (e: React.FormEvent) => {
    e.preventDefault();
    if (!user1 || !user2) {
      toast({ title: "Validation Error", description: "Please enter both usernames", variant: "destructive" });
      return;
    }
    setActiveCompare({ u1: user1, u2: user2 });
  };

  const radarData = comparison?.archetypeComparison.map(row => ({
    subject: row.archetypeName,
    [comparison.user1.user.username]: row.scoreUser1,
    [comparison.user2.user.username]: row.scoreUser2,
  }));

  return (
    <div className="p-8 space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Cross-Entity Analysis</h1>
        <p className="text-muted-foreground mt-1 font-mono text-sm">COMPARATIVE BEHAVIORAL PROFILING</p>
      </div>

      <Card className="glass">
        <CardContent className="p-6">
          <form onSubmit={handleCompare} className="flex flex-col md:flex-row items-end gap-4">
            <div className="flex-1 w-full">
              <label className="text-xs font-mono text-muted-foreground uppercase tracking-wider mb-2 block">Subject Alpha</label>
              <Input 
                value={user1} 
                onChange={(e) => setUser1(e.target.value)} 
                placeholder="Username 1"
                className="bg-background/50"
              />
            </div>
            <div className="flex items-center justify-center pb-2 md:pb-0">
              <div className="w-8 h-8 rounded-full bg-muted/20 flex items-center justify-center border border-border">
                <GitCompare className="w-4 h-4 text-muted-foreground" />
              </div>
            </div>
            <div className="flex-1 w-full">
              <label className="text-xs font-mono text-muted-foreground uppercase tracking-wider mb-2 block">Subject Beta</label>
              <Input 
                value={user2} 
                onChange={(e) => setUser2(e.target.value)} 
                placeholder="Username 2"
                className="bg-background/50"
              />
            </div>
            <Button type="submit" disabled={isLoading} className="w-full md:w-auto font-mono">
              {isLoading ? "ANALYZING..." : "EXECUTE COMPARISON"}
            </Button>
          </form>
        </CardContent>
      </Card>

      {isLoading && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-8">
          <Skeleton className="h-96 glass" />
          <Skeleton className="h-96 glass" />
        </div>
      )}

      {isError && (
        <div className="p-8 border border-destructive/20 bg-destructive/5 rounded-md flex items-center gap-3 text-destructive mt-8">
          <AlertTriangle className="w-5 h-5" />
          <p className="font-mono text-sm">Failed to generate comparison. Verify both subjects exist in the database.</p>
        </div>
      )}

      {comparison && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 animate-in fade-in duration-500 mt-8">
          <Card className="glass col-span-1 lg:col-span-2">
            <CardHeader>
              <CardTitle className="font-mono text-sm text-muted-foreground tracking-wider">SIGNATURE OVERLAP</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="h-[400px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <RadarChart cx="50%" cy="50%" outerRadius="70%" data={radarData}>
                    <PolarGrid stroke="hsl(var(--border))" />
                    <PolarAngleAxis dataKey="subject" tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }} />
                    <PolarRadiusAxis angle={30} domain={[0, 100]} tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }} />
                    <Radar name={comparison.user1.user.username} dataKey={comparison.user1.user.username} stroke="hsl(var(--primary))" fill="hsl(var(--primary))" fillOpacity={0.4} />
                    <Radar name={comparison.user2.user.username} dataKey={comparison.user2.user.username} stroke="hsl(var(--accent))" fill="hsl(var(--accent))" fillOpacity={0.4} />
                    <RechartsTooltip contentStyle={{ backgroundColor: 'hsl(var(--card))', borderColor: 'hsl(var(--border))' }} />
                    <Legend wrapperStyle={{ fontSize: '12px', fontFamily: 'var(--font-mono)' }} />
                  </RadarChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          <div className="space-y-6 col-span-1">
            <Card className="glass">
              <CardHeader className="pb-4">
                <CardTitle className="font-mono text-sm text-muted-foreground tracking-wider">SIMILARITY INDEX</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-center py-4">
                  <span className={`text-6xl font-bold font-mono ${comparison.similarityScore > 70 ? 'text-primary' : comparison.similarityScore < 30 ? 'text-destructive' : 'text-accent'}`}>
                    {comparison.similarityScore}%
                  </span>
                </div>
              </CardContent>
            </Card>

            <Card className="glass">
              <CardHeader className="pb-4">
                <CardTitle className="font-mono text-sm text-muted-foreground tracking-wider">SHARED THEMES</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2">
                  {comparison.sharedThemes.map((theme, i) => (
                    <li key={i} className="text-sm bg-muted/20 px-3 py-2 rounded border border-border/50 flex items-center gap-2">
                      <div className="w-1.5 h-1.5 rounded-full bg-primary" />
                      {theme}
                    </li>
                  ))}
                  {comparison.sharedThemes.length === 0 && (
                    <li className="text-sm text-muted-foreground italic">No common themes detected.</li>
                  )}
                </ul>
              </CardContent>
            </Card>

            {comparison.majorDifferences && comparison.majorDifferences.length > 0 && (
              <Card className="glass">
                <CardHeader className="pb-4">
                  <CardTitle className="font-mono text-sm text-muted-foreground tracking-wider">KEY DIVERGENCES</CardTitle>
                </CardHeader>
                <CardContent>
                  <ul className="space-y-2">
                    {comparison.majorDifferences.map((diff, i) => (
                      <li key={i} className="text-sm bg-muted/20 px-3 py-2 rounded border border-border/50 flex items-start gap-2">
                        <div className="w-1.5 h-1.5 rounded-full bg-accent mt-1.5 shrink-0" />
                        <span className="text-muted-foreground">{diff}</span>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      )}
    </div>
  );
}