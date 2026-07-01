import { useEffect, useState } from "react";
import {
  useCreateTopicAnalysis,
  useGetTopicAnalysis,
  useReanalyzeTopicAnalysis,
  useCrawlMissingTopicAnalysis,
  useIngestRunTopicAnalysis,
  useDeleteTopicAnalysis,
  getListTopicAnalysesQueryKey,
  getGetTopicAnalysisQueryKey,
} from "@workspace/api-client-react";
import type { TopicAnalysisSummary } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { ReportView } from "@/components/sentiment/report-view";
import { takePrefill } from "@/lib/sentiment-prefill";
import {
  MessageSquareText,
  Plus,
  X,
  Loader2,
} from "lucide-react";

const MAX_URLS = 20;

export default function TopicAnalysis() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [topicSummary, setTopicSummary] = useState("");
  const [urls, setUrls] = useState<string[]>([""]);
  const [themeHints, setThemeHints] = useState("");
  const [themeCount, setThemeCount] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);

  // Apply any settings handed off from the Reports page "Re-run" action.
  useEffect(() => {
    const p = takePrefill();
    if (!p) return;
    setTopicSummary(p.topicSummary);
    setUrls(p.inputUrls.length > 0 ? [...p.inputUrls] : [""]);
    setThemeHints((p.themeHints ?? []).join(", "));
    setThemeCount(p.themeCount != null ? String(p.themeCount) : "");
  }, []);

  const { data: detail, isLoading: detailLoading } = useGetTopicAnalysis(selectedId ?? 0, {
    query: {
      queryKey: getGetTopicAnalysisQueryKey(selectedId ?? 0),
      enabled: selectedId != null,
      refetchInterval: (query) => {
        const status = query.state.data?.status;
        return status === "pending" || status === "running" ? 4000 : false;
      },
    },
  });

  const createAnalysis = useCreateTopicAnalysis();

  // Pre-fill the new-investigation form from a past analysis so power users can
  // re-run the same investigation (topic, URLs and steering) without re-typing.
  const prefillFrom = (a: TopicAnalysisSummary) => {
    setTopicSummary(a.topicSummary);
    setUrls(a.inputUrls.length > 0 ? [...a.inputUrls] : [""]);
    setThemeHints((a.themeHints ?? []).join(", "));
    setThemeCount(a.themeCount != null ? String(a.themeCount) : "");
    setSelectedId(null);
    if (typeof window !== "undefined") {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
    toast({
      title: "Settings loaded",
      description: "Form pre-filled from a past analysis. Adjust and run again.",
    });
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

  const addUrlField = () => {
    if (urls.length >= MAX_URLS) return;
    setUrls((u) => [...u, ""]);
  };

  const removeUrlField = (idx: number) => {
    setUrls((u) => (u.length === 1 ? [""] : u.filter((_, i) => i !== idx)));
  };

  const updateUrl = (idx: number, value: string) => {
    setUrls((u) => u.map((item, i) => (i === idx ? value : item)));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanedUrls = urls.map((u) => u.trim()).filter(Boolean);
    if (!topicSummary.trim()) {
      toast({ title: "Topic summary required", description: "Describe the topic under investigation.", variant: "destructive" });
      return;
    }
    if (cleanedUrls.length === 0) {
      toast({ title: "URLs required", description: "Add at least one Reddit or Facebook post URL.", variant: "destructive" });
      return;
    }
    const hints = themeHints
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean);
    const count = themeCount.trim() ? Number(themeCount) : null;
    if (count != null && (!Number.isInteger(count) || count < 2 || count > 8)) {
      toast({
        title: "Invalid theme count",
        description: "Enter a whole number between 2 and 8, or leave it blank for automatic.",
        variant: "destructive",
      });
      return;
    }

    createAnalysis.mutate(
      {
        data: {
          topicSummary: topicSummary.trim(),
          urls: cleanedUrls,
          ...(hints.length > 0 ? { themeHints: hints } : {}),
          ...(count != null ? { themeCount: count } : {}),
        },
      },
      {
        onSuccess: (created) => {
          toast({ title: "Analysis started", description: "Crawling comments and grouping themes…" });
          setSelectedId(created.id);
          setTopicSummary("");
          setUrls([""]);
          setThemeHints("");
          setThemeCount("");
          queryClient.invalidateQueries({ queryKey: getListTopicAnalysesQueryKey() });
        },
        onError: (err) => {
          const message = err instanceof Error ? err.message : "Failed to start analysis.";
          toast({ title: "Could not start analysis", description: message, variant: "destructive" });
        },
      },
    );
  };

  return (
    <div className="p-8 space-y-6 h-full overflow-y-auto" data-testid="page-topic-analysis">
      <div className="no-print flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Analyze</h1>
          <p className="text-muted-foreground mt-1 font-mono text-sm">
            CROWD-SOURCED THEME EXTRACTION FROM POST COMMENTARY
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left column: new investigation form */}
        <div className="no-print space-y-6 lg:col-span-1">
          <Card className="glass border-accent/20">
            <CardHeader>
              <CardTitle className="font-mono text-sm text-muted-foreground tracking-wider flex items-center gap-2">
                <MessageSquareText className="w-4 h-4 text-accent" /> NEW INVESTIGATION
              </CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="text-xs font-mono text-muted-foreground mb-1 block">DESCRIBE THE TOPIC</label>
                  <p className="text-[10px] text-muted-foreground mb-2">
                    (this will be the title of your report)
                  </p>
                  <Textarea
                    value={topicSummary}
                    onChange={(e) => setTopicSummary(e.target.value)}
                    placeholder="Describe your topic"
                    className="bg-background/50 min-h-24"
                    data-testid="input-topic-summary"
                  />
                </div>

                <div>
                  <label className="text-xs font-mono text-muted-foreground mb-1 block">
                    POST URLS ({urls.filter((u) => u.trim()).length}/{MAX_URLS})
                  </label>
                  <p className="text-[10px] font-mono text-muted-foreground/70 mb-2">
                    Reddit/Facebook/Instagram/TikTok/X/YouTube posts
                  </p>
                  <div className="space-y-2">
                    {urls.map((url, idx) => (
                      <div key={idx} className="flex gap-2">
                        <Input
                          value={url}
                          onChange={(e) => updateUrl(idx, e.target.value)}
                          placeholder="reddit.com/r/<sub>/comments/<id>/ or facebook.com/…"
                          className="bg-background/50"
                          data-testid={`input-url-${idx}`}
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => removeUrlField(idx)}
                          className="shrink-0 text-muted-foreground hover:text-destructive"
                          data-testid={`button-remove-url-${idx}`}
                        >
                          <X className="w-4 h-4" />
                        </Button>
                      </div>
                    ))}
                  </div>
                  {urls.length < MAX_URLS && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={addUrlField}
                      className="mt-2 gap-1"
                      data-testid="button-add-url"
                    >
                      <Plus className="w-3 h-3" /> Add URL
                    </Button>
                  )}
                </div>

                <div>
                  <label className="text-xs font-mono text-muted-foreground mb-2 block">
                    THEMES TO LOOK FOR <span className="opacity-60">(optional)</span>
                  </label>
                  <Input
                    value={themeHints}
                    onChange={(e) => setThemeHints(e.target.value)}
                    placeholder="housing, cost of living, immigration"
                    className="bg-background/50"
                    data-testid="input-theme-hints"
                  />
                  <p className="text-[10px] text-muted-foreground mt-1">
                    The angle you want to understand from the comments. Comma-separated hints to steer grouping. Leave blank for automatic themes.
                  </p>
                </div>

                <div>
                  <label className="text-xs font-mono text-muted-foreground mb-2 block">
                    NUMBER OF THEMES <span className="opacity-60">(optional)</span>
                  </label>
                  <Input
                    type="number"
                    min={2}
                    max={8}
                    value={themeCount}
                    onChange={(e) => setThemeCount(e.target.value)}
                    placeholder="Auto (3–5)"
                    className="bg-background/50"
                    data-testid="input-theme-count"
                  />
                </div>

                <Button
                  type="submit"
                  className="w-full gap-2"
                  disabled={createAnalysis.isPending}
                  data-testid="button-start-analysis"
                >
                  {createAnalysis.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <MessageSquareText className="w-4 h-4" />}
                  Run Analysis
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>

        {/* Right column: report */}
        <div className="lg:col-span-2">
          {selectedId == null ? (
            <Card className="glass h-full flex items-center justify-center min-h-96">
              <div className="text-center text-muted-foreground p-8">
                <MessageSquareText className="w-12 h-12 mx-auto mb-3 opacity-40" />
                <p className="font-medium">Run an analysis to see the report</p>
                <p className="text-sm mt-1">Past reports live under the Reports tab.</p>
              </div>
            </Card>
          ) : (
            <ReportView
              detail={detail}
              loading={detailLoading}
              onBack={() => setSelectedId(null)}
              onRerun={prefillFrom}
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
