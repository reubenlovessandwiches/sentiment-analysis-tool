import { useMemo, useState } from "react";
import {
  useGetFinanceSummary,
  useGetFinanceUsers,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DollarSign,
  Bot,
  Database,
  CreditCard,
  Users as UsersIcon,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";

const usd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });

const fmtMonth = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  if (!y || !m) return ym;
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
};

const fmtDate = (iso: string | null) => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
};

const EstBadge = () => (
  <Badge
    variant="outline"
    className="ml-2 text-[10px] font-mono uppercase tracking-wider text-amber-500 border-amber-500/40"
    title="Reconstructed from stored content — see note below"
  >
    est.
  </Badge>
);

function StatCard({
  label,
  value,
  icon: Icon,
  sub,
}: {
  label: string;
  value: string;
  icon: React.ElementType;
  sub?: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-mono uppercase tracking-wider text-muted-foreground">{label}</p>
            <p className="text-2xl font-bold mt-1">{value}</p>
            {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
          </div>
          <div className="bg-primary/10 p-2.5 rounded-md border border-primary/20">
            <Icon className="w-5 h-5 text-primary" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function Finance() {
  const { data: summary, isLoading: summaryLoading } = useGetFinanceSummary();

  // Month navigation options: "All time" + each month with recorded costs (desc).
  const monthOptions = useMemo(() => {
    const months = summary?.months?.map((m) => m.month) ?? [];
    return [null, ...months] as (string | null)[];
  }, [summary]);

  const [navIndex, setNavIndex] = useState(0);
  const selectedMonth = monthOptions[Math.min(navIndex, monthOptions.length - 1)] ?? null;

  const { data: usersData, isLoading: usersLoading } = useGetFinanceUsers(
    selectedMonth ? { month: selectedMonth } : undefined,
  );
  const users = usersData?.users ?? [];

  const anyEstimated = summary?.months?.some((m) => m.estimated) ?? false;

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <div className="bg-primary/10 p-2 rounded-md border border-primary/20">
          <DollarSign className="w-6 h-6 text-primary" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Finance</h1>
          <p className="text-sm text-muted-foreground">
            Per-user cost attribution (Apify crawls + OpenAI analysis) and consolidated monthly spend.
          </p>
        </div>
      </div>

      {/* Consolidated totals */}
      {summaryLoading || !summary ? (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <StatCard
            label="This Month"
            value={usd(summary.currentMonth.totalUsd)}
            icon={DollarSign}
            sub={`${fmtMonth(summary.currentMonth.month)} (incl. platform)`}
          />
          <StatCard label="Apify (all time)" value={usd(summary.allTime.apifyUsd)} icon={Database} />
          <StatCard label="OpenAI (all time)" value={usd(summary.allTime.openaiUsd)} icon={Bot} />
          <StatCard
            label="Platform / month"
            value={usd(summary.platformMonthlyUsd)}
            icon={CreditCard}
            sub={`Next payment: ${fmtDate(summary.platformNextPayment)}`}
          />
        </div>
      )}

      {/* Monthly consolidated table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Monthly Consolidated</CardTitle>
        </CardHeader>
        <CardContent>
          {summaryLoading || !summary ? (
            <Skeleton className="h-40" />
          ) : summary.months.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">No usage recorded yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs font-mono uppercase tracking-wider text-muted-foreground">
                    <th className="py-2 pr-4">Month</th>
                    <th className="py-2 pr-4 text-right">Apify</th>
                    <th className="py-2 pr-4 text-right">OpenAI</th>
                    <th className="py-2 pr-4 text-right">Platform</th>
                    <th className="py-2 text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.months.map((m) => (
                    <tr key={m.month} className="border-b border-border/50">
                      <td className="py-2 pr-4 font-mono">
                        {fmtMonth(m.month)}
                        {m.estimated && <EstBadge />}
                      </td>
                      <td className="py-2 pr-4 text-right">{usd(m.apifyUsd)}</td>
                      <td className="py-2 pr-4 text-right">{usd(m.openaiUsd)}</td>
                      <td className="py-2 pr-4 text-right">{usd(m.platformUsd)}</td>
                      <td className="py-2 text-right font-semibold">{usd(m.totalUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Per-user breakdown with month navigation */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base flex items-center gap-2">
            <UsersIcon className="w-4 h-4" /> Per-User Cost
          </CardTitle>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="icon"
              className="h-7 w-7"
              disabled={navIndex >= monthOptions.length - 1}
              onClick={() => setNavIndex((i) => Math.min(i + 1, monthOptions.length - 1))}
              title="Older month"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-sm font-medium min-w-[7rem] text-center">
              {selectedMonth ? fmtMonth(selectedMonth) : "All time"}
            </span>
            <Button
              variant="outline"
              size="icon"
              className="h-7 w-7"
              disabled={navIndex <= 0}
              onClick={() => setNavIndex((i) => Math.max(i - 1, 0))}
              title="Newer month"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {usersLoading ? (
            <Skeleton className="h-40" />
          ) : users.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">
              No attributable costs {selectedMonth ? `in ${fmtMonth(selectedMonth)}` : "recorded yet"}.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs font-mono uppercase tracking-wider text-muted-foreground">
                    <th className="py-2 pr-4">Account</th>
                    <th className="py-2 pr-4 text-right">Apify</th>
                    <th className="py-2 pr-4 text-right">OpenAI</th>
                    <th className="py-2 pr-4 text-right">Tokens (in/out)</th>
                    <th className="py-2 text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.appUser ?? "__platform__"} className="border-b border-border/50">
                      <td className="py-2 pr-4">
                        {u.appUser ?? (
                          <Badge variant="secondary" className="font-mono text-[10px]">
                            platform / shared
                          </Badge>
                        )}
                        {u.estimated && <EstBadge />}
                      </td>
                      <td className="py-2 pr-4 text-right">{usd(u.apifyUsd)}</td>
                      <td className="py-2 pr-4 text-right">{usd(u.openaiUsd)}</td>
                      <td className="py-2 pr-4 text-right font-mono text-xs text-muted-foreground">
                        {u.tokensInput.toLocaleString()} / {u.tokensOutput.toLocaleString()}
                      </td>
                      <td className="py-2 text-right font-semibold">{usd(u.totalUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {anyEstimated && (
        <p className="text-xs text-muted-foreground leading-relaxed">
          <span className="text-amber-500 font-mono">est.</span> — Figures marked “est.” are
          reconstructed from stored content. Token usage and per-run costs weren’t recorded before
          cost tracking went live, so historical OpenAI spend is estimated (token counts × list
          price) and Apify spend uses actual run costs from your Apify account with approximate
          per-user attribution. All costs are recorded automatically from now on.
        </p>
      )}
    </div>
  );
}
