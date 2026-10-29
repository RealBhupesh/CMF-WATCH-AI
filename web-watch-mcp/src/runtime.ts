import type { AppConfig } from "./config.js";
import { Logger } from "./logger.js";
import { createPaths, ensurePaths, type AppPaths } from "./paths.js";
import { ApplicationStore } from "./applications.js";
import type { BrowserManager } from "./browser/browser-manager.js";
import { BrowserSessions } from "./browser/sessions.js";
import { FileStore } from "./files.js";
import { TaskStore } from "./tasks.js";
import { ProfileStore } from "./profile.js";
import { ResumeStore } from "./resumes.js";
import { ToolControl } from "./control.js";
import { WorkflowStore } from "./workflows/store.js";
import { WorkflowRunner } from "./workflows/runner.js";
import { WatchStore } from "./watches/store.js";
import { WatchRunner } from "./watches/runner.js";

export interface Runtime {
  control: ToolControl;
  config: AppConfig;
  paths: AppPaths;
  logger: Logger;
  profile: ProfileStore;
  resumes: ResumeStore;
  applications: ApplicationStore;
  browser: BrowserManager;
  sessions: BrowserSessions;
  files: FileStore;
  tasks: TaskStore;
  workflows: WorkflowStore;
  automation: WorkflowRunner;
  watches: WatchStore;
  watchRunner: WatchRunner;
  close(): Promise<void>;
}

export async function createRuntime(
  config: AppConfig,
  logger: Logger,
): Promise<Runtime> {
  const paths = createPaths(config);
  await ensurePaths(paths);

  const profile = new ProfileStore(paths.profileFile);
  const resumes = new ResumeStore(paths, config.limits);
  const applications = new ApplicationStore(paths.applicationsFile);
  const sessions = new BrowserSessions(config, paths, logger.child("browser"));
  const tasks = new TaskStore(paths.tasksFile);
  await tasks.recoverInterrupted();
  const workflows = new WorkflowStore(paths.workflowsFile);
  await workflows.recover();
  const watches = new WatchStore(paths);

  const runtime: Runtime = {
    control: new ToolControl(),
    config,
    paths,
    logger,
    profile,
    resumes,
    applications,
    sessions,
    files: new FileStore(paths, config.limits),
    tasks,
    workflows,
    watches,
    get automation() { return automation; },
    get watchRunner() { return watchRunner; },
    get browser() { return sessions.current(); },
    async close(): Promise<void> {
      await watchRunner.close();
      await automation.close();
      await sessions.closeAll();
    },
  };
  const automation = new WorkflowRunner(runtime);
  const watchRunner = new WatchRunner(runtime);
  return runtime;
}
