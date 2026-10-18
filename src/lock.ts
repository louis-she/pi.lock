import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { atomicJson, digest, fail, FORMAT, hash, inside, json, PI_VERSION } from "./common.js";
import { readDefinition, runtimeIdentity, type Definition } from "./definition.js";
import { modelIdentity, modelRuntime, selectedModel } from "./model.js";

export interface AgentLock {
  lockfileVersion: 1;
  runtime: ReturnType<typeof runtimeIdentity>;
  definition: Definition;
  model: unknown;
  effective?: unknown;
  agentDigest: string;
}
export function lockDigest(lock: Omit<AgentLock, "agentDigest"> | AgentLock): string {
  const { agentDigest: _, ...content } = lock as AgentLock;
  return digest(content);
}
export async function draftLock(root: string, allowUnselectedModel = false): Promise<AgentLock> {
  const definition = readDefinition(root, allowUnselectedModel);
  const runtime = await modelRuntime(definition, { env: {} });
  const selected = selectedModel(runtime, definition, allowUnselectedModel);
  const model = selected ? modelIdentity(selected) : null;
  const content = { lockfileVersion: FORMAT as 1, runtime: runtimeIdentity(), definition, model };
  return { ...content, agentDigest: lockDigest(content) };
}
export function readLock(root: string): AgentLock {
  const path = resolve(root, "pi.lock");
  if (!existsSync(path)) fail("LOCK_MISSING", "No pi.lock found. Run pi-lock lock once before frozen execution, or use --dev while editing.");
  const lock = json<AgentLock>(path);
  if (lock.lockfileVersion !== FORMAT || !Array.isArray(lock.definition?.files) || !lock.runtime) fail("LOCK_FORMAT", "Unsupported or malformed pi.lock.");
  if (lockDigest(lock) !== lock.agentDigest) fail("LOCK_CORRUPT", "pi.lock content does not match its digest.");
  if (lock.runtime.pi !== PI_VERSION || digest(lock.runtime) !== digest(runtimeIdentity())) fail("ENGINE_MISMATCH", "Installed Pi/pi-lock runtime differs from pi.lock. Restore the matching npm dependencies and pi-lock release.");
  return lock;
}
export function verifyDefinition(root: string, lock: AgentLock): void {
  const definition = readDefinition(root);
  if (digest(definition) !== digest(lock.definition)) {
    const changed = definition.files.filter(f => lock.definition.files.find(p => p.path === f.path)?.sha256 !== f.sha256).map(f => f.path);
    const removed = lock.definition.files.filter(f => !definition.files.some(p => p.path === f.path)).map(f => f.path);
    fail("LOCK_DRIFT", `Agent files/configuration differ from pi.lock: ${[...changed, ...removed].slice(0, 8).join(", ") || "resolved resources"}. Review your changes, then run pi-lock lock.`);
  }
}
export function verifySnapshot(root: string, lock: AgentLock): void {
  for (const file of lock.definition.files) {
    const path = inside(root, file.path);
    if (!existsSync(path) || hash(readFileSync(path)) !== file.sha256 || Boolean(statSync(path).mode & 0o111) !== file.executable) fail("SNAPSHOT_CORRUPT", `Release resource changed: ${file.path}`);
  }
}
export function verifySourcesBeforeInstall(root: string, lock: AgentLock): void {
  for (const file of lock.definition.files.filter(f => !f.path.startsWith("node_modules/") && !f.path.includes("/node_modules/"))) {
    const path = inside(root, file.path);
    if (!existsSync(path) || hash(readFileSync(path)) !== file.sha256) fail("LOCK_DRIFT", `Source changed before restoring dependencies: ${file.path}`);
  }
}
export function materialize(root: string, lock: AgentLock): string {
  const release = resolve(root, ".pi-lock/releases", lock.agentDigest);
  if (existsSync(resolve(release, ".complete"))) { verifySnapshot(release, lock); return release; }
  mkdirSync(dirname(release), { recursive: true });
  const staging = `${release}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  mkdirSync(staging);
  try {
    for (const file of lock.definition.files) {
      const source = inside(root, file.path);
      const target = inside(staging, file.path);
      const data = readFileSync(source);
      if (hash(data) !== file.sha256) fail("LOCK_DRIFT", `Source changed while creating release: ${file.path}`);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, data, { mode: file.executable ? 0o755 : 0o644 });
    }
    verifySnapshot(staging, lock);
    writeFileSync(resolve(staging, ".complete"), lock.agentDigest);
    try { renameSync(staging, release); }
    catch (e) { if (!existsSync(resolve(release, ".complete"))) throw e; rmSync(staging, { recursive: true, force: true }); }
  } catch (e) { rmSync(staging, { recursive: true, force: true }); throw e; }
  return release;
}
export function saveLock(root: string, lock: AgentLock): void {
  lock.agentDigest = lockDigest(lock);
  atomicJson(resolve(root, "pi.lock"), lock);
}
