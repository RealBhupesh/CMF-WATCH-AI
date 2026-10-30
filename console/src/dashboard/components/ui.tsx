import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import {
  Check,
  ChevronDown,
  Copy,
  Loader2,
  type LucideIcon,
} from 'lucide-react';
import { clsx } from 'clsx';

export function Panel({
  children,
  className,
  id,
  as: Tag = 'section',
}: {
  children: ReactNode;
  className?: string;
  id?: string;
  as?: 'section' | 'div' | 'article' | 'aside';
}) {
  return (
    <Tag id={id} className={clsx('panel', className)}>
      {children}
    </Tag>
  );
}

export function SectionLabel({
  children,
  trailing,
  className,
}: {
  children: ReactNode;
  trailing?: ReactNode;
  className?: string;
}) {
  return (
    <div className={clsx('flex items-center gap-3', className)}>
      <span className="micro whitespace-nowrap">{children}</span>
      <span className="h-px flex-1 bg-ink-700/70" aria-hidden="true" />
      {trailing ? <span className="micro">{trailing}</span> : null}
    </div>
  );
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md' | 'lg' | 'icon';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'border-signal bg-signal text-ink-950 hover:border-signal-soft hover:bg-signal-soft shadow-[0_0_28px_rgba(255,106,43,0.14)]',
  secondary:
    'border-ink-600 bg-ink-800/70 text-fog-200 hover:border-ink-500 hover:bg-ink-800',
  ghost:
    'border-transparent bg-transparent text-fog-400 hover:bg-ink-800/70 hover:text-fog-100',
  danger:
    'border-rose/30 bg-rose/10 text-rose hover:border-rose/50 hover:bg-rose/15',
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 gap-1.5 px-2.5 text-xs',
  md: 'h-10 gap-2 px-3.5 text-sm',
  lg: 'h-11 gap-2 px-5 text-sm',
  icon: 'h-8 w-8',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: LucideIcon;
  iconRight?: LucideIcon;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  icon: Icon,
  iconRight: IconRight,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      className={clsx(
        'inline-flex shrink-0 items-center justify-center rounded-lg border font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/30 disabled:cursor-not-allowed disabled:opacity-45',
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        className,
      )}
      {...rest}
    >
      {loading ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      ) : Icon ? (
        <Icon className="h-4 w-4" aria-hidden="true" />
      ) : null}
      {children}
      {IconRight && !loading ? (
        <IconRight className="h-4 w-4" aria-hidden="true" />
      ) : null}
    </button>
  );
}

export type BadgeTone = 'mint' | 'amber' | 'rose' | 'sky' | 'signal' | 'fog';

const BADGE_TONES: Record<BadgeTone, string> = {
  mint: 'border-mint/25 bg-mint/10 text-mint',
  amber: 'border-amber/25 bg-amber/10 text-amber',
  rose: 'border-rose/25 bg-rose/10 text-rose',
  sky: 'border-sky-400/25 bg-sky-400/10 text-sky-300',
  signal: 'border-signal/30 bg-signal/10 text-signal-soft',
  fog: 'border-ink-600 bg-ink-800 text-fog-400',
};

export function Badge({
  children,
  tone = 'fog',
  dot = false,
  className,
}: {
  children: ReactNode;
  tone?: BadgeTone;
  dot?: boolean;
  className?: string;
}) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-[0.08em]',
        BADGE_TONES[tone],
        className,
      )}
    >
      {dot ? <span className="h-1.5 w-1.5 rounded-full bg-current" /> : null}
      {children}
    </span>
  );
}

export function StatusDot({
  tone = 'mint',
  pulse = false,
  className,
}: {
  tone?: BadgeTone;
  pulse?: boolean;
  className?: string;
}) {
  const color =
    tone === 'mint'
      ? 'bg-mint'
      : tone === 'amber'
        ? 'bg-amber'
        : tone === 'rose'
          ? 'bg-rose'
          : tone === 'signal'
            ? 'bg-signal'
            : 'bg-fog-500';
  return (
    <span
      className={clsx(
        'relative inline-flex h-1.5 w-1.5 rounded-full',
        color,
        pulse && 'animate-pulse-dot',
        className,
      )}
    />
  );
}

export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
  className,
  trailing,
}: {
  label: string;
  htmlFor?: string;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
  className?: string;
  trailing?: ReactNode;
}) {
  return (
    <div className={clsx('space-y-1.5', className)}>
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={htmlFor} className="micro text-fog-400">
          {label}
        </label>
        {trailing}
      </div>
      {children}
      {error ? (
        <p className="text-xs text-rose">{error}</p>
      ) : hint ? (
        <p className="text-xs leading-relaxed text-fog-500">{hint}</p>
      ) : null}
    </div>
  );
}

export const inputClass =
  'h-10 w-full rounded-lg border border-ink-700 bg-ink-950/60 px-3 text-sm text-fog-100 placeholder:text-fog-600 transition-colors focus:border-signal/60 focus:outline-none focus:ring-2 focus:ring-signal/15 disabled:cursor-not-allowed disabled:opacity-50';

export const textareaClass =
  'w-full resize-y rounded-lg border border-ink-700 bg-ink-950/60 px-3 py-2.5 text-sm leading-relaxed text-fog-100 placeholder:text-fog-600 transition-colors focus:border-signal/60 focus:outline-none focus:ring-2 focus:ring-signal/15 disabled:cursor-not-allowed disabled:opacity-50';

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={clsx(inputClass, className)} {...rest} />;
}

export function Textarea({
  className,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={clsx(textareaClass, className)} {...rest} />;
}

export function Select({
  className,
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="relative">
      <select
        className={clsx(
          inputClass,
          'appearance-none pr-9 [color-scheme:dark]',
          className,
        )}
        {...rest}
      >
        {children}
      </select>
      <ChevronDown
        className="pointer-events-none absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2 text-fog-500"
        aria-hidden="true"
      />
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-ink-600 bg-ink-800 px-1.5 py-0.5 font-mono text-[10px] text-fog-400">
      {children}
    </kbd>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <Loader2
      className={clsx('h-4 w-4 animate-spin text-fog-400', className)}
      aria-label="Loading"
    />
  );
}

export function CopyButton({
  text,
  label,
  className,
  size = 'sm',
  variant = 'ghost',
}: {
  text: string;
  label?: string;
  className?: string;
  size?: ButtonSize;
  variant?: ButtonVariant;
}) {
  const [copied, setCopied] = useState(false);
  const timeout = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timeout.current) window.clearTimeout(timeout.current);
    },
    [],
  );

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    setCopied(true);
    if (timeout.current) window.clearTimeout(timeout.current);
    timeout.current = window.setTimeout(() => setCopied(false), 1600);
  }, [text]);

  return (
    <Button
      variant={variant}
      size={size}
      onClick={copy}
      className={className}
      aria-label={label ? undefined : 'Copy to clipboard'}
      title={label ?? 'Copy'}
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-mint" aria-hidden="true" />
      ) : (
        <Copy className="h-3.5 w-3.5" aria-hidden="true" />
      )}
      {label ? <span>{copied ? 'Copied' : label}</span> : null}
    </Button>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {eyebrow ? <p className="micro mb-2 text-signal/90">{eyebrow}</p> : null}
        <h1 className="font-display text-2xl font-semibold tracking-tight text-fog-100 sm:text-[28px]">
          {title}
        </h1>
        {description ? (
          <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-fog-400">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      ) : null}
    </header>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
  children,
}: {
  icon: LucideIcon;
  title: string;
  description: ReactNode;
  action?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div
      className={clsx(
        'flex flex-col items-center justify-center rounded-xl border border-dashed border-ink-700 bg-ink-900/40 px-6 py-12 text-center',
        className,
      )}
    >
      <div className="relative mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-ink-600 bg-ink-850 text-signal">
        <div className="absolute inset-0 rounded-xl bg-signal/5 blur-md" aria-hidden="true" />
        <Icon className="relative h-5 w-5" aria-hidden="true" />
      </div>
      <h2 className="font-display text-base font-semibold text-fog-100">{title}</h2>
      <p className="mt-1.5 max-w-md text-sm leading-relaxed text-fog-400">
        {description}
      </p>
      {action ? <div className="mt-5 flex flex-wrap justify-center gap-2">{action}</div> : null}
      {children}
    </div>
  );
}

export function StatCard({
  label,
  value,
  sub,
  icon: Icon,
  badge,
  tone = 'signal',
  className,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  icon: LucideIcon;
  badge?: ReactNode;
  tone?: 'signal' | 'mint' | 'amber' | 'rose' | 'fog';
  className?: string;
}) {
  const iconTone =
    tone === 'mint'
      ? 'text-mint'
      : tone === 'amber'
        ? 'text-amber'
        : tone === 'rose'
          ? 'text-rose'
          : tone === 'fog'
            ? 'text-fog-400'
            : 'text-signal';
  return (
    <Panel className={clsx('relative overflow-hidden p-4', className)}>
      <div className="flex items-start justify-between gap-3">
        <span className="micro">{label}</span>
        <Icon className={clsx('h-4 w-4', iconTone)} aria-hidden="true" />
      </div>
      <div className="mt-3 flex items-end gap-2">
        <span className="font-mono text-[28px] leading-none font-medium tracking-tight text-fog-100 tabular-nums">
          {value}
        </span>
        {badge}
      </div>
      {sub ? <div className="mt-2 text-xs text-fog-500">{sub}</div> : null}
      <div
        className="absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-signal/40 via-ink-700/20 to-transparent"
        aria-hidden="true"
      />
    </Panel>
  );
}

export function Switch({
  checked,
  disabled,
  label,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
}) {
  const id = useId();
  return (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={clsx(
        'relative h-6 w-11 shrink-0 rounded-full border transition-colors',
        checked
          ? 'border-signal/50 bg-signal/30'
          : 'border-ink-600 bg-ink-800',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      <span
        className={clsx(
          'absolute top-1/2 h-4 w-4 -translate-y-1/2 rounded-full transition-all',
          checked ? 'left-6 bg-signal' : 'left-1 bg-fog-600',
        )}
      />
    </button>
  );
}

export function InlineNote({
  tone = 'fog',
  icon: Icon,
  children,
  className,
}: {
  tone?: 'fog' | 'amber' | 'mint' | 'rose' | 'signal';
  icon?: LucideIcon;
  children: ReactNode;
  className?: string;
}) {
  const styles = {
    fog: 'border-ink-700 bg-ink-900/50 text-fog-400',
    amber: 'border-amber/25 bg-amber/8 text-amber/90',
    mint: 'border-mint/25 bg-mint/8 text-mint/90',
    rose: 'border-rose/25 bg-rose/8 text-rose/90',
    signal: 'border-signal/25 bg-signal/8 text-signal-soft',
  } as const;
  const iconColor = {
    fog: 'text-fog-500',
    amber: 'text-amber',
    mint: 'text-mint',
    rose: 'text-rose',
    signal: 'text-signal',
  } as const;
  return (
    <div
      className={clsx(
        'flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-xs leading-relaxed',
        styles[tone],
        className,
      )}
    >
      {Icon ? (
        <Icon className={clsx('mt-0.5 h-3.5 w-3.5 shrink-0', iconColor[tone])} aria-hidden="true" />
      ) : null}
      <div className="min-w-0">{children}</div>
    </div>
  );
}
