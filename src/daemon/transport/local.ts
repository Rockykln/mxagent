// SPDX-FileCopyrightText: 2026 rockykln
// SPDX-License-Identifier: AGPL-3.0-or-later
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { Logger } from "../log.ts";
import { socketConnection, type Connection } from "./link.ts";

export interface LocalOptions {
  socketPath: string;
  log: Logger;
  onConnection: (conn: Connection) => void;
}

export interface LocalServer {
  close(): Promise<void>;
}

/**
 * "free" only when nothing listens (ECONNREFUSED, or ENOENT if the file vanished); "in-use" if a connection
 * succeeds; "unknown" for every other error (EACCES, EAGAIN: backlog full) and on timeout.
 */
export function probeSocket(socketPath: string, timeoutMs = 1000): Promise<"free" | "in-use" | "unknown"> {
  return new Promise((resolve) => {
    const c = net.connect(socketPath);
    const done = (r: "free" | "in-use" | "unknown") => {
      clearTimeout(timer);
      c.destroy();
      resolve(r);
    };
    const timer = setTimeout(() => done("unknown"), timeoutMs);
    c.once("connect", () => done("in-use"));
    c.once("error", (e: NodeJS.ErrnoException) => done(e.code === "ECONNREFUSED" || e.code === "ENOENT" ? "free" : "unknown"));
  });
}

async function removeStale(socketPath: string): Promise<void> {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(socketPath);
  } catch {
    return;
  }
  if (!st.isSocket()) throw new Error(`${socketPath} exists and is not a socket`);
  const state = await probeSocket(socketPath);
  if (state === "in-use") throw new Error(`${socketPath} is in use (is another daemon running?)`);
  if (state === "unknown") throw new Error(`${socketPath} exists and cannot be checked; remove it if no daemon is running`);
  try {
    fs.unlinkSync(socketPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

/** Unix socket listener for agents on this host (machine "local"). Access is controlled by mode 0600. */
export async function startLocal(opts: LocalOptions): Promise<LocalServer> {
  const { socketPath, log, onConnection } = opts;
  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  await removeStale(socketPath);

  const sockets = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.once("close", () => sockets.delete(sock));
    let conn: Connection;
    try {
      conn = socketConnection(sock, "local");
      onConnection(conn);
    } catch (e) {
      log.error("local connection setup failed:", e as Error);
      sock.destroy();
    }
  });
  server.on("error", (e) => log.error("unix socket error:", e));

  // The socket file inherits the umask; bind() runs synchronously inside listen(), so the
  // restricted umask is only active for that call.
  const listening = new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const oldMask = process.umask(0o177);
  try {
    server.listen(socketPath);
  } finally {
    process.umask(oldMask);
  }
  await listening;
  fs.chmodSync(socketPath, 0o600);
  log.info("listening on", socketPath);

  let closed = false;
  return {
    close: () => {
      if (closed) return Promise.resolve();
      closed = true;
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const s of sockets) s.destroy();
        try {
          fs.unlinkSync(socketPath);
        } catch {
          // already gone
        }
      });
    },
  };
}
