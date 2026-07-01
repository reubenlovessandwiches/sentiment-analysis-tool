import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react";

interface PagerProps {
  /** Current page, 0-indexed. */
  page: number;
  /** Total number of pages. */
  pageCount: number;
  /** Called with the new 0-indexed page. */
  onPageChange: (page: number) => void;
  className?: string;
}

/**
 * Shared pagination control used across the app. Renders a single, consistent
 * `<<  <  Page X of Y  >  >>` layout. Returns null when there is only one page.
 */
export function Pager({ page, pageCount, onPageChange, className }: PagerProps) {
  if (pageCount <= 1) return null;

  const safePage = Math.min(Math.max(page, 0), pageCount - 1);
  const atStart = safePage <= 0;
  const atEnd = safePage >= pageCount - 1;

  return (
    <div className={cn("flex items-center justify-center gap-1", className)}>
      <Button
        variant="ghost"
        size="icon"
        disabled={atStart}
        onClick={() => onPageChange(0)}
        aria-label="First page"
        data-testid="button-page-first"
      >
        <ChevronsLeft className="w-4 h-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        disabled={atStart}
        onClick={() => onPageChange(safePage - 1)}
        aria-label="Previous page"
        data-testid="button-page-prev"
      >
        <ChevronLeft className="w-4 h-4" />
      </Button>
      <span className="px-3 text-sm text-muted-foreground tabular-nums whitespace-nowrap">
        Page {safePage + 1} of {pageCount}
      </span>
      <Button
        variant="ghost"
        size="icon"
        disabled={atEnd}
        onClick={() => onPageChange(safePage + 1)}
        aria-label="Next page"
        data-testid="button-page-next"
      >
        <ChevronRight className="w-4 h-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        disabled={atEnd}
        onClick={() => onPageChange(pageCount - 1)}
        aria-label="Last page"
        data-testid="button-page-last"
      >
        <ChevronsRight className="w-4 h-4" />
      </Button>
    </div>
  );
}
