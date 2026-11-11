import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const adapter = fileURLToPath(new URL("../offckb/cli.mjs", import.meta.url));
const manifest = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const genesis = `0x${"11".repeat(32)}`;

function run(contextFile) {
  const child = spawn(process.execPath, [adapter], {
    env: { PATH: "", TMPDIR: path.dirname(contextFile), NODE_USE_ENV_PROXY: "0", OFFCKB_PLUGIN_CONTEXT: contextFile },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (value) => { stdout += value; });
  child.stderr.on("data", (value) => { stderr += value; });
  const closed = new Promise((resolve) => child.once("close", (code) => resolve({ code, stdout, stderr })));
  const ready = new Promise((resolve, reject) => {
    let buffer = "";
    child.stdout.on("data", (value) => {
      buffer += value;
      if (buffer.includes("\n")) {
        try { resolve(JSON.parse(buffer.split("\n")[0])); } catch (error) { reject(error); }
      }
    });
    child.once("close", () => reject(new Error(stderr || "Exited before ready")));
  });
  ready.catch(() => {});
  return { child, closed, ready };
}

async function startRpc() {
  let firstGenesis = true;
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const result = (call) => {
      if (call.method === "get_block_hash") return genesis;
      if (call.method === "get_header_by_number" && call.params[0] === "0x0") return { number: "0x0", hash: genesis, timestamp: "0x0" };
      if (call.method === "get_block_by_number") {
        if (call.params[0] === "0x0" && firstGenesis) {
          firstGenesis = false;
          return { header: { number: "0x0", hash: genesis }, transactions: [] };
        }
        return null;
      }
      if (call.method === "get_blockchain_info") return { chain: "ckb_dev", difficulty: "0x1" };
      return "0x0";
    };
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(Array.isArray(body) ? body.map((call) => ({ jsonrpc: "2.0", id: call.id, result: result(call) })) : { jsonrpc: "2.0", id: body.id, result: result(body) }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => { server.closeAllConnections(); server.close(); } };
}

async function startRelay(token) {
  const authenticated = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let received = "";
    const authenticate = (chunk) => {
      received += chunk.toString();
      if (!received.includes("\n")) return;
      socket.removeListener("data", authenticate);
      assert.equal(received, `offckb-http/1 ${token}\n`);
      authenticated.push(socket);
      socket.write("OK\n");
    };
    socket.on("data", authenticate);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const used = new Set();
  return {
    port: server.address().port,
    async request(pathname) {
      const socket = authenticated.find((candidate) => !used.has(candidate) && !candidate.destroyed);
      assert.ok(socket, "an authenticated reverse channel is available");
      used.add(socket);
      const response = new Promise((resolve, reject) => {
        let raw = "";
        socket.on("data", (value) => {
          raw += value.toString();
          if (raw.includes("\r\n0\r\n\r\n")) { socket.destroy(); resolve(raw); }
        });
        socket.once("end", () => resolve(raw));
        socket.once("error", reject);
        setTimeout(() => reject(new Error("relay request timed out")), 5000).unref();
      });
      socket.write(`GET ${pathname} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
      const raw = await response;
      const split = raw.indexOf("\r\n\r\n");
      assert.ok(split >= 0, raw);
      const headers = raw.slice(0, split);
      let payload = raw.slice(split + 4);
      if (/transfer-encoding: chunked/i.test(headers)) {
        let decoded = "";
        while (payload) {
          const end = payload.indexOf("\r\n");
          const size = Number.parseInt(payload.slice(0, end), 16);
          if (!size) break;
          decoded += payload.slice(end + 2, end + 2 + size);
          payload = payload.slice(end + 4 + size);
        }
        payload = decoded;
      }
      return { status: Number(headers.match(/^HTTP\/1\.1 (\d+)/)?.[1]), body: payload };
    },
    close: () => { for (const socket of sockets) socket.destroy(); server.close(); },
  };
}

function contextFile(root, rpcUrl, relay, overrides = {}) {
  const scripts = path.join(root, "scripts.json");
  fs.writeFileSync(scripts, JSON.stringify({ devnet: {} }));
  const context = {
    apiVersion: 1,
    cwd: root,
    output: "json",
    sandbox: {
      permissions: ["devnet-read", "project-deployment", "serve"],
      http: { transport: "tcp-v1", endpoint: `127.0.0.1:${relay?.port ?? 1}`, token: "adapter-test-token", url: "http://127.0.0.1:7070" },
    },
    devnet: {
      kind: "pure-devnet",
      rpcUrl,
      genesisHash: genesis,
      addressPrefix: "ckt",
      systemScriptsFile: scripts,
      systemScriptsVersion: 1,
    },
    ...overrides,
  };
  const file = path.join(root, "context.json");
  fs.writeFileSync(file, JSON.stringify(context));
  return file;
}

test("the package ships a declared, prebuilt offckb adapter", () => {
  assert.equal(manifest.offckb.apiVersion, 1);
  assert.equal(manifest.offckb.command, "explorer");
  assert.deepEqual(manifest.offckb.permissions, ["devnet-read", "project-deployment", "serve"]);
  assert.ok(manifest.files.includes("offckb"));
  const entry = fileURLToPath(new URL(`../${manifest.offckb.entry}`, import.meta.url));
  assert.ok(fs.statSync(entry).isFile());
  assert.match(entry, /\.mjs$/);
});

test("adapter help is offline and does not require a plugin context", () => {
  const result = spawnSync(process.execPath, [adapter, "--help"], { env: { PATH: "" }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /offckb .*explorer/);
  assert.match(result.stdout, /--allow devnet-read/);
});

test("adapter rejects an unknown chain without contacting a provider", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cde-offckb-test-"));
  try {
    const file = contextFile(root, "http://127.0.0.1:1", undefined);
    const context = JSON.parse(fs.readFileSync(file, "utf8"));
    context.devnet.kind = "unknown";
    fs.writeFileSync(file, JSON.stringify(context));
    const app = run(file);
    const result = await app.closed;
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(JSON.parse(result.stderr).message, /known devnet or fork/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("adapter translates offckb context into the public bridge CLI contract", { timeout: 10000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cde-offckb-test-"));
  const token = "adapter-test-token";
  const relay = await startRelay(token);
  const rpc = await startRpc();
  const app = run(contextFile(root, rpc.url, relay));
  try {
    const ready = await app.ready;
    assert.deepEqual(ready, { ok: true, apiVersion: 1, command: "explorer", url: "http://127.0.0.1:7070", transport: "tcp-v1" });
    assert.equal((await relay.request("/")).status, 200);
    const infoResponse = await relay.request("/api/info");
    assert.equal(infoResponse.status, 200, infoResponse.body);
    const info = JSON.parse(infoResponse.body);
    assert.equal(info.rpcUrl, rpc.url);
    assert.deepEqual(info.projects, [root]);
    assert.equal(info.features.faucet, false);
    assert.equal(info.features.broadcast, false);
    assert.equal(info.features.downloads, false);
    app.child.kill("SIGTERM");
    const result = await app.closed;
    if (process.platform !== "win32") assert.equal(result.code, 143, result.stderr);
    assert.equal(result.stdout.trim().split("\n").length, 1);
    assert.doesNotMatch(result.stderr, new RegExp(token));
    assert.equal(fs.readdirSync(root).some((name) => name.startsWith("ckb-devnet-explorer-")), false);
  } finally {
    app.child.kill("SIGTERM");
    await app.closed;
    relay.close();
    rpc.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
