import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Explorer } from "./explorer.ts";

const WEB_DIR = fileURLToPath(new URL("./web/", import.meta.url));
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

export function startServer(explorer: Explorer, port: number, rpcUrl: string, projects: string[]) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    try {
      if (url.pathname === "/api/info") return json(200, { rpcUrl, projects, tip: await explorer.tip() });
      if (url.pathname === "/api/transactions")
        return json(200, await explorer.recentTransactions(Number(url.searchParams.get("limit") ?? 30)));
      const tx = url.pathname.match(/^\/api\/tx\/(0x[0-9a-fA-F]{64})$/);
      if (tx) {
        const view = await explorer.transaction(tx[1].toLowerCase());
        return view ? json(200, view) : json(404, { error: `No transaction ${tx[1]} on this devnet.` });
      }
      const block = url.pathname.match(/^\/api\/block\/(\d+)$/);
      if (block) {
        const view = await explorer.blockTransactions(Number(block[1]));
        return view ? json(200, view) : json(404, { error: `Block ${block[1]} doesn't exist yet.` });
      }
      if (url.pathname.startsWith("/api/")) return json(404, { error: "Unknown endpoint." });

      // Everything else is the single-page UI.
      const file = url.pathname === "/" || !extname(url.pathname) ? "index.html" : url.pathname.slice(1);
      const body = await readFile(join(WEB_DIR, file.replace(/\.\./g, "")));
      res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return json(404, { error: "Not found." });
      if (message.includes("fetch failed"))
        return json(503, { error: `Can't reach the devnet at ${rpcUrl}. Is \`offckb node\` running?` });
      json(500, { error: message });
    }
  });
  server.listen(port, () => console.log(`ckb-devnet-explorer running at http://localhost:${port}`));
  return server;
}
