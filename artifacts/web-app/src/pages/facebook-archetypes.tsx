import { useListFacebookArchetypes, getListFacebookArchetypesQueryKey } from "@workspace/api-client-react";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Users, Target, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export default function FacebookArchetypes() {
  const { data: archetypes, isLoading } = useListFacebookArchetypes({
    query: {
      queryKey: getListFacebookArchetypesQueryKey(),
    },
  });

  if (isLoading) {
    return (
      <div className="p-8 space-y-6">
        <div>
          <Skeleton className="h-10 w-64 mb-2" />
          <Skeleton className="h-4 w-96" />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-64 glass" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="p-8 space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Facebook Archetype Models</h1>
        <p className="text-muted-foreground mt-1 font-mono text-sm">BEHAVIORAL CLASSIFICATION TAXONOMY</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {archetypes?.map((arch) => (
          <Link key={arch.key} href={`/facebook-archetypes/${arch.key}`} className="block">
          <Card className="glass hover:border-primary/50 transition-colors flex flex-col h-full cursor-pointer group">
            <CardHeader className="pb-3">
              <div className="flex justify-between items-start mb-2">
                <Badge variant="outline" className="font-mono text-[10px] bg-primary/5 text-primary border-primary/20">
                  {arch.key.toUpperCase()}
                </Badge>
                <ChevronRight className="w-4 h-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
              </div>
              <CardTitle className="text-lg">{arch.name}</CardTitle>
            </CardHeader>
            <CardContent className="flex-1 flex flex-col">
              <p className="text-sm text-muted-foreground mb-4 flex-1">{arch.description}</p>

              <div className="space-y-4">
                <div className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Users className="w-4 h-4" />
                    <span>Population</span>
                  </div>
                  <span className="font-mono font-bold">{arch.userCount}</span>
                </div>

                <div className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Target className="w-4 h-4" />
                    <span>Avg Score</span>
                  </div>
                  <span className="font-mono font-bold text-accent">{arch.averageScore.toFixed(1)}</span>
                </div>

                <div className="pt-3 border-t border-border/50">
                  <p className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider mb-2">Top Themes</p>
                  <div className="flex flex-wrap gap-1">
                    {arch.topThemes?.slice(0, 3).map((theme, i) => (
                      <span key={i} className="text-xs bg-muted/30 px-2 py-1 rounded text-muted-foreground">
                        {theme}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
