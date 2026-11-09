import { readFileSync } from "node:fs";
import http from "node:http";
import { connect, type Socket } from "node:net";
import type { Server } from "node:http";

export type BridgeConfig = {
  apiVersion: 1;
  transport: "proxy-connect-v1" | "tcp-v1";
  endpoint: string;
  token: string;
  url?: string;
};

type BridgeAddress = { host: string; port: number };

function bridgeAddress(endpoint: string): BridgeAddress {
  let url: URL;
  try { url = new URL(`tcp://${endpoint}`); } catch { throw new Error("Bridge endpoint must be host:port"); }
  const port = Number(url.port);
  if (!url.hostname || !Number.isInteger(port) || port < 1 || port > 65535 || !["", "/"].includes(url.pathname) || url.search || url.hash || url.username || url.password)
    throw new Error("Bridge endpoint must be host:port");
  return { host: url.hostname.replace(/^\[|\]$/g, ""), port };
}

/** Read the short-lived bridge config written by an embedder, keeping its token out of argv. */
export function loadBridgeConfig(file: string): BridgeConfig {
  const value = JSON.parse(readFileSync(file, "utf8")) as Partial<BridgeConfig>;
  if (value.apiVersion !== 1 || !["proxy-connect-v1", "tcp-v1"].includes(value.transport ?? ""))
    throw new Error("Bridge config must declare apiVersion 1 and proxy-connect-v1 or tcp-v1");
  if (typeof value.endpoint !== "string" || typeof value.token !== "string" || !value.token || value.token.length > 4096 || /[\r\n]/.test(value.token))
    throw new Error("Bridge config requires an endpoint and a single-line token");
  bridgeAddress(value.endpoint);
  if (value.url !== undefined) {
    if (typeof value.url !== "string") throw new Error("Bridge public URL must be HTTP(S)");
    const url = new URL(value.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Bridge public URL must be HTTP(S), without credentials");
  }
  return value as BridgeConfig;
}

/** Serve HTTP over authenticated, plugin-initiated reverse channels. */
export function serveBridge(server: Server, config: BridgeConfig, ready: () => void): () => void {
  const address = bridgeAddress(config.endpoint);
  const proxyValue = config.transport === "proxy-connect-v1" ? process.env.HTTP_PROXY || process.env.http_proxy : undefined;
  if (config.transport === "proxy-connect-v1" && !proxyValue) throw new Error("proxy-connect-v1 requires HTTP_PROXY from the sandbox host");
  const proxy = proxyValue ? new URL(proxyValue) : undefined;
  if (proxy && proxy.protocol !== "http:") throw new Error("proxy-connect-v1 requires an HTTP proxy");
  const proxyAuthorization = proxy && (proxy.username || proxy.password)
    ? `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}`
    : undefined;
  const hello = Buffer.from(`offckb-http/1 ${config.token}\n`);
  const sockets = new Set<Socket>();
  const requests = new Set<http.ClientRequest>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let stopped = false;
  let announced = false;
  const startup = setTimeout(() => {
    if (!announced) {
      stop();
      server.emit("error", Object.assign(new Error("HTTP bridge did not authenticate"), { code: "BRIDGE_UNAVAILABLE" }));
    }
  }, 5000);

  const open = () => {
    if (stopped) return;
    let finished = false;
    const retry = () => {
      if (finished || stopped) return;
      finished = true;
      const timer = setTimeout(() => { timers.delete(timer); open(); }, 100);
      timers.add(timer);
    };
    const authenticate = (socket: Socket) => {
      let received = Buffer.alloc(0);
      const authenticate = (chunk: Buffer) => {
        received = Buffer.concat([received, chunk]);
        const end = received.indexOf(10);
        if (end < 0) {
          if (received.length > 2) socket.destroy();
          return;
        }
        if (received.subarray(0, end + 1).toString() !== "OK\n") {
          socket.destroy();
          return;
        }
        socket.removeListener("data", authenticate);
        socket.pause();
        server.emit("connection", socket);
        // The host may have sent the first request in the same frame as the acknowledgement.
        const rest = received.subarray(end + 1);
        if (rest.length) socket.unshift(rest);
        socket.resume();
        if (!announced) { announced = true; clearTimeout(startup); ready(); }
      };
      socket.on("data", authenticate);
      socket.write(hello);
    };
    const watch = (socket: Socket) => {
      sockets.add(socket);
      socket.on("error", () => socket.destroy());
      socket.once("close", () => { sockets.delete(socket); retry(); });
      if (stopped) socket.destroy();
      else authenticate(socket);
    };

    if (config.transport === "tcp-v1") {
      const socket = connect(address);
      sockets.add(socket);
      socket.on("error", () => socket.destroy());
      socket.once("close", () => { sockets.delete(socket); retry(); });
      socket.once("connect", () => { if (stopped) socket.destroy(); else authenticate(socket); });
      return;
    }

    const request = http.request({
      hostname: proxy!.hostname.replace(/^\[|\]$/g, ""),
      port: Number(proxy!.port || 80),
      method: "CONNECT",
      path: config.endpoint,
      headers: { Host: config.endpoint, ...(proxyAuthorization ? { "Proxy-Authorization": proxyAuthorization } : {}) },
      agent: false,
    });
    requests.add(request);
    let connected = false;
    request.once("error", () => { requests.delete(request); if (!connected) retry(); });
    request.once("connect", (response, socket, head) => {
      connected = true;
      requests.delete(request);
      if (stopped || response.statusCode !== 200 || head.length) {
        socket.destroy();
        retry();
        return;
      }
      watch(socket);
    });
    request.end();
  };

  for (let i = 0; i < 8; i++) open();
  const stop = () => {
    stopped = true;
    clearTimeout(startup);
    for (const timer of timers) clearTimeout(timer);
    for (const request of requests) request.destroy();
    for (const socket of sockets) socket.destroy();
  };
  return stop;
}
