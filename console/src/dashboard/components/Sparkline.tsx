import { useId } from 'react';

import type { Overview } from '../lib/api';

export function Sparkline({
  data,
  className,
}: {
  data: Overview['sparkline'];
  className?: string;
}) {
  const reactId = useId().replace(/[^a-zA-Z0-9]/g, '');
  const gradientId = `spark-${reactId}`;
  const width = 760;
  const height = 190;
  const padding = { top: 14, right: 6, bottom: 10, left: 6 };
  const plotHeight = height - padding.top - padding.bottom;
  const slot = (width - padding.left - padding.right) / Math.max(1, data.length);
  const barWidth = Math.max(3, slot * 0.52);
  const max = Math.max(1, ...data.map((point) => point.replies));

  return (
    <div className={className}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="h-44 w-full overflow-visible"
        role="img"
        aria-label="Replies generated per hour over the last 24 hours"
      >
        <defs>
          <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#FF6A2B" stopOpacity="0.95" />
            <stop offset="100%" stopColor="#FF6A2B" stopOpacity="0.18" />
          </linearGradient>
        </defs>

        {[0.25, 0.5, 0.75].map((fraction) => {
          const y = padding.top + plotHeight * fraction;
          return (
            <line
              key={fraction}
              x1={padding.left}
              x2={width - padding.right}
              y1={y}
              y2={y}
              stroke="#1B2127"
              strokeDasharray="2 6"
              strokeWidth="1"
            />
          );
        })}

        {data.map((point, index) => {
          const x =
            padding.left + slot * index + slot / 2 - barWidth / 2;
          const ratio = point.replies / max;
          const barHeight =
            point.replies === 0 ? 2 : Math.max(4, ratio * plotHeight);
          const y = padding.top + plotHeight - barHeight;
          const isLast = index === data.length - 1;
          return (
            <rect
              key={point.hour}
              x={x}
              y={y}
              width={barWidth}
              height={barHeight}
              rx={1.5}
              fill={isLast ? '#FF8A57' : `url(#${gradientId})`}
              opacity={point.replies === 0 ? 0.28 : 1}
            >
              <title>
                {new Date(point.hour).toLocaleTimeString(undefined, {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
                {' — '}
                {point.replies} {point.replies === 1 ? 'reply' : 'replies'}
              </title>
            </rect>
          );
        })}

        <line
          x1={padding.left}
          x2={width - padding.right}
          y1={height - padding.bottom + 1}
          y2={height - padding.bottom + 1}
          stroke="#27303A"
          strokeWidth="1"
        />
      </svg>

      <div className="mt-2 flex justify-between font-mono text-[10px] tracking-wide text-fog-600">
        <span>{hourLabel(data[0]?.hour)}</span>
        <span>{hourLabel(data[Math.floor(data.length / 2)]?.hour)}</span>
        <span className="text-fog-400">now</span>
      </div>
    </div>
  );
}

function hourLabel(iso: string | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
}
