import { Link, useLocation, Redirect, Switch, Route } from "wouter";
import { lazy, Suspense } from "react";
import { Rocket, Globe, FileText, Monitor, LogOut } from "lucide-react";
import { useLogout, getGetMeQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";

const TopicAnalysis = lazy(() => import("@/pages/topic-analysis"));
const SentimentReports = lazy(() => import("@/pages/sentiment-reports"));

const DESKTOP_NOTE = "For full features, please access this website on desktop.";

function MobileTab({
  href,
  label,
  icon: Icon,
  active,
}: {
  href: string;
  label: string;
  icon: React.ElementType;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-md text-sm font-medium transition-all ${
        active
          ? "bg-primary/15 text-primary border border-primary/20"
          : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
      }`}
      data-testid={`mobile-tab-${label.toLowerCase()}`}
    >
      <Icon className="w-4 h-4" />
      {label}
    </Link>
  );
}

function MobileShell({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const queryClient = useQueryClient();
  const logout = useLogout();

  const handleLogout = () => {
    logout.mutate(undefined, {
      onSuccess: () => {
        queryClient.setQueryData(getGetMeQueryKey(), null);
        queryClient.invalidateQueries();
      },
    });
  };

  const reportsActive = location.startsWith("/sentiment-reports");
  const analyzeActive =
    location.startsWith("/sentiment-analysis") || location.startsWith("/topic-analysis");

  return (
    <div className="flex flex-col h-screen w-full overflow-hidden bg-background">
      <header className="shrink-0 border-b border-border bg-card/50 glass">
        <div className="px-4 pt-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="bg-primary/10 p-1.5 rounded-md border border-primary/20">
              <Rocket className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h1 className="font-bold text-base tracking-tight text-foreground leading-none">
                ASTRO ORBITER
              </h1>
              <p className="text-[9px] text-muted-foreground uppercase tracking-wider font-mono mt-0.5">
                Operations Center
              </p>
            </div>
          </div>
          <button
            onClick={handleLogout}
            disabled={logout.isPending}
            className="flex items-center gap-1.5 px-2 py-1.5 rounded-md text-[11px] font-mono text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-all"
            data-testid="mobile-button-logout"
          >
            <LogOut className="w-3.5 h-3.5" />
            {logout.isPending ? "…" : "LOGOUT"}
          </button>
        </div>

        <nav className="flex items-center gap-2 px-4 pt-3">
          <MobileTab href="/sentiment-analysis" label="Analyze" icon={Globe} active={analyzeActive} />
          <MobileTab href="/sentiment-reports" label="Reports" icon={FileText} active={reportsActive} />
        </nav>

        <p className="px-4 py-2 text-[11px] text-muted-foreground text-center" data-testid="mobile-desktop-note">
          {DESKTOP_NOTE}
        </p>
      </header>

      <main className="flex-1 overflow-y-auto relative">
        <Suspense
          fallback={
            <div className="min-h-[60vh] flex items-center justify-center">
              <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            </div>
          }
        >
          {children}
        </Suspense>
      </main>
    </div>
  );
}

function DesktopOnlyNotice() {
  return (
    <div
      className="flex flex-col items-center justify-center text-center gap-4 px-6 py-16 min-h-[60vh]"
      data-testid="mobile-desktop-only"
    >
      <div className="bg-muted/40 p-4 rounded-full border border-border/50">
        <Monitor className="w-8 h-8 text-muted-foreground" />
      </div>
      <div>
        <h2 className="text-lg font-bold tracking-tight">This page requires desktop</h2>
        <p className="text-sm text-muted-foreground mt-1.5 max-w-xs">{DESKTOP_NOTE}</p>
      </div>
      <div className="flex items-center gap-2 pt-1">
        <Link href="/sentiment-analysis">
          <Button className="gap-2" data-testid="mobile-link-analyze">
            <Globe className="w-4 h-4" /> Analyze
          </Button>
        </Link>
        <Link href="/sentiment-reports">
          <Button variant="outline" className="gap-2" data-testid="mobile-link-reports">
            <FileText className="w-4 h-4" /> Reports
          </Button>
        </Link>
      </div>
    </div>
  );
}

/**
 * Phone-only (<768px) app shell. Exposes just the two Sentiment pages
 * (Analyze + Reports); every other route shows a "requires desktop" notice.
 * The root path lands on Analyze.
 */
export function MobileApp() {
  return (
    <MobileShell>
      <Switch>
        <Route path="/sentiment-analysis" component={TopicAnalysis} />
        <Route path="/topic-analysis" component={TopicAnalysis} />
        <Route path="/sentiment-reports" component={SentimentReports} />
        <Route path="/">
          <Redirect to="/sentiment-analysis" />
        </Route>
        <Route>
          <DesktopOnlyNotice />
        </Route>
      </Switch>
    </MobileShell>
  );
}
