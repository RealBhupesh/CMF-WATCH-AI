import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clsx } from 'clsx';
import {
  AlertTriangle,
  Bell,
  Bluetooth,
  BluetoothConnected,
  BluetoothSearching,
  Bookmark,
  ChevronRight,
  Download,
  Eye,
  FlaskConical,
  Info,
  ListTree,
  PenLine,
  PlugZap,
  Save,
  Send,
  Terminal,
  Trash2,
  Unplug,
  X,
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
  StatusDot,
  Textarea,
} from '../components/ui';
import { useToast } from '../components/Toast';
import {
  bluetoothAvailable,
  bytesToHex,
  bytesToText,
  characteristicLabel,
  connectDevice,
  encodePayload,
  enumerateServices,
  findCharacteristic,
  formatBleError,
  loadRecipes,
  readCharacteristic,
  requestDevice,
  saveRecipes,
  serviceLabel,
  shortUuid,
  writeCharacteristic,
  type BleDirection,
  type BleLogEntry,
  type BleRecipe,
  type GattServiceInfo,
  type WriteMode,
} from '../lib/ble';
import { useLabHandoff } from '../state/LabHandoff';
import { formatRelative } from '../lib/format';
import type { Intent } from '../lib/api';

const BATTERY_SERVICE = '0000180f-0000-1000-8000-00805f9b34fb';
const BATTERY_LEVEL = '00002a19-0000-1000-8000-00805f9b34fb';

const DIRECTION_STYLES: Record<
  BleDirection,
  { label: string; className: string }
> = {
  system: {
    label: 'SYS',
    className: 'border-ink-600 bg-ink-800 text-fog-400',
  },
  tx: {
    label: 'TX',
    className: 'border-signal/30 bg-signal/10 text-signal',
  },
  rx: {
    label: 'RX',
    className: 'border-mint/30 bg-mint/10 text-mint',
  },
  error: {
    label: 'ERR',
    className: 'border-rose/30 bg-rose/10 text-rose',
  },
};

function timestamp(at: number): string {
  return new Date(at).toISOString().slice(11, 23);
}

function printable(bytes: Uint8Array): string {
  return bytesToText(bytes).replace(/[^\x20-\x7E]/g, '·');
}

function logLine(entry: BleLogEntry): string {
  const parts = [
    new Date(entry.at).toISOString(),
    entry.direction.toUpperCase(),
    entry.label,
  ];
  if (entry.hex) parts.push(`hex=${entry.hex}`);
  if (entry.text) parts.push(`text=${JSON.stringify(entry.text)}`);
  return parts.join(' ');
}

export function LabPage() {
  const toast = useToast();
  const { handoff, setHandoff } = useLabHandoff();

  const available = useMemo(() => bluetoothAvailable(), []);
  const [device, setDevice] = useState<BluetoothDevice | null>(null);
  const [services, setServices] = useState<GattServiceInfo[]>([]);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [acceptAll, setAcceptAll] = useState(true);
  const [namePrefix, setNamePrefix] = useState('CMF');
  const [serviceFilter, setServiceFilter] = useState('180f, 180a');

  const [log, setLog] = useState<BleLogEntry[]>([]);
  const logRef = useRef<HTMLDivElement>(null);

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [encoding, setEncoding] = useState<'utf8' | 'hex'>('utf8');
  const [value, setValue] = useState('');
  const [prefixHex, setPrefixHex] = useState('');
  const [suffixHex, setSuffixHex] = useState('');
  const [writeMode, setWriteMode] = useState<WriteMode>('auto');

  const [notifying, setNotifying] = useState<string[]>([]);
  const notifyHandlers = useRef(
    new Map<
      string,
      { char: BluetoothRemoteGATTCharacteristic; handler: (event: Event) => void }
    >(),
  );

  const [recipes, setRecipes] = useState<BleRecipe[]>(() => loadRecipes());
  const [recipeFormOpen, setRecipeFormOpen] = useState(false);
  const [recipeName, setRecipeName] = useState('');
  const [handoffRecipeId, setHandoffRecipeId] = useState('');
  const [labIntent, setLabIntent] = useState<Intent>('positive');

  const addLog = useCallback(
    (direction: BleDirection, label: string, detail?: { hex?: string; text?: string }) => {
      setLog((current) =>
        [
          ...current.slice(-499),
          {
            id: crypto.randomUUID(),
            at: Date.now(),
            direction,
            label,
            ...detail,
          },
        ].slice(-500),
      );
    },
    [],
  );

  const stopAllNotifications = useCallback(() => {
    for (const { char, handler } of notifyHandlers.current.values()) {
      char.removeEventListener('characteristicvaluechanged', handler);
      void char.stopNotifications().catch(() => undefined);
    }
    notifyHandlers.current.clear();
    setNotifying([]);
  }, []);

  useEffect(() => {
    const current = logRef.current;
    if (current) current.scrollTop = current.scrollHeight;
  }, [log.length]);

  useEffect(
    () => () => {
      for (const { char, handler } of notifyHandlers.current.values()) {
        char.removeEventListener('characteristicvaluechanged', handler);
        void char.stopNotifications().catch(() => undefined);
      }
    },
    [],
  );

  useEffect(() => {
    if (!device) return;
    const onDisconnect = () => {
      setConnected(false);
      setServices([]);
      stopAllNotifications();
      addLog('system', 'Watch disconnected');
    };
    device.addEventListener('gattserverdisconnected', onDisconnect);
    return () => device.removeEventListener('gattserverdisconnected', onDisconnect);
  }, [device, stopAllNotifications, addLog]);

  useEffect(() => {
    if (handoff) setLabIntent(handoff.selectedIntent ?? 'positive');
  }, [handoff]);

  useEffect(() => {
    if (recipes.length === 0) return;
    if (!recipes.some((recipe) => recipe.id === handoffRecipeId)) {
      setHandoffRecipeId(recipes[0].id);
    }
  }, [recipes, handoffRecipeId]);

  const selected = useMemo(() => {
    if (!selectedKey) return null;
    const [serviceUuid, characteristicUuid] = selectedKey.split('|');
    const service = services.find((item) => item.uuid === serviceUuid);
    const characteristic = service?.characteristics.find(
      (item) => item.uuid === characteristicUuid,
    );
    if (!service || !characteristic) return null;
    return { service, characteristic };
  }, [selectedKey, services]);

  const payloadPreview = useMemo(() => {
    try {
      const bytes = encodePayload({ encoding, value, prefixHex, suffixHex });
      return { bytes, hex: bytesToHex(bytes), error: null as string | null };
    } catch (caught) {
      return { bytes: null, hex: '', error: formatBleError(caught) };
    }
  }, [encoding, value, prefixHex, suffixHex]);

  const handoffReply = useMemo(() => {
    if (!handoff) return null;
    return (
      handoff.replies.find((reply) => reply.intent === labIntent) ??
      handoff.replies[0] ??
      null
    );
  }, [handoff, labIntent]);

  const handoffRecipe =
    recipes.find((recipe) => recipe.id === handoffRecipeId) ?? recipes[0] ?? null;

  const characteristicCount = services.reduce(
    (sum, service) => sum + service.characteristics.length,
    0,
  );

  async function openDevice(next: BluetoothDevice) {
    setBusy('connect');
    setError(null);
    try {
      const server = await connectDevice(next);
      setConnected(server.connected);
      const tree = await enumerateServices(server);
      setServices(tree);
      addLog('system', `Connected to ${next.name ?? 'unnamed device'}`, {
        text: `${tree.length} services · ${tree.reduce(
          (sum, service) => sum + service.characteristics.length,
          0,
        )} characteristics`,
      });

      const battery = findCharacteristic(tree, BATTERY_SERVICE, BATTERY_LEVEL);
      if (battery) {
        try {
          const bytes = await readCharacteristic(battery);
          addLog('rx', 'Battery level', {
            hex: bytesToHex(bytes),
            text: `${bytes[0] ?? 0}%`,
          });
        } catch {
          // Battery service is often read-protected; ignore.
        }
      }
    } catch (caught) {
      setConnected(false);
      setServices([]);
      const message = formatBleError(caught);
      setError(message);
      addLog('error', 'Connect failed', { text: message });
    } finally {
      setBusy(null);
    }
  }

  async function scan() {
    if (!available) {
      setError('Web Bluetooth is unavailable in this browser.');
      return;
    }
    setBusy('scan');
    setError(null);
    addLog('system', 'Opening scan dialog', {
      text: acceptAll ? 'accept all devices' : `name starts with “${namePrefix}”`,
    });

    try {
      const next = await requestDevice({
        acceptAll,
        namePrefix,
        serviceUuids: serviceFilter
          .split(/[\s,]+/)
          .map((item) => item.trim())
          .filter(Boolean),
      });
      setDevice(next);
      addLog('system', `Selected ${next.name ?? next.id}`);
      await openDevice(next);
    } catch (caught) {
      const message = formatBleError(caught);
      setError(message);
      addLog('error', 'Scan cancelled', { text: message });
      setBusy(null);
    }
  }

  async function reconnect() {
    if (!device) return;
    await openDevice(device);
  }

  function disconnect() {
    stopAllNotifications();
    if (device?.gatt?.connected) device.gatt.disconnect();
    setConnected(false);
    setServices([]);
    addLog('system', 'Disconnected by user');
  }

  function forget() {
    disconnect();
    setDevice(null);
    setSelectedKey(null);
    addLog('system', 'Device forgotten');
  }

  function selectCharacteristic(service: GattServiceInfo, uuid: string) {
    setSelectedKey(`${service.uuid}|${uuid}`);
    setError(null);
  }

  async function readValue(char: BluetoothRemoteGATTCharacteristic) {
    setBusy('read');
    setError(null);
    try {
      const bytes = await readCharacteristic(char);
      addLog('rx', `Read · ${shortUuid(char.uuid)}`, {
        hex: bytesToHex(bytes),
        text: printable(bytes),
      });
    } catch (caught) {
      const message = formatBleError(caught);
      setError(message);
      addLog('error', 'Read failed', { text: message });
    } finally {
      setBusy(null);
    }
  }

  async function toggleNotify(char: BluetoothRemoteGATTCharacteristic) {
    const key = char.uuid;
    const existing = notifyHandlers.current.get(key);
    setError(null);

    if (existing) {
      existing.char.removeEventListener('characteristicvaluechanged', existing.handler);
      notifyHandlers.current.delete(key);
      setNotifying((current) => current.filter((item) => item !== key));
      try {
        await char.stopNotifications();
      } catch {
        // The watch may already be gone.
      }
      addLog('system', `Notifications off · ${shortUuid(char.uuid)}`);
      return;
    }

    try {
      await char.startNotifications();
      const handler = (event: Event) => {
        const target = event.target as BluetoothRemoteGATTCharacteristic;
        const view = target.value;
        if (!view) return;
        const bytes = new Uint8Array(
          view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength),
        );
        addLog('rx', `Notify · ${shortUuid(target.uuid)}`, {
          hex: bytesToHex(bytes),
          text: printable(bytes),
        });
      };
      char.addEventListener('characteristicvaluechanged', handler);
      notifyHandlers.current.set(key, { char, handler });
      setNotifying((current) => [...current, key]);
      addLog('system', `Notifications on · ${shortUuid(char.uuid)}`);
    } catch (caught) {
      const message = formatBleError(caught);
      setError(message);
      addLog('error', 'Notify failed', { text: message });
    }
  }

  async function writeFrame() {
    if (!selected) {
      setError('Select a characteristic in the GATT tree first.');
      return;
    }
    if (!payloadPreview.bytes) {
      setError(payloadPreview.error ?? 'The payload is invalid.');
      return;
    }
    setBusy('write');
    setError(null);
    try {
      await writeCharacteristic(
        selected.characteristic.char,
        payloadPreview.bytes,
        writeMode,
      );
      addLog('tx', `Write · ${shortUuid(selected.characteristic.uuid)}`, {
        hex: payloadPreview.hex,
        text: encoding === 'utf8' ? printable(payloadPreview.bytes) : undefined,
      });
      toast.push({
        title: `${payloadPreview.bytes.length} bytes written`,
        description: 'Raw frame only — the watch protocol is unverified until M0.',
        variant: 'success',
      });
    } catch (caught) {
      const message = formatBleError(caught);
      setError(message);
      addLog('error', 'Write failed', { text: message });
      toast.push({ title: 'Write failed', description: message, variant: 'error' });
    } finally {
      setBusy(null);
    }
  }

  function openRecipeForm() {
    if (!selected) {
      setError('Select a characteristic before saving a recipe.');
      return;
    }
    setRecipeFormOpen(true);
    setRecipeName(`${shortUuid(selected.characteristic.uuid)} frame`);
  }

  function saveRecipe() {
    if (!selected || !recipeName.trim()) {
      setError('Give the recipe a name.');
      return;
    }
    const recipe: BleRecipe = {
      id: crypto.randomUUID(),
      name: recipeName.trim(),
      serviceUuid: selected.service.uuid,
      characteristicUuid: selected.characteristic.uuid,
      encoding,
      prefixHex,
      suffixHex,
    };
    const next = [...recipes, recipe];
    setRecipes(next);
    saveRecipes(next);
    setRecipeFormOpen(false);
    setRecipeName('');
    setHandoffRecipeId(recipe.id);
    toast.push({
      title: 'Recipe saved',
      description: 'Stored in this browser only, under localStorage.',
      variant: 'success',
    });
  }

  function applyRecipe(recipe: BleRecipe) {
    setSelectedKey(`${recipe.serviceUuid}|${recipe.characteristicUuid}`);
    setEncoding(recipe.encoding);
    setPrefixHex(recipe.prefixHex);
    setSuffixHex(recipe.suffixHex);
    setError(null);
    toast.push({
      title: `Loaded “${recipe.name}”`,
      description: connected
        ? 'Characteristic selected in the current GATT tree.'
        : 'Connect the watch, then write when the service is available.',
      variant: 'info',
    });
  }

  function deleteRecipe(recipe: BleRecipe) {
    const next = recipes.filter((item) => item.id !== recipe.id);
    setRecipes(next);
    saveRecipes(next);
    toast.push({ title: `Deleted “${recipe.name}”`, variant: 'info' });
  }

  async function writeHandoffReply() {
    if (!handoff || !handoffReply || !handoffRecipe) return;
    const char = findCharacteristic(
      services,
      handoffRecipe.serviceUuid,
      handoffRecipe.characteristicUuid,
    );
    if (!char) {
      setError(
        'That recipe’s characteristic is not in the current GATT tree. Connect the watch and inspect its services first.',
      );
      return;
    }

    setBusy('write');
    setError(null);
    try {
      const bytes = encodePayload({
        encoding: handoffRecipe.encoding,
        value: handoffReply.text,
        prefixHex: handoffRecipe.prefixHex,
        suffixHex: handoffRecipe.suffixHex,
      });
      await writeCharacteristic(char, bytes, 'auto');
      addLog('tx', `Playground reply · ${handoffRecipe.name}`, {
        hex: bytesToHex(bytes),
        text: handoffReply.text,
      });
      toast.push({
        title: 'Reply frame written',
        description:
          'Protocol unverified: confirm the watch actually accepted it. M0 still gates automatic delivery.',
        variant: 'success',
      });
    } catch (caught) {
      const message = formatBleError(caught);
      setError(message);
      addLog('error', 'Reply write failed', { text: message });
      toast.push({ title: 'Write failed', description: message, variant: 'error' });
    } finally {
      setBusy(null);
    }
  }

  function exportLog() {
    if (log.length === 0) return;
    const payload = log.map(logLine).join('\n');
    const blob = new Blob([payload], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `watchai-ble-log-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  const canWrite = Boolean(
    selected &&
      (selected.characteristic.char.properties.write ||
        selected.characteristic.char.properties.writeWithoutResponse),
  );

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Mac lab"
        title="Device Lab"
        description="Talk to the CMF Watch Pro 2 directly from Chrome or Edge on macOS. Enumerate GATT, read characteristics, and write raw frames while the protocol is still unknown."
        actions={
          <>
            <Badge tone={available ? 'mint' : 'rose'} dot>
              {available ? 'Web Bluetooth ready' : 'Web Bluetooth unavailable'}
            </Badge>
            <Badge tone="amber">M0 pending</Badge>
          </>
        }
      />

      <div className="grid gap-2 lg:grid-cols-2">
        <InlineNote tone="amber" icon={AlertTriangle}>
          <span className="font-medium text-amber">Raw frames only.</span> Until M0
          (Capture 01) proves the watch exposes a reply action, this lab writes bytes
          with no knowledge of the vendor protocol. A write can be ignored or rejected
          safely; confirm on the watch itself.
        </InlineNote>
        <InlineNote tone="fog" icon={Bluetooth}>
          The watch holds a single companion connection. Turn off phone Bluetooth — or
          force-stop the CMF companion — before scanning, then re-enable it afterwards.
        </InlineNote>
      </div>

      {!available ? (
        <InlineNote tone="rose" icon={AlertTriangle}>
          This browser does not expose <code className="text-rose">navigator.bluetooth</code>.
          Use Chrome or Edge on macOS, served over HTTPS or localhost. Safari and Firefox
          are not supported.
        </InlineNote>
      ) : null}

      {handoff ? (
        <Panel className="relative overflow-hidden border-signal/25 p-5">
          <div className="absolute inset-y-0 left-0 w-0.5 bg-signal" aria-hidden="true" />
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="micro text-signal/90">From Playground</p>
              <h2 className="mt-1.5 font-display text-base font-semibold text-fog-100">
                {handoff.sender} · {handoff.app.split('.').at(-1)}
              </h2>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <Badge tone="signal">{handoff.tone.replaceAll('_', ' ')}</Badge>
                <Badge tone={handoff.from_ai ? 'mint' : 'amber'}>
                  {handoff.from_ai ? 'AI' : 'fallback'}
                </Badge>
                <span className="font-mono text-[10px] text-fog-600">
                  {formatRelative(new Date(handoff.at).toISOString())}
                </span>
              </div>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setHandoff(null)}
              aria-label="Clear playground handoff"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>

          <div className="mt-4 grid gap-2 sm:grid-cols-3">
            {handoff.replies.map((reply) => (
              <button
                key={reply.intent}
                type="button"
                onClick={() => setLabIntent(reply.intent)}
                className={clsx(
                  'rounded-lg border p-3 text-left transition-colors',
                  labIntent === reply.intent
                    ? 'border-signal/50 bg-signal/10'
                    : 'border-ink-700 bg-ink-950/40 hover:border-ink-600',
                )}
              >
                <span className="micro">{reply.intent}</span>
                <span className="mt-1.5 block text-[12px] leading-snug text-fog-200">
                  {reply.text}
                </span>
              </button>
            ))}
          </div>

          <div className="mt-3 flex flex-col gap-2 rounded-lg border border-ink-700/80 bg-ink-950/40 p-3 sm:flex-row sm:items-end">
            <Field label="Write via recipe" htmlFor="handoff-recipe" className="flex-1">
              <Select
                id="handoff-recipe"
                value={handoffRecipe?.id ?? ''}
                onChange={(event) => setHandoffRecipeId(event.target.value)}
                disabled={recipes.length === 0}
              >
                {recipes.length === 0 ? (
                  <option value="">Save a recipe first</option>
                ) : (
                  recipes.map((recipe) => (
                    <option key={recipe.id} value={recipe.id}>
                      {recipe.name}
                    </option>
                  ))
                )}
              </Select>
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                icon={PenLine}
                onClick={() => {
                  if (!handoffReply || !handoffRecipe) return;
                  applyRecipe(handoffRecipe);
                  setValue(handoffReply.text);
                  setEncoding('utf8');
                }}
              >
                Load in composer
              </Button>
              <Button
                variant="primary"
                icon={Send}
                disabled={!connected || !handoffRecipe || recipes.length === 0}
                loading={busy === 'write'}
                onClick={() => void writeHandoffReply()}
              >
                Write reply
              </Button>
            </div>
          </div>
          <p className="mt-2 text-[10px] leading-relaxed text-fog-600">
            {handoffRecipe
              ? `Recipe: ${handoffRecipe.name} · ${shortUuid(handoffRecipe.serviceUuid)} / ${shortUuid(handoffRecipe.characteristicUuid)} · ${handoffRecipe.encoding}`
              : 'No recipe saved yet. Select a writable characteristic, compose a frame, and save it as a recipe.'}
          </p>
        </Panel>
      ) : null}

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
        <div className="space-y-4">
          <Panel className="p-5">
            <SectionLabel trailing={`${characteristicCount} chars`}>
              Connection
            </SectionLabel>

            <div className="mt-4 flex items-center gap-2.5 rounded-lg border border-ink-700/80 bg-ink-950/40 px-3 py-2.5">
              <StatusDot
                tone={connected ? 'mint' : device ? 'amber' : 'fog'}
                pulse={connected}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] text-fog-200">
                  {connected
                    ? device?.name ?? 'Connected watch'
                    : device
                      ? `${device.name ?? 'Watch'} · disconnected`
                      : 'No watch selected'}
                </p>
                <p className="truncate font-mono text-[10px] text-fog-600">
                  {device?.id ?? 'scan to begin'}
                </p>
              </div>
              <BluetoothConnected
                className={clsx(
                  'h-4 w-4',
                  connected ? 'text-mint' : 'text-fog-600',
                )}
                aria-hidden="true"
              />
            </div>

            <div className="mt-4 space-y-3">
              <label className="flex items-center justify-between gap-3 rounded-lg border border-ink-700/70 bg-ink-950/30 px-3 py-2">
                <span>
                  <span className="block text-[12px] text-fog-300">
                    Show all nearby devices
                  </span>
                  <span className="mt-0.5 block text-[10px] text-fog-600">
                    Turn off to filter by name prefix.
                  </span>
                </span>
                <input
                  type="checkbox"
                  checked={acceptAll}
                  onChange={(event) => setAcceptAll(event.target.checked)}
                  className="h-4 w-4 shrink-0 accent-signal"
                  aria-label="Show all nearby Bluetooth devices"
                />
              </label>

              <Field
                label="Name prefix"
                htmlFor="lab-prefix"
                hint={acceptAll ? 'Disabled while showing all devices.' : 'For example CMF or Watch.'}
              >
                <Input
                  id="lab-prefix"
                  value={namePrefix}
                  onChange={(event) => setNamePrefix(event.target.value)}
                  disabled={acceptAll}
                  placeholder="CMF"
                  autoComplete="off"
                />
              </Field>

              <Field
                label="Optional service UUIDs"
                htmlFor="lab-services"
                hint="Comma or space separated. These grant access after connecting; add vendor UUIDs once known."
              >
                <Input
                  id="lab-services"
                  value={serviceFilter}
                  onChange={(event) => setServiceFilter(event.target.value)}
                  placeholder="180f, 180a"
                  spellCheck={false}
                  autoComplete="off"
                  className="font-mono text-[11px]"
                />
              </Field>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              <Button
                variant="primary"
                icon={BluetoothSearching}
                loading={busy === 'scan'}
                disabled={!available || busy === 'connect'}
                onClick={() => void scan()}
              >
                {device ? 'Scan again' : 'Scan for watch'}
              </Button>
              {device && !connected ? (
                <Button
                  variant="secondary"
                  icon={PlugZap}
                  loading={busy === 'connect'}
                  onClick={() => void reconnect()}
                >
                  Reconnect
                </Button>
              ) : null}
              {connected ? (
                <Button variant="secondary" icon={Unplug} onClick={disconnect}>
                  Disconnect
                </Button>
              ) : null}
              {device ? (
                <Button variant="ghost" size="sm" onClick={forget}>
                  Forget
                </Button>
              ) : null}
            </div>

            {error ? (
              <InlineNote tone="rose" icon={AlertTriangle} className="mt-3">
                {error}
              </InlineNote>
            ) : null}
          </Panel>

          <Panel className="p-5">
            <SectionLabel>Phone conflict checklist</SectionLabel>
            <ul className="mt-3 space-y-2.5">
              {[
                'Disable Bluetooth on the Android phone, or force-stop the CMF companion.',
                'Wake the watch and keep it within a metre of the Mac.',
                'Scan, connect, inspect GATT. Re-enable phone Bluetooth when finished.',
              ].map((item, index) => (
                <li key={item} className="flex gap-2.5 text-[11px] leading-relaxed text-fog-400">
                  <span className="font-mono text-[10px] text-signal">
                    0{index + 1}
                  </span>
                  {item}
                </li>
              ))}
            </ul>
            <InlineNote tone="fog" icon={Info} className="mt-3">
              If macOS cannot see the watch, quit the phone app, toggle Mac Bluetooth
              off/on, then scan again. Web Bluetooth uses the OS pairing cache.
            </InlineNote>
          </Panel>

          <Panel className="p-5">
            <SectionLabel
              trailing={
                <Button
                  variant="ghost"
                  size="sm"
                  icon={Save}
                  onClick={openRecipeForm}
                  disabled={!selected}
                >
                  New
                </Button>
              }
            >
              Write recipes
            </SectionLabel>

            {recipeFormOpen ? (
              <div className="mt-3 rounded-lg border border-signal/25 bg-signal/[0.04] p-3">
                <Field label="Recipe name" htmlFor="recipe-name">
                  <Input
                    id="recipe-name"
                    value={recipeName}
                    onChange={(event) => setRecipeName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        saveRecipe();
                      }
                    }}
                    autoFocus
                    maxLength={60}
                  />
                </Field>
                <div className="mt-2 flex justify-end gap-1.5">
                  <Button variant="ghost" size="sm" onClick={() => setRecipeFormOpen(false)}>
                    Cancel
                  </Button>
                  <Button variant="primary" size="sm" icon={Save} onClick={saveRecipe}>
                    Save
                  </Button>
                </div>
              </div>
            ) : null}

            {recipes.length === 0 ? (
              <p className="mt-3 rounded-lg border border-dashed border-ink-700 px-3 py-4 text-center text-[11px] leading-relaxed text-fog-500">
                No recipes yet. Select a writable characteristic, set the encoding and
                prefix, then save the frame shape.
              </p>
            ) : (
              <ul className="mt-2 divide-y divide-ink-800/80">
                {recipes.map((recipe) => (
                  <li key={recipe.id} className="py-2.5">
                    <div className="flex items-start gap-2">
                      <Bookmark className="mt-0.5 h-3 w-3 shrink-0 text-signal/80" aria-hidden="true" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[12px] text-fog-200">{recipe.name}</p>
                        <p className="truncate font-mono text-[10px] text-fog-600">
                          {shortUuid(recipe.serviceUuid)} / {shortUuid(recipe.characteristicUuid)} ·{' '}
                          {recipe.encoding}
                        </p>
                      </div>
                      <div className="flex shrink-0 gap-0.5">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => applyRecipe(recipe)}
                          aria-label={`Use recipe ${recipe.name}`}
                          title="Load recipe"
                        >
                          <PenLine className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => deleteRecipe(recipe)}
                          aria-label={`Delete recipe ${recipe.name}`}
                          title="Delete recipe"
                          className="text-fog-600 hover:text-rose"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>

        <div className="space-y-4">
          <Panel>
            <div className="flex flex-wrap items-center justify-between gap-2 px-5 pt-5">
              <SectionLabel className="min-w-0 flex-1">
                GATT tree
              </SectionLabel>
              <span className="font-mono text-[10px] text-fog-600">
                {services.length} services · {characteristicCount} characteristics
              </span>
            </div>

            {!connected ? (
              <div className="p-5">
                <EmptyState
                  icon={BluetoothSearching}
                  title={device ? 'Watch is disconnected' : 'Scan to inspect GATT'}
                  description={
                    device
                      ? 'Reconnect to enumerate services again. The watch may also still be held by the phone.'
                      : 'Web Bluetooth will show a chooser. Once connected, every primary service and characteristic appears here with read, notify, and write controls.'
                  }
                  className="border-0 bg-transparent px-2 py-6"
                  action={
                    device ? (
                      <Button
                        variant="secondary"
                        icon={PlugZap}
                        loading={busy === 'connect'}
                        onClick={() => void reconnect()}
                      >
                        Reconnect
                      </Button>
                    ) : undefined
                  }
                />
              </div>
            ) : services.length === 0 ? (
              <div className="p-5">
                <InlineNote tone="amber" icon={AlertTriangle}>
                  Connected, but no services were returned. The watch may expose vendor
                  services only after a handshake, or the UUID list above is incomplete.
                </InlineNote>
              </div>
            ) : (
              <div className="mt-3 divide-y divide-ink-800/70 border-t border-ink-700/60">
                {services.map((service) => (
                  <details
                    key={service.uuid}
                    className="group"
                    open={selected?.service.uuid === service.uuid}
                  >
                    <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 transition-colors hover:bg-ink-800/30 [&::-webkit-details-marker]:hidden">
                      <ChevronRight
                        className="h-3 w-3 shrink-0 text-fog-600 transition-transform group-open:rotate-90"
                        aria-hidden="true"
                      />
                      <code className="shrink-0 font-mono text-[11px] text-fog-200">
                        {shortUuid(service.uuid)}
                      </code>
                      <span className="min-w-0 flex-1 truncate text-[11px] text-fog-500">
                        {service.uuid.startsWith('0000')
                          ? serviceLabel(service.uuid)
                          : 'Vendor service'}
                      </span>
                      <Badge tone="fog">{service.characteristics.length} ch</Badge>
                    </summary>

                    {service.characteristics.length === 0 ? (
                      <p className="px-9 pb-3 text-[10px] text-fog-600">
                        No accessible characteristics. Add the service UUID before
                        scanning, or the watch hides it until paired.
                      </p>
                    ) : (
                      <div className="divide-y divide-ink-800/50 pb-1">
                        {service.characteristics.map((characteristic) => {
                          const key = `${service.uuid}|${characteristic.uuid}`;
                          const isSelected = selectedKey === key;
                          const props = characteristic.char.properties;
                          const isNotifying = notifying.includes(characteristic.uuid);
                          return (
                            <div
                              key={characteristic.uuid}
                              className={clsx(
                                'flex items-center gap-2 px-4 py-2 pl-9',
                                isSelected && 'bg-signal/[0.06]',
                              )}
                            >
                              <button
                                type="button"
                                onClick={() =>
                                  selectCharacteristic(service, characteristic.uuid)
                                }
                                className="min-w-0 flex-1 text-left"
                              >
                                <span className="flex flex-wrap items-center gap-2">
                                  <code className="font-mono text-[11px] text-fog-200">
                                    {shortUuid(characteristic.uuid)}
                                  </code>
                                  {characteristicLabel(characteristic.uuid) ? (
                                    <span className="truncate text-[10px] text-fog-500">
                                      {characteristicLabel(characteristic.uuid)}
                                    </span>
                                  ) : null}
                                </span>
                                <span className="mt-1 flex flex-wrap gap-1">
                                  {characteristic.properties.map((property) => (
                                    <span
                                      key={property}
                                      className="rounded border border-ink-700 bg-ink-850 px-1 py-px font-mono text-[8px] tracking-wide text-fog-500 uppercase"
                                    >
                                      {property}
                                    </span>
                                  ))}
                                </span>
                              </button>

                              <div className="flex shrink-0 items-center gap-0.5">
                                {props.read ? (
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    aria-label={`Read ${characteristic.uuid}`}
                                    title="Read value"
                                    loading={busy === 'read' && isSelected}
                                    onClick={() => void readValue(characteristic.char)}
                                  >
                                    <Eye className="h-3.5 w-3.5" />
                                  </Button>
                                ) : null}
                                {props.notify || props.indicate ? (
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    aria-label={`Toggle notifications for ${characteristic.uuid}`}
                                    title={isNotifying ? 'Stop notifications' : 'Notify'}
                                    onClick={() => void toggleNotify(characteristic.char)}
                                    className={isNotifying ? 'text-mint' : undefined}
                                  >
                                    <Bell className="h-3.5 w-3.5" />
                                  </Button>
                                ) : null}
                                {props.write || props.writeWithoutResponse ? (
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    aria-label={`Select ${characteristic.uuid} for writing`}
                                    title="Use in composer"
                                    onClick={() =>
                                      selectCharacteristic(service, characteristic.uuid)
                                    }
                                    className={isSelected ? 'text-signal' : undefined}
                                  >
                                    <PenLine className="h-3.5 w-3.5" />
                                  </Button>
                                ) : null}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </details>
                ))}
              </div>
            )}
          </Panel>

          <Panel className="p-5">
            <SectionLabel
              trailing={
                <span className="font-mono text-[10px] text-fog-600">
                  {payloadPreview.bytes?.length ?? 0} bytes
                </span>
              }
            >
              Frame composer
            </SectionLabel>

            <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-ink-700/80 bg-ink-950/40 px-3 py-2">
              <ListTree className="h-3.5 w-3.5 shrink-0 text-fog-500" aria-hidden="true" />
              {selected ? (
                <>
                  <code className="min-w-0 flex-1 truncate text-[11px] text-fog-300">
                    {shortUuid(selected.service.uuid)} /{' '}
                    {shortUuid(selected.characteristic.uuid)}
                  </code>
                  <CopyButton
                    text={selected.characteristic.uuid}
                    label="UUID"
                    size="sm"
                  />
                </>
              ) : (
                <span className="text-[11px] text-fog-500">
                  Select a characteristic in the GATT tree.
                </span>
              )}
            </div>

            <div className="mt-3 grid gap-3 sm:grid-cols-[auto_minmax(0,1fr)]">
              <div>
                <span className="micro mb-1 block">Encoding</span>
                <div className="inline-flex rounded-lg border border-ink-700 bg-ink-950/60 p-0.5">
                  {(['utf8', 'hex'] as const).map((option) => (
                    <button
                      key={option}
                      type="button"
                      onClick={() => setEncoding(option)}
                      className={clsx(
                        'rounded-md px-3 py-1.5 font-mono text-[10px] tracking-wide uppercase transition-colors',
                        encoding === option
                          ? 'bg-signal/15 text-signal'
                          : 'text-fog-500 hover:text-fog-200',
                      )}
                    >
                      {option === 'utf8' ? 'UTF-8' : 'HEX'}
                    </button>
                  ))}
                </div>
              </div>

              <Field
                label="Payload"
                htmlFor="lab-value"
                hint={
                  encoding === 'hex'
                    ? 'Even number of hex digits. Spaces and colons are ignored.'
                    : 'Written as UTF-8 bytes, then wrapped by prefix and suffix.'
                }
              >
                <Textarea
                  id="lab-value"
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  rows={3}
                  placeholder={
                    encoding === 'hex' ? 'a5 01 00 00' : 'hello watch'
                  }
                  className={encoding === 'hex' ? 'font-mono text-[11px]' : undefined}
                />
              </Field>
            </div>

            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <Field label="Prefix hex" htmlFor="lab-prefix-hex">
                <Input
                  id="lab-prefix-hex"
                  value={prefixHex}
                  onChange={(event) => setPrefixHex(event.target.value)}
                  placeholder="a5 01"
                  spellCheck={false}
                  autoComplete="off"
                  className="font-mono text-[11px]"
                />
              </Field>
              <Field label="Suffix hex" htmlFor="lab-suffix-hex">
                <Input
                  id="lab-suffix-hex"
                  value={suffixHex}
                  onChange={(event) => setSuffixHex(event.target.value)}
                  placeholder="0d 0a"
                  spellCheck={false}
                  autoComplete="off"
                  className="font-mono text-[11px]"
                />
              </Field>
              <Field label="Write mode" htmlFor="lab-write-mode">
                <Select
                  id="lab-write-mode"
                  value={writeMode}
                  onChange={(event) => setWriteMode(event.target.value as WriteMode)}
                >
                  <option value="auto">Auto (prefer response)</option>
                  <option value="with">With response</option>
                  <option value="without">Without response</option>
                </Select>
              </Field>
            </div>

            <div className="mt-3 rounded-lg border border-ink-700/80 bg-ink-950/60 p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="micro">Byte preview</span>
                {payloadPreview.hex ? (
                  <CopyButton text={payloadPreview.hex} label="Copy hex" size="sm" />
                ) : null}
              </div>
              <p
                className={clsx(
                  'mt-2 break-all font-mono text-[11px] leading-relaxed',
                  payloadPreview.error ? 'text-rose' : 'text-fog-300',
                )}
              >
                {payloadPreview.error
                  ? payloadPreview.error
                  : payloadPreview.hex || 'Empty payload.'}
              </p>
              {(payloadPreview.bytes?.length ?? 0) > 20 ? (
                <p className="mt-2 text-[10px] leading-relaxed text-amber">
                  Over 20 bytes. The default BLE MTU may split or reject this frame;
                  the watch protocol is unverified.
                </p>
              ) : null}
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                variant="primary"
                icon={Send}
                loading={busy === 'write'}
                disabled={!connected || !selected || !canWrite || Boolean(payloadPreview.error)}
                onClick={() => void writeFrame()}
              >
                Write frame
              </Button>
              <Button
                variant="secondary"
                icon={Eye}
                loading={busy === 'read'}
                disabled={
                  !connected ||
                  !selected ||
                  !selected.characteristic.char.properties.read
                }
                onClick={() => {
                  if (selected) void readValue(selected.characteristic.char);
                }}
              >
                Read
              </Button>
              <Button
                variant="ghost"
                icon={Save}
                disabled={!selected}
                onClick={openRecipeForm}
              >
                Save recipe
              </Button>
              {selected && !canWrite ? (
                <span className="text-[10px] text-amber">
                  This characteristic is not writable.
                </span>
              ) : null}
            </div>
          </Panel>

          <Panel>
            <div className="flex flex-wrap items-center justify-between gap-2 px-5 pt-5">
              <SectionLabel className="min-w-0 flex-1" trailing={`${log.length} frames`}>
                Live log
              </SectionLabel>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  icon={Download}
                  onClick={exportLog}
                  disabled={log.length === 0}
                >
                  Export
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={Trash2}
                  onClick={() => setLog([])}
                  disabled={log.length === 0}
                >
                  Clear
                </Button>
              </div>
            </div>

            <div
              ref={logRef}
              className="mt-3 max-h-[380px] min-h-[140px] overflow-y-auto border-t border-ink-700/60 bg-ink-950/50 px-4 py-3"
            >
              {log.length === 0 ? (
                <div className="flex h-[110px] flex-col items-center justify-center gap-2 text-fog-600">
                  <Terminal className="h-5 w-5" aria-hidden="true" />
                  <p className="text-[11px]">
                    Frames, reads, and notifications appear here.
                  </p>
                </div>
              ) : (
                <ul className="space-y-2 font-mono text-[10px]">
                  {log.map((entry) => {
                    const style = DIRECTION_STYLES[entry.direction];
                    return (
                      <li key={entry.id} className="flex gap-2">
                        <span className="shrink-0 text-fog-600 tabular-nums">
                          {timestamp(entry.at)}
                        </span>
                        <span
                          className={clsx(
                            'h-fit shrink-0 rounded border px-1 py-px text-[8px] tracking-wide',
                            style.className,
                          )}
                        >
                          {style.label}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-fog-300">{entry.label}</span>
                          {entry.hex ? (
                            <span className="mt-0.5 block break-all text-fog-500">
                              {entry.hex}
                            </span>
                          ) : null}
                          {entry.text ? (
                            <span className="mt-0.5 block break-all text-fog-600">
                              {entry.text}
                            </span>
                          ) : null}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            <p className="px-4 py-2 text-[9px] text-fog-600">
              The log lives in this tab only. It is never uploaded, and it is cleared
              on reload unless you export it.
            </p>
          </Panel>

          <Panel className="p-5">
            <SectionLabel trailing="what M0 must prove">Capture 01</SectionLabel>
            <div className="mt-3 flex items-start gap-2.5">
              <FlaskConical className="mt-0.5 h-4 w-4 shrink-0 text-amber" aria-hidden="true" />
              <div className="space-y-2 text-[11px] leading-relaxed text-fog-400">
                <p>
                  Send yourself a WhatsApp or SMS while the phone owns the watch. On the
                  watch notification, look for a reply or quick-reply action.
                </p>
                <p>
                  If it exists, the Android companion can write replies through that
                  surface. If it does not, automatic watch replies are not possible and
                  the product pivots to phone-side quick replies plus this lab.
                </p>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              <Badge tone="amber">not yet verified</Badge>
              <Badge tone="fog">gates Android phase</Badge>
              <Badge tone="fog">gates auto-delivery</Badge>
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}
