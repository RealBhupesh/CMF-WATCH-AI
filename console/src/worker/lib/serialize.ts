import type {
  DeviceRow,
  EventRow,
  PublicDevice,
  SettingsRow,
} from '../db/queries';
import { parseOptOuts } from './settings';

export function toIso(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
}

export interface PublicEvent {
  id: string;
  device_id: string | null;
  source: EventRow['source'];
  app: string;
  sender_alias: string;
  latency_ms: number;
  from_ai: boolean;
  reply_count: number;
  outcome: EventRow['outcome'];
  created_at: string;
}

export function serializeEvent(row: EventRow): PublicEvent {
  return {
    ...row,
    from_ai: row.from_ai === 1,
    created_at: toIso(row.created_at) ?? row.created_at,
  };
}

export interface DeviceResponse extends Omit<PublicDevice, 'token_hash'> {
  online: boolean;
}

export function serializeDevice(row: DeviceRow | PublicDevice): DeviceResponse {
  const { token_hash: _tokenHash, ...device } = row as DeviceRow;
  const lastSeen = device.last_seen_at
    ? Date.parse(toIso(device.last_seen_at) ?? '')
    : Number.NaN;
  const online =
    !device.revoked_at &&
    Number.isFinite(lastSeen) &&
    Date.now() - lastSeen <= 5 * 60 * 1000;

  return {
    ...device,
    last_seen_at: toIso(device.last_seen_at),
    created_at: toIso(device.created_at) ?? device.created_at,
    revoked_at: toIso(device.revoked_at),
    online,
  };
}

export interface SettingsResponse {
  model: string;
  forced_tone: string;
  opt_outs: string[];
  retention_days: number;
  updated_at: string | null;
}

export function serializeSettings(row: SettingsRow): SettingsResponse {
  return {
    model: row.model,
    forced_tone: row.forced_tone,
    opt_outs: parseOptOuts(row.opt_outs),
    retention_days: row.retention_days,
    updated_at: toIso(row.updated_at),
  };
}
