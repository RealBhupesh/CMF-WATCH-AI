export interface AppMeta {
  label: string;
  code: string;
  accent: string;
}

const APPS: Record<string, AppMeta> = {
  'com.whatsapp': {
    label: 'WhatsApp',
    code: 'WA',
    accent: 'border-mint/25 bg-mint/10 text-mint',
  },
  'com.android.mms': {
    label: 'SMS',
    code: 'SMS',
    accent: 'border-sky-400/25 bg-sky-400/10 text-sky-300',
  },
  'com.google.android.apps.messaging': {
    label: 'Messages',
    code: 'MSG',
    accent: 'border-sky-400/25 bg-sky-400/10 text-sky-300',
  },
  'com.microsoft.teams': {
    label: 'Teams',
    code: 'TM',
    accent: 'border-violet-400/25 bg-violet-400/10 text-violet-300',
  },
  'com.Slack': {
    label: 'Slack',
    code: 'SL',
    accent: 'border-fuchsia-400/25 bg-fuchsia-400/10 text-fuchsia-300',
  },
  'com.google.android.gm': {
    label: 'Gmail',
    code: 'GM',
    accent: 'border-rose-400/25 bg-rose-400/10 text-rose-300',
  },
  'com.linkedin.android': {
    label: 'LinkedIn',
    code: 'LI',
    accent: 'border-sky-500/25 bg-sky-500/10 text-sky-300',
  },
  'com.microsoft.office.outlook': {
    label: 'Outlook',
    code: 'OL',
    accent: 'border-sky-400/25 bg-sky-400/10 text-sky-300',
  },
};

export function appMeta(app: string): AppMeta {
  const known = APPS[app];
  if (known) return known;
  const tail = app.split('.').filter(Boolean).at(-1) ?? '';
  return {
    label: app || 'Unknown',
    code: (tail || 'APP').slice(0, 3).toUpperCase(),
    accent: 'border-ink-600 bg-ink-800 text-fog-400',
  };
}

export const APP_OPTIONS = [
  { value: 'com.whatsapp', label: 'WhatsApp' },
  { value: 'com.android.mms', label: 'SMS' },
  { value: 'com.google.android.apps.messaging', label: 'Google Messages' },
  { value: 'com.microsoft.teams', label: 'Microsoft Teams' },
  { value: 'com.Slack', label: 'Slack' },
  { value: 'com.google.android.gm', label: 'Gmail' },
  { value: 'com.linkedin.android', label: 'LinkedIn' },
  { value: 'com.microsoft.office.outlook', label: 'Outlook' },
  { value: 'custom', label: 'Other package…' },
] as const;
