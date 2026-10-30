import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { Explorer } from "./explorer.ts";
import type { Faucet } from "./faucet.ts";

const WEB_DIR = fileURLToPath(new URL("./web/", import.meta.url));
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png" };

type Route = [RegExp, (m: RegExpMatchArray, url: URL) => Promise<unknown>, (m: RegExpMatchArray) => string];

// ?page=2&size=20, with sane bounds.
const pageArgs = (url: URL) => {
  const pageNo = Math.max(1, Number(url.searchParams.get("page")) || 1);
  const size = Math.min(100, Math.max(1, Number(url.searchParams.get("size")) || 20));
  return [pageNo, size] as const;
};

const LOCAL = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

// writable: false when embedded (offckb's plugin sandbox only forwards read RPC methods and has no
// offckb binary), which turns off the faucet and broadcast.
export type ServerOptions = { writable?: boolean };

export function createExplorerServer(explorer: Explorer, faucet: Faucet, rpcUrl: string, projects: string[], options: ServerOptions = {}) {
  const writable = options.writable ?? true;
  const readOnly = "This explorer is running read-only (embedded in offckb), so it doesn't send transactions.";
  // Optional extras must never take /api/info down: offckb's sandbox doesn't allow local_node_info.
  const optional = async <T>(f: () => Promise<T>) => { try { return (await f()) ?? null; } catch { return null; } };
  // Claims belong to one chain: forget them when `offckb clean` resets it.
  let resets = 0;
  const faucetStatus = async () => {
    if (explorer.index.resets !== resets) { resets = explorer.index.resets; faucet.reset(); }
    return faucet.status();
  };
  const tools = explorer.tools();
  // Tool answers carry their own error message: a bad input is a 200 with { error }.
  const tool = async (f: () => unknown) => { try { return await f(); } catch (err) { return { error: (err as Error).message }; } };
  const q = (url: URL, k: string) => url.searchParams.get(k) ?? "";
  const noTx = (m: RegExpMatchArray) => `No transaction ${m[1]} on this devnet.`;
  // [pattern, handler, message when the handler finds nothing]
  const routes: Route[] = [
    [/^\/api\/info$/, async () => ({
      rpcUrl, projects, tip: await explorer.tip(), resets: explorer.index.resets,
      node: await optional(() => explorer.nodeVersion()), knowledgeSize: await optional(() => explorer.knowledgeSize()),
      features: { faucet: writable && faucet.hasAccount(), broadcast: writable, accounts: explorer.hasAccounts() },
    }), () => ""],
    [/^\/api\/home$/, () => explorer.home(), () => ""],
    [/^\/api\/blocks$/, (_, url) => explorer.blockList(...pageArgs(url)), () => ""],
    [/^\/api\/transactions$/, (_, url) => explorer.transactionList(...pageArgs(url)), () => ""],
    [/^\/api\/pool$/, () => explorer.pool(), () => ""],
    [/^\/api\/tx\/(0x[0-9a-fA-F]{64})\/raw$/, (m) => explorer.rawTransaction(m[1].toLowerCase()), noTx],
    [/^\/api\/tx\/(0x[0-9a-fA-F]{64})$/, (m) => explorer.transaction(m[1].toLowerCase()), noTx],
    [/^\/api\/block\/(\d+|0x[0-9a-fA-F]{64})$/, (m) => explorer.blockDetail(m[1]), (m) => `Block ${m[1]} doesn't exist on this devnet yet.`],
    [/^\/api\/address\/(ck[bt]1[0-9a-z]+)$/i, (m, url) => explorer.address(m[1], url.searchParams.get("tab") ?? "", ...pageArgs(url)), (m) => `Couldn't read address ${m[1]}.`],
    [/^\/api\/script\/(0x[0-9a-fA-F]{64})\/(type|data|data1|data2)$/, (m, url) => explorer.script(m[1], m[2], url.searchParams.get("tab") ?? "", ...pageArgs(url)), () => ""],
    [/^\/api\/scripts$/, () => explorer.scripts(), () => ""],
    [/^\/api\/tokens$/, () => explorer.tokens(), () => ""],
    [/^\/api\/token\/(0x[0-9a-fA-F]{64})$/, (m, url) => explorer.token(m[1], url.searchParams.get("tab") ?? "", ...pageArgs(url)), (m) => `No sUDT or xUDT token with type hash ${m[1]} on this devnet.`],
    [/^\/api\/nfts$/, () => explorer.nfts(), () => ""],
    [/^\/api\/spore\/(0x[0-9a-fA-F]{64})$/, (m) => explorer.spore(m[1]), (m) => `No spore ${m[1]} on this devnet.`],
    [/^\/api\/dao$/, (_, url) => explorer.dao(url.searchParams.get("tab") ?? "", ...pageArgs(url)), () => "This devnet has no Nervos DAO script."],
    [/^\/api\/accounts$/, () => explorer.accounts(), () => ""],
    [/^\/api\/faucet$/, async () => (writable ? faucetStatus() : { ...(await faucetStatus()), available: false, reason: readOnly }), () => ""],
    [/^\/api\/charts$/, () => explorer.charts(), () => ""],
    [/^\/api\/tools\/address$/, (_, url) => tool(() => tools.address(q(url, "address").trim())), () => ""],
    [/^\/api\/tools\/script$/, (_, url) => tool(() => tools.script(q(url, "code_hash").trim(), q(url, "hash_type"), q(url, "args").trim() || "0x")), () => ""],
    [/^\/api\/tools\/hash$/, (_, url) => tool(() => tools.hash(q(url, "input"), q(url, "as"))), () => ""],
    [/^\/api\/tools\/molecule$/, (_, url) => tool(() => tools.molecule(q(url, "type"), q(url, "hex"))), () => ""],
    [/^\/api\/search$/, (_, url) => explorer.search(url.searchParams.get("q") ?? ""), () => ""],
  ];

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    try {
      // The endpoints that write to the chain (the faucet and broadcast). Only from this
      // machine, only as JSON (a page on another site can't send that without a CORS
      // preflight, which we never answer), and only from our own origin when the browser says
      // where it came from.
      const readJson = async (limit: number): Promise<Record<string, unknown> | string> => {
        const origin = req.headers.origin;
        if (!LOCAL.has(req.socket.remoteAddress ?? "") || (origin && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)))
          return "This only takes requests from this machine.";
        if (!(req.headers["content-type"] ?? "").startsWith("application/json")) return "Send it as JSON.";
        let raw = "";
        for await (const chunk of req) {
          raw += chunk;
          if (raw.length > limit) return "Request too large.";
        }
        try { return JSON.parse(raw); } catch { return "Send it as JSON."; }
      };
      if (!writable && req.method === "POST" && (url.pathname === "/api/tools/broadcast" || url.pathname === "/api/faucet"))
        return json(403, { error: readOnly });
      if (url.pathname === "/api/tools/broadcast" && req.method === "POST") {
        const body = await readJson(512 * 1024);
        if (typeof body === "string") return json(400, { error: body });
        const devnet = await faucet.devnetProblem();
        if (devnet) return json(403, { error: devnet });
        if (!body.tx || typeof body.tx !== "object") return json(400, { error: "Paste a transaction as JSON." });
        try {
          return json(200, await tools.broadcast(body.tx as Record<string, unknown>, body.dryRun === true));
        } catch (err) {
          return json(200, { error: (err as Error).message.replace(/^(send_transaction|test_tx_pool_accept): /, "") });
        }
      }
      if (url.pathname === "/api/faucet" && req.method === "POST") {
        const body = await readJson(2048);
        if (typeof body === "string") return json(400, { error: body });
        const to = String(body.address ?? "").trim();
        const amount = Number(body.amount);
        const problem = await faucet.check(to, amount);
        if (problem) return json(400, { error: problem });
        try {
          return json(200, await faucet.claim(to, amount));
        } catch (err) {
          return json(502, { error: `offckb couldn't send it: ${(err as Error).message}` });
        }
      }
      if (req.method !== "GET" && req.method !== "HEAD") return json(405, { error: "Method not allowed." });
      // A spore's image, for <img>. Spore content is whatever its minter chose, so only image
      // types are served, never sniffed, and sandboxed: an SVG with a script can't run here.
      const content = url.pathname.match(/^\/api\/spore\/(0x[0-9a-fA-F]{64})\/content$/);
      if (content) {
        const c = await explorer.sporeContentOf(content[1]);
        if (!c) return json(404, { error: "No such spore." });
        if (!/^image\/(png|jpeg|gif|webp|svg\+xml|avif)$/.test(c.contentType)) return json(415, { error: `Not an image (${c.contentType}).` });
        res.writeHead(200, {
          "Content-Type": c.contentType,
          "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "no-cache",
        });
        return res.end(Buffer.from(c.bytes));
      }
      if (url.pathname.startsWith("/api/")) {
        for (const [pattern, handler, notFound] of routes) {
          const m = url.pathname.match(pattern);
          if (!m) continue;
          const body = await handler(m, url);
          return body === null ? json(404, { error: notFound(m) }) : json(200, body);
        }
        return json(404, { error: "Unknown endpoint." });
      }

      // Everything else is the single-page UI and its modules.
      const file = url.pathname === "/" || !extname(url.pathname) ? "index.html" : normalize(url.pathname).replace(/^([/\\]|\.\.)+/, "");
      const body = await readFile(join(WEB_DIR, file));
      // no-cache: the browser revalidates, so an updated explorer never runs yesterday's page code.
      res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-cache" });
      res.end(body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return json(404, { error: "Not found." });
      if (message.includes("fetch failed"))
        return json(503, { error: `Can't reach the devnet at ${rpcUrl}. Start it with \`offckb node\` and reload.` });
      json(500, { error: message });
    }
  });

  // Keep upstream's index warm in both TCP and embedded bridge modes.
  const keepUp = () => explorer.index.sync().catch(() => {});
  keepUp();
  const interval = setInterval(keepUp, 3000);
  interval.unref();
  server.once('close', () => clearInterval(interval));
  return server;
}

export function startServer(explorer: Explorer, faucet: Faucet, port: number, rpcUrl: string, projects: string[], host = "127.0.0.1", options: ServerOptions = {}) {
  const server = createExplorerServer(explorer, faucet, rpcUrl, projects, options);
  server.listen(port, host);
  return server;
}
