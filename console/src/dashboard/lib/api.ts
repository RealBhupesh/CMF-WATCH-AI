export type Tone = 'casual_hinglish' | 'casual_english' | 'professional';
export type ToneSetting = 'auto' | Tone;
export type Intent = 'positive' | 'neutral' | 'decline';
export type Source = 'phone' | 'playground' | 'lab';
export type Outcome = 'generated' | 'delivered' | 'failed' | 'opted_out';

export interface Reply {
  intent: Intent;
  text: string;
}

export interface ReplySet {
  replies: Reply[];
  tone: Tone;
  from_ai: boolean;
  latency_ms: number;
}

export interface PlaygroundResponse extends ReplySet {
  event_id: string;
  fallback_reason?: string;
}

export interface Overview {
  version: string;
  environment: string;
  auth_mode: string;
  groq_configured: boolean;
  api_origin: string;
  retention_days: number;
  devices: { total: number; online: number; revoked: number };
  today: {
    replies: number;
    ai_replies: number;
    fallbacks: number;
    opted_out: number;
    ai_success_rate: number | null;
  };
  latency: {
    p50_ms: number | null;
    p95_ms: number | null;
    samples: number;
  };
  sparkline: Array<{
    hour: string;
    replies: number;
    avg_latency_ms: number;
  }>;
  recent: EventRecord[];
  onboarding: { has_device: boolean; has_event: boolean };
}

export interface EventRecord {
  id: string;
  device_id: string | null;
  source: Source;
  app: string;
  sender_alias: string;
  latency_ms: number;
  from_ai: boolean;
  reply_count: number;
  outcome: Outcome;
  created_at: string;
}

export interface DeviceRecord {
  id: string;
  name: string;
  platform: string;
  app_version: string;
  watch_name: string;
  watch_firmware: string;
  battery: number | null;
  last_seen_at: string | null;
  created_at: string;
  revoked_at: string | null;
  online: boolean;
}

export interface SettingsRecord {
  model: string;
  forced_tone: ToneSetting;
  opt_outs: string[];
  retention_days: number;
  updated_at: string | null;
}

export interface EnrollmentCode {
  code: string;
  expires_at: string;
}

export interface EventListResponse {
  events: EventRecord[];
  total: number;
  limit: number;
  offset: number;
}

export interface DeviceListResponse {
  devices: DeviceRecord[];
}

export interface SettingsPayload {
  model: string;
  forced_tone: ToneSetting;
  opt_outs: string[];
  retention_days: number;
}

export interface PlaygroundPayload {
  sender?: string;
  body: string;
  app?: string;
  history?: string[];
  tone?: ToneSetting;
}

export interface EventQueryParams {
  limit?: number;
  offset?: number;
  source?: Source;
  app?: string;
  from_ai?: 'true' | 'false';
  outcome?: Outcome;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Array<{ path: string; code: string }>;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: Array<{ path: string; code: string }>,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const BASE = '/admin/api';

function queryString(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }

  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers,
    credentials: 'same-origin',
  });

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const body = (payload ?? {}) as {
      error?: string;
      message?: string;
      details?: Array<{ path: string; code: string }>;
    };
    throw new ApiError(
      response.status,
      body.error ?? 'request_failed',
      body.message ?? body.error ?? `Request failed (${response.status})`,
      body.details,
    );
  }

  return payload as T;
}

export const api = {
  overview(): Promise<Overview> {
    return request('/overview');
  },

  events(params: EventQueryParams = {}): Promise<EventListResponse> {
    return request(`/events${queryString({ ...params })}`);
  },

  deleteEvents(): Promise<{ deleted: number }> {
    return request('/events', { method: 'DELETE' });
  },

  settings(): Promise<SettingsRecord> {
    return request('/settings');
  },

  updateSettings(payload: SettingsPayload): Promise<SettingsRecord> {
    return request('/settings', {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
  },

  devices(): Promise<DeviceListResponse> {
    return request('/devices');
  },

  enrollmentCode(): Promise<EnrollmentCode> {
    return request('/enrollment-codes', { method: 'POST' });
  },

  revokeDevice(id: string): Promise<{ ok: true }> {
    return request(`/devices/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  revokeAllDevices(): Promise<{ revoked: number }> {
    return request('/devices/revoke-all', { method: 'POST' });
  },

  playground(payload: PlaygroundPayload): Promise<PlaygroundResponse> {
    return request('/playground', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },
};

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'opted_out':
        return 'That sender is opted out in Settings. No generation was attempted.';
      case 'rate_limited':
        return 'Rate limit reached. Wait a moment and try again.';
      case 'unauthorized':
        return 'Access denied. Reload and sign in through Cloudflare Access.';
      case 'auth_misconfigured':
        return 'Dashboard auth is misconfigured. The Worker is failing closed.';
      case 'server_misconfigured':
        return 'The Worker is missing a required secret. Set TOKEN_PEPPER before enrolling.';
      case 'body_too_large':
        return 'That payload is larger than the 16 KB limit.';
      case 'invalid_code':
        return 'That enrollment code is invalid, used, or expired.';
      case 'server_error':
        return 'The Worker hit an internal error. Check the logs.';
      default:
        return error.message;
    }
  }
  if (error instanceof Error) return error.message;
  return 'Something went wrong.';
}
