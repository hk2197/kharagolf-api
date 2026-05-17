import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Home from "@/pages/home";
import CapabilityReport from "@/pages/capability-report";
import ClubSite from "@/pages/club-site";
import CoursePage from "@/pages/course-page";
import Pricing from "@/pages/pricing";
import CookieBanner from "@/components/CookieBanner";
import PublicProfile from "@/pages/public-profile";
import PublicBadge from "@/pages/public-badge";
import { useCustomDomainSite, CustomDomainProvider } from "@/lib/custom-domain";
import { LocaleProvider } from "@/lib/i18n";
import { Loader2 } from "lucide-react";

const queryClient = new QueryClient();

/**
 * Task #438 — Root route. When the SPA is being served from a club's
 * custom vanity domain (e.g. https://pinevalley.golf/) we render the
 * club mini-site at "/" instead of the generic KHARAGOLF marketing
 * homepage. The lookup is async so we briefly show a spinner.
 */
function RootRoute() {
  const { loading, slug } = useCustomDomainSite();
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin" />
      </div>
    );
  }
  if (slug) return <ClubSite slugOverride={slug} />;
  return <Home />;
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={RootRoute} />
      <Route path="/capability-report" component={CapabilityReport} />
      <Route path="/features" component={CapabilityReport} />
      <Route path="/clubs/:clubSlug/courses/:courseSlug" component={CoursePage} />
      <Route path="/pricing" component={Pricing} />
      <Route path="/clubs/:slug">{() => <ClubSite />}</Route>
      <Route path="/p/:handle/badge/:type" component={PublicBadge} />
      <Route path="/p/:handle" component={PublicProfile} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        {/* Task #1765 — site-wide locale provider. Detects the visitor's
            preferred language on first load (localStorage → browser →
            English), persists the choice and keeps `<html lang>`/`dir`
            in sync. The badge page keeps its own `?lang=` URL override
            (Task #1442) which still takes precedence on that route. */}
        <LocaleProvider>
          <CustomDomainProvider>
            <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
              <Router />
            </WouterRouter>
          </CustomDomainProvider>
          <CookieBanner />
          <Toaster />
        </LocaleProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
