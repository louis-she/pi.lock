import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { createEventBus, createExtensionRuntime, createCodemodeExtension, createToolSearchExtension, createSyntheticSourceInfo, parseFrontmatter, type ResourceLoader, type LoadExtensionsResult, type Skill, type PromptTemplate, type Theme } from "@earendil-works/pi-coding-agent";
import { explicitExtensionLoader, internalModule } from "./bridge.js";
import type { Definition } from "./definition.js";
import { fail } from "./common.js";
import { prepareMcp, type LockedMcp } from "./mcp.js";

export class LockedResourceLoader implements ResourceLoader {
  private extensions!: LoadExtensionsResult;
  private themes: Theme[] = [];
  mcp?: LockedMcp;
  constructor(public root: string, readonly workspace: string, public definition: Definition, private env: Record<string, string | undefined> = process.env, private expectedMcp?: Record<string, unknown>) {}
  async reload(): Promise<void> {
    try { await this.load(); }
    catch (error) { await this.mcp?.close(); throw error; }
  }
  private async load(): Promise<void> {
    const events = createEventBus();
    const bridge = await explicitExtensionLoader();
    const shared = createExtensionRuntime();
    const paths = [...this.definition.resources.extensions];
    this.mcp = await prepareMcp(this.root, this.workspace, this.env, this.expectedMcp);
    if (this.mcp) {
      for (const name of ["builtin:codemode", "builtin:tool_search"]) if (!paths.includes(name) && !this.definition.settings.extensions?.includes(`-${name}`)) paths.push(name);
    }
    const alias: Record<string, string> = {};
    alias["pi-lock"] = fileURLToPath(new URL("./index.js", import.meta.url));
    for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-agent-core", "@earendil-works/pi-tui", "typebox", "typebox/compile", "typebox/value"]) alias[name] = fileURLToPath(import.meta.resolve(name));
    for (const sub of ["", "/compat", "/oauth", "/providers/all"]) alias[`@earendil-works/pi-ai${sub}`] = fileURLToPath(import.meta.resolve(`@earendil-works/pi-ai${sub || "/compat"}`));
    for (const [key, value] of Object.entries({ ...alias })) if (key.startsWith("@earendil-works/")) alias[key.replace("@earendil-works/", "@mariozechner/")] = value;
    alias["@sinclair/typebox"] = alias.typebox;
    alias["@sinclair/typebox/compile"] = alias["typebox/compile"];
    alias["@sinclair/typebox/value"] = alias["typebox/value"];
    const jiti = createJiti(import.meta.url, { alias, moduleCache: false, fsCache: false, tsconfigPaths: false, tryNative: false, interopDefault: true, transformModules: [], nativeModules: ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "@earendil-works/pi-agent-core", "@earendil-works/pi-tui", "typebox"] });
    const result: LoadExtensionsResult = { extensions: [], errors: [], runtime: shared };
    try {
      for (const path of paths.filter(p => !p.startsWith("builtin:"))) {
        const full = resolve(this.root, path);
        const factory = await jiti.import<any>(full, { default: true });
        if (typeof factory !== "function") fail("INVALID_EXTENSION", `${path} must export a default Pi extension factory.`);
        result.extensions.push(await bridge.loadExtensionFromFactory(factory, this.workspace, events, shared, full));
      }
    } catch (error) { await this.mcp?.close(); throw error; }
    // Reorder factories to exactly the locked declaration order, including built-ins.
    const ordered: LoadExtensionsResult["extensions"] = [];
    for (const path of paths) {
      if (path.startsWith("builtin:")) {
        const factory = path === "builtin:codemode" ? createCodemodeExtension() : createToolSearchExtension();
        ordered.push(await bridge.loadExtensionFromFactory(factory, this.workspace, events, shared, path));
      } else {
        const extension = result.extensions.find(e => e.resolvedPath === resolve(this.root, path) || e.path === resolve(this.root, path));
        if (extension) ordered.push(extension);
      }
    }
    if (this.mcp) ordered.push(await bridge.loadExtensionFromFactory(this.mcp.factory, this.workspace, events, shared, "builtin:mcp"));
    if (result.errors.length) fail("EXTENSION_LOAD_FAILED", result.errors.map(e => `${e.path}: ${e.error}`).join("\n"));
    const names = new Set<string>();
    for (const extension of ordered) for (const name of extension.tools.keys()) {
      if (names.has(name)) fail("RESOURCE_COLLISION", `Duplicate tool name ${name}.`);
      names.add(name);
    }
    this.extensions = { ...result, extensions: ordered };
    const themeModule = this.definition.resources.themes.length ? await internalModule("./modes/interactive/theme/theme.js") : undefined;
    this.themes = this.definition.resources.themes.map(path => themeModule.loadThemeFromPath(resolve(this.root, path)));
    this.getSkills(); this.getPrompts(); // Validate metadata and duplicate names before running.
  }
  getExtensions(): LoadExtensionsResult { return this.extensions; }
  getSkills(): { skills: Skill[]; diagnostics: [] } {
    const names = new Set<string>();
    const skills = this.definition.resources.skills.map(path => {
      const filePath = resolve(this.root, path);
      const { frontmatter } = parseFrontmatter<Record<string, unknown>>(readFileSync(filePath, "utf8"));
      const name = String(frontmatter.name ?? (basename(path) === "SKILL.md" ? basename(dirname(path)) : basename(path, ".md")));
      if (!frontmatter.description || typeof frontmatter.description !== "string") fail("INVALID_SKILL", `${path} needs a description in its frontmatter.`);
      if (names.has(name)) fail("RESOURCE_COLLISION", `Duplicate skill name ${name}.`);
      names.add(name);
      return { name, description: frontmatter.description, filePath, baseDir: dirname(filePath), sourceInfo: createSyntheticSourceInfo(filePath, { source: "pi.lock", scope: "project" }), disableModelInvocation: frontmatter["disable-model-invocation"] === true };
    });
    return { skills, diagnostics: [] };
  }
  getPrompts(): { prompts: PromptTemplate[]; diagnostics: [] } {
    const names = new Set<string>();
    const prompts = this.definition.resources.prompts.map(path => {
      const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(readFileSync(resolve(this.root, path), "utf8"));
      const name = basename(path, ".md");
      if (names.has(name)) fail("RESOURCE_COLLISION", `Duplicate prompt name ${name}.`);
      names.add(name);
      return { name, description: String(frontmatter.description ?? body.split("\n").find(s => s.trim()) ?? name), content: body, sourceInfo: createSyntheticSourceInfo(resolve(this.root, path), { source: "pi.lock", scope: "project" }), filePath: resolve(this.root, path) };
    });
    return { prompts, diagnostics: [] };
  }
  getThemes(): { themes: Theme[]; diagnostics: [] } { return { themes: this.themes, diagnostics: [] }; }
  getAgentsFiles() { return { agentsFiles: this.definition.resources.context.map(path => ({ path: resolve(this.root, path), content: readFileSync(resolve(this.root, path), "utf8") })) }; }
  getSystemPrompt() { const p = this.definition.resources.system; return p ? readFileSync(resolve(this.root, p), "utf8") : undefined; }
  getSystemPromptSource() { const p = this.definition.resources.system; return p ? { path: resolve(this.root, p) } : undefined; }
  getAppendSystemPrompt() { const p = this.definition.resources.append; return p ? [readFileSync(resolve(this.root, p), "utf8")] : []; }
  getAppendSystemPromptSources() { const p = this.definition.resources.append; return p ? [{ path: resolve(this.root, p) }] : []; }
  extendResources(paths: { skillPaths?: unknown[]; promptPaths?: unknown[]; themePaths?: unknown[] }): void {
    if ([paths.skillPaths, paths.promptPaths, paths.themePaths].some(p => p?.length)) fail("UNLOCKED_RESOURCE", "An extension attempted to discover additional resources. Declare them in .pi/settings.json and re-lock.");
  }
}
