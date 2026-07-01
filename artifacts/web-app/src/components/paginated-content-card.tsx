import { useState, type ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Pager } from "@/components/pager";

const PAGE_SIZE = 5;

interface PaginatedContentCardProps<T> {
  title: string;
  items: T[];
  getKey: (item: T) => string | number;
  renderItem: (item: T) => ReactNode;
  emptyText: string;
}

export function PaginatedContentCard<T>({
  title,
  items,
  getKey,
  renderItem,
  emptyText,
}: PaginatedContentCardProps<T>) {
  const [page, setPage] = useState(0);

  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const start = safePage * PAGE_SIZE;

  return (
    <Card className="glass">
      <CardHeader>
        <CardTitle className="font-mono text-sm tracking-wider text-muted-foreground flex items-center justify-between">
          <span>{title}</span>
          <span className="text-xs text-primary">{total} TOTAL</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {total === 0 ? (
          <p className="text-sm text-muted-foreground">{emptyText}</p>
        ) : (
          <>
            {/* Every item is rendered so printing can expand all pages. On
                screen, items outside the current page are hidden; in print
                they are revealed (and the pager is hidden) so the full list
                prints. */}
            <div className="space-y-4">
              {items.map((item, i) => {
                const inPage = i >= start && i < start + PAGE_SIZE;
                return (
                  <div
                    key={getKey(item)}
                    className={inPage ? undefined : "hidden print:block"}
                  >
                    {renderItem(item)}
                  </div>
                );
              })}
            </div>
            {pageCount > 1 && (
              <div className="no-print mt-4 pt-3 border-t border-border/50">
                <Pager
                  page={safePage}
                  pageCount={pageCount}
                  onPageChange={setPage}
                />
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
