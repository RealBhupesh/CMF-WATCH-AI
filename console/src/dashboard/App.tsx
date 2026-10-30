import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Compass } from 'lucide-react';
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom';

import { Shell } from './components/Shell';
import { ToastProvider } from './components/Toast';
import { EmptyState } from './components/ui';
import { ActivityPage } from './pages/Activity';
import { DevicesPage } from './pages/Devices';
import { LabPage } from './pages/Lab';
import { OverviewPage } from './pages/Overview';
import { PlaygroundPage } from './pages/Playground';
import { SettingsPage } from './pages/Settings';
import { LabHandoffProvider } from './state/LabHandoff';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function NotFound() {
  return (
    <EmptyState
      icon={Compass}
      title="This panel does not exist"
      description="The route you opened is not part of the console. Head back to the overview."
      action={
        <Link
          to="/"
          className="inline-flex h-10 items-center justify-center rounded-lg border border-signal bg-signal px-3.5 text-sm font-medium text-ink-950 transition-colors hover:border-signal-soft hover:bg-signal-soft"
        >
          Back to overview
        </Link>
      }
    />
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <LabHandoffProvider>
          <BrowserRouter>
            <Routes>
              <Route element={<Shell />}>
                <Route index element={<OverviewPage />} />
                <Route path="playground" element={<PlaygroundPage />} />
                <Route path="devices" element={<DevicesPage />} />
                <Route path="lab" element={<LabPage />} />
                <Route path="activity" element={<ActivityPage />} />
                <Route path="settings" element={<SettingsPage />} />
                <Route path="*" element={<NotFound />} />
              </Route>
            </Routes>
          </BrowserRouter>
        </LabHandoffProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}
