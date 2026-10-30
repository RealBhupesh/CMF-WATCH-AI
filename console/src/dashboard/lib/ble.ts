export type BleDirection = 'system' | 'tx' | 'rx' | 'error';

export interface BleLogEntry {
  id: string;
  at: number;
  direction: BleDirection;
  label: string;
  hex?: string;
  text?: string;
}

export interface BleRecipe {
  id: string;
  name: string;
  serviceUuid: string;
  characteristicUuid: string;
  encoding: 'utf8' | 'hex';
  prefixHex: string;
  suffixHex: string;
}

export interface GattCharacteristicInfo {
  uuid: string;
  properties: string[];
  char: BluetoothRemoteGATTCharacteristic;
}

export interface GattServiceInfo {
  uuid: string;
  name: string;
  service: BluetoothRemoteGATTService;
  characteristics: GattCharacteristicInfo[];
}

export interface ScanOptions {
  namePrefix: string;
  acceptAll: boolean;
  serviceUuids: string[];
}

export interface PayloadOptions {
  encoding: 'utf8' | 'hex';
  value: string;
  prefixHex: string;
  suffixHex: string;
}

export type WriteMode = 'auto' | 'with' | 'without';

export class BleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BleError';
  }
}

const BASE_UUID_SUFFIX = '-0000-1000-8000-00805f9b34fb';

const SERVICE_NAMES: Record<string, string> = {
  '00001800-0000-1000-8000-00805f9b34fb': 'Generic Access',
  '00001801-0000-1000-8000-00805f9b34fb': 'Generic Attribute',
  '0000180a-0000-1000-8000-00805f9b34fb': 'Device Information',
  '0000180f-0000-1000-8000-00805f9b34fb': 'Battery',
  '0000180d-0000-1000-8000-00805f9b34fb': 'Heart Rate',
  '00001812-0000-1000-8000-00805f9b34fb': 'Human Interface Device',
};

const CHARACTERISTIC_NAMES: Record<string, string> = {
  '00002a00-0000-1000-8000-00805f9b34fb': 'Device Name',
  '00002a01-0000-1000-8000-00805f9b34fb': 'Appearance',
  '00002a04-0000-1000-8000-00805f9b34fb': 'Peripheral Preferred Connection',
  '00002a05-0000-1000-8000-00805f9b34fb': 'Service Changed',
  '00002a19-0000-1000-8000-00805f9b34fb': 'Battery Level',
  '00002a24-0000-1000-8000-00805f9b34fb': 'Model Number',
  '00002a25-0000-1000-8000-00805f9b34fb': 'Serial Number',
  '00002a26-0000-1000-8000-00805f9b34fb': 'Firmware Revision',
  '00002a27-0000-1000-8000-00805f9b34fb': 'Hardware Revision',
  '00002a28-0000-1000-8000-00805f9b34fb': 'Software Revision',
  '00002a29-0000-1000-8000-00805f9b34fb': 'Manufacturer Name',
  '00002a2a-0000-1000-8000-00805f9b34fb': 'IEEE Regulatory Certification',
};

export function bluetoothAvailable(): boolean {
  return typeof navigator !== 'undefined' && Boolean(navigator.bluetooth);
}

export function normalizeUuid(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!value) return '';
  if (/^[0-9a-f]{4}$/.test(value)) return `0000${value}${BASE_UUID_SUFFIX}`;
  if (/^[0-9a-f]{8}$/.test(value)) return `${value}${BASE_UUID_SUFFIX}`;
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      value,
    )
  ) {
    return value;
  }
  return '';
}

export function shortUuid(uuid: string): string {
  const match = /^0000([0-9a-f]{4})0000-1000-8000-00805f9b34fb$/i.exec(
    uuid.replace(/-/g, ''),
  );
  if (match) return `0x${match[1].toUpperCase()}`;
  return uuid;
}

export function serviceLabel(uuid: string): string {
  return SERVICE_NAMES[uuid.toLowerCase()] ?? 'Vendor service';
}

export function characteristicLabel(uuid: string): string {
  return CHARACTERISTIC_NAMES[uuid.toLowerCase()] ?? '';
}

export async function requestDevice(
  options: ScanOptions,
): Promise<BluetoothDevice> {
  if (!bluetoothAvailable()) {
    throw new BleError(
      'Web Bluetooth is unavailable. Use Chrome or Edge on macOS over HTTPS or localhost.',
    );
  }

  const serviceUuids = options.serviceUuids
    .map((uuid) => uuid.trim())
    .filter(Boolean);

  for (const uuid of serviceUuids) {
    if (!normalizeUuid(uuid)) {
      throw new BleError(`"${uuid}" is not a valid Bluetooth UUID.`);
    }
  }
  const optionalServices = serviceUuids.map(normalizeUuid);

  const prefix = options.namePrefix.trim();
  const requestOptions =
    options.acceptAll || !prefix
      ? {
          acceptAllDevices: true,
          ...(optionalServices.length ? { optionalServices } : {}),
        }
      : {
          filters: [{ namePrefix: prefix }],
          ...(optionalServices.length ? { optionalServices } : {}),
        };

  return navigator.bluetooth.requestDevice(requestOptions);
}

export async function connectDevice(
  device: BluetoothDevice,
): Promise<BluetoothRemoteGATTServer> {
  if (!device.gatt) {
    throw new BleError('This device does not expose a GATT server.');
  }
  return device.gatt.connect();
}

export async function enumerateServices(
  server: BluetoothRemoteGATTServer,
): Promise<GattServiceInfo[]> {
  const services = await server.getPrimaryServices();
  const tree: GattServiceInfo[] = [];

  for (const service of services) {
    let characteristics: BluetoothRemoteGATTCharacteristic[] = [];
    try {
      characteristics = await service.getCharacteristics();
    } catch {
      // A service can be visible while its characteristics are filtered out.
      characteristics = [];
    }

    tree.push({
      uuid: service.uuid,
      name: serviceLabel(service.uuid),
      service,
      characteristics: characteristics.map((characteristic) => ({
        uuid: characteristic.uuid,
        properties: propertyNames(characteristic.properties),
        char: characteristic,
      })),
    });
  }

  return tree.sort((a, b) => a.uuid.localeCompare(b.uuid));
}

function propertyNames(
  properties: BluetoothCharacteristicProperties,
): string[] {
  const names: string[] = [];
  if (properties.read) names.push('read');
  if (properties.write) names.push('write');
  if (properties.writeWithoutResponse) names.push('write-no-response');
  if (properties.notify) names.push('notify');
  if (properties.indicate) names.push('indicate');
  return names;
}

export function parseHex(input: string): Uint8Array<ArrayBuffer> {
  const clean = input
    .replace(/0x/gi, '')
    .replace(/[\s,:;-]/g, '')
    .toLowerCase();
  if (!clean) return new Uint8Array();
  if (!/^[0-9a-f]+$/.test(clean) || clean.length % 2 !== 0) {
    throw new BleError('Hex must contain an even number of 0-9/a-f digits.');
  }
  const bytes = new Uint8Array(clean.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(clean.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join(' ');
}

export function bytesToText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return '';
  }
}

export function encodePayload(options: PayloadOptions): Uint8Array<ArrayBuffer> {
  const prefix = parseHex(options.prefixHex);
  const suffix = parseHex(options.suffixHex);
  const body =
    options.encoding === 'hex'
      ? parseHex(options.value)
      : new TextEncoder().encode(options.value);

  const output = new Uint8Array(prefix.length + body.length + suffix.length);
  output.set(prefix, 0);
  output.set(body, prefix.length);
  output.set(suffix, prefix.length + body.length);
  return output;
}

export async function readCharacteristic(
  characteristic: BluetoothRemoteGATTCharacteristic,
): Promise<Uint8Array<ArrayBuffer>> {
  const value = await characteristic.readValue();
  const copy = new Uint8Array(value.byteLength);
  copy.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  return copy;
}

export async function writeCharacteristic(
  characteristic: BluetoothRemoteGATTCharacteristic,
  bytes: Uint8Array<ArrayBuffer>,
  mode: WriteMode,
): Promise<void> {
  const properties = characteristic.properties;
  if (mode === 'with' || (mode === 'auto' && properties.write)) {
    if (properties.write) {
      await characteristic.writeValueWithResponse(bytes);
      return;
    }
  }
  if (properties.writeWithoutResponse) {
    await characteristic.writeValueWithoutResponse(bytes);
    return;
  }
  if (properties.write) {
    await characteristic.writeValueWithResponse(bytes);
    return;
  }
  throw new BleError('This characteristic is not writable.');
}

export function formatBleError(error: unknown): string {
  if (error instanceof BleError) return error.message;
  if (error instanceof DOMException) {
    switch (error.name) {
      case 'NotFoundError':
        return 'No device selected. The scan dialog was closed.';
      case 'SecurityError':
        return 'Bluetooth access was blocked. Use HTTPS or localhost and allow the permission.';
      case 'NetworkError':
        return 'Connection failed. The watch may still be held by the phone — turn off phone Bluetooth and try again.';
      case 'InvalidStateError':
        return 'The watch is not connected. Reconnect and try again.';
      case 'NotSupportedError':
        return 'This browser does not support that Bluetooth operation.';
      case 'NotAllowedError':
        return 'Bluetooth permission was denied.';
      default:
        return `${error.name}: ${error.message}`;
    }
  }
  if (error instanceof Error) return error.message;
  return 'Bluetooth operation failed.';
}

const RECIPE_KEY = 'watchai.lab.recipes.v1';

export function loadRecipes(): BleRecipe[] {
  try {
    const raw = localStorage.getItem(RECIPE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is BleRecipe => {
      if (typeof item !== 'object' || item === null) return false;
      const recipe = item as Record<string, unknown>;
      return (
        typeof recipe.id === 'string' &&
        typeof recipe.name === 'string' &&
        typeof recipe.serviceUuid === 'string' &&
        typeof recipe.characteristicUuid === 'string' &&
        (recipe.encoding === 'utf8' || recipe.encoding === 'hex') &&
        typeof recipe.prefixHex === 'string' &&
        typeof recipe.suffixHex === 'string'
      );
    });
  } catch {
    return [];
  }
}

export function saveRecipes(recipes: BleRecipe[]): void {
  try {
    localStorage.setItem(RECIPE_KEY, JSON.stringify(recipes));
  } catch {
    // Storage can be full or blocked; the in-memory list still works.
  }
}

export function findCharacteristic(
  services: GattServiceInfo[],
  serviceUuid: string,
  characteristicUuid: string,
): BluetoothRemoteGATTCharacteristic | null {
  const service = services.find(
    (item) => item.uuid.toLowerCase() === serviceUuid.toLowerCase(),
  );
  if (!service) return null;
  const characteristic = service.characteristics.find(
    (item) => item.uuid.toLowerCase() === characteristicUuid.toLowerCase(),
  );
  return characteristic?.char ?? null;
}
