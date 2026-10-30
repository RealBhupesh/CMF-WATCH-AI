import { useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Download,
  Inbox,
  Lock,
  RefreshCw,
  RotateCcw,
  SlidersHorizontal,
} from 'lucide-react';

import { EventTable } from '../components/EventTable';
import {
  Badge,
  Button,
  EmptyState,
  InlineNote,
  PageHeader,
  Panel,
  Select,
} from '../components/ui';
import { api, errorMessage } from '../lib/api';
import type {
  EventQueryParams,
  EventRecord,
  Outcome,
  Source,
} from '../lib/api';
import { APP_OPTIONS } from '../lib/apps';
import {
  csvEscape,
  downloadFile,
  formatCount,
  formatDateTime,
} from '../lib/format';

const PAGE_SIZES = [25, 50, 100];

export function ActivityPage() {
  const [source, setSource] = useState<Source | ''>('');
  const [app, setApp] = useState('');
  const [fromAi, setFromAi] = useState<'' | 'true' | 'false'>('');
  const [outcome, setOutcome] = useState<Outcome | ''>('');
  const [limit, setLimit] = useState(25);
  const [offset, setOffset] = useState(0);

  const params: EventQueryParams = useMemo(
    () => ({
      limit,
      offset,
      ...(source ? { source } : {}),
      ...(app ? { app } : {}),
      ...(fromAi ? { from_ai: fromAi } : {}),
      ...(outcome ? { outcome } : {}),
    }),
    [limit, offset, source, app, fromAi, outcome],
  );

  const query = useQuery({
    queryKey: ['events', params],
    queryFn: () => api.events(params),
    placeholderData: keepPreviousData,
    refetchInterval: 45_000,
  });

  const filtered = Boolean(source || app || fromAi || outcome);
  const total = query.data?.total ?? 0;
  const events = query.data?.events ?? [];
  const start = total === 0 ? 0 : offset + 1;
  const end = Math.min(offset + limit, total);
  const page = Math.floor(offset / limit) + 1;
  const pages = Math.max(1, Math.ceil(total / limit));

  function resetFilters() {
    setSource('');
    setApp('');
    setFromAi('');
    setOutcome('');
    setOffset(0);
  }

  function exportCsv() {
    if (events.length === 0) return;
    const header = [
      'created_at',
      'source',
      'app',
      'sender_alias',
      'latency_ms',
      'from_ai',
      'reply_count',
      'outcome',
    ].join(',');
    const rows = events.map((event: EventRecord) =>
      [
        csvEscape(event.created_at),
        event.source,
        csvEscape(event.app),
        csvEscape(event.sender_alias),
        String(event.latency_ms),
        event.from_ai ? 'true' : 'false',
        String(event.reply_count),
        event.outcome,
      ].join(','),
    );
    downloadFile(
      `watchai-activity-${new Date().toISOString().slice(0, 10)}.csv`,
      [header, ...rows].join('\n'),
      'text/csv;charset=utf-8',
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Telemetry"
        title="Activity"
        description="Every generation and delivery outcome, metadata only. There is no body column in D1, so there is nothing private to leak here."
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              icon={Download}
              onClick={exportCsv}
              disabled={events.length === 0}
            >
              Export page CSV
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={RefreshCw}
              loading={query.isFetching}
              onClick={() => void query.refetch()}
            >
              Refresh
            </Button>
          </>
        }
      />

      <Panel className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex items-center gap-2 text-[11px] text-fog-400">
            <SlidersHorizontal className="h-3.5 w-3.5 text-fog-500" aria-hidden="true" />
            Filters
          </span>
          <div className="flex items-center gap-2">
            {filtered ? <Badge tone="signal">filtered</Badge> : null}
            {filtered ? (
              <Button variant="ghost" size="sm" icon={RotateCcw} onClick={resetFilters}>
                Reset
              </Button>
            ) : null}
          </div>
        </div>

        <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
          <label className="space-y-1">
            <span className="micro block">Source</span>
            <Select
              value={source}
              onChange={(event) => {
                setSource(event.target.value as Source | '');
                setOffset(0);
              }}
              aria-label="Filter by source"
            >
              <option value="">All sources</option>
              <option value="phone">Phone</option>
              <option value="playground">Playground</option>
              <option value="lab">Device Lab</option>
            </Select>
          </label>

          <label className="space-y-1">
            <span className="micro block">App</span>
            <Select
              value={app}
              onChange={(event) => {
                setApp(event.target.value);
                setOffset(0);
              }}
              aria-label="Filter by app"
            >
              <option value="">All apps</option>
              {APP_OPTIONS.filter((option) => option.value !== 'custom').map(
                (option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ),
              )}
            </Select>
          </label>

          <label className="space-y-1">
            <span className="micro block">Model</span>
            <Select
              value={fromAi}
              onChange={(event) => {
                setFromAi(event.target.value as '' | 'true' | 'false');
                setOffset(0);
              }}
              aria-label="Filter by AI or fallback"
            >
              <option value="">AI + fallback</option>
              <option value="true">AI only</option>
              <option value="false">Fallback only</option>
            </Select>
          </label>

          <label className="space-y-1">
            <span className="micro block">Outcome</span>
            <Select
              value={outcome}
              onChange={(event) => {
                setOutcome(event.target.value as Outcome | '');
                setOffset(0);
              }}
              aria-label="Filter by outcome"
            >
              <option value="">All outcomes</option>
              <option value="generated">Generated</option>
              <option value="delivered">Delivered</option>
              <option value="failed">Failed</option>
              <option value="opted_out">Opted out</option>
            </Select>
          </label>

          <label className="space-y-1">
            <span className="micro block">Page size</span>
            <Select
              value={limit}
              onChange={(event) => {
                setLimit(Number(event.target.value));
                setOffset(0);
              }}
              aria-label="Rows per page"
            >
              {PAGE_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size} rows
                </option>
              ))}
            </Select>
          </label>
        </div>
      </Panel>

      {query.isError ? (
        <Panel className="p-5">
          <InlineNote tone="rose" icon={AlertTriangle}>
            {errorMessage(query.error)}
          </InlineNote>
          <Button
            className="mt-3"
            variant="secondary"
            size="sm"
            icon={RefreshCw}
            onClick={() => void query.refetch()}
          >
            Retry
          </Button>
        </Panel>
      ) : (
        <Panel>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-700/70 px-4 py-3">
            <p className="font-mono text-[10px] tracking-wide text-fog-500 uppercase">
              {total === 0
                ? 'No events'
                : `Showing ${formatCount(start)}–${formatCount(end)} of ${formatCount(total)}`}
            </p>
            <div className="flex items-center gap-1.5">
              <Button
                variant="ghost"
                size="icon"
                aria-label="Previous page"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - limit))}
              >
                <ChevronLeft className="h-4 w-4" aria-hidden="true" />
              </Button>
              <span className="font-mono text-[10px] text-fog-500 tabular-nums">
                {page}/{pages}
              </span>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Next page"
                disabled={end >= total}
                onClick={() => setOffset(offset + limit)}
              >
                <ChevronRight className="h-4 w-4" aria-hidden="true" />
              </Button>
            </div>
          </div>

          {query.isPending ? (
            <div className="space-y-2 p-4" aria-busy="true">
              {Array.from({ length: 6 }, (_, index) => (
                <div
                  key={index}
                  className="h-9 animate-pulse rounded-md bg-ink-800/60"
                />
              ))}
            </div>
          ) : events.length === 0 ? (
            <div className="p-5">
              <EmptyState
                icon={filtered ? Inbox : Activity}
                title={filtered ? 'No events match those filters' : 'No activity yet'}
                description={
                  filtered
                    ? 'Try a wider range. Filters combine with AND, so an app with no playground events will return nothing when both are set.'
                    : 'Generate a reply in the Playground, or have the Android companion call /v1/replies. Each request writes one metadata-only row.'
                }
                action={
                  filtered ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={RotateCcw}
                      onClick={resetFilters}
                    >
                      Clear filters
                    </Button>
                  ) : (
                    <Link
                      to="/playground"
                      className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-signal bg-signal px-2.5 text-xs font-medium text-ink-950 transition-colors hover:border-signal-soft hover:bg-signal-soft"
                    >
                      Open Playground
                    </Link>
                  )
                }
              />
            </div>
          ) : (
            <EventTable events={events} />
          )}

          {events.length > 0 ? (
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-ink-700/70 px-4 py-2.5">
              <span className="text-[10px] text-fog-600">
                Latest row: {formatDateTime(events[0]?.created_at)}
              </span>
              <span className="flex items-center gap-1.5 font-mono text-[10px] text-fog-600">
                <Lock className="h-3 w-3" aria-hidden="true" />
                no bodies · no phone numbers
              </span>
            </div>
          ) : null}
        </Panel>
      )}

      <InlineNote tone="fog" icon={Lock}>
        Activity is deliberately boring. Sender aliases and app package names are the
        only context retained; retention prunes rows daily according to Settings.
      </InlineNote>
    </div>
  );
}
