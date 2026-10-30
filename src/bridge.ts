import { connect, type Socket } from "node:net";
import type { Server } from "node:http";

/** Serve HTTP over connections to an embedder's Unix socket, without opening a TCP listener. */
export function serveBridge(server: Server, path: string, ready: () => void): () => void {
  const sockets = new Set<Socket>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let stopped = false;
  let announced = false;
  const startup = setTimeout(() => {
    if (!announced) {
      stop();
      server.emit("error", Object.assign(new Error("HTTP bridge did not connect"), { code: "BRIDGE_UNAVAILABLE" }));
    }
  }, 5000);
  const open = () => {
    if (stopped) return;
    const socket = connect(path);
    sockets.add(socket);
    socket.once("connect", () => {
      server.emit("connection", socket);
      if (!announced) { announced = true; clearTimeout(startup); ready(); }
    });
    socket.on("error", () => socket.destroy());
    socket.once("close", () => {
      sockets.delete(socket);
      if (!stopped) {
        const timer = setTimeout(() => { timers.delete(timer); open(); }, 100);
        timers.add(timer);
      }
    });
  };
  for (let i = 0; i < 8; i++) open();
  const stop = () => {
    stopped = true;
    clearTimeout(startup);
    for (const timer of timers) clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
  };
  return stop;
}
