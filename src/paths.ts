import { mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { hash } from "./common.js";

export interface PiLockRuntimePaths {
  home: string;
  projectKey: string;
  project: string;
  state: string;
  sessions: string;
  ui: string;
  releases: string;
}

export function piLockHome(): string {
  const configured = process.env.PI_LOCK_HOME?.trim();
  if (!configured) return resolve(homedir(), ".pi-lock");
  if (configured === "~") return homedir();
  if (configured.startsWith("~/")) return resolve(homedir(), configured.slice(2));
  return resolve(configured);
}

export function runtimePaths(projectRoot: string): PiLockRuntimePaths {
  const root = realpathSync(projectRoot);
  const home = piLockHome();
  const projectKey = hash(root).slice(0, 32);
  const project = resolve(home, "projects", projectKey);
  const state = resolve(project, "state");
  return {
    home,
    projectKey,
    project,
    state,
    sessions: resolve(state, "sessions"),
    ui: resolve(state, "ui"),
    releases: resolve(home, "releases"),
  };
}

export function prepareRuntimePaths(projectRoot: string): PiLockRuntimePaths {
  const paths = runtimePaths(projectRoot);
  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  mkdirSync(resolve(paths.home, "projects"), { recursive: true, mode: 0o700 });
  mkdirSync(paths.releases, { recursive: true, mode: 0o700 });
  mkdirSync(paths.project, { recursive: true, mode: 0o700 });
  mkdirSync(paths.state, { recursive: true, mode: 0o700 });
  mkdirSync(paths.sessions, { recursive: true, mode: 0o700 });
  mkdirSync(paths.ui, { recursive: true, mode: 0o700 });
  return paths;
}
