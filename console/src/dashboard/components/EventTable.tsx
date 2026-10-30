import { clsx } from 'clsx';

import { appMeta } from '../lib/apps';
import { formatMs, formatRelative } from '../lib/format';
import type { EventRecord, Outcome, Source } from '../lib/api';
import { Badge, type BadgeTone } from './ui';

export function AppBadge({ app }: { app: string }) {
  const meta = appMeta(app);
  return (
    <span className="flex min-w-0 items-center gap-2" title={app || 'Unknown app'}>
      <span
        className={clsx(
          'inline-flex h-5 min-w-7 shrink-0 items-center justify-center rounded border px-1 font-mono text-[9px] font-semibold tracking-wide',
          meta.accent,
        )}
      >
        {meta.code}
      </span>
      <span className="truncate text-xs text-fog-300">{meta.label}</span>
    </span>
  );
}

const SOURCE_TONES: Record<Source, BadgeTone> = {
  phone: 'sky',
  playground: 'signal',
  lab: 'fog',
};

const OUTCOME_TONES: Record<Outcome, BadgeTone> = {
  generated: 'signal',
  delivered: 'mint',
  failed: 'rose',
  opted_out: 'amber',
};

export function EventTable({
  events,
  compact = false,
}: {
  events: EventRecord[];
  compact?: boolean;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] border-collapse text-left">
        <thead>
          <tr className="border-b border-ink-700/80">
            {['Time', 'Source', 'App', 'Sender', 'Latency', 'Model', 'Replies', 'Outcome'].map(
              (heading) => (
                <th
                  key={heading}
                  scope="col"
                  className={clsx(
                    'micro px-3 py-2.5 font-normal first:pl-4 last:pr-4',
                    compact && heading === 'Source' && 'hidden lg:table-cell',
                  )}
                >
                  {heading}
                </th>
              ),
            )}
          </tr>
        </thead>
        <tbody>
          {events.map((event) => {
            const latencyTone =
              event.outcome !== 'generated'
                ? 'text-fog-500'
                : event.latency_ms > 2500
                  ? 'text-rose'
                  : event.latency_ms > 1200
                    ? 'text-amber'
                    : 'text-fog-300';
            return (
              <tr
                key={event.id}
                className="border-b border-ink-800/70 transition-colors last:border-0 hover:bg-ink-800/30"
              >
                <td className="px-3 py-2.5 pl-4 whitespace-nowrap">
                  <span
                    className="text-xs text-fog-300"
                    title={new Date(event.created_at).toLocaleString()}
                  >
                    {formatRelative(event.created_at)}
                  </span>
                </td>
                <td
                  className={clsx(
                    'px-3 py-2.5',
                    compact && 'hidden lg:table-cell',
                  )}
                >
                  <Badge tone={SOURCE_TONES[event.source]}>{event.source}</Badge>
                </td>
                <td className="max-w-[180px] px-3 py-2.5">
                  <AppBadge app={event.app} />
                </td>
                <td className="max-w-[160px] px-3 py-2.5">
                  <span className="block truncate font-mono text-xs text-fog-300">
                    {event.sender_alias || '—'}
                  </span>
                </td>
                <td
                  className={clsx(
                    'px-3 py-2.5 font-mono text-xs whitespace-nowrap tabular-nums',
                    latencyTone,
                  )}
                >
                  {event.outcome === 'opted_out' ? '—' : formatMs(event.latency_ms)}
                </td>
                <td className="px-3 py-2.5">
                  {event.outcome === 'opted_out' ? (
                    <Badge tone="amber">skipped</Badge>
                  ) : event.from_ai ? (
                    <Badge tone="mint" dot>
                      AI
                    </Badge>
                  ) : (
                    <Badge tone="amber">fallback</Badge>
                  )}
                </td>
                <td className="px-3 py-2.5 font-mono text-xs text-fog-400 tabular-nums">
                  {event.reply_count}×
                </td>
                <td className="px-3 py-2.5 pr-4">
                  <Badge tone={OUTCOME_TONES[event.outcome]}>
                    {event.outcome.replace('_', ' ')}
                  </Badge>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
