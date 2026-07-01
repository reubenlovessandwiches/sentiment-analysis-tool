import { useState, useEffect } from "react";
import { Link } from "wouter";
import {
  useListInstagramUsers,
  getListInstagramUsersQueryKey,
  useListInstagramArchetypes,
  getListInstagramArchetypesQueryKey,
  useResumeInstagramClassification,
  getGetInstagramDashboardQueryKey,
} from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Pager } from "@/components/pager";
import { Skeleton } from "@/components/ui/skeleton";
import { Search, ShieldAlert, X, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const SORT_OPTIONS = [
  { value: "recent", label: "Recent activity" },
  { value: "volume", label: "Data volume" },
  { value: "score", label: "Highest confidence" },
  { value: "name", label: "Name A–Z" },
] as const;

function InstagramHandleCell({ handle }: { handle: string }) {
  return (
    <span
      title={handle}
      className="font-mono text-xs text-muted-foreground break-all"
    >
      @{handle}
    </span>
  );
}

export default function InstagramUsers() {
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState("");
  const [q, setQ] = useState("");
  const [archetype, setArchetype] = useState<string>("all");
  const [sortBy, setSortBy] = useState<string>("recent");
  const limit = 20;

  useEffect(() => {
    const t = setTimeout(() => {
      setQ(searchInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    setPage(1);
  }, [archetype, sortBy]);

  const { data: archetypes } = useListInstagramArchetypes({
    query: { queryKey: getListInstagramArchetypesQueryKey() },
  });

  const queryParams = {
    limit,
    offset: (page - 1) * limit,
    sortBy,
    ...(q ? { q } : {}),
    ...(archetype !== "all" ? { archetype } : {}),
  };

  const { data, isLoading } = useListInstagramUsers(queryParams, {
    query: { queryKey: getListInstagramUsersQueryKey(queryParams) },
  });

  const hasFilters = q !== "" || archetype !== "all" || sortBy !== "recent";

  const queryClient = useQueryClient();
  const { toast } = useToast();
  const resumeClassify = useResumeInstagramClassification();

  const handleClassify = async () => {
    try {
      const res = await resumeClassify.mutateAsync(undefined);
      if (res.status === "started") {
        toast({
          title: "Classification started",
          description: `Classifying ${res.pending} unclassified Instagram ${res.pending === 1 ? "user" : "users"}.`,
        });
      } else if (res.status === "already_running") {
        toast({ title: "Already running", description: "A classification pass is already in progress." });
      } else {
        toast({ title: "Nothing to classify", description: "All Instagram entities are already classified." });
      }
      queryClient.invalidateQueries({ queryKey: getListInstagramUsersQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetInstagramDashboardQueryKey() });
    } catch {
      toast({ title: "Classification failed", description: "Could not start classification.", variant: "destructive" });
    }
  };

  const clearFilters = () => {
    setSearchInput("");
    setQ("");
    setArchetype("all");
    setSortBy("recent");
    setPage(1);
  };

  return (
    <div className="p-8 space-y-6 h-full flex flex-col">
      <div className="flex flex-wrap justify-between items-end gap-4 shrink-0">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Instagram Entity Directory</h1>
          <p className="text-muted-foreground mt-1 font-mono text-sm">INDEX OF CLASSIFIED INSTAGRAM PROFILES</p>
        </div>
        <div className="flex flex-wrap gap-2 items-center">
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="w-56 pl-9 bg-card/50 glass border-border"
              placeholder="Search entity..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
            />
          </div>

          <Select value={archetype} onValueChange={setArchetype}>
            <SelectTrigger className="w-48 glass bg-card/50">
              <SelectValue placeholder="All archetypes" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All archetypes</SelectItem>
              {archetypes?.map((a) => (
                <SelectItem key={a.key} value={a.key}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={sortBy} onValueChange={setSortBy}>
            <SelectTrigger className="w-44 glass bg-card/50">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SORT_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Button
            variant="outline"
            size="sm"
            className="font-mono text-xs"
            onClick={handleClassify}
            disabled={resumeClassify.isPending}
          >
            <Sparkles className="w-4 h-4 mr-1" />
            {resumeClassify.isPending ? "CLASSIFYING..." : "CLASSIFY UNCLASSIFIED"}
          </Button>
          {hasFilters && (
            <Button variant="ghost" size="sm" className="font-mono text-xs" onClick={clearFilters}>
              <X className="w-4 h-4 mr-1" /> CLEAR
            </Button>
          )}
        </div>
      </div>

      <Card className="glass flex-1 overflow-hidden flex flex-col">
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="text-xs text-muted-foreground uppercase bg-muted/20 border-b border-border font-mono tracking-wider">
              <tr>
                <th className="px-6 py-3">Subject</th>
                <th className="px-6 py-3">Handle</th>
                <th className="px-6 py-3">Dominant Archetype</th>
                <th className="px-6 py-3">Confidence</th>
                <th className="px-6 py-3 text-right">Data Volume</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                Array.from({ length: 10 }).map((_, i) => (
                  <tr key={i} className="border-b border-border/50">
                    <td className="px-6 py-3"><Skeleton className="h-5 w-32" /></td>
                    <td className="px-6 py-3"><Skeleton className="h-5 w-28" /></td>
                    <td className="px-6 py-3"><Skeleton className="h-6 w-40 rounded-full" /></td>
                    <td className="px-6 py-3"><Skeleton className="h-5 w-16" /></td>
                    <td className="px-6 py-3 text-right"><Skeleton className="h-5 w-24 ml-auto" /></td>
                  </tr>
                ))
              ) : data?.users.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-6 py-12 text-center text-muted-foreground">
                    <ShieldAlert className="w-12 h-12 mx-auto mb-3 opacity-20" />
                    <p className="font-mono">NO ENTITIES FOUND</p>
                  </td>
                </tr>
              ) : (
                data?.users.map((u) => (
                  <tr key={u.user.id} className="border-b border-border/50 hover:bg-muted/10 transition-colors">
                    <td className="px-6 py-3 font-medium">
                      <Link
                        href={`/instagram-users/${encodeURIComponent(u.user.username)}`}
                        className="hover:text-primary hover:underline transition-colors"
                      >
                        {u.user.displayName}
                      </Link>
                    </td>
                    <td className="px-6 py-3 align-top"><InstagramHandleCell handle={u.user.username} /></td>
                    <td className="px-6 py-3">
                      {u.dominantArchetype ? (
                        <Badge variant="outline" className="font-mono bg-primary/10 text-primary border-primary/20">
                          {u.dominantArchetype}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground font-mono text-xs">UNCLASSIFIED</span>
                      )}
                    </td>
                    <td className="px-6 py-3">
                      {u.topScore ? (
                        <span className={`font-mono font-bold ${u.topScore > 80 ? "text-accent" : "text-foreground"}`}>
                          {u.topScore}%
                        </span>
                      ) : "-"}
                    </td>
                    <td className="px-6 py-3 text-right text-muted-foreground font-mono">
                      {u.user.totalPosts}P / {u.user.totalComments}C
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {!isLoading && data?.total && data.total > limit ? (
          <div className="p-4 border-t border-border mt-auto flex items-center justify-between bg-muted/10">
            <span className="text-sm text-muted-foreground font-mono">
              SHOWING {(page - 1) * limit + 1}-{Math.min(page * limit, data.total)} OF {data.total} ENTITIES
            </span>
            <Pager
              page={page - 1}
              pageCount={Math.ceil(data.total / limit)}
              onPageChange={(p) => setPage(p + 1)}
            />
          </div>
        ) : null}
      </Card>
    </div>
  );
}
