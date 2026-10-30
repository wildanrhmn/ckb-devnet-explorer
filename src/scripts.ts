import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type CodeLocation = { txHash: string; index: number; depType: "code" | "depGroup" };
export type KnownScript = {
  name: string;
  source: "genesis" | string;
  codeHash: string;
  hashType: string;
  // Where a transaction finds this script's code (its cell dep), if the deployment file says.
  location: CodeLocation | null;
};

type ScriptEntry = {
  codeHash: string;
  hashType: string;
  cellDeps?: { cellDep?: { outPoint: { txHash: string; index: number | string }; depType: string } }[];
};
type ScriptsFile = Record<string, Record<string, ScriptEntry | { script: ScriptEntry }>>;

const key = (codeHash: string, hashType: string) => `${codeHash.toLowerCase()}:${hashType}`;

// Asks offckb for the devnet's system scripts every run instead of reading a cached copy:
// cached copies went stale once already when the devnet drifted from the installed offckb.
export function loadSystemScripts(file?: string): Map<string, KnownScript> {
  if (file) return toMap(JSON.parse(readFileSync(file, "utf8")), "genesis");
  const directory = mkdtempSync(join(tmpdir(), "cde-"));
  try {
    const out = join(directory, "system-scripts.json");
    execFileSync("offckb", ["system-scripts", "-o", out], { stdio: "ignore" });
    return toMap(JSON.parse(readFileSync(out, "utf8")), "genesis");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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
    if (!s?.codeHash || !s?.hashType) continue;
    const dep = s.cellDeps?.[0]?.cellDep;
    map.set(key(s.codeHash, s.hashType), {
      name,
      source,
      codeHash: s.codeHash.toLowerCase(),
      hashType: s.hashType,
      location: dep
        ? { txHash: dep.outPoint.txHash, index: Number(dep.outPoint.index), depType: dep.depType === "depGroup" ? "depGroup" : "code" }
        : null,
    });
  }
  return map;
}

export { key };
