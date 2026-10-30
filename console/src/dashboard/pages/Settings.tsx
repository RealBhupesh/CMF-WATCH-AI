import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Check,
  Database,
  KeyRound,
  Lock,
  Plus,
  RotateCcw,
  Save,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';

import { ConfirmDialog } from '../components/Modal';
import {
  Badge,
  Button,
  CopyButton,
  Field,
  InlineNote,
  Input,
  PageHeader,
  Panel,
  SectionLabel,
  Select,
  Switch,
} from '../components/ui';
import { useToast } from '../components/Toast';
import {
  api,
  errorMessage,
  type SettingsPayload,
  type SettingsRecord,
  type ToneSetting,
} from '../lib/api';
import { formatRelative } from '../lib/format';

const MODEL_OPTIONS = [
  'llama-3.3-70b-versatile',
  'openai/gpt-oss-120b',
  'llama-3.1-8b-instant',
  'qwen/qwen3-32b',
];

const TONE_OPTIONS: Array<{ value: ToneSetting; label: string }> = [
  { value: 'auto', label: 'Auto — infer per message' },
  { value: 'casual_hinglish', label: 'Casual Hinglish' },
  { value: 'casual_english', label: 'Casual English' },
  { value: 'professional', label: 'Professional' },
];

const RETENTION_PRESETS = [7, 30, 90, 365];

function toPayload(settings: SettingsRecord): SettingsPayload {
  return {
    model: settings.model,
    forced_tone: settings.forced_tone,
    opt_outs: [...settings.opt_outs],
    retention_days: settings.retention_days,
  };
}

function sameList(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((item, index) => item === right[index])
  );
}

export function SettingsPage() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const location = useLocation();
  const [draft, setDraft] = useState<SettingsPayload | null>(null);
  const [optOutInput, setOptOutInput] = useState('');
  const [optOutError, setOptOutError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [revokeOpen, setRevokeOpen] = useState(false);

  const settingsQuery = useQuery({
    queryKey: ['settings'],
    queryFn: api.settings,
    staleTime: 60_000,
  });
  const overviewQuery = useQuery({
    queryKey: ['overview'],
    queryFn: api.overview,
    staleTime: 60_000,
  });

  const settings = settingsQuery.data;

  useEffect(() => {
    if (settings && draft === null) setDraft(toPayload(settings));
  }, [settings, draft]);

  useEffect(() => {
    if (location.hash === '#privacy' && draft) {
      document
        .getElementById('privacy')
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [location.hash, draft]);

  const dirty =
    Boolean(settings && draft) &&
    (draft!.model !== settings!.model ||
      draft!.forced_tone !== settings!.forced_tone ||
      draft!.retention_days !== settings!.retention_days ||
      !sameList(draft!.opt_outs, settings!.opt_outs));

  const saveMutation = useMutation({
    mutationFn: (payload: SettingsPayload) => api.updateSettings(payload),
    onSuccess: (updated) => {
      queryClient.setQueryData(['settings'], updated);
      setDraft(toPayload(updated));
      toast.push({
        title: 'Settings saved',
        description: 'The phone API reads these values on the next request.',
        variant: 'success',
      });
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
    },
    onError: (error) => {
      toast.push({
        title: 'Could not save settings',
        description: errorMessage(error),
        variant: 'error',
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: api.deleteEvents,
    onSuccess: (result) => {
      toast.push({
        title: `${result.deleted} event${result.deleted === 1 ? '' : 's'} deleted`,
        description: 'Metadata telemetry cleared. Devices and settings are untouched.',
        variant: 'success',
      });
      setDeleteOpen(false);
      void queryClient.invalidateQueries({ queryKey: ['events'] });
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
    },
    onError: (error) => {
      toast.push({
        title: 'Could not delete events',
        description: errorMessage(error),
        variant: 'error',
      });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: api.revokeAllDevices,
    onSuccess: (result) => {
      toast.push({
        title: `${result.revoked} device${result.revoked === 1 ? '' : 's'} revoked`,
        description: 'Every existing phone token now fails with 401.',
        variant: 'success',
      });
      setRevokeOpen(false);
      void queryClient.invalidateQueries({ queryKey: ['devices'] });
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
    },
    onError: (error) => {
      toast.push({
        title: 'Could not revoke devices',
        description: errorMessage(error),
        variant: 'error',
      });
    },
  });

  function addOptOut() {
    if (!draft) return;
    const value = optOutInput.trim();
    if (!value) return;
    if (value.length > 100) {
      setOptOutError('Aliases are capped at 100 characters.');
      return;
    }
    if (draft.opt_outs.some((item) => item.toLowerCase() === value.toLowerCase())) {
      setOptOutError('That alias is already opted out.');
      return;
    }
    if (draft.opt_outs.length >= 200) {
      setOptOutError('The opt-out list is capped at 200 aliases.');
      return;
    }
    setOptOutError(null);
    setOptOutInput('');
    setDraft({ ...draft, opt_outs: [...draft.opt_outs, value] });
  }

  if (settingsQuery.isError) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Control" title="Settings" />
        <Panel className="p-5">
          <InlineNote tone="rose" icon={AlertTriangle}>
            {errorMessage(settingsQuery.error)}
          </InlineNote>
          <Button
            className="mt-3"
            variant="secondary"
            size="sm"
            onClick={() => void settingsQuery.refetch()}
          >
            Retry
          </Button>
        </Panel>
      </div>
    );
  }

  if (settingsQuery.isPending || !draft) {
    return (
      <div className="space-y-6" aria-busy="true">
        <div className="h-16 animate-pulse rounded-lg bg-ink-900/60" />
        <div className="grid gap-4 xl:grid-cols-2">
          <div className="h-[420px] animate-pulse rounded-xl border border-ink-800 bg-ink-900/60" />
          <div className="h-[420px] animate-pulse rounded-xl border border-ink-800 bg-ink-900/60" />
        </div>
      </div>
    );
  }

  const overview = overviewQuery.data;
  const apiOrigin =
    overview?.api_origin ||
    (typeof window !== 'undefined' ? window.location.origin : '');
  const sampleCurl = `curl -s ${apiOrigin}/v1/replies \\
  -H "authorization: Bearer $WATCHAI_TOKEN" \\
  -H "content-type: application/json" \\
  -d '{"sender":"Rahul","app":"com.whatsapp","body":"kal milte hai?"}'`;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Control"
        title="Settings"
        description="Engine defaults, opt-outs, retention, and the destructive switches. Changes apply to the phone API on its next request."
        actions={
          <>
            {dirty ? <Badge tone="amber">unsaved</Badge> : null}
            <Button
              variant="ghost"
              size="sm"
              icon={RotateCcw}
              disabled={!dirty || saveMutation.isPending}
              onClick={() => settings && setDraft(toPayload(settings))}
            >
              Revert
            </Button>
            <Button
              variant="primary"
              size="sm"
              icon={Save}
              disabled={!dirty}
              loading={saveMutation.isPending}
              onClick={() => draft && saveMutation.mutate(draft)}
            >
              Save changes
            </Button>
          </>
        }
      />

      <div className="grid items-start gap-4 xl:grid-cols-2">
        <div className="min-w-0 space-y-4">
          <Panel className="p-5">
            <SectionLabel trailing="applies to phone + playground">Generation</SectionLabel>

            <div className="mt-4 space-y-4">
              <Field
                label="Groq model ID"
                htmlFor="set-model"
                hint="Any chat model on Groq. The Worker falls back honestly if the call fails or times out."
              >
                <Input
                  id="set-model"
                  value={draft.model}
                  onChange={(event) =>
                    setDraft({ ...draft, model: event.target.value })
                  }
                  list="model-options"
                  spellCheck={false}
                  autoComplete="off"
                  className="font-mono text-[12px]"
                />
                <datalist id="model-options">
                  {MODEL_OPTIONS.map((model) => (
                    <option key={model} value={model} />
                  ))}
                </datalist>
              </Field>

              <Field
                label="Tone"
                htmlFor="set-tone"
                hint="Auto infers from the app and language markers. A forced tone overrides both."
              >
                <Select
                  id="set-tone"
                  value={draft.forced_tone}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      forced_tone: event.target.value as ToneSetting,
                    })
                  }
                >
                  {TONE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field
                label="Contact opt-outs"
                htmlFor="set-optout"
                hint="Matching is case-insensitive after trimming. The phone checks first; the Worker re-checks and skips Groq."
              >
                <div className="flex gap-2">
                  <Input
                    id="set-optout"
                    value={optOutInput}
                    onChange={(event) => {
                      setOptOutInput(event.target.value);
                      setOptOutError(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        addOptOut();
                      }
                    }}
                    placeholder="Rahul"
                    maxLength={100}
                    autoComplete="off"
                  />
                  <Button
                    variant="secondary"
                    icon={Plus}
                    onClick={addOptOut}
                    disabled={!optOutInput.trim()}
                  >
                    Add
                  </Button>
                </div>
              </Field>

              {optOutError ? (
                <p className="text-xs text-rose">{optOutError}</p>
              ) : null}

              {draft.opt_outs.length === 0 ? (
                <div className="rounded-lg border border-dashed border-ink-700 px-3 py-4 text-center text-[11px] text-fog-500">
                  No opt-outs. Every sender is eligible for replies.
                </div>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {draft.opt_outs.map((alias) => (
                    <span
                      key={alias}
                      className="inline-flex items-center gap-1.5 rounded-md border border-ink-600 bg-ink-800 px-2 py-1 text-[11px] text-fog-300"
                    >
                      <Lock className="h-2.5 w-2.5 text-fog-500" aria-hidden="true" />
                      {alias}
                      <button
                        type="button"
                        onClick={() =>
                          setDraft({
                            ...draft,
                            opt_outs: draft.opt_outs.filter((item) => item !== alias),
                          })
                        }
                        className="rounded p-0.5 text-fog-500 hover:bg-ink-700 hover:text-rose"
                        aria-label={`Remove opt-out for ${alias}`}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </Panel>

          <Panel className="p-5" id="privacy">
            <SectionLabel trailing="metadata only">Privacy</SectionLabel>

            <div className="mt-4 space-y-4">
              <Field
                label="Event retention"
                htmlFor="set-retention"
                hint="A daily cron deletes older rows. Enrollment codes and rate-limit rows are pruned too."
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    id="set-retention"
                    type="number"
                    min={1}
                    max={365}
                    value={draft.retention_days}
                    onChange={(event) => {
                      const next = Number(event.target.value);
                      setDraft({
                        ...draft,
                        retention_days: Number.isFinite(next) ? next : 1,
                      });
                    }}
                    className="max-w-24 font-mono"
                  />
                  <span className="text-xs text-fog-500">days</span>
                  <div className="ml-auto flex gap-1">
                    {RETENTION_PRESETS.map((days) => (
                      <button
                        key={days}
                        type="button"
                        onClick={() => setDraft({ ...draft, retention_days: days })}
                        className={
                          draft.retention_days === days
                            ? 'rounded-md border border-signal/40 bg-signal/10 px-2 py-1 font-mono text-[10px] text-signal'
                            : 'rounded-md border border-ink-700 px-2 py-1 font-mono text-[10px] text-fog-500 hover:border-ink-600 hover:text-fog-300'
                        }
                      >
                        {days}d
                      </button>
                    ))}
                  </div>
                </div>
              </Field>

              <div className="flex items-start justify-between gap-4 rounded-lg border border-ink-700/80 bg-ink-950/40 p-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 text-[13px] text-fog-200">
                    Store message bodies
                    <Badge tone="fog">disabled by design</Badge>
                  </p>
                  <p className="mt-1 text-[11px] leading-relaxed text-fog-500">
                    There is no body column in D1, and no code path writes one. The
                    engine sees the text in memory, sends it to Groq, and discards it.
                  </p>
                </div>
                <Switch checked={false} disabled label="Store message bodies" />
              </div>

              <div className="flex items-center gap-2 rounded-lg border border-mint/20 bg-mint/[0.04] p-3 text-[11px] leading-relaxed text-fog-400">
                <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-mint" aria-hidden="true" />
                Logs contain request id, route, status, duration, and device id — never
                sender, body, or reply text.
              </div>
            </div>
          </Panel>

          <Panel className="border-rose/20 p-5">
            <SectionLabel>Danger zone</SectionLabel>
            <div className="mt-3 divide-y divide-ink-800/80">
              <div className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-[13px] text-fog-200">Delete all events</p>
                  <p className="mt-0.5 text-[11px] text-fog-500">
                    Clears metadata telemetry. Settings and devices survive.
                  </p>
                </div>
                <Button
                  variant="danger"
                  size="sm"
                  icon={Trash2}
                  onClick={() => setDeleteOpen(true)}
                >
                  Delete events
                </Button>
              </div>
              <div className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-[13px] text-fog-200">Revoke all devices</p>
                  <p className="mt-0.5 text-[11px] text-fog-500">
                    Every phone token stops working on its next request.
                  </p>
                </div>
                <Button
                  variant="danger"
                  size="sm"
                  icon={KeyRound}
                  onClick={() => setRevokeOpen(true)}
                >
                  Revoke devices
                </Button>
              </div>
            </div>
          </Panel>
        </div>

        <div className="min-w-0 space-y-4">
          <Panel className="p-5">
            <SectionLabel
              trailing={
                <CopyButton text={`${apiOrigin}/v1`} label="API base" size="sm" />
              }
            >
              Phone API
            </SectionLabel>
            <p className="mt-2 text-[11px] leading-relaxed text-fog-500">
              Device bearer tokens only. Enrollment is the one unauthenticated route,
              rate limited by IP.
            </p>

            <div className="mt-3 divide-y divide-ink-800/80">
              {[
                ['POST', '/v1/enroll', 'code → token'],
                ['POST', '/v1/replies', 'sender, body, app, history'],
                ['POST', '/v1/events', 'delivery outcome'],
                ['GET', '/v1/me', 'device + settings'],
                ['POST', '/v1/heartbeat', 'watch, firmware, battery'],
                ['POST', '/v1/unenroll', 'revoke self'],
              ].map(([method, path, detail]) => (
                <div key={path} className="flex items-center gap-2 py-2">
                  <span
                    className={
                      method === 'GET'
                        ? 'w-9 font-mono text-[9px] text-sky-300'
                        : 'w-9 font-mono text-[9px] text-signal'
                    }
                  >
                    {method}
                  </span>
                  <code className="min-w-0 flex-1 truncate text-[11px] text-fog-300">
                    {path}
                  </code>
                  <span className="hidden truncate text-[10px] text-fog-600 sm:block">
                    {detail}
                  </span>
                  <CopyButton text={`${apiOrigin}${path}`} size="sm" />
                </div>
              ))}
            </div>

            <div className="mt-3 rounded-lg border border-ink-700/80 bg-ink-950/60">
              <div className="flex items-center justify-between border-b border-ink-800 px-3 py-2">
                <span className="micro">Sample request</span>
                <CopyButton text={sampleCurl} label="Copy curl" size="sm" />
              </div>
              <pre className="overflow-x-auto p-3 text-[10px] leading-relaxed text-fog-400">
                {sampleCurl}
              </pre>
            </div>
          </Panel>

          <Panel className="p-5">
            <SectionLabel>Runtime</SectionLabel>
            <div className="mt-2 divide-y divide-ink-800/80">
              {[
                ['Version', overview ? `v${overview.version}` : '—'],
                ['Environment', overview?.environment ?? '—'],
                ['Auth mode', overview?.auth_mode ?? '—'],
                ['Groq key', overview?.groq_configured ? 'configured' : 'missing'],
                ['Retention', `${draft.retention_days} days`],
                [
                  'Settings updated',
                  settings?.updated_at ? formatRelative(settings.updated_at) : 'defaults',
                ],
              ].map(([label, value]) => (
                <div
                  key={label}
                  className="flex items-center justify-between gap-3 py-2"
                >
                  <span className="text-[11px] text-fog-500">{label}</span>
                  <span className="font-mono text-[11px] text-fog-300">{value}</span>
                </div>
              ))}
            </div>

            <div className="mt-3 space-y-2">
              <InlineNote
                tone={overview?.groq_configured ? 'mint' : 'amber'}
                icon={overview?.groq_configured ? Check : AlertTriangle}
              >
                {overview?.groq_configured
                  ? 'GROQ_API_KEY is present. Fallbacks still protect every timeout and bad JSON response.'
                  : 'No GROQ_API_KEY. Add it with `wrangler secret put GROQ_API_KEY`; until then replies are static fallbacks.'}
              </InlineNote>
              <InlineNote tone="fog" icon={Database}>
                TOKEN_PEPPER must be set before production enrollment. Without it the
                Worker fails closed with 503 in production.
              </InlineNote>
            </div>
          </Panel>

          <Panel className="p-5" id="privacy-notes">
            <SectionLabel>What is stored</SectionLabel>
            <ul className="mt-3 space-y-2 text-[11px] leading-relaxed text-fog-400">
              {[
                'Devices: id, name, platform, app version, watch identity, battery, timestamps.',
                'Enrollment codes: SHA-256 hash, expiry, used-at. Never the plaintext.',
                'Settings: model, tone, opt-out aliases, retention days.',
                'Events: app, sender alias, latency, AI flag, reply count, outcome.',
              ].map((item) => (
                <li key={item} className="flex gap-2">
                  <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-signal/70" />
                  {item}
                </li>
              ))}
            </ul>
            <p className="mt-3 border-t border-ink-800 pt-3 text-[11px] leading-relaxed text-fog-500">
              Not stored: message bodies, reply text, phone numbers, contact photos, or
              any request-level payload. The database schema itself omits a body
              column, which is tested in CI.
            </p>
          </Panel>
        </div>
      </div>

      <ConfirmDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={() => deleteMutation.mutate()}
        title="Delete all activity?"
        description="Every metadata event will be permanently removed. This cannot be undone, and there is no backup. Devices, enrollment codes, and settings survive."
        confirmLabel="Delete events"
        loading={deleteMutation.isPending}
      />

      <ConfirmDialog
        open={revokeOpen}
        onClose={() => setRevokeOpen(false)}
        onConfirm={() => revokeMutation.mutate()}
        title="Revoke every device?"
        description="All enrolled phones lose access immediately. You will need to issue a new enrollment code and pair again."
        confirmLabel="Revoke all"
        loading={revokeMutation.isPending}
      />
    </div>
  );
}
