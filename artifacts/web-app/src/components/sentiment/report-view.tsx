import { useEffect, useRef, useState } from "react";
import { fmtDateTime, cn } from "@/lib/utils";
import {
  detectPlatform,
  platformIcon,
  platformIconColor,
  platformLabel,
  type Platform,
} from "@/lib/platform";
import { Pager } from "@/components/pager";
import { printReportPdf, buildReportFilename } from "@/lib/generate-pdf";
import { ReportPdfDocument } from "./report-pdf-document";
import type {
  TopicAnalysisDetail,
  TopicAnalysisSummary,
  TopicTheme,
  FlaggedComment,
  RepresentativeComment,
  TopicAnalysisPost,
} from "@workspace/api-client-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Printer,
  Loader2,
  AlertTriangle,
  ExternalLink,
  CheckCircle2,
  XCircle,
  Clock,
  ArrowLeft,
  Target,
  RotateCcw,
  Play,
  Eraser,
  Info,
  Trash2,
  MessageCircle,
  Filter,
  User,
  DownloadCloud,
} from "lucide-react";

export function statusBadge(status: string) {
  switch (status) {
    case "completed":
      return (
        <Badge className="bg-primary/15 text-primary border-primary/30 gap-1">
          <CheckCircle2 className="w-3 h-3" /> Completed
        </Badge>
      );
    case "failed":
      return (
        <Badge className="bg-destructive/15 text-destructive border-destructive/30 gap-1">
          <XCircle className="w-3 h-3" /> Failed
        </Badge>
      );
    case "running":
      return (
        <Badge className="bg-accent/15 text-accent border-accent/30 gap-1">
          <Loader2 className="w-3 h-3 animate-spin" /> Running
        </Badge>
      );
    default:
      return (
        <Badge className="bg-muted text-muted-foreground gap-1">
          <Clock className="w-3 h-3" /> Pending
        </Badge>
      );
  }
}

export function ReportView({
  detail,
  loading,
  onBack,
  onRerun,
  onResume,
  onReanalyzeClear,
  onCrawlMissing,
  onIngestRun,
  onDelete,
}: {
  detail: TopicAnalysisDetail | undefined;
  loading: boolean;
  onBack: () => void;
  onRerun: (a: TopicAnalysisSummary) => void;
  onResume: (a: TopicAnalysisSummary) => void;
  onReanalyzeClear: (a: TopicAnalysisSummary) => void;
  onCrawlMissing: (a: TopicAnalysisSummary) => void;
  onIngestRun: (a: TopicAnalysisSummary, url: string, runId: string) => void;
  onDelete: (a: TopicAnalysisSummary) => void;
}) {
  // Generate the formal PDF (as before) and send it straight to the print
  // dialog instead of downloading — printing a PDF carries no browser
  // header/footer, preserving the clean direct-PDF appearance and margins.
  const pdfRef = useRef<HTMLDivElement>(null);
  const [generatingPdf, setGeneratingPdf] = useState(false);

  const handlePrint = async () => {
    if (!pdfRef.current || !detail) return;
    setGeneratingPdf(true);
    try {
      await printReportPdf(
        pdfRef.current,
        buildReportFilename(detail.topicSummary, detail.completedAt),
      );
    } finally {
      setGeneratingPdf(false);
    }
  };

  // Two-step delete confirmation: the first click arms it, the second confirms.
  // Reset whenever the selected report changes or after a short timeout.
  const [confirmDelete, setConfirmDelete] = useState(false);
  const detailId = detail?.id;
  useEffect(() => {
    setConfirmDelete(false);
  }, [detailId]);
  useEffect(() => {
    if (!confirmDelete) return;
    const t = setTimeout(() => setConfirmDelete(false), 4000);
    return () => clearTimeout(t);
  }, [confirmDelete]);

  // Dialog state for viewing all comments in a theme
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogTheme, setDialogTheme] = useState<TopicTheme | null>(null);

  // Dialog state for viewing other/unsorted comments
  const [otherDialogOpen, setOtherDialogOpen] = useState(false);

  // Per-skipped-link Apify run IDs typed by the analyst for free re-ingest.
  const [ingestRunIds, setIngestRunIds] = useState<Record<string, string>>({});
  useEffect(() => {
    setIngestRunIds({});
  }, [detailId]);

  if (loading && !detail) {
    return (
      <Card className="glass min-h-96 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </Card>
    );
  }
  if (!detail) {
    return (
      <Card className="glass min-h-96 flex items-center justify-center">
        <p className="text-muted-foreground">Report not found.</p>
      </Card>
    );
  }

  const isPending = detail.status === "pending" || detail.status === "running";
  const posts: TopicAnalysisPost[] = detail.posts ?? [];
  // A URL gathered no comments if it has no post row, or a post row with 0
  // comments (a crawl that ran but ingested nothing). Those links can be
  // re-ingested for free from an existing, already-paid Apify run.
  const commentsByUrl = new Map<string, number>();
  for (const p of posts) {
    commentsByUrl.set(p.url, (commentsByUrl.get(p.url) ?? 0) + p.commentCount);
  }
  const skippedUrls = (detail.inputUrls ?? []).filter((u) => (commentsByUrl.get(u) ?? 0) === 0);
  const result = detail.result;
  const otherComments = result?.otherComments ?? [];
  const dialogComments = dialogTheme?.comments ?? [];

  const openThemeDialog = (theme: TopicTheme) => {
    setDialogTheme(theme);
    setDialogOpen(true);
  };

  return (
    <div className="space-y-6">
      <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <Button variant="ghost" size="sm" onClick={onBack} className="gap-1">
          <ArrowLeft className="w-4 h-4" /> Back
        </Button>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          {detail.status === "failed" && (
            <Button
              onClick={() => onResume(detail)}
              className="gap-2"
              data-testid="button-resume"
            >
              <Play className="w-4 h-4" /> Resume (no re-crawl)
            </Button>
          )}
          {!isPending && (detail.inputUrls?.length ?? 0) > posts.length && (
            <Button
              onClick={() => onCrawlMissing(detail)}
              className="gap-2"
              data-testid="button-crawl-missing"
            >
              <Play className="w-4 h-4" /> Crawl skipped links (
              {(detail.inputUrls?.length ?? 0) - posts.length})
            </Button>
          )}
          <TooltipProvider delayDuration={150}>
            {!isPending && ((detail.themeHints?.length ?? 0) > 0 || detail.themeCount != null) && (
              <div className="inline-flex items-center gap-1">
                <Button
                  variant="outline"
                  onClick={() => onReanalyzeClear(detail)}
                  className="gap-2"
                  data-testid="button-reanalyze-clear"
                >
                  <Eraser className="w-4 h-4" /> Re-analyze
                </Button>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label="What does Re-analyze do?"
                      className="text-muted-foreground hover:text-foreground transition-colors"
                      data-testid="info-reanalyze-clear"
                    >
                      <Info className="w-4 h-4" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>
                    Using already crawled comments, reconfigure themes.
                  </TooltipContent>
                </Tooltip>
              </div>
            )}
            <div className="inline-flex items-center gap-1">
              <Button
                variant="outline"
                onClick={() => onRerun(detail)}
                className="gap-2"
                data-testid="button-rerun"
              >
                <RotateCcw className="w-4 h-4" /> Re-run
              </Button>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label="What does Re-run do?"
                    className="text-muted-foreground hover:text-foreground transition-colors"
                    data-testid="info-rerun"
                  >
                    <Info className="w-4 h-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Re-crawl all posts.</TooltipContent>
              </Tooltip>
            </div>
          </TooltipProvider>
          {confirmDelete ? (
            <Button
              variant="destructive"
              onClick={() => onDelete(detail)}
              className="gap-2"
              data-testid="button-delete-confirm"
            >
              <Trash2 className="w-4 h-4" /> Click again to confirm
            </Button>
          ) : (
            <Button
              variant="outline"
              onClick={() => setConfirmDelete(true)}
              className="gap-2 text-destructive hover:text-destructive"
              data-testid="button-delete"
            >
              <Trash2 className="w-4 h-4" /> Delete
            </Button>
          )}
          <Button
            onClick={handlePrint}
            disabled={generatingPdf || detail.status !== "completed"}
            className="gap-2"
            data-testid="button-print"
          >
            {generatingPdf ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Printer className="w-4 h-4" />
            )}
            {generatingPdf ? "Preparing…" : "Print"}
          </Button>
        </div>
      </div>

      {/* Report header */}
      <Card className="glass border-primary/20" data-pdf-block>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider mb-1">
                Topic Sentiment Report
              </p>
              <CardTitle className="text-xl leading-snug">{detail.topicSummary}</CardTitle>
              <SteeringSummary themeHints={detail.themeHints ?? []} themeCount={detail.themeCount ?? null} />
            </div>
            <div className="no-print flex items-center gap-1.5 flex-wrap justify-end">
              {statusBadge(detail.status)}
              {detail.createdBy && (
                <Badge variant="outline" className="gap-1 text-muted-foreground" data-testid="badge-report-created-by">
                  <User className="w-3 h-3" /> {detail.createdBy}
                </Badge>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-6 text-sm">
            <div>
              <p className="text-2xl font-bold text-primary">
                {isPending
                  ? `${detail.threadsDone ?? 0}/${detail.threadsTotal ?? detail.inputUrls.length}`
                  : detail.postCount}
              </p>
              <p className="text-xs text-muted-foreground font-mono">POSTS</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-primary">
                {isPending ? (detail.commentsGathered ?? 0) : detail.commentCount}
              </p>
              <p className="text-xs text-muted-foreground font-mono">COMMENTS</p>
            </div>
            <div>
              {isPending ? (
                <>
                  <p className="text-sm font-medium pt-1 flex items-center gap-1.5">
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-accent" />
                    {detail.status === "pending" ? "Queued" : "Crawling…"}
                  </p>
                  <p className="text-xs text-muted-foreground font-mono">STATUS</p>
                </>
              ) : (
                <>
                  <p className="text-sm font-medium pt-1">
                    {fmtDateTime(detail.completedAt)}
                  </p>
                  <p className="text-xs text-muted-foreground font-mono">COMPLETED</p>
                </>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {isPending && (
        <CrawlProgress detail={detail} />
      )}

      {detail.status === "failed" && (
        <Card className="glass border-destructive/30">
          <CardContent className="py-6">
            <div className="flex items-start gap-3 text-destructive">
              <AlertTriangle className="w-5 h-5 mt-0.5 shrink-0" />
              <div>
                <p className="font-medium">Analysis failed</p>
                <p className="text-sm text-muted-foreground mt-1">{detail.errorMessage ?? "Unknown error."}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {detail.status === "completed" && result && (
        <>
          {/* Executive summary */}
          <Card className="glass" data-pdf-block>
            <CardHeader>
              <CardTitle className="font-mono text-sm text-muted-foreground tracking-wider">
                EXECUTIVE SUMMARY
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm leading-relaxed whitespace-pre-line">{result.executiveSummary}</p>
            </CardContent>
          </Card>

          {/* Themes */}
          <div className="space-y-4">
            <h2 className="text-lg font-bold tracking-tight" data-pdf-block>Themes</h2>
            {result.themes.map((theme, i) => (
              <ThemeCard key={i} theme={theme} onViewComments={() => openThemeDialog(theme)} />
            ))}

            {/* Other comments link */}
            {otherComments.length > 0 && (
              <div className="no-print">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setOtherDialogOpen(true)}
                  className="gap-2 text-muted-foreground hover:text-primary"
                >
                  <Filter className="w-4 h-4" />
                  View other comments ({otherComments.length} not sorted into themes)
                </Button>
              </div>
            )}
          </div>

          {/* Flagged comments */}
          {result.flagged.length > 0 && (
            <Card className="glass border-red-500/40" data-pdf-block>
              <CardHeader>
                <CardTitle className="font-mono text-sm text-red-400 tracking-wider flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4" /> COMMENTS REQUIRING ATTENTION
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {result.flagged.map((f, i) => (
                  <FlaggedRow key={i} flagged={f} />
                ))}
              </CardContent>
            </Card>
          )}

          {/* Posts analyzed */}
          {posts.length > 0 && (
            <Card className="glass" data-pdf-block>
              <CardHeader>
                <CardTitle className="font-mono text-sm text-muted-foreground tracking-wider">
                  POSTS ANALYSED
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {posts.map((p, i) => (
                  <div key={i} className="print-thread-row flex items-center justify-between gap-3 py-2 border-b border-border/40 last:border-0">
                    <div className="min-w-0">
                      <a
                        href={p.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="print-thread-title text-sm hover:text-primary truncate flex items-center gap-1"
                      >
                        <span className="truncate">{p.title || p.url}</span>
                        <ExternalLink className="w-3 h-3 shrink-0 no-print" />
                      </a>
                      <p className="print-only hidden text-[9pt] text-muted-foreground break-all mt-0.5">
                        {p.url}
                      </p>
                    </div>
                    <span className="text-xs font-mono text-muted-foreground shrink-0 print-thread-stats">
                      {p.commentCount} comments
                    </span>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {/* Skipped links — re-ingest each from an existing, already-paid Apify run (free) */}
          {skippedUrls.length > 0 && (
            <Card className="glass border-accent/20 no-print" data-testid="card-skipped-links">
              <CardHeader>
                <CardTitle className="font-mono text-sm text-muted-foreground tracking-wider">
                  SKIPPED LINKS ({skippedUrls.length})
                </CardTitle>
                <p className="text-xs text-muted-foreground mt-1">
                  These links produced no comments. Paste the Apify run ID for each to re-ingest its
                  results for free (no new crawl, no re-billing).
                </p>
              </CardHeader>
              <CardContent className="space-y-3">
                {skippedUrls.map((url) => (
                  <div
                    key={url}
                    className="flex flex-col gap-2 py-2 border-b border-border/40 last:border-0 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <a
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm hover:text-primary truncate flex items-center gap-1 min-w-0"
                    >
                      <span className="truncate">{url}</span>
                      <ExternalLink className="w-3 h-3 shrink-0" />
                    </a>
                    <div className="flex items-center gap-2 shrink-0">
                      <Input
                        value={ingestRunIds[url] ?? ""}
                        onChange={(e) =>
                          setIngestRunIds((prev) => ({ ...prev, [url]: e.target.value }))
                        }
                        placeholder="Apify run ID"
                        className="h-8 w-44 font-mono text-xs"
                        data-testid={`input-ingest-run-${url}`}
                      />
                      <Button
                        size="sm"
                        disabled={isPending || !(ingestRunIds[url] ?? "").trim()}
                        onClick={() => onIngestRun(detail, url, (ingestRunIds[url] ?? "").trim())}
                        className="gap-1.5"
                        data-testid={`button-ingest-run-${url}`}
                      >
                        <DownloadCloud className="w-3.5 h-3.5" /> Ingest run
                      </Button>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </>
      )}

      {/* Dialog: all comments in a theme */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MessageCircle className="w-5 h-5 text-primary" />
              {dialogTheme?.name}
            </DialogTitle>
            <DialogDescription>
              {dialogComments.length} comments classified in this theme
            </DialogDescription>
          </DialogHeader>
          <PaginatedComments
            comments={dialogComments}
            emptyMessage="Individual comments weren't captured for this report."
          />
        </DialogContent>
      </Dialog>

      {/* Dialog: other/unsorted comments */}
      <Dialog open={otherDialogOpen} onOpenChange={setOtherDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Filter className="w-5 h-5 text-primary" />
              Other Comments
            </DialogTitle>
            <DialogDescription>
              {otherComments.length} comments not sorted into any theme
            </DialogDescription>
          </DialogHeader>
          <PaginatedComments
            comments={otherComments}
            emptyMessage="No other comments."
          />
        </DialogContent>
      </Dialog>
      </div>

      {/* Off-screen formal report — the source captured into the PDF that is
          sent to the print dialog (see handlePrint). Kept mounted off-screen
          (not display:none) so html2canvas can render it on demand. */}
      <div
        aria-hidden
        style={{
          position: "fixed",
          left: -10000,
          top: 0,
          width: 760,
          pointerEvents: "none",
        }}
      >
        <ReportPdfDocument ref={pdfRef} detail={detail} />
      </div>
    </div>
  );
}

const COMMENTS_PER_PAGE = 5;

function PaginatedComments({
  comments,
  emptyMessage,
}: {
  comments: RepresentativeComment[];
  emptyMessage: string;
}) {
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(comments.length / COMMENTS_PER_PAGE));

  // Reset to the first page whenever a different comment set is shown.
  useEffect(() => {
    setPage(0);
  }, [comments]);

  const safePage = Math.min(page, pageCount - 1);
  const start = safePage * COMMENTS_PER_PAGE;
  const visible = comments.slice(start, start + COMMENTS_PER_PAGE);

  if (comments.length === 0) {
    return (
      <p className="text-sm text-muted-foreground text-center py-6">
        {emptyMessage}
      </p>
    );
  }

  return (
    <div className="flex flex-1 min-h-0 flex-col gap-4">
      <div className="flex-1 min-h-0 overflow-y-auto -mx-6 px-6">
        <div className="space-y-3 pt-2">
          {visible.map((c, i) => (
            <CommentListRow key={start + i} comment={c} />
          ))}
        </div>
      </div>
      <Pager page={safePage} pageCount={pageCount} onPageChange={setPage} />
    </div>
  );
}

function CommentListRow({ comment }: { comment: RepresentativeComment }) {
  const platform = detectPlatform(comment.permalink);
  return (
    <div className="rounded-md border border-border/50 bg-background/40 p-3">
      <p className="text-sm leading-relaxed">{comment.excerpt}</p>
      <div className="flex items-center justify-between gap-2 mt-2">
        <PlatformAuthor platform={platform} author={comment.author} />
        <a
          href={comment.permalink}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-primary hover:underline flex items-center gap-1"
        >
          View <ExternalLink className="w-3 h-3" />
        </a>
      </div>
    </div>
  );
}

function SteeringSummary({ themeHints, themeCount }: { themeHints: string[]; themeCount: number | null }) {
  const hasSteering = themeHints.length > 0 || themeCount != null;
  return (
    <div className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground" data-testid="steering-summary">
      <Target className="w-3.5 h-3.5 mt-0.5 shrink-0 text-accent" />
      {hasSteering ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {themeHints.length > 0 ? (
            <span className="flex flex-wrap items-center gap-1">
              <span className="font-mono uppercase tracking-wider">Steered toward:</span>
              {themeHints.map((h, i) => (
                <Badge key={i} variant="outline" className="font-normal">
                  {h}
                </Badge>
              ))}
            </span>
          ) : (
            <span><span className="font-mono uppercase tracking-wider">Steered:</span> automatic themes</span>
          )}
          {themeCount != null && (
            <span className="font-mono">· {themeCount} themes</span>
          )}
        </div>
      ) : (
        <span>
          <span className="font-mono uppercase tracking-wider">Steering:</span> Automatic
        </span>
      )}
    </div>
  );
}

function CrawlProgress({ detail }: { detail: TopicAnalysisDetail }) {
  const total = detail.threadsTotal ?? detail.inputUrls.length ?? 0;
  const done = detail.threadsDone ?? 0;
  const comments = detail.commentsGathered ?? 0;
  // Before crawling actually begins (status "pending" / "running" with no total
  // recorded yet) we can't show a meaningful count, so fall back to a soft note.
  const hasProgress = total > 0;
  const pct = hasProgress ? Math.min(100, Math.round((done / total) * 100)) : 0;

  return (
    <Card className="glass" data-testid="crawl-progress">
      <CardContent className="py-10 text-center">
        <Loader2 className="w-8 h-8 animate-spin mx-auto mb-3 text-accent" />
        <p className="font-medium">Crawling comments and grouping themes…</p>
        {hasProgress ? (
          <>
            <p className="text-sm text-muted-foreground mt-1" data-testid="text-crawl-progress">
              {done} of {total} posts crawled · {comments.toLocaleString()} comments gathered
            </p>
            <div className="mt-4 mx-auto max-w-sm h-2 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full bg-accent transition-all duration-500"
                style={{ width: `${pct}%` }}
                data-testid="bar-crawl-progress"
              />
            </div>
            {done >= total && (
              <p className="text-xs text-muted-foreground mt-3">
                All posts crawled — grouping themes with AI…
              </p>
            )}
          </>
        ) : (
          <p className="text-sm text-muted-foreground mt-1">
            This can take a few minutes depending on post size.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function ThemeCard({ theme, onViewComments }: { theme: TopicTheme; onViewComments: () => void }) {
  return (
    <Card className="glass" data-pdf-block>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-base">{theme.name}</CardTitle>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              variant="ghost"
              size="sm"
              onClick={onViewComments}
              className="h-7 gap-1.5 px-2 text-xs font-mono no-print hover:text-primary"
            >
              <MessageCircle className="w-3.5 h-3.5" />
              {theme.commentCount} comments
            </Button>
            <Badge className="bg-primary/15 text-primary border-primary/30 font-mono no-print">
              {theme.percentage}%
            </Badge>
            {/* Print-only badges */}
            <Badge variant="outline" className="font-mono hidden print-inline">
              {theme.commentCount} comments
            </Badge>
            <Badge className="bg-primary/15 text-primary border-primary/30 font-mono hidden print-inline">
              {theme.percentage}%
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <ul className="space-y-1.5">
          {theme.summary.map((point, i) => (
            <li key={i} className="text-sm flex gap-2">
              <span className="text-primary mt-1">•</span>
              <span>{point}</span>
            </li>
          ))}
        </ul>
        {theme.representativeComments.length > 0 && (
          <>
            <Separator />
            <div className="space-y-2">
              <p className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">
                Representative Comments
              </p>
              {theme.representativeComments.map((c, i) => (
                <RepresentativeRow key={i} comment={c} />
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function RepresentativeRow({ comment }: { comment: RepresentativeComment }) {
  const platform = detectPlatform(comment.permalink);
  return (
    <div className="rounded-md border border-border/50 bg-background/40 p-3 print-quote">
      <p className="text-sm italic leading-relaxed">"{comment.excerpt}"</p>
      <div className="flex items-center justify-between gap-2 mt-2">
        <PlatformAuthor platform={platform} author={comment.author} />
        <a
          href={comment.permalink}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-primary hover:underline flex items-center gap-1 no-print"
        >
          View <ExternalLink className="w-3 h-3" />
        </a>
      </div>
      <p className="hidden print-only text-[10px] font-mono text-muted-foreground break-all mt-1">
        {comment.permalink}
      </p>
    </div>
  );
}

function FlaggedRow({ flagged }: { flagged: FlaggedComment }) {
  const platform = detectPlatform(flagged.permalink);
  return (
    <div className="rounded-md border border-red-500/40 bg-red-500/[0.07] p-3 print-flagged">
      <div className="flex items-start gap-2 mb-1">
        <Badge className="bg-red-500/20 text-red-300 border-red-500/50 text-[10px] whitespace-normal break-words text-left h-auto leading-snug">
          {flagged.issue}
        </Badge>
      </div>
      <p className="text-sm italic leading-relaxed">"{flagged.excerpt}"</p>
      <div className="flex items-center justify-between gap-2 mt-2">
        <PlatformAuthor platform={platform} author={flagged.author} />
        <a
          href={flagged.permalink}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-primary hover:underline flex items-center gap-1 no-print"
        >
          View <ExternalLink className="w-3 h-3" />
        </a>
      </div>
      <p className="hidden print-only text-[10px] font-mono text-muted-foreground break-all mt-1">
        {flagged.permalink}
      </p>
    </div>
  );
}

function PlatformAuthor({ platform, author }: { platform: Platform; author: string }) {
  return (
    <span className="flex items-center gap-1.5 text-xs font-mono text-muted-foreground">
      <span className={cn("inline-flex items-center justify-center w-4 h-4 rounded-full text-[10px] font-bold shrink-0 border", platformIconColor(platform))}>
        {platformIcon(platform)}
      </span>
      <span>{platformLabel(platform)}{author}</span>
    </span>
  );
}
