import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createPaths, ensurePaths, type AppPaths } from "../src/paths.js";
import { mergeDeep, ProfileStore } from "../src/profile.js";

let directory: string;
let paths: AppPaths;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "job-crawler-profile-"));
  const config = loadConfig("stdio", { DATA_DIR: directory });
  paths = createPaths(config);
  await ensurePaths(paths);
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("ProfileStore", () => {
  it("merges nested updates", async () => {
    const store = new ProfileStore(paths.profileFile);
    await store.update({ fullName: "Ada Lovelace", location: { city: "London" } });
    await store.update({ email: "ada@example.com", location: { country: "UK" } });

    const result = await store.get();
    expect(result.profile.fullName).toBe("Ada Lovelace");
    expect(result.profile.email).toBe("ada@example.com");
    expect(result.profile.location).toEqual({ city: "London", country: "UK" });
    expect(result.isEmpty).toBe(false);
  });

  it("replaces the entire profile on request", async () => {
    const store = new ProfileStore(paths.profileFile);
    await store.update({ fullName: "Ada Lovelace", email: "ada@example.com" });
    await store.update({ fullName: "Grace Hopper" }, true);

    const result = await store.get();
    expect(result.profile.fullName).toBe("Grace Hopper");
    expect(result.profile.email).toBeUndefined();
  });

  it("clears the active profile", async () => {
    const store = new ProfileStore(paths.profileFile);
    await store.update({ fullName: "Alan Turing" });
    await store.clear();

    const result = await store.get();
    expect(result.profile).toEqual({});
    expect(result.isEmpty).toBe(true);
  });

  it("reports missing required fields", async () => {
    const store = new ProfileStore(paths.profileFile);
    const result = await store.get();
    expect(result.missingFields.map((entry) => entry.field)).toContain("email");
  });
});

describe("mergeDeep", () => {
  it("ignores prototype pollution keys", () => {
    const patch = JSON.parse('{"__proto__":{"polluted":true},"safe":"value"}') as Record<string, unknown>;
    const merged = mergeDeep<Record<string, unknown>>({}, patch);
    expect(merged.safe).toBe("value");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
