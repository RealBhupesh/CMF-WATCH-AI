import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { QRCodeSVG } from 'qrcode.react';
import {
  AlertTriangle,
  BatteryFull,
  Bluetooth,
  KeyRound,
  Plus,
  QrCode,
  RefreshCw,
  ShieldOff,
  Smartphone,
  Timer,
  Trash2,
  Watch,
} from 'lucide-react';

import { ConfirmDialog, Modal } from '../components/Modal';
import {
  Badge,
  Button,
  CopyButton,
  EmptyState,
  InlineNote,
  PageHeader,
  Panel,
  SectionLabel,
  StatusDot,
} from '../components/ui';
import { useToast } from '../components/Toast';
import {
  api,
  errorMessage,
  type DeviceRecord,
  type EnrollmentCode,
} from '../lib/api';
import {
  formatBattery,
  formatCountdown,
  formatDateTime,
  formatRelative,
} from '../lib/format';

function batteryTone(battery: number | null): string {
  if (battery === null) return 'text-fog-600';
  if (battery <= 20) return 'text-rose';
  if (battery <= 45) return 'text-amber';
  return 'text-mint';
}

function DeviceCard({
  device,
  onRevoke,
  busy,
}: {
  device: DeviceRecord;
  onRevoke: (device: DeviceRecord) => void;
  busy: boolean;
}) {
  const revoked = Boolean(device.revoked_at);
  const status = revoked ? 'revoked' : device.online ? 'online' : 'offline';

  return (
    <Panel className="p-4">
      <div className="flex items-start gap-3">
        <div
          className={clsx(
            'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border',
            revoked
              ? 'border-ink-700 bg-ink-850 text-fog-600'
              : 'border-ink-700 bg-ink-850 text-signal',
          )}
        >
          <Smartphone className="h-4 w-4" aria-hidden="true" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h2 className="truncate text-sm font-medium text-fog-100">
              {device.name}
            </h2>
            {revoked ? (
              <Badge tone="rose">revoked</Badge>
            ) : device.online ? (
              <Badge tone="mint" dot>
                online
              </Badge>
            ) : (
              <Badge tone="fog">offline</Badge>
            )}
          </div>
          <p className="mt-0.5 truncate font-mono text-[10px] text-fog-600">
            {device.id}
          </p>
        </div>

        {!revoked ? (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onRevoke(device)}
            disabled={busy}
            aria-label={`Revoke ${device.name}`}
            title="Revoke device"
            className="text-fog-500 hover:text-rose"
          >
            <ShieldOff className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        ) : null}
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-3 gap-y-2.5 border-t border-ink-700/60 pt-3">
        <div className="min-w-0">
          <dt className="micro">Platform</dt>
          <dd className="mt-1 truncate font-mono text-[11px] text-fog-300">
            {device.platform || 'unknown'}
            {device.app_version ? ` · v${device.app_version}` : ''}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="micro">Last seen</dt>
          <dd className="mt-1 truncate text-[11px] text-fog-300">
            {revoked ? formatDateTime(device.revoked_at) : formatRelative(device.last_seen_at)}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="micro">Watch</dt>
          <dd className="mt-1 flex items-center gap-1.5 truncate text-[11px] text-fog-300">
            <Watch className="h-3 w-3 shrink-0 text-fog-500" aria-hidden="true" />
            <span className="truncate">{device.watch_name || 'Not reported'}</span>
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="micro">Firmware</dt>
          <dd className="mt-1 truncate font-mono text-[11px] text-fog-300">
            {device.watch_firmware || '—'}
          </dd>
        </div>
        <div>
          <dt className="micro">Battery</dt>
          <dd
            className={clsx(
              'mt-1 flex items-center gap-1.5 font-mono text-[11px]',
              batteryTone(device.battery),
            )}
          >
            <BatteryFull className="h-3 w-3" aria-hidden="true" />
            {formatBattery(device.battery)}
          </dd>
        </div>
        <div>
          <dt className="micro">Enrolled</dt>
          <dd className="mt-1 truncate text-[11px] text-fog-300">
            {formatRelative(device.created_at)}
          </dd>
        </div>
      </dl>

      {device.battery !== null && !revoked ? (
        <div className="mt-3 h-1 overflow-hidden rounded-full bg-ink-800">
          <div
            className={clsx(
              'h-full rounded-full',
              device.battery <= 20
                ? 'bg-rose'
                : device.battery <= 45
                  ? 'bg-amber'
                  : 'bg-mint',
            )}
            style={{ width: `${Math.min(100, Math.max(0, device.battery))}%` }}
          />
        </div>
      ) : null}
    </Panel>
  );
}

export function DevicesPage() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [enrollment, setEnrollment] = useState<EnrollmentCode | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<DeviceRecord | null>(null);
  const [revokeAllOpen, setRevokeAllOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const devicesQuery = useQuery({
    queryKey: ['devices'],
    queryFn: api.devices,
    refetchInterval: 30_000,
  });
  const overviewQuery = useQuery({
    queryKey: ['overview'],
    queryFn: api.overview,
    staleTime: 30_000,
  });

  useEffect(() => {
    if (!modalOpen) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [modalOpen]);

  const enrollmentMutation = useMutation({
    mutationFn: api.enrollmentCode,
    onSuccess: (code) => {
      setEnrollment(code);
      setModalOpen(true);
      setNow(Date.now());
    },
    onError: (error) => {
      toast.push({
        title: 'Could not create a code',
        description: errorMessage(error),
        variant: 'error',
      });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => api.revokeDevice(id),
    onSuccess: () => {
      toast.push({ title: 'Device revoked', variant: 'success' });
      setRevokeTarget(null);
      void queryClient.invalidateQueries({ queryKey: ['devices'] });
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
    },
    onError: (error) => {
      toast.push({
        title: 'Revoke failed',
        description: errorMessage(error),
        variant: 'error',
      });
    },
  });

  const revokeAllMutation = useMutation({
    mutationFn: api.revokeAllDevices,
    onSuccess: (result) => {
      toast.push({
        title: `${result.revoked} device${result.revoked === 1 ? '' : 's'} revoked`,
        description: 'Existing bearer tokens stop working immediately.',
        variant: 'success',
      });
      setRevokeAllOpen(false);
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

  const devices = devicesQuery.data?.devices ?? [];
  const active = devices.filter((device) => !device.revoked_at);
  const revoked = devices.filter((device) => device.revoked_at);
  const online = active.filter((device) => device.online).length;

  const expiresAt = enrollment ? Date.parse(enrollment.expires_at) : 0;
  const remaining = expiresAt - now;
  const expired = Boolean(enrollment) && remaining <= 0;
  const apiOrigin =
    overviewQuery.data?.api_origin ||
    (typeof window !== 'undefined' ? window.location.origin : '');
  const qrValue = enrollment
    ? `watchai://enroll?code=${encodeURIComponent(enrollment.code)}&api=${encodeURIComponent(apiOrigin)}`
    : '';

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Bridge"
        title="Devices"
        description="Phones hold the only reliable watch connection. Enroll the Android companion once, and it can fetch replies and report metadata-only outcomes."
        actions={
          <>
            {active.length > 0 ? (
              <Button
                variant="danger"
                size="sm"
                icon={Trash2}
                onClick={() => setRevokeAllOpen(true)}
              >
                Revoke all
              </Button>
            ) : null}
            <Button
              variant="primary"
              size="sm"
              icon={Plus}
              loading={enrollmentMutation.isPending}
              onClick={() => enrollmentMutation.mutate()}
            >
              New enrollment code
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={RefreshCw}
              loading={devicesQuery.isFetching}
              onClick={() => void devicesQuery.refetch()}
              aria-label="Refresh devices"
            />
          </>
        }
      />

      <Panel className="grid grid-cols-1 divide-y divide-ink-700/70 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        {[
          {
            label: 'Active devices',
            value: active.length,
            detail: `${devices.length} total records`,
            tone: 'text-fog-100',
          },
          {
            label: 'Online now',
            value: online,
            detail: 'heartbeat within 5 minutes',
            tone: online > 0 ? 'text-mint' : 'text-fog-400',
          },
          {
            label: 'Revoked',
            value: revoked.length,
            detail: 'tokens fail closed',
            tone: 'text-fog-400',
          },
        ].map((item) => (
          <div key={item.label} className="px-4 py-3.5">
            <p className="micro">{item.label}</p>
            <p
              className={clsx(
                'mt-1.5 font-mono text-2xl leading-none tabular-nums',
                item.tone,
              )}
            >
              {item.value}
            </p>
            <p className="mt-1.5 text-[10px] text-fog-500">{item.detail}</p>
          </div>
        ))}
      </Panel>

      <div className="grid items-start gap-4 xl:grid-cols-3">
        <Panel className="p-5 xl:col-span-1">
          <SectionLabel>Pair a phone</SectionLabel>
          <ol className="mt-4 space-y-3">
            {[
              {
                n: '01',
                title: 'Generate a one-time code',
                detail: 'Ten characters, valid for ten minutes, hashed at rest.',
              },
              {
                n: '02',
                title: 'Open the Android companion',
                detail: 'Install the APK on the phone that owns the watch.',
              },
              {
                n: '03',
                title: 'Scan the QR or type the code',
                detail: 'The app stores a device token; the token is never shown again.',
              },
            ].map((step) => (
              <li key={step.n} className="flex gap-3">
                <span className="mt-0.5 font-mono text-[10px] text-signal">
                  {step.n}
                </span>
                <div>
                  <p className="text-[13px] text-fog-200">{step.title}</p>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-fog-500">
                    {step.detail}
                  </p>
                </div>
              </li>
            ))}
          </ol>
          <InlineNote tone="amber" icon={AlertTriangle} className="mt-4">
            The Android companion is a later phase. Automatic watch replies stay
            gated on M0 (Capture 01) proving the watch exposes a reply action.
          </InlineNote>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="sm"
              icon={KeyRound}
              onClick={() => enrollmentMutation.mutate()}
              loading={enrollmentMutation.isPending}
            >
              Create code
            </Button>
            <Link
              to="/lab"
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-transparent px-2.5 text-xs font-medium text-fog-400 transition-colors hover:bg-ink-800 hover:text-fog-100"
            >
              <Bluetooth className="h-3.5 w-3.5" aria-hidden="true" />
              Mac Device Lab
            </Link>
          </div>
        </Panel>

        <div className="space-y-3 xl:col-span-2">
          {devicesQuery.isError ? (
            <Panel className="p-5">
              <InlineNote tone="rose" icon={AlertTriangle}>
                {errorMessage(devicesQuery.error)}
              </InlineNote>
              <Button
                className="mt-3"
                variant="secondary"
                size="sm"
                icon={RefreshCw}
                onClick={() => void devicesQuery.refetch()}
              >
                Retry
              </Button>
            </Panel>
          ) : devicesQuery.isPending ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {Array.from({ length: 2 }, (_, index) => (
                <div
                  key={index}
                  className="h-[190px] animate-pulse rounded-xl border border-ink-800 bg-ink-900/60"
                />
              ))}
            </div>
          ) : devices.length === 0 ? (
            <Panel className="p-5">
              <EmptyState
                icon={Watch}
                title="No devices enrolled"
                description="This is expected until the Android companion ships. Generate a code now to see the flow, or use the Mac Device Lab to talk to the watch directly over Bluetooth."
                action={
                  <>
                    <Button
                      variant="primary"
                      size="sm"
                      icon={QrCode}
                      onClick={() => enrollmentMutation.mutate()}
                      loading={enrollmentMutation.isPending}
                    >
                      Generate code
                    </Button>
                    <Link
                      to="/lab"
                      className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-ink-600 bg-ink-800/70 px-2.5 text-xs font-medium text-fog-200 transition-colors hover:border-ink-500 hover:bg-ink-800"
                    >
                      <Bluetooth className="h-3.5 w-3.5" aria-hidden="true" />
                      Open Device Lab
                    </Link>
                  </>
                }
              />
            </Panel>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {active.map((device) => (
                <DeviceCard
                  key={device.id}
                  device={device}
                  onRevoke={setRevokeTarget}
                  busy={revokeMutation.isPending}
                />
              ))}
            </div>
          )}

          {revoked.length > 0 ? (
            <Panel className="p-4">
              <SectionLabel trailing={`${revoked.length} records`}>
                Revoked devices
              </SectionLabel>
              <ul className="mt-2 divide-y divide-ink-800/70">
                {revoked.map((device) => (
                  <li
                    key={device.id}
                    className="flex items-center gap-3 py-2.5 text-[11px]"
                  >
                    <ShieldOff className="h-3.5 w-3.5 shrink-0 text-fog-600" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate text-fog-400">
                      {device.name}
                    </span>
                    <span className="font-mono text-[10px] text-fog-600">
                      {formatRelative(device.revoked_at)}
                    </span>
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}
        </div>
      </div>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="Enrollment code"
        eyebrow="One-time pairing"
        width="max-w-md"
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => setModalOpen(false)}
            >
              Close
            </Button>
            <Button
              variant="secondary"
              icon={RefreshCw}
              loading={enrollmentMutation.isPending}
              onClick={() => enrollmentMutation.mutate()}
            >
              Generate another
            </Button>
          </>
        }
      >
        {enrollment ? (
          <div className="space-y-5">
            <div className="text-center">
              <div className="flex items-center justify-center gap-2">
                <StatusDot tone={expired ? 'rose' : 'amber'} pulse={!expired} />
                <p className="micro">
                  {expired ? 'Code expired' : 'Expires in'}{' '}
                  {!expired ? (
                    <span className="text-amber tabular-nums">
                      {formatCountdown(remaining)}
                    </span>
                  ) : null}
                </p>
              </div>
              <div className="mt-3 flex items-center justify-center gap-2">
                <p
                  className={clsx(
                    'font-mono text-[26px] font-medium tracking-[0.18em]',
                    expired ? 'text-fog-600 line-through' : 'text-fog-100',
                  )}
                >
                  {enrollment.code.slice(0, 5)} {enrollment.code.slice(5)}
                </p>
                <CopyButton text={enrollment.code} label="Copy" size="sm" />
              </div>
            </div>

            <div className="flex justify-center">
              <div className="rounded-xl border border-ink-600 bg-fog-100 p-3">
                <QRCodeSVG
                  value={qrValue}
                  size={188}
                  level="M"
                  bgColor="#F2F4F6"
                  fgColor="#08090B"
                  marginSize={0}
                />
              </div>
            </div>

            <div className="rounded-lg border border-ink-700/80 bg-ink-950/40 p-3">
              <p className="micro">API origin</p>
              <div className="mt-1.5 flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate text-[11px] text-fog-300">
                  {apiOrigin}
                </code>
                <CopyButton text={apiOrigin} size="sm" />
              </div>
            </div>

            <ol className="space-y-2 text-[11px] leading-relaxed text-fog-400">
              <li className="flex gap-2">
                <span className="font-mono text-[10px] text-signal">01</span>
                Scan the QR in the Android companion, or type the ten-character code.
              </li>
              <li className="flex gap-2">
                <span className="font-mono text-[10px] text-signal">02</span>
                The app exchanges the code for a bearer token exactly once.
              </li>
              <li className="flex gap-2">
                <span className="font-mono text-[10px] text-signal">03</span>
                Codes expire after ten minutes and cannot be reused.
              </li>
            </ol>

            <InlineNote tone="fog" icon={Timer}>
              The code is stored as a SHA-256 hash. This dialog is the only time the
              plaintext code is available.
            </InlineNote>
          </div>
        ) : (
          <div className="py-10 text-center">
            <Timer className="mx-auto h-5 w-5 animate-pulse text-fog-500" />
            <p className="mt-3 text-sm text-fog-400">Generating a code…</p>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={Boolean(revokeTarget)}
        onClose={() => setRevokeTarget(null)}
        onConfirm={() => {
          if (revokeTarget) revokeMutation.mutate(revokeTarget.id);
        }}
        title="Revoke this device?"
        description={
          <>
            <span className="font-medium text-fog-100">{revokeTarget?.name}</span>{' '}
            will stop working immediately. Its bearer token is rejected on the next
            request, and the phone must enroll again with a fresh code.
          </>
        }
        confirmLabel="Revoke device"
        loading={revokeMutation.isPending}
      />

      <ConfirmDialog
        open={revokeAllOpen}
        onClose={() => setRevokeAllOpen(false)}
        onConfirm={() => revokeAllMutation.mutate()}
        title="Revoke every device?"
        description={`${active.length} active device${active.length === 1 ? '' : 's'} will lose access immediately. Enrollment codes already issued stay valid until they expire.`}
        confirmLabel="Revoke all"
        loading={revokeAllMutation.isPending}
      />
    </div>
  );
}
