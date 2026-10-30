import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  Bluetooth,
  ChevronRight,
  Cpu,
  LayoutDashboard,
  Lock,
  Menu,
  Settings,
  Sparkles,
  Watch,
  WifiOff,
  X,
} from 'lucide-react';
import { clsx } from 'clsx';

import { api } from '../lib/api';
import { formatUtcClock } from '../lib/format';
import { StatusDot } from './ui';

const NAV = [
  { to: '/', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/playground', label: 'AI Playground', icon: Sparkles },
  { to: '/devices', label: 'Devices', icon: Watch },
  { to: '/lab', label: 'Mac Device Lab', icon: Bluetooth, badge: 'M0' },
  { to: '/activity', label: 'Activity', icon: Activity },
  { to: '/settings', label: 'Settings', icon: Settings },
] as const;

function UtcClock() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <span
      className="hidden font-mono text-[11px] tracking-wide text-fog-500 tabular-nums sm:inline"
      title="Current time in UTC"
    >
      {formatUtcClock(now)}
    </span>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-3">
      <div className="relative flex h-9 w-9 items-center justify-center rounded-xl border border-signal/30 bg-signal/10">
        <Watch className="h-4 w-4 text-signal" aria-hidden="true" />
        <span className="absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-signal" />
      </div>
      <div className="leading-none">
        <p className="font-display text-[15px] font-semibold tracking-tight text-fog-100">
          WatchAI
        </p>
        <p className="mt-1 font-mono text-[9px] tracking-[0.22em] text-fog-500 uppercase">
          Console
        </p>
      </div>
    </div>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { data, isError } = useQuery({
    queryKey: ['overview'],
    queryFn: api.overview,
    refetchInterval: 60_000,
    staleTime: 20_000,
  });

  const environment = data?.environment ?? (isError ? 'offline' : '…');
  const production = environment === 'production';

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 items-center justify-between border-b border-ink-800/80 px-5">
        <Brand />
        {onNavigate ? (
          <button
            type="button"
            onClick={onNavigate}
            className="rounded-lg p-1.5 text-fog-500 hover:bg-ink-800 hover:text-fog-200 lg:hidden"
            aria-label="Close navigation"
          >
            <X className="h-4 w-4" />
          </button>
        ) : null}
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-5" aria-label="Primary">
        <p className="micro px-2.5 pb-2">Console</p>
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={'end' in item ? item.end : false}
            onClick={onNavigate}
            className={({ isActive }) =>
              clsx(
                'group relative flex h-9 items-center gap-2.5 rounded-lg border border-transparent px-2.5 text-[13px] transition-colors',
                isActive
                  ? 'border-ink-700/80 bg-ink-800/70 text-fog-100'
                  : 'text-fog-400 hover:bg-ink-800/40 hover:text-fog-200',
              )
            }
          >
            {({ isActive }) => (
              <>
                {isActive ? (
                  <span
                    className="absolute inset-y-1.5 -left-px w-0.5 rounded-full bg-signal"
                    aria-hidden="true"
                  />
                ) : null}
                <item.icon
                  className={clsx(
                    'h-4 w-4 shrink-0',
                    isActive
                      ? 'text-signal'
                      : 'text-fog-500 group-hover:text-fog-300',
                  )}
                  aria-hidden="true"
                />
                <span className="flex-1 truncate">{item.label}</span>
                {'badge' in item ? (
                  <span className="rounded border border-amber/25 bg-amber/10 px-1 py-px font-mono text-[9px] tracking-wide text-amber">
                    {item.badge}
                  </span>
                ) : null}
              </>
            )}
          </NavLink>
        ))}

        <div className="pt-6">
          <p className="micro px-2.5 pb-2">System</p>
          <NavLink
            to="/settings"
            onClick={onNavigate}
            className="group flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] text-fog-400 transition-colors hover:bg-ink-800/40 hover:text-fog-200"
          >
            <Cpu className="h-4 w-4 text-fog-500 group-hover:text-fog-300" aria-hidden="true" />
            <span className="flex-1">Worker</span>
            <span className="font-mono text-[10px] text-fog-500">
              {data?.version ?? '—'}
            </span>
          </NavLink>
          <NavLink
            to="/settings#privacy"
            onClick={onNavigate}
            className="group flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] text-fog-400 transition-colors hover:bg-ink-800/40 hover:text-fog-200"
          >
            <Lock className="h-4 w-4 text-fog-500 group-hover:text-fog-300" aria-hidden="true" />
            <span className="flex-1">Privacy</span>
          </NavLink>
        </div>
      </nav>

      <div className="border-t border-ink-800/80 p-3">
        <div className="rounded-lg border border-ink-700/70 bg-ink-850/60 px-3 py-2.5">
          <div className="flex items-center gap-2">
            <StatusDot
              tone={isError ? 'rose' : production ? 'mint' : 'amber'}
              pulse={!isError && production}
            />
            <span className="font-mono text-[10px] tracking-[0.1em] text-fog-400 uppercase">
              {isError ? 'Unreachable' : environment}
            </span>
            <span className="ml-auto font-mono text-[10px] text-fog-500">
              {data?.auth_mode ? `auth:${data.auth_mode}` : ''}
            </span>
          </div>
          <p className="mt-1.5 flex items-center gap-1 text-[10px] text-fog-600">
            {data?.groq_configured ? (
              <>
                <Sparkles className="h-3 w-3 text-mint" aria-hidden="true" />
                Groq API configured
              </>
            ) : (
              <>
                <WifiOff className="h-3 w-3 text-amber" aria-hidden="true" />
                Groq key not set — fallbacks only
              </>
            )}
          </p>
        </div>
        <p className="mt-2.5 px-1 text-[10px] leading-relaxed text-fog-600">
          Metadata-only by design. Message bodies are never stored.
        </p>
      </div>
    </div>
  );
}

export function Shell() {
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  const current = NAV.find((item) =>
    item.to === '/'
      ? location.pathname === '/'
      : location.pathname.startsWith(item.to),
  );

  return (
    <div className="relative min-h-dvh">
      <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
        <div className="instrument-grid absolute inset-0" />
        <div className="absolute -top-40 left-1/2 h-[420px] w-[820px] -translate-x-1/2 rounded-full bg-signal/5 blur-[110px]" />
      </div>

      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[100] focus:rounded-lg focus:bg-signal focus:px-3 focus:py-2 focus:text-sm focus:font-semibold focus:text-ink-950"
      >
        Skip to content
      </a>

      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[248px] border-r border-ink-800/80 bg-ink-950/85 backdrop-blur-xl lg:block">
        <Sidebar />
      </aside>

      {mobileOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            className="absolute inset-0 bg-ink-950/80 backdrop-blur-sm"
            onClick={() => setMobileOpen(false)}
            aria-label="Close navigation"
            tabIndex={-1}
          />
          <div className="relative h-full w-[280px] border-r border-ink-700 bg-ink-950 shadow-2xl">
            <Sidebar onNavigate={() => setMobileOpen(false)} />
          </div>
        </div>
      ) : null}

      <div className="lg:pl-[248px]">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-ink-800/80 bg-ink-950/80 px-4 backdrop-blur-xl sm:px-6 lg:px-8">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            className="rounded-lg border border-ink-700 p-1.5 text-fog-400 transition-colors hover:bg-ink-800 hover:text-fog-100 lg:hidden"
            aria-label="Open navigation"
          >
            <Menu className="h-4 w-4" />
          </button>

          <nav className="flex min-w-0 items-center gap-1.5" aria-label="Breadcrumb">
            <span className="hidden font-mono text-[11px] tracking-wide text-fog-600 sm:inline">
              watchai
            </span>
            <ChevronRight
              className="hidden h-3 w-3 text-fog-600 sm:block"
              aria-hidden="true"
            />
            <span className="truncate font-mono text-[11px] tracking-wide text-fog-300">
              {current?.label.toLowerCase() ?? 'console'}
            </span>
          </nav>

          <div className="ml-auto flex items-center gap-3">
            <UtcClock />
            <span className="hidden h-4 w-px bg-ink-700 sm:block" aria-hidden="true" />
            <div className="flex items-center gap-1.5 rounded-md border border-ink-700/80 bg-ink-900/60 px-2 py-1">
              <StatusDot tone="mint" pulse />
              <span className="font-mono text-[10px] tracking-[0.08em] text-fog-400 uppercase">
                live
              </span>
            </div>
          </div>
        </header>

        <main id="main" className="mx-auto w-full max-w-[1440px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          <div key={location.pathname} className="animate-page-in">
            <Outlet />
          </div>
        </main>

        <footer className="mx-auto flex w-full max-w-[1440px] flex-col gap-1.5 border-t border-ink-800/60 px-4 py-5 text-[10px] text-fog-600 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
          <span>
            WatchAI Console · CMF Watch Pro 2 companion lab · metadata-only telemetry
          </span>
          <span className="font-mono tracking-wide uppercase">
            M0 protocol unverified · replies require manual capture
          </span>
        </footer>
      </div>
    </div>
  );
}
