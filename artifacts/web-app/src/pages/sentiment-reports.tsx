import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { fmtDateTime } from "@/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListTopicAnalyses,
  useGetTopicAnalysis,
  useReanalyzeTopicAnalysis,
  useCrawlMissingTopicAnalysis,
  useIngestRunTopicAnalysis,
  useDeleteTopicAnalysis,
  getListTopicAnalysesQueryKey,
  getGetTopicAnalysisQueryKey,
} from "@workspace/api-client-react";
import type { TopicAnalysisSummary } from "@workspace/api-client-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Pager } from "@/components/pager";
import { ReportView, statusBadge } from "@/components/sentiment/report-view";
import { stashPrefill } from "@/lib/sentiment-prefill";
import { FileText, Search, X, MessageSquareText, User, ChevronLeft, ChevronRight } from "lucide-react";

const PER_PAGE = 10;

export default function SentimentReports() {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [creator, setCreator] = useState("");

  const { data: list = [] } = useListTopicAnalyses({
    query: {
      queryKey: getListTopicAnalysesQueryKey(),
      refetchInterval: 5000,
    },
  });

  const isActiveRun = (id: number | null) => {
    if (id == null) return false;
    const item = list.find((a) => a.id === id);
    return item ? item.status === "pending" || item.status === "running" : false;
  };

  const { data: detail, isLoading: detailLoading } = useGetTopicAnalysis(selectedId ?? 0, {
    query: {
      queryKey: getGetTopicAnalysisQueryKey(selectedId ?? 0),
      enabled: selectedId != null,
      refetchInterval: isActiveRun(selectedId) ? 4000 : false,
    },
  });

  const creators = useMemo(() => {
    const set = new Set<string>();
    for (const a of list) {
      if (a.createdBy) set.add(a.createdBy);
    }
    return Array.from(set).sort((x, y) => x.localeCompare(y));
  }, [list]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const fromTs = from ? new Date(from + "T00:00:00").getTime() : null;
    const toTs = to ? new Date(to + "T23:59:59.999").getTime() : null;
    return list.filter((a) => {
      if (q && !a.topicSummary.toLowerCase().includes(q)) return false;
      if (creator && a.createdBy !== creator) return false;
      const ts = a.createdAt ? new Date(a.createdAt).getTime() : null;
      if (fromTs != null && (ts == null || ts < fromTs)) return false;
      if (toTs != null && (ts == null || ts > toTs)) return false;
      return true;
    });
  }, [list, search, from, to, creator]);

  const [page, setPage] = useState(1);
  useEffect(() => {
    setPage(1);
  }, [search, from, to, creator]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PER_PAGE));
  const safePage = Math.min(page, pageCount);
  const paged = filtered.slice((safePage - 1) * PER_PAGE, safePage * PER_PAGE);

  const hasFilters = search.trim() !== "" || from !== "" || to !== "" || creator !== "";

  const clearFilters = () => {
    setSearch("");
    setFrom("");
    setTo("");
    setCreator("");
  };

  const handleRerun = (a: TopicAnalysisSummary) => {
    stashPrefill({
      topicSummary: a.topicSummary,
      inputUrls: a.inputUrls ?? [],
      themeHints: a.themeHints ?? [],
      themeCount: a.themeCount ?? null,
    });
    navigate("/sentiment-analysis");
  };

  const reanalyze = useReanalyzeTopicAnalysis();
  const crawlMissing = useCrawlMissingTopicAnalysis();
  const ingestRun = useIngestRunTopicAnalysis();
  const deleteAnalysis = useDeleteTopicAnalysis();

  const handleResume = (a: TopicAnalysisSummary) => {
    reanalyze.mutate(
      { id: a.id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListTopicAnalysesQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetTopicAnalysisQueryKey(a.id) });
        },
      },
    );
  };

  const handleReanalyzeClear = (a: TopicAnalysisSummary) => {
    reanalyze.mutate(
      { id: a.id, data: { clearSteering: true } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListTopicAnalysesQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetTopicAnalysisQueryKey(a.id) });
        },
      },
    );
  };

  const handleCrawlMissing = (a: TopicAnalysisSummary) => {
    crawlMissing.mutate(
      { id: a.id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListTopicAnalysesQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetTopicAnalysisQueryKey(a.id) });
        },
      },
    );
  };

  const handleIngestRun = (a: TopicAnalysisSummary, url: string, runId: string) => {
    ingestRun.mutate(
      { id: a.id, data: { url, runId } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListTopicAnalysesQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetTopicAnalysisQueryKey(a.id) });
        },
      },
    );
  };

  const handleDelete = (a: TopicAnalysisSummary) => {
    deleteAnalysis.mutate(
      { id: a.id },
      {
        onSuccess: () => {
          if (selectedId === a.id) setSelectedId(null);
          queryClient.invalidateQueries({ queryKey: getListTopicAnalysesQueryKey() });
        },
      },
    );
  };

  return (
    <div
      className="p-8 space-y-6 h-full overflow-hidden flex flex-col"
      data-testid="page-sentiment-reports"
    >
      <div className="no-print flex items-start justify-between gap-4 shrink-0">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Reports</h1>
          <p className="text-muted-foreground mt-1 font-mono text-sm">
            BROWSE, SEARCH AND REVIEW PAST SENTIMENT ANALYSES
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 grid-rows-1 gap-6 flex-1 min-h-0">
        {/* Left column: filter fixed, only the list card below scrolls. On mobile it
            hides when a report is selected (master-detail). */}
        <div
          className={`no-print lg:col-span-1 min-h-0 flex-col gap-4 overflow-hidden ${
            selectedId != null ? "hidden lg:flex" : "flex"
          }`}
        >
          <div className="shrink-0">
          <Card className="glass">
            <CardHeader>
              <CardTitle className="font-mono text-sm text-muted-foreground tracking-wider flex items-center gap-2">
                <FileText className="w-4 h-4" /> PAST ANALYSES
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search topics…"
                  className="bg-background/50 pl-8"
                  data-testid="input-search-reports"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] font-mono text-muted-foreground mb-1 block">FROM</label>
                  <Input
                    type="date"
                    value={from}
                    onChange={(e) => setFrom(e.target.value)}
                    className="bg-background/50"
                    data-testid="input-date-from"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-mono text-muted-foreground mb-1 block">TO</label>
                  <Input
                    type="date"
                    value={to}
                    onChange={(e) => setTo(e.target.value)}
                    className="bg-background/50"
                    data-testid="input-date-to"
                  />
                </div>
              </div>
              {creators.length > 0 && (
                <div>
                  <label className="text-[10px] font-mono text-muted-foreground mb-1 block">GENERATED BY</label>
                  <select
                    value={creator}
                    onChange={(e) => setCreator(e.target.value)}
                    className="w-full h-9 rounded-md border border-input bg-background/50 px-3 py-1 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    data-testid="select-creator"
                  >
                    <option value="">All creators</option>
                    {creators.map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </div>
              )}
              {hasFilters && (
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>{filtered.length} of {list.length}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={clearFilters}
                    className="h-7 gap-1 text-xs"
                    data-testid="button-clear-filters"
                  >
                    <X className="w-3 h-3" /> Clear
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
          </div>

          <Card className="glass flex-1 min-h-0 flex flex-col overflow-hidden">
            <CardContent className="space-y-2 pt-6 flex-1 min-h-0 overflow-y-auto">
              {list.length === 0 && (
                <p className="text-sm text-muted-foreground py-4 text-center">No analyses yet.</p>
              )}
              {list.length > 0 && filtered.length === 0 && (
                <p className="text-sm text-muted-foreground py-4 text-center">No reports match your filters.</p>
              )}
              {paged.map((a) => (
                <button
                  key={a.id}
                  onClick={() => setSelectedId(a.id)}
                  className={`w-full text-left p-3 rounded-md border transition-all ${
                    selectedId === a.id
                      ? "border-primary/40 bg-primary/10"
                      : "border-border/50 hover:border-border hover:bg-muted/40"
                  }`}
                  data-testid={`history-item-${a.id}`}
                >
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {statusBadge(a.status)}
                      {a.createdBy && (
                        <Badge
                          variant="outline"
                          className="gap-1 text-muted-foreground"
                          data-testid={`badge-created-by-${a.id}`}
                        >
                          <User className="w-3 h-3" /> {a.createdBy}
                        </Badge>
                      )}
                    </div>
                    <span className="text-[10px] font-mono text-muted-foreground">
                      {fmtDateTime(a.createdAt)}
                    </span>
                  </div>
                  <p className="text-sm line-clamp-2">{a.topicSummary}</p>
                  <p className="text-[10px] font-mono text-muted-foreground mt-1">
                    {a.postCount} posts · {a.commentCount} comments
                  </p>
                </button>
              ))}

              {pageCount > 1 && (
                <div className="pt-2">
                  <Pager
                    page={safePage - 1}
                    pageCount={pageCount}
                    onPageChange={(p) => setPage(p + 1)}
                  />
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right column: report. On mobile it is hidden until a report is selected
            (master-detail); the ReportView's back button returns to the list. */}
        <div
          className={`lg:col-span-2 min-h-0 overflow-y-auto lg:pr-1 ${
            selectedId == null ? "hidden lg:block" : "block"
          }`}
        >
          {selectedId == null ? (
            <Card className="glass h-full flex items-center justify-center min-h-96">
              <div className="text-center text-muted-foreground p-8">
                <MessageSquareText className="w-12 h-12 mx-auto mb-3 opacity-40" />
                <p className="font-medium">Select a report</p>
                <p className="text-sm mt-1">Pick a past analysis from the list to view it here.</p>
              </div>
            </Card>
          ) : (
            <ReportView
              detail={detail}
              loading={detailLoading}
              onBack={() => setSelectedId(null)}
              onRerun={handleRerun}
              onResume={handleResume}
              onReanalyzeClear={handleReanalyzeClear}
              onCrawlMissing={handleCrawlMissing}
              onIngestRun={handleIngestRun}
              onDelete={handleDelete}
            />
          )}
        </div>
      </div>
    </div>
  );
}
