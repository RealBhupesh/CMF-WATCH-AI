import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { LucideIcon } from 'lucide-react';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Check,
  CircleGauge,
  Copy,
  Database,
  Gauge,
  MessageSquare,
  Play,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Watch,
} from 'lucide-react';
import { clsx } from 'clsx';

import { Sparkline } from '../components/Sparkline';
import { EventTable } from '../components/EventTable';
import {
  Badge,
  Button,
  CopyButton,
  EmptyState,
  InlineNote,
  PageHeader,
  Panel,
  SectionLabel,
  StatCard,
  StatusDot,
} from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { formatCount, formatMs, formatPercent, formatRelative } from '../lib/format';

function Loading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading overview">
      <div className="h-20 animate-pulse rounded-xl border border-ink-800 bg-ink-900/60" />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <div
            key={index}
            className="h-[118px] animate-pulse rounded-xl border border-ink-800 bg-ink-900/60"
          />
        ))}
      </div>
      <div className="grid gap-4 xl:grid-cols-3">
        <div className="h-[340px] animate-pulse rounded-xl border border-ink-800 bg-ink-900/60 xl:col-span-2" />
        <div className="h-[340px] animate-pulse rounded-xl border border-ink-800 bg-ink-900/60" />
      </div>
      <div className="h-[280px] animate-pulse rounded-xl border border-ink-800 bg-ink-900/60" />
    </div>
  );
}

function StatusCell({
  icon: Icon,
  label,
  value,
  tone,
  detail,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  tone: 'mint' | 'amber' | 'rose' | 'fog';
  detail?: string;
}) {
  const toneText =
    tone === 'mint'
      ? 'text-mint'
      : tone === 'amber'
        ? 'text-amber'
        : tone === 'rose'
          ? 'text-rose'
          : 'text-fog-400';
  return (
    <div className="flex min-w-0 items-center gap-3 bg-ink-900 px-4 py-3.5">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-ink-700 bg-ink-850">
        <Icon className={clsx('h-3.5 w-3.5', toneText)} aria-hidden="true" />
      </div>
      <div className="min-w-0">
        <p className="micro">{label}</p>
        <p className="mt-1 flex items-center gap-1.5 text-[13px] text-fog-200">
          <StatusDot tone={tone} pulse={tone === 'mint'} />
          <span className="truncate">{value}</span>
        </p>
        {detail ? (
          <p className="mt-0.5 truncate font-mono text-[10px] text-fog-500">
            {detail}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function ChecklistRow({
  done,
  label,
  detail,
  to,
  action,
}: {
  done: boolean;
  label: string;
  detail: string;
  to?: string;
  action?: string;
}) {
  return (
    <li className="flex items-start gap-2.5 py-2.5">
      <span
        className={clsx(
          'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border',
          done
            ? 'border-mint/40 bg-mint/15 text-mint'
            : 'border-ink-600 bg-ink-800 text-transparent',
        )}
      >
        <Check className="h-2.5 w-2.5" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <p className={clsx('text-[13px]', done ? 'text-fog-300' : 'text-fog-200')}>
          {label}
        </p>
        <p className="mt-0.5 text-[11px] leading-relaxed text-fog-500">{detail}</p>
      </div>
      {!done && to && action ? (
        <Link
          to={to}
          className="mt-0.5 inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-signal hover:text-signal-soft"
        >
          {action}
          <ArrowRight className="h-3 w-3" aria-hidden="true" />
        </Link>
      ) : null}
    </li>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <span className="text-[11px] text-fog-500">{label}</span>
      <span className="min-w-0 truncate font-mono text-[11px] text-fog-300">
        {children}
      </span>
    </div>
  );
}

export function OverviewPage() {
  const query = useQuery({
    queryKey: ['overview'],
    queryFn: api.overview,
    refetchInterval: 30_000,
  });

  if (query.isPending) return <Loading />;

  if (query.isError) {
    return (
      <div className="space-y-6">
        <PageHeader
          eyebrow="Operations"
          title="Overview"
          description="Live health and usage for the WatchAI Worker."
        />
        <Panel className="p-6">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-rose/30 bg-rose/10">
              <AlertTriangle className="h-4 w-4 text-rose" aria-hidden="true" />
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="font-display text-base font-semibold text-fog-100">
                Could not reach the Worker
              </h2>
              <p className="mt-1 text-sm leading-relaxed text-fog-400">
                {errorMessage(query.error)}
              </p>
              <p className="mt-2 font-mono text-[11px] text-fog-600">
                If you are running locally, make sure `wrangler dev` is on port 8787
                and the D1 migration has been applied.
              </p>
              <Button
                className="mt-4"
                variant="secondary"
                icon={RefreshCw}
                loading={query.isFetching}
                onClick={() => void query.refetch()}
              >
                Retry
              </Button>
            </div>
          </div>
        </Panel>
      </div>
    );
  }

  const data = query.data;
  const totalReplies = data.sparkline.reduce((sum, point) => sum + point.replies, 0);
  const showOnboarding = !data.onboarding.has_device || !data.onboarding.has_event;
  const aiRate = data.today.ai_success_rate;
  const latencyTone =
    data.latency.p50_ms === null
      ? 'fog'
      : data.latency.p50_ms > 1800
        ? 'rose'
        : data.latency.p50_ms > 1000
          ? 'amber'
          : 'mint';

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Operations"
        title="Overview"
        description="Live health, latency, and metadata-only usage for the WatchAI Worker. Message bodies never appear here."
        actions={
          <>
            <span className="hidden font-mono text-[10px] text-fog-600 sm:inline">
              updated {formatRelative(new Date(query.dataUpdatedAt).toISOString())}
            </span>
            <Button
              variant="secondary"
              size="sm"
              icon={RefreshCw}
              loading={query.isFetching}
              onClick={() => void query.refetch()}
            >
              Refresh
            </Button>
            <Link
              to="/playground"
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-signal bg-signal px-2.5 text-xs font-medium text-ink-950 transition-colors hover:border-signal-soft hover:bg-signal-soft"
            >
              <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
              Playground
            </Link>
          </>
        }
      />

      <Panel className="overflow-hidden">
        <div className="grid grid-cols-1 gap-px bg-ink-700/70 sm:grid-cols-2 xl:grid-cols-4">
          <StatusCell
            icon={Database}
            label="Cloudflare Worker"
            value="Online"
            tone="mint"
            detail={`v${data.version}`}
          />
          <StatusCell
            icon={Sparkles}
            label="Groq inference"
            value={data.groq_configured ? 'Configured' : 'Fallbacks only'}
            tone={data.groq_configured ? 'mint' : 'amber'}
            detail={data.groq_configured ? undefined : 'no key'}
          />
          <StatusCell
            icon={ShieldCheck}
            label="Dashboard auth"
            value={data.auth_mode === 'access' ? 'Access JWT' : 'Dev bypass'}
            tone={data.auth_mode === 'access' ? 'mint' : 'amber'}
            detail={data.environment}
          />
          <StatusCell
            icon={Database}
            label="D1 database"
            value="Connected"
            tone="mint"
            detail={`${formatCount(data.devices.total)} devices`}
          />
        </div>
      </Panel>

      {showOnboarding ? (
        <Panel className="relative overflow-hidden border-signal/20 p-5">
          <div
            className="absolute inset-y-0 left-0 w-0.5 bg-signal"
            aria-hidden="true"
          />
          <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
            <div className="max-w-xl">
              <p className="micro text-signal/90">Get to first reply</p>
              <h2 className="mt-2 font-display text-lg font-semibold tracking-tight text-fog-100">
                The phone is the bridge. The dashboard is the control room.
              </h2>
              <p className="mt-1.5 text-sm leading-relaxed text-fog-400">
                Pair the Android companion, then watch replies flow in. Until the
                companion ships, use the Playground and the Mac Device Lab to test the
                engine and the watch.
              </p>
            </div>
            <div className="grid gap-2 sm:grid-cols-3 lg:max-w-xl">
              {[
                {
                  n: '01',
                  title: 'Enroll a phone',
                  to: '/devices',
                  action: 'Get a code',
                  done: data.onboarding.has_device,
                },
                {
                  n: '02',
                  title: 'Generate a reply',
                  to: '/playground',
                  action: 'Open lab',
                  done: data.onboarding.has_event,
                },
                {
                  n: '03',
                  title: 'Verify M0',
                  to: '/lab',
                  action: 'Device Lab',
                  done: false,
                },
              ].map((step) => (
                <Link
                  key={step.n}
                  to={step.to}
                  className="group rounded-lg border border-ink-700/80 bg-ink-850/60 p-3 transition-colors hover:border-ink-600 hover:bg-ink-800/60"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[10px] text-signal">{step.n}</span>
                    {step.done ? (
                      <Badge tone="mint">done</Badge>
                    ) : (
                      <ArrowRight className="h-3.5 w-3.5 text-fog-600 transition-transform group-hover:translate-x-0.5 group-hover:text-fog-300" />
                    )}
                  </div>
                  <p className="mt-2 text-[13px] font-medium text-fog-200">
                    {step.title}
                  </p>
                  <p className="mt-0.5 text-[11px] text-fog-500">{step.action}</p>
                </Link>
              ))}
            </div>
          </div>
        </Panel>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Replies today"
          value={formatCount(data.today.replies)}
          icon={MessageSquare}
          sub={`${formatCount(data.today.ai_replies)} AI · ${formatCount(data.today.fallbacks)} fallback`}
          badge={
            data.today.opted_out > 0 ? (
              <Badge tone="amber">{data.today.opted_out} skipped</Badge>
            ) : undefined
          }
        />
        <StatCard
          label="Devices online"
          value={`${data.devices.online}/${data.devices.total}`}
          icon={Watch}
          tone={data.devices.online > 0 ? 'mint' : 'fog'}
          sub={
            data.devices.revoked > 0
              ? `${data.devices.revoked} revoked`
              : 'No revoked devices'
          }
          badge={
            data.devices.online > 0 ? (
              <StatusDot tone="mint" pulse />
            ) : (
              <Badge tone="fog">idle</Badge>
            )
          }
        />
        <StatCard
          label="p50 latency"
          value={formatMs(data.latency.p50_ms)}
          icon={Gauge}
          tone={latencyTone}
          sub={`p95 ${formatMs(data.latency.p95_ms)} · ${formatCount(data.latency.samples)} samples`}
        />
        <StatCard
          label="AI success rate"
          value={formatPercent(aiRate, 0)}
          icon={Sparkles}
          tone={aiRate === null ? 'fog' : aiRate > 0.8 ? 'mint' : 'amber'}
          sub={
            aiRate === null
              ? 'No generations yet today'
              : `${formatCount(data.today.ai_replies)} from Groq · ${formatCount(data.today.fallbacks)} honest fallbacks`
          }
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Panel className="min-w-0 p-5 xl:col-span-2">
          <SectionLabel
            trailing={`${formatCount(totalReplies)} replies · 24h`}
          >
            Reply volume
          </SectionLabel>
          <Sparkline data={data.sparkline} className="mt-4" />
          <div className="mt-4 grid grid-cols-3 divide-x divide-ink-700/70 rounded-lg border border-ink-700/70 bg-ink-950/40">
            <div className="px-3 py-2.5">
              <p className="micro">p50</p>
              <p className="mt-1 font-mono text-sm text-fog-200 tabular-nums">
                {formatMs(data.latency.p50_ms)}
              </p>
            </div>
            <div className="px-3 py-2.5">
              <p className="micro">p95</p>
              <p className="mt-1 font-mono text-sm text-fog-200 tabular-nums">
                {formatMs(data.latency.p95_ms)}
              </p>
            </div>
            <div className="px-3 py-2.5">
              <p className="micro">opted out</p>
              <p className="mt-1 font-mono text-sm text-fog-200 tabular-nums">
                {formatCount(data.today.opted_out)}
              </p>
            </div>
          </div>
        </Panel>

        <div className="space-y-4">
          <Panel className="p-5">
            <SectionLabel>Launch checklist</SectionLabel>
            <ul className="mt-2 divide-y divide-ink-800/80">
              <ChecklistRow
                done={data.groq_configured}
                label="Groq API key"
                detail={
                  data.groq_configured
                    ? 'Inference is live. Fallbacks still guard failures.'
                    : 'Set GROQ_API_KEY with wrangler secret put.'
                }
                to="/settings"
                action="Check"
              />
              <ChecklistRow
                done={data.onboarding.has_device}
                label="Android companion enrolled"
                detail={
                  data.onboarding.has_device
                    ? 'A device token exists and can call /v1/replies.'
                    : 'Generate an enrollment code, then scan the QR in the app.'
                }
                to="/devices"
                action="Enroll"
              />
              <ChecklistRow
                done={data.onboarding.has_event}
                label="First generation recorded"
                detail={
                  data.onboarding.has_event
                    ? 'The engine has produced at least one reply set.'
                    : 'Try the Playground to confirm the full path.'
                }
                to="/playground"
                action="Try"
              />
              <ChecklistRow
                done={false}
                label="M0 watch capture verified"
                detail="Does WhatsApp or SMS show a reply action on the watch? This gates automatic delivery."
                to="/lab"
                action="Open"
              />
            </ul>
          </Panel>

          <Panel className="p-5">
            <SectionLabel
              trailing={
                <CopyButton text={data.api_origin} label="API origin" size="sm" />
              }
            >
              Runtime
            </SectionLabel>
            <div className="mt-2 divide-y divide-ink-800/80">
              <Fact label="Environment">{data.environment}</Fact>
              <Fact label="Version">v{data.version}</Fact>
              <Fact label="Auth mode">{data.auth_mode}</Fact>
              <Fact label="Retention">{data.retention_days} days</Fact>
              <Fact label="API origin">{data.api_origin || 'same origin'}</Fact>
            </div>
            {data.groq_configured ? null : (
              <InlineNote tone="amber" icon={AlertTriangle} className="mt-3">
                No Groq key is configured. Generation returns the static fallback set
                and marks it honestly as not AI.
              </InlineNote>
            )}
          </Panel>
        </div>
      </div>

      <Panel>
        <div className="flex items-center justify-between gap-3 px-5 pt-5">
          <SectionLabel trailing={`${formatCount(data.recent.length)} latest`}>
            Recent activity
          </SectionLabel>
          <Link
            to="/activity"
            className="inline-flex items-center gap-1 text-xs font-medium text-fog-400 hover:text-fog-100"
          >
            View all
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        </div>

        {data.recent.length === 0 ? (
          <div className="p-5">
            <EmptyState
              icon={Activity}
              title="No events yet"
              description="Activity stores metadata only: app, sender alias, latency, and outcome. The message itself never reaches this table."
              action={
                <>
                  <Link
                    to="/devices"
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-ink-600 bg-ink-800/70 px-2.5 text-xs font-medium text-fog-200 transition-colors hover:border-ink-500 hover:bg-ink-800"
                  >
                    <Smartphone className="h-3.5 w-3.5" aria-hidden="true" />
                    Pair a device
                  </Link>
                  <Link
                    to="/playground"
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-signal bg-signal px-2.5 text-xs font-medium text-ink-950 transition-colors hover:border-signal-soft hover:bg-signal-soft"
                  >
                    <Play className="h-3.5 w-3.5" aria-hidden="true" />
                    Generate a reply
                  </Link>
                </>
              }
            />
          </div>
        ) : (
          <div className="mt-3 pb-1">
            <EventTable events={data.recent} compact />
          </div>
        )}
      </Panel>

      <div className="flex items-center gap-2 text-[10px] text-fog-600">
        <CircleGauge className="h-3 w-3" aria-hidden="true" />
        <span>
          Counts refresh every 30 seconds. The sparkline is bucketed hourly in UTC.
        </span>
        <span className="ml-auto hidden items-center gap-1 sm:flex">
          <Copy className="h-3 w-3" aria-hidden="true" />
          No bodies, no sender numbers, no message text.
        </span>
      </div>
    </div>
  );
}
