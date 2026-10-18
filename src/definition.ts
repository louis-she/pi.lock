import { existsSync, readFileSync, statSync, readdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import { minimatch } from "minimatch";
import { digest, fail, hash, inside, json, PI_VERSION, portablePath, walk } from "./common.js";

export interface FileRecord { path: string; sha256: string; executable: boolean; }
export interface Resources { extensions: string[]; skills: string[]; prompts: string[]; themes: string[]; context: string[]; system?: string; append?: string; }
export interface Definition {
  settings: Record<string, any>;
  files: FileRecord[];
  resources: Resources;
  dependencies: Array<{ path: string; name: string; version: string; integrity?: string }>;
  modelConfig: Record<string, any>;
}
const HOST = /^(?:@(?:earendil-works|mariozechner)\/(?:pi-ai(?:\/.*)?|pi-agent-core|pi-coding-agent|pi-tui)|(?:@sinclair\/)?typebox(?:\/.*)?|pi\.lock)$/;
const OMIT = new Set(["node_modules", ".git", ".pi-lock", ".DS_Store"]);

function directories(root: string, path: string): string[] {
  if (!existsSync(path)) return [];
  inside(root, path);
  return readdirSync(path).sort().map(n => resolve(path, n));
}
function extensionEntries(root: string, path: string): string[] {
  inside(root, path);
  if (!existsSync(path)) fail("MISSING_RESOURCE", `Extension not found: ${path}`);
  if (!statSync(path).isDirectory()) return [path];
  const manifest = resolve(path, "package.json");
  if (existsSync(manifest) && json(manifest).pi?.extensions) {
    return manifestEntries(root, path, json(manifest).pi.extensions);
  }
  for (const name of ["index.ts", "index.js", "index.mjs", "index.cjs"]) if (existsSync(resolve(path, name))) return [resolve(path, name)];
  return directories(root, path).flatMap(p => statSync(p).isDirectory() ? extensionEntries(root, p) : /\.(?:[cm]?js|ts)$/.test(p) ? [p] : []);
}
function matches(path: string, pattern: string): boolean {
  const p = pattern.replace(/^[+!\-]/, "").replace(/^\.\//, "").replace(/\/$/, "");
  return minimatch(path, p, { dot: true }) || (!/[*?\[\]{}]/.test(p) && path.startsWith(p + "/"));
}
function filterPaths(root: string, base: string, paths: string[], patterns: string[]): string[] {
  const positive = patterns.filter(p => !p.startsWith("!") && !p.startsWith("-"));
  const negative = patterns.filter(p => p.startsWith("!") || p.startsWith("-"));
  return [...new Set(paths)].filter(path => {
    const rel = portablePath(base, inside(root, path));
    return (!positive.length || positive.some(p => matches(rel, p))) && !negative.some(p => matches(rel, p));
  });
}
function skillEntries(root: string, path: string): string[] {
  if (!statSync(path).isDirectory()) return path.endsWith(".md") ? [path] : [];
  const main = resolve(path, "SKILL.md");
  if (existsSync(main)) return [main];
  return directories(root, path).filter(p => !OMIT.has(basename(p))).flatMap(p => skillEntries(root, p));
}
function expandResource(root: string, path: string, kind: string): string[] {
  return kind === "extensions" ? extensionEntries(root, path) : kind === "skills" ? skillEntries(root, path) : walk(root, path, OMIT).filter(f => kind === "prompts" ? f.endsWith(".md") : f.endsWith(".json"));
}
function manifestEntries(root: string, base: string, entries: unknown, kind = "extensions"): string[] {
  if (!Array.isArray(entries) || entries.some(p => typeof p !== "string")) fail("INVALID_MANIFEST", `Resource entries in ${base}/package.json must be strings.`);
  const selected: string[] = [];
  const allFiles = walk(root, base, OMIT);
  const candidates = new Set(allFiles);
  for (const file of allFiles) { let dir = dirname(file); while (dir !== base && dir.startsWith(base + "/")) { candidates.add(dir); dir = dirname(dir); } }
  for (const pattern of entries.filter(p => !p.startsWith("!") && !p.startsWith("-"))) {
    const p = pattern.replace(/^\+/, "");
    if (/^[~\/]|^[A-Za-z]:/.test(p)) fail("NON_PORTABLE_PATH", `Use package-relative paths: ${p}`);
    if (/[*?\[\]{}]/.test(p)) {
      for (const path of candidates) if (minimatch(portablePath(base, path), p.replace(/^\.\//, ""), { dot: true })) selected.push(...expandResource(root, path, kind));
    } else {
      const path = inside(root, resolve(base, p));
      if (!existsSync(path)) fail("MISSING_RESOURCE", `Missing package resource ${path}.`);
      if (kind === "extensions" && path === base) fail("INVALID_MANIFEST", "A package cannot recursively use itself as its extensions directory.");
      selected.push(...expandResource(root, path, kind));
    }
  }
  return filterPaths(root, base, selected, entries.filter(p => p.startsWith("!") || p.startsWith("-")));
}

export function readDefinition(root: string, allowUnselectedModel = false): Definition {
  const config = resolve(root, ".pi");
  const settingsFile = resolve(config, "settings.json");
  if (!existsSync(settingsFile)) fail("NO_SETTINGS", "Expected .pi/settings.json. Run pi-lock init.");
  const settings = json(settingsFile);
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) fail("INVALID_SETTINGS", ".pi/settings.json must contain an object.");
  const hasProvider = typeof settings.defaultProvider === "string" && Boolean(settings.defaultProvider);
  const hasModel = typeof settings.defaultModel === "string" && Boolean(settings.defaultModel);
  if ((!hasProvider || !hasModel) && !(allowUnselectedModel && !hasProvider && !hasModel)) {
    const message = allowUnselectedModel
      ? "Set both defaultProvider and defaultModel, or leave both unset and choose a model with /model in dev mode."
      : "Set defaultProvider and defaultModel in .pi/settings.json; frozen agents never choose a fallback model.";
    fail("MODEL_REQUIRED", message);
  }
  if (settings.defaultThinkingLevel && !["off", "minimal", "low", "medium", "high", "xhigh"].includes(settings.defaultThinkingLevel)) fail("INVALID_SETTINGS", "Invalid defaultThinkingLevel.");
  for (const key of ["extensions", "skills", "prompts", "themes", "defaultTools", "packages"]) {
    if (settings[key] !== undefined && !Array.isArray(settings[key])) fail("INVALID_SETTINGS", `${key} must be an array.`);
  }
  for (const key of ["auth.json", "mcp-auth.json", "models-store.json", "trust.json", "sessions"]) {
    if (existsSync(resolve(config, key))) fail("RUNTIME_STATE_IN_DEFINITION", `.pi/${key} is machine state or credentials. Keep it outside the Agent definition.`);
  }
  const files = new Set(walk(root, config, OMIT));
  for (const name of ["package.json", "package-lock.json"]) if (existsSync(resolve(root, name))) files.add(resolve(root, name));
  const resources: Resources = { extensions: [], skills: [], prompts: [], themes: [], context: [] };
  for (const n of ["SYSTEM.md", "APPEND_SYSTEM.md"]) if (existsSync(resolve(config, n))) resources[n === "SYSTEM.md" ? "system" : "append"] = portablePath(root, resolve(config, n));
  for (const n of ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]) {
    if (existsSync(resolve(config, n))) { resources.context.push(portablePath(root, resolve(config, n))); break; }
  }
  for (const n of ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]) {
    if (existsSync(resolve(root, n))) { resources.context.push(n); files.add(resolve(root, n)); break; }
  }
  const bases: Record<string, string[]> = {};
  const excluded: Record<string, string[]> = {};
  for (const kind of ["extensions", "skills", "prompts", "themes"] as const) {
    bases[kind] = directories(root, resolve(config, kind));
    excluded[kind] = [];
    if (kind === "skills" && existsSync(resolve(root, ".agents/skills"))) {
      bases[kind].push(resolve(root, ".agents/skills"));
      walk(root, resolve(root, ".agents/skills"), OMIT).forEach(f => files.add(f));
    }
    for (const raw of settings[kind] ?? []) {
      if (typeof raw !== "string") fail("INVALID_SETTINGS", `${kind} entries must be relative paths.`);
      if (raw.startsWith("-") || raw.startsWith("!")) { excluded[kind].push(raw); continue; }
      const item = raw.replace(/^\+/, "");
      if (item.startsWith("builtin:")) {
        if (kind !== "extensions" || !["builtin:codemode", "builtin:tool_search"].includes(item)) fail("UNSUPPORTED_BUILTIN", `Unsupported built-in: ${item}. MCP is configured through .pi/mcp.json.`);
        bases[kind].push(item); continue;
      }
      if (/^[~\/]|^[A-Za-z]:/.test(item)) fail("NON_PORTABLE_PATH", `${kind}: use project-relative paths, got ${item}.`);
      if (/[*?\[\]{}]/.test(item)) { bases[kind].push(...manifestEntries(root, config, [item], kind)); continue; }
      const path = inside(root, resolve(config, item));
      if (!existsSync(path)) fail("MISSING_RESOURCE", `Missing ${kind}: ${path}`);
      bases[kind].push(path);
      walk(root, path, OMIT).forEach(f => files.add(f));
    }
  }
  const dependencies: Definition["dependencies"] = [];
  const visited = new Set<string>();
  function capturePackage(path: string): void {
    inside(root, path);
    const rel = portablePath(root, path);
    if (visited.has(rel)) return;
    visited.add(rel);
    const pkg = json(resolve(path, "package.json"));
    const lockRoot = rel.startsWith(".pi/npm/node_modules/") ? resolve(config, "npm") : root;
    const lockFile = resolve(lockRoot, "package-lock.json");
    if (!existsSync(lockFile)) fail("DEPENDENCY_LOCK_REQUIRED", `Missing ${portablePath(root, lockFile)}. Install project dependencies with npm and commit its lockfile.`);
    const lockEntry = json(lockFile).packages?.[portablePath(lockRoot, path)];
    if (!lockEntry || lockEntry.link || lockEntry.version !== pkg.version || !lockEntry.integrity) fail("DEPENDENCY_MISMATCH", `${rel} does not match an integrity-pinned npm lock entry. Run npm ci.`);
    dependencies.push({ path: rel, name: pkg.name, version: pkg.version, integrity: lockEntry.integrity });
    if (typeof lockEntry.resolved === "string" && lockEntry.resolved.startsWith("file:")) {
      const archive = inside(root, resolve(lockRoot, lockEntry.resolved.slice(5)));
      if (!existsSync(archive) || !statSync(archive).isFile()) fail("NON_PORTABLE_DEPENDENCY", `Keep the npm tarball inside this project: ${lockEntry.resolved}`);
      files.add(archive);
    }
    files.add(lockFile);
    if (existsSync(resolve(lockRoot, "package.json"))) files.add(resolve(lockRoot, "package.json"));
    walk(root, path, OMIT).forEach(f => files.add(f));
    for (const name of new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})])) {
      if (HOST.test(name)) continue;
      const child = locatePackage(path, name, root);
      if (!child) {
        if (pkg.optionalDependencies?.[name] || pkg.peerDependenciesMeta?.[name]?.optional) continue;
        fail("MISSING_DEPENDENCY", `${pkg.name} requires ${name}. Run npm ci.`);
      }
      capturePackage(child);
    }
  }
  // Capture imports used by local extensions as well as explicit Pi packages.
  const rootPkg = existsSync(resolve(root, "package.json")) ? json(resolve(root, "package.json")) : {};
  for (const name of Object.keys(rootPkg.dependencies ?? {})) {
    if (HOST.test(name)) continue;
    const path = locatePackage(root, name, root);
    if (!path) fail("MISSING_DEPENDENCY", `Missing ${name}. Run npm ci.`);
    capturePackage(path);
  }
  for (const declaration of settings.packages ?? []) {
    const source = typeof declaration === "string" ? declaration : declaration?.source;
    if (typeof source !== "string") fail("INVALID_PACKAGE", "Pi packages need a source.");
    let base: string;
    if (source.startsWith("npm:")) {
      const match = /^npm:((?:@[^/]+\/)?[^@]+)(?:@(.+))?$/.exec(source)!;
      if (!match) fail("INVALID_PACKAGE", `Invalid npm source: ${source}`);
      const [, name, requested] = match;
      base = [resolve(root, "node_modules", name), resolve(config, "npm/node_modules", name)].find(p => existsSync(resolve(p, "package.json"))) ?? fail("MISSING_DEPENDENCY", `Install ${name} locally with npm or pi install -l, then lock it.`);
      const version = json(resolve(base, "package.json")).version;
      if (requested && requested !== version) fail("UNPINNED_PACKAGE", `${source}: use the installed exact version ${version}, or omit the version and let pi.lock pin it.`);
      capturePackage(base);
    } else {
      if (/^(?:git:|https?:|~|\/)/.test(source)) fail("NON_PORTABLE_PACKAGE", `Use an npm lockfile for ${source}, or vendor a Git checkout inside the project and reference it relatively.`);
      base = inside(root, resolve(config, source));
      walk(root, base, OMIT).forEach(f => files.add(f));
    }
    if (!existsSync(base)) fail("MISSING_RESOURCE", `Missing package ${source}.`);
    if (statSync(base).isFile()) { bases.extensions.push(base); continue; }
    const pkg = existsSync(resolve(base, "package.json")) ? json(resolve(base, "package.json")) : {};
    const manifest = pkg.pi ?? {};
    for (const kind of ["extensions", "skills", "prompts", "themes"] as const) {
      const entries = manifest[kind] ? manifestEntries(root, base, manifest[kind], kind) : existsSync(resolve(base, kind)) ? expandResource(root, resolve(base, kind), kind) : [];
      const filters = typeof declaration === "object" ? declaration[kind] : undefined;
      if (filters !== undefined) {
        if (!Array.isArray(filters) || filters.some(p => typeof p !== "string")) fail("INVALID_FILTER", "Package resource filters must be string arrays.");
        if (!filters.length) continue;
        bases[kind].push(...filterPaths(root, base, entries, filters)); continue;
      }
      bases[kind].push(...entries);
    }
  }
  for (const kind of ["extensions", "skills", "prompts", "themes"] as const) {
    const paths = bases[kind].flatMap(p => p.startsWith("builtin:") ? [p] : expandResource(root, p, kind));
    const files = paths.filter(p => !p.startsWith("builtin:"));
    const filtered = filterPaths(root, config, files, excluded[kind]);
    resources[kind] = [...new Set([...filtered.map(p => portablePath(root, p)), ...paths.filter(p => p.startsWith("builtin:") && !excluded[kind].includes(`-${p}`))])];
  }
  // Include local helper imports, and reject undeclared ambient npm imports before executing code.
  const imports = resources.extensions.filter(p => !p.startsWith("builtin:")).map(p => resolve(root, p));
  const checked = new Set<string>();
  while (imports.length) {
    const file = imports.shift()!;
    if (checked.has(file)) continue;
    checked.add(file);
    const text = readFileSync(file, "utf8");
    const pattern = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;
    for (const match of text.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier.startsWith("node:") || builtinModules.includes(specifier) || HOST.test(specifier)) continue;
      if (specifier.startsWith(".")) {
        const path = inside(root, resolve(dirname(file), specifier));
        const candidates = [path, `${path}.ts`, `${path}.js`, path.replace(/\.js$/, ".ts"), resolve(path, "index.ts"), resolve(path, "index.js")];
        const found = candidates.find(p => existsSync(p) && statSync(p).isFile());
        if (!found) fail("MISSING_IMPORT", `${portablePath(root, file)} imports missing local file ${specifier}.`);
        files.add(found); if (/\.(?:[cm]?js|ts)$/.test(found)) imports.push(found);
      } else {
        const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
        const path = locatePackage(dirname(file), name, root);
        if (!path) fail("UNDECLARED_IMPORT", `${portablePath(root, file)} imports ${name}, which is not installed inside this agent project.`);
        capturePackage(path);
      }
    }
  }
  const modelsPath = resolve(config, "models.json");
  const modelConfig = existsSync(modelsPath) ? json(modelsPath) : {};
  for (const [provider, cfg] of Object.entries<any>(modelConfig.providers ?? {})) {
    if (cfg.apiKey && !/^[A-Z][A-Z0-9_]*$/.test(cfg.apiKey)) fail("SECRET_IN_DEFINITION", `${provider}.apiKey must name an environment variable, not contain a credential or shell command.`);
    for (const [key, value] of Object.entries(cfg.headers ?? {})) {
      if (/authorization|api[-_]?key|token|secret/i.test(key) || (typeof value === "string" && (value.startsWith("!") || value.includes("${")))) fail("SECRET_IN_DEFINITION", "Keep authentication in the supplied credential store or apiKey environment reference, not models.json headers.");
    }
  }
  const mcpPath = resolve(config, "mcp.json");
  if (existsSync(mcpPath)) {
    for (const server of Object.values<any>(json(mcpPath).mcpServers ?? {})) {
      for (const arg of [server.command, ...(server.args ?? [])]) {
        if (typeof arg === "string" && arg.startsWith("./")) walk(root, inside(root, arg), OMIT).forEach(f => files.add(f));
      }
    }
  }
  const records = [...files].map(f => {
    inside(root, f);
    return { path: portablePath(root, f), sha256: hash(readFileSync(f)), executable: Boolean(statSync(f).mode & 0o111) };
  }).sort((a, b) => a.path.localeCompare(b.path, "en"));
  return { settings, files: records, resources, dependencies: dependencies.sort((a, b) => a.path.localeCompare(b.path, "en")), modelConfig };
}

function locatePackage(from: string, name: string, root: string): string | undefined {
  let base = from;
  while (true) {
    const candidate = resolve(base, "node_modules", name);
    if (existsSync(resolve(candidate, "package.json"))) return inside(root, candidate);
    if (base === root || !base.startsWith(root + "/")) break;
    base = dirname(base);
  }
  return undefined;
}

// Hash the actual shipped runtime closure, not just its mutable package version string.
let runtimeHash: string | undefined;
export function runtimeIdentity(): { pi: string; adapter: string; sha256: string } {
  if (runtimeHash) return { pi: PI_VERSION, adapter: "0.1.0", sha256: runtimeHash };
  const require = createRequire(import.meta.url);
  const packages = new Map<string, string>();
  const hostRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const identities: unknown[] = [];
  function add(path: string): void {
    const pkg = json(resolve(path, "package.json"));
    const key = `${pkg.name}@${pkg.version}`;
    if (packages.has(key)) return;
    const files = walk(path, path, new Set(["node_modules", ".git", ".DS_Store"]));
    // npm may hoist a developer's @types/node into a dependency's type-only edge.
    // Declaration packages do not execute in Pi and must not make runtime identity
    // depend on whether the embedding app has TypeScript devDependencies installed.
    if (pkg.name.startsWith("@types/") || (pkg.types && !files.some(f => /\.(?:[cm]?js|node|wasm)$/.test(f)))) return;
    packages.set(key, path);
    const content = files.map(f => [portablePath(path, f), hash(readFileSync(f))]);
    identities.push({ name: pkg.name, version: pkg.version, content });
    const localRequire = createRequire(resolve(path, "package.json"));
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      try {
        const entry = localRequire.resolve.paths(dep)?.map(base => resolve(base, dep)).find(base => existsSync(resolve(base, "package.json")));
        if (!entry) throw new Error(dep);
        add(entry);
      } catch (e) { fail("RUNTIME_DEPENDENCY_MISSING", `Cannot verify runtime dependency ${dep}: ${(e as Error).message}`); }
    }
  }
  const host = json(resolve(hostRoot, "package.json"));
  identities.push({ name: host.name, version: host.version, files: walk(hostRoot, resolve(hostRoot, "dist")).filter(f => f.endsWith(".js")).map(f => [portablePath(hostRoot, f), hash(readFileSync(f))]) });
  for (const dep of Object.keys(host.dependencies ?? {})) {
    const entry = require.resolve.paths(dep)?.map(base => resolve(base, dep)).find(base => existsSync(resolve(base, "package.json"))) ?? fail("RUNTIME_DEPENDENCY_MISSING", dep);
    add(entry);
  }
  runtimeHash = digest(identities.sort((a: any, b: any) => a.name.localeCompare(b.name, "en") || a.version.localeCompare(b.version, "en")));
  return { pi: PI_VERSION, adapter: "0.1.0", sha256: runtimeHash };
}
