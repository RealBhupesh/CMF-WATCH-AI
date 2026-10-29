import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { AppPaths } from "../paths.js";
import { JsonFile } from "../storage/json-file.js";
import {
  WATCH_MAX_COUNT,
  WATCH_MAX_EVENTS,
  watchEventSchema,
  watchSchema,
  type NewWatch,
  type Watch,
  type WatchEvent,
} from "./model.js";

type WatchFile = { watches: Watch[] };
type EventFile = { events: WatchEvent[] };

export type WatchEventInput = Omit<
  WatchEvent,
  "id" | "detectedAt" | "acknowledgedAt"
>;

export interface ListEventsOptions {
  watchId?: string;
  unreadOnly?: boolean;
  limit?: number;
}

export interface AckOptions {
  eventIds?: string[];
  watchId?: string;
  all?: boolean;
}

export class WatchStore {
  private readonly watchesFile: JsonFile<WatchFile>;
  private readonly eventsFile: JsonFile<EventFile>;
  private readonly snapshotsDir: string;

  constructor(paths: AppPaths) {
    this.watchesFile = new JsonFile(
      paths.watchesFile,
      z.object({ watches: z.array(watchSchema) }),
      () => ({ watches: [] }),
    );
    this.eventsFile = new JsonFile(
      paths.watchEventsFile,
      z.object({ events: z.array(watchEventSchema) }),
      () => ({ events: [] }),
    );
    this.snapshotsDir = paths.watchSnapshotsDir;
  }

  async list(): Promise<Watch[]> {
    return structuredClone((await this.watchesFile.read()).watches);
  }

  async get(id: string): Promise<Watch> {
    const watch = (await this.list()).find((entry) => entry.id === id);
    if (!watch) throw new Error(`Watch not found: ${id}`);
    return watch;
  }

  async create(input: NewWatch): Promise<Watch> {
    const now = new Date().toISOString();
    const watch = watchSchema.parse({
      ...input,
      id: randomUUID(),
      status: "active",
      nextRunAt: now,
      consecutiveFailures: 0,
      createdAt: now,
      updatedAt: now,
    });

    await this.watchesFile.update((current) => {
      if (current.watches.length >= WATCH_MAX_COUNT) {
        throw new Error(
          `Watch limit (${WATCH_MAX_COUNT}) reached; delete an unused watch first`,
        );
      }
      return { watches: [...current.watches, watch] };
    });

    return watch;
  }

  async change(id: string, change: (watch: Watch) => Watch): Promise<Watch> {
    let updated!: Watch;
    await this.watchesFile.update((current) => ({
      watches: current.watches.map((watch) => {
        if (watch.id !== id) return watch;
        updated = watchSchema.parse({
          ...change(structuredClone(watch)),
          id,
          updatedAt: new Date().toISOString(),
        });
        return updated;
      }),
    }));

    if (!updated) throw new Error(`Watch not found: ${id}`);
    return updated;
  }

  async delete(id: string): Promise<void> {
    await this.get(id);
    await this.watchesFile.update((current) => ({
      watches: current.watches.filter((watch) => watch.id !== id),
    }));
    await this.eventsFile.update((current) => ({
      events: current.events.filter((event) => event.watchId !== id),
    }));
    await this.deleteSnapshot(id);
  }

  async addEvent(input: WatchEventInput): Promise<WatchEvent> {
    const event = watchEventSchema.parse({
      ...input,
      id: randomUUID(),
      detectedAt: new Date().toISOString(),
    });

    await this.eventsFile.update((current) => {
      const events = [...current.events, event];
      while (events.length > WATCH_MAX_EVENTS) {
        const acknowledged = events.findIndex((entry) =>
          Boolean(entry.acknowledgedAt),
        );
        if (acknowledged >= 0) events.splice(acknowledged, 1);
        else events.shift();
      }
      return { events };
    });

    return event;
  }

  async listEvents(options: ListEventsOptions = {}): Promise<WatchEvent[]> {
    const limit = Math.min(Math.max(options.limit ?? 20, 1), WATCH_MAX_EVENTS);
    const events = (await this.eventsFile.read()).events
      .filter((event) => !options.watchId || event.watchId === options.watchId)
      .filter((event) => !options.unreadOnly || !event.acknowledgedAt)
      .slice()
      .reverse()
      .slice(0, limit);

    return structuredClone(events);
  }

  async ack(options: AckOptions): Promise<number> {
    if (!options.all && !options.watchId && !options.eventIds?.length) {
      throw new Error("Supply eventIds, watchId, or all to acknowledge events");
    }

    const ids = new Set(options.eventIds ?? []);
    const now = new Date().toISOString();
    let changed = 0;

    await this.eventsFile.update((current) => ({
      events: current.events.map((event) => {
        if (event.acknowledgedAt) return event;
        if (
          options.all ||
          (options.watchId && event.watchId === options.watchId) ||
          ids.has(event.id)
        ) {
          changed += 1;
          return { ...event, acknowledgedAt: now };
        }
        return event;
      }),
    }));

    return changed;
  }

  async unreadCounts(): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    for (const event of (await this.eventsFile.read()).events) {
      if (!event.acknowledgedAt) {
        counts.set(event.watchId, (counts.get(event.watchId) ?? 0) + 1);
      }
    }
    return counts;
  }

  async unreadCount(): Promise<number> {
    return (await this.eventsFile.read()).events.filter(
      (event) => !event.acknowledgedAt,
    ).length;
  }

  async readSnapshot(id: string): Promise<string | undefined> {
    try {
      return await readFile(this.snapshotPath(id), "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw error;
    }
  }

  async writeSnapshot(id: string, text: string): Promise<void> {
    await mkdir(this.snapshotsDir, { recursive: true, mode: 0o700 });
    const target = this.snapshotPath(id);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, text, { encoding: "utf8", mode: 0o600 });
    await chmod(temporary, 0o600).catch(() => undefined);
    await rename(temporary, target);
    await chmod(target, 0o600).catch(() => undefined);
  }

  async deleteSnapshot(id: string): Promise<void> {
    await rm(this.snapshotPath(id), { force: true }).catch(() => undefined);
  }

  private snapshotPath(id: string): string {
    return join(this.snapshotsDir, `${id}.txt`);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
