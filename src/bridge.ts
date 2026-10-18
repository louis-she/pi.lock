// Pi 1.3.0 exposes ResourceLoader publicly but not its explicit-only extension loader.
// Keep these version-specific imports in one audited bridge; never call discovery.
import { VERSION } from "@earendil-works/pi-coding-agent";
import type { ExtensionFactory, LoadExtensionsResult, ExtensionRuntime, EventBus } from "@earendil-works/pi-coding-agent";
import { PI_VERSION, fail } from "./common.js";

const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
export function assertEngine(): void {
  if (VERSION !== PI_VERSION) fail("ENGINE_MISMATCH", `pi-lock supports Pi ${PI_VERSION}; installed Pi is ${VERSION}. Run npm ci.`);
}
export async function explicitExtensionLoader(): Promise<{
  loadExtensions: (paths: string[], cwd: string, events?: EventBus, runtime?: ExtensionRuntime) => Promise<LoadExtensionsResult>;
  loadExtensionFromFactory: (factory: ExtensionFactory, cwd: string, events: EventBus, runtime: ExtensionRuntime, name?: string) => Promise<LoadExtensionsResult["extensions"][number]>;
}> {
  assertEngine();
  return import(new URL("./core/extensions/loader.js", entry).href);
}
export async function internalModule(path: string): Promise<any> {
  assertEngine();
  return import(new URL(path, entry).href);
}
