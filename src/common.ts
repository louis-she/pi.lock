import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, readdirSync, statSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export const PI_VERSION = "1.3.0";
export const FORMAT = 1;
export class LockError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = "LockError"; }
}
export function fail(code: string, message: string): never { throw new LockError(code, message); }
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).filter(k => (value as any)[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical((value as any)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
export function hash(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
export function digest(value: unknown): string { return hash(canonical(value)); }
export function json<T = any>(path: string): T {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (e) { return fail("INVALID_JSON", `${path}: ${(e as Error).message}`); }
}
export function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(temp, path);
}
export function inside(root: string, path: string): string {
  const full = resolve(root, path);
  const rel = relative(root, full);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) fail("OUTSIDE_PROJECT", `Resource must be inside the agent project: ${path}`);
  if (existsSync(full)) {
    const actual = relative(realpathSync(root), realpathSync(full));
    if (isAbsolute(actual) || actual === ".." || actual.startsWith(`..${sep}`)) fail("OUTSIDE_PROJECT", `Symlink leaves agent project: ${path}`);
  }
  return full;
}
export function portablePath(root: string, full: string): string { return relative(root, full).split(sep).join("/"); }
export function walk(root: string, path: string, skip = new Set<string>()): string[] {
  if (!existsSync(path)) return [];
  inside(root, path);
  if (lstatSync(path).isSymbolicLink()) fail("SYMLINK_RESOURCE", `Use ordinary project files instead of symlinks: ${path}`);
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).sort().filter(name => !skip.has(name)).flatMap(name => walk(root, resolve(path, name), skip));
}
export function findProject(start: string, explicit?: string): string {
  if (explicit) return realpathSync(resolve(explicit));
  let path = realpathSync(resolve(start));
  while (true) {
    if (existsSync(resolve(path, "pi.lock")) || existsSync(resolve(path, ".pi/settings.json"))) return path;
    const parent = dirname(path);
    if (parent === path) fail("NO_PROJECT", "No pi.lock or .pi/settings.json found. Run pi-lock init in the agent project.");
    path = parent;
  }
}
export function replaceRoots(value: unknown, roots: Array<[string, string]>): unknown {
  if (typeof value === "string") {
    for (const [root, label] of [...roots].sort((a, b) => b[0].length - a[0].length)) value = (value as string).split(root).join(label);
    return value;
  }
  if (Array.isArray(value)) return value.map(v => replaceRoots(v, roots));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replaceRoots(v, roots)]));
  return value;
}
