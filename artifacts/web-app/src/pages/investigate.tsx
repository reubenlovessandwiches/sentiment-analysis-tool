import { useState } from "react";
import { useStartCrawl, getListJobsQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { Play, AlertCircle, ExternalLink } from "lucide-react";

type CrawlMode = "posts" | "comments" | "both" | "user";
type ContentType = "posts" | "comments" | "both";

export default function Investigate() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [crawlMode, setCrawlMode] = useState<CrawlMode>("both");
  const [crawlSubreddit, setCrawlSubreddit] = useState("");
  const [crawlLimit, setCrawlLimit] = useState("50");
  const [crawlPostUrl, setCrawlPostUrl] = useState("");

  // User-investigation (Arctic Shift) inputs.
  const [crawlUsername, setCrawlUsername] = useState("");
  const [userContentType, setUserContentType] = useState<ContentType>("both");
  const [userMaxItems, setUserMaxItems] = useState("1000");
  const [userRefresh, setUserRefresh] = useState<"incremental" | "full">("full");

  const startCrawl = useStartCrawl();

  const handleLaunchCrawl = (e: React.FormEvent) => {
    e.preventDefault();

    let data: Parameters<typeof startCrawl.mutate>[0]["data"];

    if (crawlMode === "user") {
      const username = crawlUsername.trim().replace(/^\/?(?:u|user)\//i, "").replace(/^@/, "");
      if (!username) {
        toast({ title: "Username Required", description: "Enter a Reddit username to investigate.", variant: "destructive" });
        return;
      }
      const maxItems = parseInt(userMaxItems, 10);
      data = {
        mode: "user",
        username,
        contentType: userContentType,
        maxItems: Number.isFinite(maxItems) ? maxItems : 1000,
        refresh: userRefresh,
      };
    } else if (crawlMode === "comments") {
      const postUrl = crawlPostUrl.trim();
      if (!postUrl) {
        toast({ title: "Post URL Required", description: "Comments-only crawls need a specific Reddit post URL.", variant: "destructive" });
        return;
      }
      data = { mode: crawlMode, postUrl };
    } else {
      const subreddit = crawlSubreddit.trim().replace(/^\/?r\//i, "");
      const postLimit = parseInt(crawlLimit, 10);
      data = { mode: crawlMode, subreddit, postLimit };
    }

    startCrawl.mutate({ data }, {
      onSuccess: () => {
        toast({ title: "Operation Launched", description: "Data ingestion sequence started." });
        queryClient.invalidateQueries({ queryKey: getListJobsQueryKey() });
      }
    });
  };

  const submitDisabled =
    startCrawl.isPending ||
    (crawlMode === "user"
      ? !crawlUsername.trim()
      : crawlMode === "comments"
        ? !crawlPostUrl.trim()
        : !crawlSubreddit.trim());

  return (
    <div className="p-8 space-y-6 h-full overflow-y-auto">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Investigate</h1>
        <p className="text-muted-foreground mt-1 font-mono text-sm">LAUNCH A NEW CRAWL AGAINST A SUBREDDIT, POST, OR USER</p>
      </div>

      <div className="max-w-lg">
        <Card className="glass border-accent/20">
          <CardHeader>
            <CardTitle className="font-mono text-sm text-muted-foreground tracking-wider flex items-center gap-2">
              <Play className="w-4 h-4 text-accent" />
              LAUNCH INVESTIGATION
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleLaunchCrawl} className="space-y-4">
              <div>
                <label className="text-xs font-mono text-muted-foreground mb-2 block">CRAWL MODE</label>
                <Select value={crawlMode} onValueChange={(v) => setCrawlMode(v as CrawlMode)}>
                  <SelectTrigger className="bg-background/50">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="posts">Posts only</SelectItem>
                    <SelectItem value="both">Posts + Comments</SelectItem>
                    <SelectItem value="comments">Comments only (single post)</SelectItem>
                    <SelectItem value="user">User</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {crawlMode === "user" ? (
                <>
                  <div>
                    <label className="text-xs font-mono text-muted-foreground mb-2 block">REDDIT USERNAME</label>
                    <Input
                      value={crawlUsername}
                      onChange={(e) => setCrawlUsername(e.target.value)}
                      placeholder="username (without u/)"
                      className="bg-background/50 font-mono"
                    />
                    <p className="text-[10px] text-muted-foreground mt-1 font-mono">
                      The user's full Reddit history is pulled directly from the Arctic Shift archive — no Apify, no cost.
                    </p>
                  </div>

                  <div>
                    <label className="text-xs font-mono text-muted-foreground mb-2 block">CONTENT</label>
                    <Select value={userContentType} onValueChange={(v) => setUserContentType(v as ContentType)}>
                      <SelectTrigger className="bg-background/50">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="both">Posts + Comments</SelectItem>
                        <SelectItem value="posts">Posts only</SelectItem>
                        <SelectItem value="comments">Comments only</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div>
                    <label className="text-xs font-mono text-muted-foreground mb-2 block">REFRESH MODE</label>
                    <Select value={userRefresh} onValueChange={(v) => setUserRefresh(v as "incremental" | "full")}>
                      <SelectTrigger className="bg-background/50">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="incremental">Incremental (only newer than stored)</SelectItem>
                        <SelectItem value="full">Full re-scan (entire history)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div>
                    <label className="text-xs font-mono text-muted-foreground mb-2 block">MAX ITEMS (PER CONTENT TYPE)</label>
                    <Input
                      type="number"
                      min={1}
                      max={5000}
                      step={1}
                      value={userMaxItems}
                      onChange={(e) => setUserMaxItems(e.target.value)}
                      placeholder="1000"
                      className="bg-background/50 font-mono"
                    />
                    <p className="text-[10px] text-muted-foreground mt-1 font-mono">
                      Caps how many posts and comments are fetched (1–5000). Default 1000.
                    </p>
                  </div>

                  <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
                    <AlertCircle className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
                    <p className="text-[10px] text-amber-200/90 font-mono leading-relaxed">
                      User mode is powered by{" "}
                      <a
                        href="https://arctic-shift.photon-reddit.com/"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-0.5 underline text-amber-200 hover:text-amber-100"
                      >
                        arctic-shift.photon-reddit.com
                        <ExternalLink className="w-2.5 h-2.5" />
                      </a>
                      , a free third-party Reddit archive. It can surface content already deleted on live Reddit, but it's
                      best-effort with no uptime guarantee — if it's unavailable the job will fail with a clear message.
                    </p>
                  </div>
                </>
              ) : crawlMode === "comments" ? (
                <div>
                  <label className="text-xs font-mono text-muted-foreground mb-2 block">REDDIT POST URL</label>
                  <Input
                    value={crawlPostUrl}
                    onChange={(e) => setCrawlPostUrl(e.target.value)}
                    placeholder="https://www.reddit.com/r/<sub>/comments/<id>/…"
                    className="bg-background/50 font-mono"
                  />
                  <p className="text-[10px] text-muted-foreground mt-1 font-mono">
                    Comments-only crawls target one specific thread. The subreddit is derived from this URL — whole-subreddit comment crawls aren't supported.
                  </p>
                </div>
              ) : (
                <>
                  <div>
                    <label className="text-xs font-mono text-muted-foreground mb-2 block">TARGET DOMAIN</label>
                    <Input
                      value={crawlSubreddit}
                      onChange={(e) => setCrawlSubreddit(e.target.value)}
                      placeholder="Subreddit name (without r/)"
                      className="bg-background/50 font-mono"
                    />
                    <p className="text-[10px] text-muted-foreground mt-1 font-mono">
                      Type the target subreddit — it's created automatically and doesn't need to be pre-registered.
                    </p>
                  </div>

                  <div>
                    <label className="text-xs font-mono text-muted-foreground mb-2 block">VOLUME LIMIT (POSTS)</label>
                    <Input
                      type="number"
                      min={1}
                      max={1000}
                      step={1}
                      value={crawlLimit}
                      onChange={(e) => setCrawlLimit(e.target.value)}
                      placeholder="50"
                      className="bg-background/50 font-mono"
                    />
                    <p className="text-[10px] text-muted-foreground mt-1 font-mono">
                      Max number of posts to fetch. Default 50 — lower it for incremental scrapes.
                      Observed cost: ~$1 per 170 posts (posts-only, free actor).
                    </p>
                  </div>
                </>
              )}

              {crawlMode === "both" && (
                <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
                  <AlertCircle className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
                  <p className="text-[10px] text-amber-200/90 font-mono leading-relaxed">
                    Crawling posts and comments together requires a paid / higher-tier Apify actor (e.g. trudax~reddit-scraper). The free trudax~reddit-scraper-lite returns posts only in this mode. Comments-only crawls work fine on the free tier.
                  </p>
                </div>
              )}

              <Button
                type="submit"
                className="w-full font-mono bg-accent hover:bg-accent/90 text-accent-foreground"
                disabled={submitDisabled}
              >
                {startCrawl.isPending ? "INITIALIZING..." : "EXECUTE CRAWL SEQUENCE"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
