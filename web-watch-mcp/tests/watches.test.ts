import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppPaths } from "../src/paths.js";
import { WatchStore, type WatchEventInput } from "../src/watches/store.js";
import type { NewWatch, Watch } from "../src/watches/model.js";

let directory: string;
let store: WatchStore;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "watch-store-"));
  store = new WatchStore(paths(directory));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const newWatch: NewWatch = {
  name: "Careers",
  url: "https://example.com/careers",
  intent: "New engineering roles in Pune",
  intervalMinutes: 60,
  sessionId: "default",
};

function paths(root: string): AppPaths {
  return {
    watchesFile: join(root, "watches.json"),
    watchEventsFile: join(root, "watch-events.json"),
    watchSnapshotsDir: join(root, "watches", "snapshots"),
  } as AppPaths;
}

function eventInput(watch: Watch, added = ["New role"]): WatchEventInput {
  return {
    watchId: watch.id,
    watchName: watch.name,
    url: watch.url,
    title: "Careers",
    previousTitle: "Careers",
    titleChanged: false,
    intent: watch.intent,
    added,
    removed: [],
    addedCount: added.length,
    removedCount: 0,
    diffTruncated: false,
    currentExcerpt: added.join("\n"),
    snapshotChars: 100,
    truncated: false,
  };
}

describe("watch store", () => {
  it("creates, lists, reads and changes a watch", async () => {
    const watch = await store.create(newWatch);
    expect(watch).toMatchObject({
      ...newWatch,
      status: "active",
      consecutiveFailures: 0,
    });
    expect(await store.list()).toHaveLength(1);
    expect(await store.get(watch.id)).toEqual(watch);

    const updated = await store.change(watch.id, (current) => ({
      ...current,
      name: "Updated careers",
      intervalMinutes: 120,
    }));
    expect(updated).toMatchObject({
      id: watch.id,
      name: "Updated careers",
      intervalMinutes: 120,
    });
    expect(updated.updatedAt >= watch.updatedAt).toBe(true);
    expect(await store.get(watch.id)).toEqual(updated);
  });

  it("rejects intervals below the minimum", async () => {
    await expect(
      store.create({ ...newWatch, intervalMinutes: 5 }),
    ).rejects.toThrow();
  });

  it("stores baseline snapshots privately and removes them on delete", async () => {
    const watch = await store.create(newWatch);
    await store.writeSnapshot(watch.id, "Line one\nLine two");

    expect(await store.readSnapshot(watch.id)).toBe("Line one\nLine two");
    const info = await stat(join(directory, "watches", "snapshots", `${watch.id}.txt`));
    expect(info.mode & 0o777).toBe(0o600);

    const event = await store.addEvent(eventInput(watch));
    expect(await store.listEvents()).toHaveLength(1);

    await store.delete(watch.id);
    expect(await store.list()).toHaveLength(0);
    expect(await store.listEvents()).toHaveLength(0);
    expect(await store.readSnapshot(watch.id)).toBeUndefined();
    expect(await store.listEvents({ watchId: event.watchId })).toHaveLength(0);
  });

  it("tracks unread events and acknowledges by event, watch, or all", async () => {
    const first = await store.create(newWatch);
    const second = await store.create({
      ...newWatch,
      name: "Status",
      url: "https://example.com/status",
    });
    const firstEvent = await store.addEvent(eventInput(first));
    await store.addEvent(eventInput(first, ["Second role"]));
    const secondEvent = await store.addEvent(eventInput(second));

    expect(await store.unreadCount()).toBe(3);
    expect([...(await store.unreadCounts()).values()].reduce((sum, value) => sum + value, 0)).toBe(3);
    expect((await store.listEvents())[0].id).toBe(secondEvent.id);

    expect(await store.ack({ eventIds: [firstEvent.id] })).toBe(1);
    expect(await store.unreadCount()).toBe(2);

    expect(await store.ack({ watchId: first.id })).toBe(1);
    expect(await store.unreadCount()).toBe(1);

    expect(await store.ack({ all: true })).toBe(1);
    expect(await store.unreadCount()).toBe(0);
    expect(await store.ack({ all: true })).toBe(0);

    expect(await store.listEvents({ unreadOnly: true })).toHaveLength(0);
    expect(await store.listEvents({ unreadOnly: false })).toHaveLength(3);
  });

  it("requires an acknowledgement selector", async () => {
    await expect(store.ack({})).rejects.toThrow(/eventIds/);
  });

  it("removes events for a deleted watch only", async () => {
    const first = await store.create(newWatch);
    const second = await store.create({
      ...newWatch,
      name: "Status",
      url: "https://example.com/status",
    });
    await store.addEvent(eventInput(first));
    const kept = await store.addEvent(eventInput(second));

    await store.delete(first.id);
    const events = await store.listEvents();
    expect(events.map((event) => event.id)).toEqual([kept.id]);
  });

  it("evicts the oldest acknowledged event when the event limit is reached", async () => {
    const watch = await store.create(newWatch);
    const base = Date.now();
    const existing = Array.from({ length: 500 }, (_, index) => ({
      id: randomUUID(),
      watchId: watch.id,
      watchName: watch.name,
      url: watch.url,
      title: "Careers",
      titleChanged: false,
      intent: watch.intent,
      detectedAt: new Date(base + index).toISOString(),
      added: [],
      removed: [],
      addedCount: 0,
      removedCount: 0,
      diffTruncated: false,
      currentExcerpt: "",
      snapshotChars: 0,
      truncated: false,
      ...(index === 2
        ? { acknowledgedAt: new Date(base + index).toISOString() }
        : {}),
    }));
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "watch-events.json"),
      JSON.stringify({ events: existing }),
      { mode: 0o600 },
    );

    await store.addEvent(eventInput(watch, ["Newest role"]));
    const events = await store.listEvents({ limit: 500 });
    expect(events).toHaveLength(500);
    expect(events.some((event) => event.id === existing[2].id)).toBe(false);
    expect(await store.unreadCount()).toBe(500);
  });
});
