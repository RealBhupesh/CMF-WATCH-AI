export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

type LogFields = Record<string, unknown>;

export class Logger {
  constructor(
    private readonly level: LogLevel,
    private readonly scope: string,
  ) {}

  child(scope: string): Logger {
    return new Logger(this.level, `${this.scope}:${scope}`);
  }

  debug(message: string, fields?: LogFields): void {
    this.write("debug", message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.write("info", message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.write("warn", message, fields);
  }

  error(message: string, fields?: LogFields): void {
    this.write("error", message, fields);
  }

  private write(level: LogLevel, message: string, fields?: LogFields): void {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.level]) {
      return;
    }

    const record: Record<string, unknown> = {
      time: new Date().toISOString(),
      level,
      scope: this.scope,
      message,
    };

    if (fields && Object.keys(fields).length > 0) {
      record.fields = redact(fields);
    }

    process.stderr.write(`${JSON.stringify(record)}\n`);
  }
}

const REDACTED_KEYS = new Set([
  "authorization",
  "password",
  "ownerpassword",
  "secret",
  "clientsecret",
  "jwtsecret",
  "token",
  "accesstoken",
  "refreshtoken",
  "codeverifier",
  "code",
]);

function redact(value: unknown, depth = 0): unknown {
  if (depth > 5) {
    return "[max-depth]";
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redact(entry, depth + 1));
  }

  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (REDACTED_KEYS.has(key.toLowerCase())) {
        output[key] = "[redacted]";
      } else {
        output[key] = redact(entry, depth + 1);
      }
    }
    return output;
  }

  return value;
}
