import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import {
  ArrowDownRight,
  ArrowUpRight,
  CornerDownLeft,
  FlaskConical,
  Lock,
  Minus,
  Send,
  Sparkles,
  Wand2,
} from 'lucide-react';

import {
  Badge,
  Button,
  CopyButton,
  EmptyState,
  Field,
  InlineNote,
  Input,
  PageHeader,
  Panel,
  SectionLabel,
  Select,
  Textarea,
} from '../components/ui';
import { useToast } from '../components/Toast';
import { APP_OPTIONS } from '../lib/apps';
import { api, errorMessage, type Intent, type PlaygroundResponse, type ToneSetting } from '../lib/api';
import { useLabHandoff } from '../state/LabHandoff';

const TONE_OPTIONS: Array<{ value: ToneSetting; label: string }> = [
  { value: 'auto', label: 'Auto — infer from app + language' },
  { value: 'casual_hinglish', label: 'Casual Hinglish' },
  { value: 'casual_english', label: 'Casual English' },
  { value: 'professional', label: 'Professional' },
];

const INTENT_META: Record<
  Intent,
  { label: string; hint: string; icon: typeof ArrowUpRight; className: string; chip: string }
> = {
  positive: {
    label: 'Positive',
    hint: 'Lean in',
    icon: ArrowUpRight,
    className: 'border-mint/20 bg-mint/[0.04]',
    chip: 'border-mint/25 bg-mint/10 text-mint',
  },
  neutral: {
    label: 'Neutral',
    hint: 'Hold the line',
    icon: Minus,
    className: 'border-sky-400/20 bg-sky-400/[0.04]',
    chip: 'border-sky-400/25 bg-sky-400/10 text-sky-300',
  },
  decline: {
    label: 'Decline',
    hint: 'Say no cleanly',
    icon: ArrowDownRight,
    className: 'border-rose/20 bg-rose/[0.04]',
    chip: 'border-rose/25 bg-rose/10 text-rose',
  },
};

const QUICK_EXAMPLES = [
  {
    label: 'Hinglish',
    sender: 'Rahul',
    app: 'com.whatsapp',
    body: 'kal office aa rahe ho? team lunch plan kar rahe hai',
    history: '',
  },
  {
    label: 'Work',
    sender: 'Priya Menon',
    app: 'com.microsoft.teams',
    body: 'Can you review the launch deck before tomorrow’s client call?',
    history: 'Priya Menon: The narrative needs one more pass.',
  },
  {
    label: 'Quick yes',
    sender: 'Mom',
    app: 'com.android.mms',
    body: 'Reached home? Call me when you get a minute.',
    history: '',
  },
];

export function PlaygroundPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { setHandoff } = useLabHandoff();

  const [sender, setSender] = useState('');
  const [app, setApp] = useState('com.whatsapp');
  const [customApp, setCustomApp] = useState('');
  const [body, setBody] = useState('');
  const [history, setHistory] = useState('');
  const [tone, setTone] = useState<ToneSetting>('auto');
  const [formError, setFormError] = useState<string | null>(null);

  const mutation = useMutation<PlaygroundResponse, unknown, void>({
    mutationFn: () =>
      api.playground({
        sender: sender.trim() || undefined,
        body: body.trim(),
        app: app === 'custom' ? customApp.trim() : app,
        history: history
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .slice(-10),
        tone,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
    },
    onError: (error) => {
      toast.push({
        title: 'Generation failed',
        description: errorMessage(error),
        variant: 'error',
      });
    },
  });

  const result = mutation.data ?? null;
  const historyLines = useMemo(
    () => history.split('\n').filter((line) => line.trim().length > 0).length,
    [history],
  );

  function submit() {
    if (!body.trim()) {
      setFormError('Write the message you want to reply to.');
      return;
    }
    if (app === 'custom' && !customApp.trim()) {
      setFormError('Enter the Android package name for the custom app.');
      return;
    }
    setFormError(null);
    mutation.mutate();
  }

  function loadExample(example: (typeof QUICK_EXAMPLES)[number]) {
    setSender(example.sender);
    setApp(example.app);
    setCustomApp('');
    setBody(example.body);
    setHistory(example.history);
    setTone('auto');
    setFormError(null);
    mutation.reset();
  }

  function sendToLab(intent: Intent, text: string) {
    if (!result) return;
    setHandoff({
      replies: result.replies,
      sender: sender.trim() || 'Unknown',
      app: app === 'custom' ? customApp.trim() : app,
      tone: result.tone,
      from_ai: result.from_ai,
      selectedIntent: intent,
      at: Date.now(),
    });
    toast.push({
      title: `“${text}” ready in the Device Lab`,
      description: 'Connect the watch and write it through a saved recipe.',
      variant: 'info',
    });
    navigate('/lab');
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Engine"
        title="AI Playground"
        description="Call the exact TypeScript engine the phone uses. Three replies, tone inference, honest fallback badges — and nothing stored but metadata."
        actions={
          <>
            <Button
              variant="ghost"
              size="sm"
              icon={FlaskConical}
              onClick={() => loadExample(QUICK_EXAMPLES[0])}
            >
              Load example
            </Button>
            <Badge tone="signal" dot>
              in-memory only
            </Badge>
          </>
        }
      />

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
        <Panel className="min-w-0 p-5">
          <SectionLabel trailing={<span className="normal-case">⌘ + Enter</span>}>
            Compose
          </SectionLabel>

          <div className="mt-4 space-y-4">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
              <Field label="Sender alias" htmlFor="pg-sender">
                <Input
                  id="pg-sender"
                  value={sender}
                  onChange={(event) => setSender(event.target.value)}
                  placeholder="Rahul"
                  maxLength={80}
                  autoComplete="off"
                />
              </Field>

              <Field label="Source app" htmlFor="pg-app">
                <Select
                  id="pg-app"
                  value={app}
                  onChange={(event) => setApp(event.target.value)}
                >
                  {APP_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            {app === 'custom' ? (
              <Field
                label="Android package"
                htmlFor="pg-custom-app"
                hint="Used for tone inference. Example: com.discord"
              >
                <Input
                  id="pg-custom-app"
                  value={customApp}
                  onChange={(event) => setCustomApp(event.target.value)}
                  placeholder="com.discord"
                  maxLength={100}
                  autoComplete="off"
                />
              </Field>
            ) : null}

            <Field
              label="Incoming message"
              htmlFor="pg-body"
              hint="Never logged, never written to D1, never echoed in errors."
              trailing={
                <span className="font-mono text-[10px] text-fog-600 tabular-nums">
                  {body.length}/6000
                </span>
              }
            >
              <Textarea
                id="pg-body"
                value={body}
                onChange={(event) => setBody(event.target.value)}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                    event.preventDefault();
                    submit();
                  }
                }}
                rows={6}
                maxLength={6000}
                placeholder="kal office aa rahe ho? team lunch plan kar rahe hai"
                className="font-sans text-[13px]"
              />
            </Field>

            <Field
              label="Conversation history · optional"
              htmlFor="pg-history"
              hint="One prior line per row. The engine reads the last ten."
              trailing={
                <span className="font-mono text-[10px] text-fog-600 tabular-nums">
                  {historyLines}/10
                </span>
              }
            >
              <Textarea
                id="pg-history"
                value={history}
                onChange={(event) => setHistory(event.target.value)}
                rows={3}
                placeholder={'Rahul: bhai kal ka meeting confirm hai?\nYou: haan, 10 baje'}
                className="font-mono text-[11px]"
              />
            </Field>

            <Field label="Tone override" htmlFor="pg-tone">
              <Select
                id="pg-tone"
                value={tone}
                onChange={(event) => setTone(event.target.value as ToneSetting)}
              >
                {TONE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </Field>

            {formError ? (
              <InlineNote tone="rose" icon={Wand2}>
                {formError}
              </InlineNote>
            ) : null}

            {mutation.isError ? (
              <InlineNote tone="rose" icon={Wand2}>
                {errorMessage(mutation.error)}
              </InlineNote>
            ) : null}

            <InlineNote tone="fog" icon={Lock}>
              The message is processed in memory and sent only to Groq for this
              request. Activity keeps the app, sender alias, latency, and outcome.
            </InlineNote>

            <Button
              variant="primary"
              size="lg"
              className="w-full"
              loading={mutation.isPending}
              icon={Sparkles}
              onClick={submit}
            >
              {mutation.isPending ? 'Generating…' : 'Generate three replies'}
            </Button>
            <p className="flex items-center justify-center gap-1 text-center font-mono text-[10px] text-fog-600">
              <CornerDownLeft className="h-3 w-3" aria-hidden="true" />
              1200 ms Groq timeout · static fallback on any failure
            </p>
          </div>
        </Panel>

        <div className="min-w-0 space-y-4">
          {!result ? (
            <Panel className="p-5">
              <EmptyState
                icon={Sparkles}
                title={mutation.isPending ? 'Thinking in three directions…' : 'No reply set yet'}
                description={
                  mutation.isPending
                    ? 'The engine is asking Groq for a JSON reply set, then sanitising every line for the watch display.'
                    : 'Compose a message or load one of these, then generate. You will get a positive, neutral, and decline option capped for the watch.'
                }
                className="border-0 bg-transparent px-2 py-6"
              >
                <div className="mt-6 grid w-full gap-2 sm:grid-cols-3">
                  {QUICK_EXAMPLES.map((example) => (
                    <button
                      key={example.label}
                      type="button"
                      onClick={() => loadExample(example)}
                      className="min-w-0 rounded-lg border border-ink-700 bg-ink-850/60 px-3 py-2.5 text-left transition-colors hover:border-ink-600 hover:bg-ink-800/70"
                    >
                      <span className="micro text-signal/80">{example.label}</span>
                      <span className="mt-1.5 block truncate text-[12px] text-fog-300">
                        {example.body}
                      </span>
                    </button>
                  ))}
                </div>
              </EmptyState>
            </Panel>
          ) : (
            <>
              <Panel className="p-5">
                <div className="flex flex-wrap items-center gap-2">
                  <SectionLabel className="min-w-0 flex-1">Reply set</SectionLabel>
                  <Badge tone="signal">{result.tone.replaceAll('_', ' ')}</Badge>
                  {result.from_ai ? (
                    <Badge tone="mint" dot>
                      AI · Groq
                    </Badge>
                  ) : (
                    <Badge tone="amber">static fallback</Badge>
                  )}
                  <Badge tone="fog">{result.latency_ms} ms</Badge>
                </div>

                {result.fallback_reason ? (
                  <InlineNote tone="amber" icon={Wand2} className="mt-3">
                    Groq did not answer cleanly ({result.fallback_reason}). You are
                    looking at the deterministic fallback set — honest, not AI.
                  </InlineNote>
                ) : null}

                <div className="mt-4 space-y-2.5">
                  {result.replies.map((reply) => {
                    const meta = INTENT_META[reply.intent];
                    const Icon = meta.icon;
                    return (
                      <div
                        key={reply.intent}
                        className={clsx(
                          'group rounded-xl border p-3.5 transition-colors',
                          meta.className,
                        )}
                      >
                        <div className="flex items-center gap-2">
                          <span
                            className={clsx(
                              'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[9px] font-medium tracking-[0.1em] uppercase',
                              meta.chip,
                            )}
                          >
                            <Icon className="h-2.5 w-2.5" aria-hidden="true" />
                            {meta.label}
                          </span>
                          <span className="text-[10px] text-fog-600">{meta.hint}</span>
                          <span className="ml-auto font-mono text-[10px] text-fog-600 tabular-nums">
                            {reply.text.length}/40
                          </span>
                        </div>

                        <p className="mt-2.5 font-display text-[17px] leading-snug font-medium text-fog-100">
                          {reply.text}
                        </p>

                        <div className="mt-2 flex items-center justify-end gap-1.5">
                          <CopyButton
                            text={reply.text}
                            label="Copy"
                            variant="ghost"
                            size="sm"
                          />
                          <Button
                            variant="secondary"
                            size="sm"
                            icon={Send}
                            onClick={() => sendToLab(reply.intent, reply.text)}
                          >
                            Send to Device Lab
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-ink-700/70 pt-3">
                  <p className="font-mono text-[10px] text-fog-600">
                    event {result.event_id.slice(0, 8)} · logged without body
                  </p>
                  <div className="flex items-center gap-1.5">
                    <CopyButton
                      text={result.replies
                        .map((reply) => `${reply.intent}: ${reply.text}`)
                        .join('\n')}
                      label="Copy all"
                      size="sm"
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={Sparkles}
                      onClick={submit}
                      loading={mutation.isPending}
                    >
                      Regenerate
                    </Button>
                  </div>
                </div>
              </Panel>

              <div className="grid gap-3 sm:grid-cols-3">
                {[
                  {
                    label: 'What the phone gets',
                    value: 'application/json',
                    detail: 'Replies + tone + from_ai + latency',
                  },
                  {
                    label: 'Watch constraint',
                    value: '40 ASCII chars',
                    detail: 'Sanitised, deduped, word-boundary cut',
                  },
                  {
                    label: 'Storage',
                    value: 'metadata only',
                    detail: 'No body column exists in D1',
                  },
                ].map((item) => (
                  <Panel key={item.label} className="p-3.5">
                    <p className="micro">{item.label}</p>
                    <p className="mt-1.5 font-mono text-[12px] text-fog-200">
                      {item.value}
                    </p>
                    <p className="mt-1 text-[10px] leading-relaxed text-fog-500">
                      {item.detail}
                    </p>
                  </Panel>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
