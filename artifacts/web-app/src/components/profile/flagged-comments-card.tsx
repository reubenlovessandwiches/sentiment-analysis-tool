import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Pager } from "@/components/pager";
import { fmtDate } from "@/lib/utils";
import { AlertCircle, ExternalLink } from "lucide-react";

const PAGE_SIZE = 5;

export interface FlaggedComment {
  id: number;
  issue: string;
  excerpt: string;
  subreddit?: string | null;
  permalink?: string | null;
  createdAt: string;
}

export function FlaggedCommentsCard({ items }: { items: FlaggedComment[] }) {
  const [page, setPage] = useState(0);

  if (items.length === 0) return null;

  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const start = safePage * PAGE_SIZE;

  return (
    <Card className="glass border-red-500/30">
      <CardHeader>
        <CardTitle className="font-mono text-sm tracking-wider text-red-400 flex items-center gap-2">
          <AlertCircle className="w-4 h-4" />
          COMMENTS REQUIRING ATTENTION
          <Badge variant="outline" className="bg-red-500/15 text-red-300 border-red-500/40 font-mono text-[10px]">
            {total}
          </Badge>
        </CardTitle>
        <CardDescription className="text-xs">
          AI-flagged from this user's comment history. Probabilistic flags, not severity rankings.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {/* Every item is rendered so printing can expand all pages. On screen,
            items outside the current page are hidden; in print they are revealed
            (and the pager is hidden) so the full list prints. */}
        <div className="space-y-3">
          {items.map((f, i) => {
            const inPage = i >= start && i < start + PAGE_SIZE;
            return (
              <div
                key={f.id}
                className={
                  inPage
                    ? "rounded-md border border-red-500/40 bg-red-500/[0.07] p-3"
                    : "hidden print:block rounded-md border border-red-500/40 bg-red-500/[0.07] p-3"
                }
              >
                <Badge className="bg-red-500/20 text-red-300 border-red-500/50 text-[10px] whitespace-normal break-words text-left h-auto leading-snug mb-1.5">
                  {f.issue}
                </Badge>
                <p className="text-sm italic leading-relaxed text-foreground/90">"{f.excerpt}"</p>
                <div className="flex items-center justify-between gap-2 mt-2 text-xs text-muted-foreground font-mono">
                  <span>
                    {f.subreddit ? `r/${f.subreddit} · ` : ""}
                    {fmtDate(f.createdAt)}
                  </span>
                  {f.permalink && (
                    <a
                      href={f.permalink}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-1 text-primary hover:underline no-print"
                    >
                      View <ExternalLink className="w-3 h-3" />
                    </a>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {pageCount > 1 && (
          <div className="no-print mt-4 pt-3 border-t border-border/50">
            <Pager page={safePage} pageCount={pageCount} onPageChange={setPage} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
