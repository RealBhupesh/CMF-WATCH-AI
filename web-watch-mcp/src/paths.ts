import { mkdir, chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AppConfig } from "./config.js";

export interface AppPaths {
  dataDir: string;
  browserProfileDir: string;
  profileFile: string;
  applicationsFile: string;
  resumesDir: string;
  resumeFilesDir: string;
  resumeInboxDir: string;
  resumeIndexFile: string;
  screenshotsDir: string;
  logsDir: string;
  oauthDir: string;
  oauthClientsFile: string;
  oauthRefreshTokensFile: string;
  oauthRevokedFile: string;
  filesDir: string;
  fileBlobsDir: string;
  fileInboxDir: string;
  fileIndexFile: string;
  sessionsDir: string;
  sessionsFile: string;
  tasksFile: string;
  workflowsFile: string;
  watchesDir: string;
  watchesFile: string;
  watchSnapshotsDir: string;
  watchEventsFile: string;
}

export function createPaths(config: AppConfig): AppPaths {
  const dataDir = config.dataDir;
  const resumesDir = join(dataDir, "resumes");
  const oauthDir = join(dataDir, "oauth");

  return {
    dataDir,
    browserProfileDir: config.browser.profileDir,
    profileFile: join(dataDir, "profile.json"),
    applicationsFile: join(dataDir, "applications.jsonl"),
    resumesDir,
    resumeFilesDir: join(resumesDir, "files"),
    resumeInboxDir: join(resumesDir, "inbox"),
    resumeIndexFile: join(resumesDir, "index.json"),
    screenshotsDir: join(dataDir, "screenshots"),
    logsDir: join(dataDir, "logs"),
    oauthDir,
    oauthClientsFile: join(oauthDir, "clients.json"),
    oauthRefreshTokensFile: join(oauthDir, "refresh-tokens.json"),
    oauthRevokedFile: join(oauthDir, "revoked.json"),
    filesDir: join(dataDir, "files"),
    fileBlobsDir: join(dataDir, "files", "blobs"),
    fileInboxDir: join(dataDir, "files", "inbox"),
    fileIndexFile: join(dataDir, "files", "index.json"),
    sessionsDir: join(dataDir, "sessions"),
    sessionsFile: join(dataDir, "sessions", "index.json"),
    tasksFile: join(dataDir, "tasks.json"),
    workflowsFile: join(dataDir, "workflows.json"),
    watchesDir: join(dataDir, "watches"),
    watchesFile: join(dataDir, "watches.json"),
    watchSnapshotsDir: join(dataDir, "watches", "snapshots"),
    watchEventsFile: join(dataDir, "watch-events.json"),
  };
}

export async function ensurePaths(paths: AppPaths): Promise<void> {
  const directories = [
    paths.dataDir,
    paths.browserProfileDir,
    paths.resumesDir,
    paths.resumeFilesDir,
    paths.resumeInboxDir,
    paths.screenshotsDir,
    paths.logsDir,
    paths.oauthDir,
    paths.fileBlobsDir,
    paths.fileInboxDir,
    paths.sessionsDir,
    paths.watchesDir,
    paths.watchSnapshotsDir,
    dirname(paths.applicationsFile),
    dirname(paths.profileFile),
  ];

  await Promise.all(
    directories.map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })),
  );

  await Promise.all(
    [paths.dataDir, paths.oauthDir, paths.resumesDir].map((directory) =>
      chmod(directory, 0o700).catch(() => undefined),
    ),
  );
}
