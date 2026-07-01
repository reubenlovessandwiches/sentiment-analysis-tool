import { useRoute, Link } from "wouter";
import {
  useGetFacebookArchetypeUsers,
  getGetFacebookArchetypeUsersQueryKey,
  useListFacebookArchetypes,
  getListFacebookArchetypesQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Users, Target, ShieldAlert } from "lucide-react";

export default function FacebookArchetypeDetail() {
  const [, params] = useRoute("/facebook-archetypes/:key");
  const key = params?.key ?? "";

  const { data: archetypes } = useListFacebookArchetypes({
    query: { queryKey: getListFacebookArchetypesQueryKey() },
  });
  const meta = archetypes?.find((a) => a.key === key);

  const { data: users, isLoading } = useGetFacebookArchetypeUsers(
    key,
    { minScore: 1, limit: 100 },
    { query: { queryKey: getGetFacebookArchetypeUsersQueryKey(key, { minScore: 1, limit: 100 }) } },
  );

  return (
    <div className="p-8 space-y-6">
      <div>
        <Link href="/facebook-archetypes">
          <Button variant="ghost" size="sm" className="font-mono text-xs mb-4 -ml-2">
            <ArrowLeft className="w-4 h-4 mr-2" /> ALL ARCHETYPES
          </Button>
        </Link>
        <div className="flex items-center gap-3">
          <Badge variant="outline" className="font-mono text-[10px] bg-primary/5 text-primary border-primary/20">
            {key.toUpperCase()}
          </Badge>
        </div>
        <h1 className="text-3xl font-bold tracking-tight mt-2">{meta?.name ?? key}</h1>
        {meta?.description && <p className="text-muted-foreground mt-1 max-w-3xl">{meta.description}</p>}
      </div>

      {meta && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card className="glass">
            <CardContent className="pt-6 flex items-center justify-between">
              <div className="flex items-center gap-2 text-muted-foreground text-sm">
                <Users className="w-4 h-4" /> Population
              </div>
              <span className="font-mono font-bold text-lg">{meta.userCount}</span>
            </CardContent>
          </Card>
          <Card className="glass">
            <CardContent className="pt-6 flex items-center justify-between">
              <div className="flex items-center gap-2 text-muted-foreground text-sm">
                <Target className="w-4 h-4" /> Avg Score
              </div>
              <span className="font-mono font-bold text-lg text-accent">{meta.averageScore.toFixed(1)}</span>
            </CardContent>
          </Card>
        </div>
      )}

      <Card className="glass">
        <CardHeader>
          <CardTitle className="text-lg font-mono">CLASSIFIED ENTITIES</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="text-xs text-muted-foreground uppercase bg-muted/20 border-b border-border font-mono tracking-wider">
                <tr>
                  <th className="px-4 py-3">Subject</th>
                  <th className="px-4 py-3 text-right">Score</th>
                  <th className="px-4 py-3 text-right">Data Volume</th>
                  <th className="px-4 py-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  Array.from({ length: 6 }).map((_, i) => (
                    <tr key={i} className="border-b border-border/50">
                      <td className="px-4 py-3"><Skeleton className="h-5 w-32" /></td>
                      <td className="px-4 py-3 text-right"><Skeleton className="h-5 w-12 ml-auto" /></td>
                      <td className="px-4 py-3 text-right"><Skeleton className="h-5 w-20 ml-auto" /></td>
                      <td className="px-4 py-3 text-right"><Skeleton className="h-8 w-20 ml-auto" /></td>
                    </tr>
                  ))
                ) : !users || users.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-4 py-12 text-center text-muted-foreground">
                      <ShieldAlert className="w-12 h-12 mx-auto mb-3 opacity-20" />
                      <p className="font-mono">NO ENTITIES CLASSIFIED IN THIS ARCHETYPE</p>
                    </td>
                  </tr>
                ) : (
                  users.map((u) => (
                    <tr key={u.user.id} className="border-b border-border/50 hover:bg-muted/10 transition-colors">
                      <td className="px-4 py-3 font-medium">
                        <Link
                          href={`/facebook-users/${encodeURIComponent(u.user.profileId)}`}
                          className="hover:text-primary hover:underline transition-colors"
                        >
                          {u.user.displayName}
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span className={`font-mono font-bold ${(u.topScore ?? 0) > 80 ? "text-accent" : "text-foreground"}`}>
                          {u.topScore ?? "-"}%
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right text-muted-foreground font-mono">
                        {u.user.totalPosts}P / {u.user.totalComments}C
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Link href={`/facebook-users/${encodeURIComponent(u.user.profileId)}`}>
                          <Button size="sm" variant="ghost" className="font-mono text-xs hover:bg-primary/20 hover:text-primary">
                            VIEW DOSSIER
                          </Button>
                        </Link>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
