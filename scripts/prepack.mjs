import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const compiler = fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url));
const result = spawnSync(process.execPath, [compiler, "-p", "tsconfig.json"], { cwd: root, stdio: "inherit" });
if (result.status !== 0) process.exit(result.status ?? 1);
// npm publishes shrinkwrap (but not package-lock), so the distributed adapter also
// restores the exact engine's transitive dependency graph on a fresh installation.
const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
writeFileSync(new URL("../npm-shrinkwrap.json", import.meta.url), JSON.stringify(lock, null, 2) + "\n");
