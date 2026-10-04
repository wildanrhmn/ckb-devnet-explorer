import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type KnownScript = { name: string; source: "genesis" | string };
type ScriptsFile = Record<string, Record<string, { codeHash: string; hashType: string } | { script: { codeHash: string; hashType: string } }>>;

const key = (codeHash: string, hashType: string) => `${codeHash.toLowerCase()}:${hashType}`;

// Asks offckb for the devnet's system scripts every run instead of reading a cached copy:
// cached copies went stale once already when the devnet drifted from the installed offckb.
export function loadSystemScripts(): Map<string, KnownScript> {
  const out = join(mkdtempSync(join(tmpdir(), "cde-")), "system-scripts.json");
  execFileSync("offckb", ["system-scripts", "-o", out], { stdio: "ignore" });
  return toMap(JSON.parse(readFileSync(out, "utf8")), "genesis");
}

// A project deployed with `offckb deploy` keeps its own scripts in deployment/scripts.json.
export function loadProjectScripts(projectDir: string): Map<string, KnownScript> {
  const file = join(projectDir, "deployment", "scripts.json");
  if (!existsSync(file)) return new Map();
  const label = projectDir.replace(/\/+$/, "").split("/").pop() ?? projectDir;
  return toMap(JSON.parse(readFileSync(file, "utf8")), label);
}

function toMap(file: ScriptsFile, source: string): Map<string, KnownScript> {
  const map = new Map<string, KnownScript>();
  for (const [name, entry] of Object.entries(file.devnet ?? {})) {
    const s = "script" in entry ? entry.script : entry;
    if (s?.codeHash && s?.hashType) map.set(key(s.codeHash, s.hashType), { name, source });
  }
  return map;
}

export { key };
