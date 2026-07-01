import { lazy, Suspense } from "react";
import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/components/theme-provider";
import NotFound from "@/pages/not-found";
import { AppLayout } from "@/components/layout/app-layout";
import { MobileApp } from "@/components/layout/mobile-shell";
import { useIsMobile } from "@/hooks/use-mobile";
import Login from "@/pages/login";
import { getMe, getGetMeQueryKey } from "@workspace/api-client-react";

// Pages (lazy-loaded so each becomes its own chunk, fetched on navigation)
const Home = lazy(() => import("@/pages/home"));
const Dashboard = lazy(() => import("@/pages/dashboard"));
const Users = lazy(() => import("@/pages/users"));
const UserProfile = lazy(() => import("@/pages/user-profile"));
const Archetypes = lazy(() => import("@/pages/archetypes"));
const ArchetypeDetail = lazy(() => import("@/pages/archetype-detail"));
const TopicAnalysis = lazy(() => import("@/pages/topic-analysis"));
const SentimentReports = lazy(() => import("@/pages/sentiment-reports"));
const Investigate = lazy(() => import("@/pages/investigate"));
const Admin = lazy(() => import("@/pages/admin"));
const UserManagement = lazy(() => import("@/pages/user-management"));
const Finance = lazy(() => import("@/pages/finance"));
const FacebookDashboard = lazy(() => import("@/pages/facebook-dashboard"));
const FacebookUsers = lazy(() => import("@/pages/facebook-users"));
const FacebookUserProfile = lazy(() => import("@/pages/facebook-user-profile"));
const FacebookArchetypes = lazy(() => import("@/pages/facebook-archetypes"));
const FacebookArchetypeDetail = lazy(() => import("@/pages/facebook-archetype-detail"));
const InstagramDashboard = lazy(() => import("@/pages/instagram-dashboard"));
const InstagramUsers = lazy(() => import("@/pages/instagram-users"));
const InstagramUserProfile = lazy(() => import("@/pages/instagram-user-profile"));
const InstagramArchetypes = lazy(() => import("@/pages/instagram-archetypes"));
const InstagramArchetypeDetail = lazy(() => import("@/pages/instagram-archetype-detail"));
const TwitterDashboard = lazy(() => import("@/pages/twitter-dashboard"));
const TwitterUsers = lazy(() => import("@/pages/twitter-users"));
const TwitterUserProfile = lazy(() => import("@/pages/twitter-user-profile"));
const TwitterArchetypes = lazy(() => import("@/pages/twitter-archetypes"));
const TwitterArchetypeDetail = lazy(() => import("@/pages/twitter-archetype-detail"));
const YoutubeDashboard = lazy(() => import("@/pages/youtube-dashboard"));
const YoutubeUsers = lazy(() => import("@/pages/youtube-users"));
const YoutubeUserProfile = lazy(() => import("@/pages/youtube-user-profile"));
const YoutubeArchetypes = lazy(() => import("@/pages/youtube-archetypes"));
const YoutubeArchetypeDetail = lazy(() => import("@/pages/youtube-archetype-detail"));
const TikTokDashboard = lazy(() => import("@/pages/tiktok-dashboard"));
const TikTokUsers = lazy(() => import("@/pages/tiktok-users"));
const TikTokUserProfile = lazy(() => import("@/pages/tiktok-user-profile"));
const TikTokArchetypes = lazy(() => import("@/pages/tiktok-archetypes"));
const TikTokArchetypeDetail = lazy(() => import("@/pages/tiktok-archetype-detail"));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

function AuthGuard({ children }: { children: React.ReactNode }) {
  const { data, isLoading } = useQuery({
    queryKey: getGetMeQueryKey(),
    queryFn: () => getMe(),
    retry: false,
  });

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!data) {
    return <Login />;
  }

  return <>{children}</>;
}

function Router() {
  const isMobile = useIsMobile();
  if (isMobile) {
    return <MobileApp />;
  }
  return (
    <AppLayout>
      <Suspense
        fallback={
          <div className="min-h-[60vh] flex items-center justify-center">
            <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          </div>
        }
      >
      <Switch>
        <Route path="/" component={Home} />

        <Route path="/reddit-overview" component={Dashboard} />
        <Route path="/reddit-users" component={Users} />
        <Route path="/reddit-users/:username" component={UserProfile} />
        <Route path="/reddit-archetypes" component={Archetypes} />
        <Route path="/reddit-archetypes/:key" component={ArchetypeDetail} />
        <Route path="/reddit-investigate" component={Investigate} />

        <Route path="/facebook-overview" component={FacebookDashboard} />
        <Route path="/facebook-users" component={FacebookUsers} />
        <Route path="/facebook-users/:profileId" component={FacebookUserProfile} />
        <Route path="/facebook-archetypes" component={FacebookArchetypes} />
        <Route path="/facebook-archetypes/:key" component={FacebookArchetypeDetail} />

        <Route path="/instagram-overview" component={InstagramDashboard} />
        <Route path="/instagram-users" component={InstagramUsers} />
        <Route path="/instagram-users/:username" component={InstagramUserProfile} />
        <Route path="/instagram-archetypes" component={InstagramArchetypes} />
        <Route path="/instagram-archetypes/:key" component={InstagramArchetypeDetail} />
        <Route path="/twitter-overview" component={TwitterDashboard} />
        <Route path="/twitter-users" component={TwitterUsers} />
        <Route path="/twitter-users/:username" component={TwitterUserProfile} />
        <Route path="/twitter-archetypes" component={TwitterArchetypes} />
        <Route path="/twitter-archetypes/:key" component={TwitterArchetypeDetail} />
        <Route path="/youtube-overview" component={YoutubeDashboard} />
        <Route path="/youtube-users" component={YoutubeUsers} />
        <Route path="/youtube-users/:username" component={YoutubeUserProfile} />
        <Route path="/youtube-archetypes" component={YoutubeArchetypes} />
        <Route path="/youtube-archetypes/:key" component={YoutubeArchetypeDetail} />
        <Route path="/tiktok-overview" component={TikTokDashboard} />
        <Route path="/tiktok-users" component={TikTokUsers} />
        <Route path="/tiktok-users/:username" component={TikTokUserProfile} />
        <Route path="/tiktok-archetypes" component={TikTokArchetypes} />
        <Route path="/tiktok-archetypes/:key" component={TikTokArchetypeDetail} />

        <Route path="/sentiment-analysis" component={TopicAnalysis} />
        <Route path="/topic-analysis" component={TopicAnalysis} />
        <Route path="/sentiment-reports" component={SentimentReports} />
        <Route path="/admin" component={Admin} />
        <Route path="/user-management" component={UserManagement} />
        <Route path="/finance" component={Finance} />
        <Route component={NotFound} />
      </Switch>
      </Suspense>
    </AppLayout>
  );
}

function App() {
  return (
    <ThemeProvider defaultTheme="dark">
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <AuthGuard>
              <Router />
            </AuthGuard>
          </WouterRouter>
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}

export default App;
