const dateTime = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

const timeOnly = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return 'Never';
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return '—';

  const delta = timestamp - Date.now();
  const absolute = Math.abs(delta);

  if (absolute < 45_000) return 'just now';
  if (absolute < 3_600_000) {
    const minutes = Math.round(absolute / 60_000);
    return delta < 0 ? `${minutes}m ago` : `in ${minutes}m`;
  }
  if (absolute < 86_400_000) {
    const hours = Math.round(absolute / 3_600_000);
    return delta < 0 ? `${hours}h ago` : `in ${hours}h`;
  }
  if (absolute < 7 * 86_400_000) {
    const days = Math.round(absolute / 86_400_000);
    return delta < 0 ? `${days}d ago` : `in ${days}d`;
  }
  return dateTime.format(new Date(timestamp));
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const timestamp = Date.parse(iso);
  return Number.isFinite(timestamp) ? dateTime.format(new Date(timestamp)) : '—';
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const timestamp = Date.parse(iso);
  return Number.isFinite(timestamp) ? timeOnly.format(new Date(timestamp)) : '—';
}

export function formatUtcClock(date: Date): string {
  return `${date.toISOString().slice(11, 19)} UTC`;
}

export function formatCount(value: number): string {
  return new Intl.NumberFormat().format(value);
}

export function formatPercent(value: number | null, digits = 0): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

export function formatMs(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${formatCount(value)} ms`;
}

export function formatBattery(value: number | null): string {
  return value === null ? '—' : `${value}%`;
}

export function formatCountdown(ms: number): string {
  if (ms <= 0) return '00:00';
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function downloadFile(
  filename: string,
  contents: string,
  type = 'text/plain;charset=utf-8',
): void {
  const blob = new Blob([contents], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
