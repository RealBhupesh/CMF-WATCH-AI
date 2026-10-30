-- WatchAI Console schema.
--
-- The events table deliberately has no body column. Message bodies are ephemeral:
-- they exist in the request and the Groq call only. If a future migration adds a
-- body column here, the privacy promise in docs/designs/watchai-console.md is broken.

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL DEFAULT '',
  app_version TEXT NOT NULL DEFAULT '',
  watch_name TEXT NOT NULL DEFAULT '',
  watch_firmware TEXT NOT NULL DEFAULT '',
  battery INTEGER,
  last_seen_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT
);

CREATE INDEX idx_devices_token_hash ON devices(token_hash);
CREATE INDEX idx_devices_last_seen ON devices(last_seen_at);

CREATE TABLE enrollment_codes (
  code_hash TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_enrollment_expires ON enrollment_codes(expires_at);

CREATE TABLE settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  model TEXT NOT NULL DEFAULT 'llama-3.3-70b-versatile',
  forced_tone TEXT NOT NULL DEFAULT 'auto'
    CHECK (forced_tone IN ('auto', 'casual_hinglish', 'casual_english', 'professional')),
  opt_outs TEXT NOT NULL DEFAULT '[]',
  retention_days INTEGER NOT NULL DEFAULT 30
    CHECK (retention_days BETWEEN 1 AND 365),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO settings (id) VALUES (1);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  device_id TEXT,
  source TEXT NOT NULL
    CHECK (source IN ('phone', 'playground', 'lab')),
  app TEXT NOT NULL DEFAULT '',
  sender_alias TEXT NOT NULL DEFAULT '',
  latency_ms INTEGER NOT NULL DEFAULT 0,
  from_ai INTEGER NOT NULL DEFAULT 0,
  reply_count INTEGER NOT NULL DEFAULT 3,
  outcome TEXT NOT NULL DEFAULT 'generated'
    CHECK (outcome IN ('generated', 'delivered', 'failed', 'opted_out')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_events_created_at ON events(created_at DESC);
CREATE INDEX idx_events_device_id ON events(device_id);
CREATE INDEX idx_events_source ON events(source);

CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);

CREATE INDEX idx_rate_limits_window ON rate_limits(window_start);
