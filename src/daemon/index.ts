#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 rockykln
// SPDX-License-Identifier: AGPL-3.0-or-later
// Daemon wiring, startup and shutdown.

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { handleConnection, type AgentLinkDeps } from "./agent-link.ts";
import { ConfigError, loadConfig, paths, type Config } from "./config.ts";
import { createLogger, type Logger } from "./log.ts";
import { MachineStore, machinesFile } from "./machines.ts";
import { createMatrix, type Matrix } from "./matrix.ts";
import { Media } from "./media.ts";
import { Polls } from "./polls.ts";
import { Reactions } from "./reactions.ts";
import { AgentRegistry, RoomQuota, agentKey } from "./registry.ts";
import { RoomManager, type RoomsClient } from "./rooms.ts";
import { Router, type RouterMatrix, type RouterTrust } from "./router.ts";
import { StateStore } from "./state.ts";
import { OwnerTrust } from "./trust.ts";
import { Updates } from "./updates.ts";
import { startLocal, type LocalServer } from "./transport/local.ts";
import { startWebSocket, type WebSocketServerHandle } from "./transport/websocket.ts";

export const SHUTDOWN_TIMEOUT_MS = 10_000;
export const SWEEP_INTERVAL_MS = 30_000;

/** The part of the Matrix class the daemon uses; tests pass a fake. */
export type DaemonMatrix = Pick<
  Matrix,
  | "botUser"
  | "owner"
  | "onDecrypted"
  | "onPlainEvent"
  | "onSent"
  | "onSendRefused"
  | "onHeldDropped"
  | "sendMessage"
  | "sendText"
  | "sendNotice"
  | "sendEvent"
  | "sendRaw"
  | "setTyping"
  | "getEvent"
  | "keysQuery"
  | "healthy"
  | "start"
  | "stop"
> &
  Partial<Pick<Matrix, "isReplay" | "recordReplay" | "setDeviceGuard" | "onDevicesChanged">> & { readonly client: RoomsClient };

export interface DaemonDeps {
  config: Config;
  state: StateStore;
  log: Logger;
  matrix: DaemonMatrix;
  /** Machine secrets for the WebSocket transport. */
  machines: { secretFor(name: string): string | undefined };
  /** Defaults to OwnerTrust over matrix.keysQuery with the pin stored in state. */
  trust?: RouterTrust;
  /** Used for media downloads. */
  fetch?: typeof fetch;
  version?: string;
  sweepIntervalMs?: number;
  updateStaggerMs?: number;
}

export interface Daemon {
  readonly version: string;
  readonly registry: AgentRegistry;
  readonly rooms: RoomManager;
  readonly router: Router;
  /** Port of the WebSocket listener after start() (useful with port 0), else undefined. */
  readonly wsPort: number | undefined;
  /** Sends a notice to the system room (logged only if there is none yet). */
  system(text: string): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function packageVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

/** Builds the module graph. Nothing touches the network until start(). */
export function createDaemon(deps: DaemonDeps): Daemon {
  const { config, state, log, matrix } = deps;
  const version = deps.version ?? packageVersion();

  const rooms = new RoomManager({ client: matrix.client, config, state, log: log.child("rooms") });
  const ownerTrust = deps.trust
    ? undefined
    : new OwnerTrust({
        queryKeys: (b) => matrix.keysQuery(b),
        botUser: config.botUser,
        owner: config.owner,
        getPinnedMaster: () => state.data.ownerMasterKey,
        getBotMasterKey: () => state.data.botMasterKey,
        getOwnDeviceId: () => state.data.deviceId,
        pinMaster: (k) => {
          state.data.ownerMasterKey = k;
          state.save();
          log.info("pinned owner master key");
        },
      });
  const trust: RouterTrust = deps.trust ?? ownerTrust!;
  // Without a guard the Matrix layer refuses every encrypted send (fails closed).
  if (ownerTrust) {
    matrix.setDeviceGuard?.(() => ownerTrust.auditDevices());
    matrix.onDevicesChanged?.(() => ownerTrust.invalidate());
  }

  const system = (text: string): void => {
    const roomId = rooms.systemRoomId;
    if (!roomId) {
      log.info("no system room yet, notice dropped");
      return;
    }
    matrix.sendNotice(roomId, text).catch((e: Error) => log.warn("system notice failed:", e?.name ?? "error"));
  };
  const notify = { system };

  const registry = new AgentRegistry();
  const media = new Media({ config, state, log: log.child("media"), fetch: deps.fetch });
  const reactions = new Reactions({ matrix, rooms, registry, log: log.child("reactions") });
  matrix.onSent((roomId, eventId, content) => reactions.rememberBotMessage(roomId, eventId, typeof content.body === "string" ? content.body : ""));
  const polls = new Polls({
    matrix,
    rooms,
    registry,
    log: log.child("polls"),
    summarize: (eventId, label, agentName, previousLabel) => reactions.summarize(eventId, label, agentName, previousLabel),
    approvalTtlMs: config.approvalTtlMs,
  });
  const updates = new Updates({ registry, reactions, log: log.child("updates"), notify, staggerMs: deps.updateStaggerMs });
  // a Matrix layer without replay protection gets every event treated as a replay (fails closed)
  const routerMatrix: RouterMatrix = {
    onDecrypted: (cb) => matrix.onDecrypted(cb),
    onPlainEvent: (cb) => matrix.onPlainEvent(cb),
    sendNotice: (roomId, body) => matrix.sendNotice(roomId, body),
    setTyping: (roomId, typing, timeoutMs) => matrix.setTyping(roomId, typing, timeoutMs),
    isReplay: (key) => (matrix.isReplay ? matrix.isReplay(key) : true),
    recordReplay: (key) => (matrix.recordReplay ? matrix.recordReplay(key) : false),
  };
  const router = new Router({ config, log: log.child("router"), matrix: routerMatrix, trust, rooms, registry, media, polls, reactions, updates, notify });
  // control-room messages the daemon sent for an agent ("[name] ..."), held ones included once flushed, are the
  // only reply targets the router accepts
  matrix.onSent((roomId, eventId, content) => {
    if (roomId !== rooms.controlRoomId || typeof content.body !== "string") return;
    const m = content.body.match(/^\[([^\]\n]{1,64})\]/);
    if (!m) return;
    const key = agentKey(m[1]);
    if (registry.has(key) || rooms.agentRoom(key)) router.rememberControlMessage(eventId, key);
  });
  matrix.onSendRefused((roomId, reason) => {
    if (roomId !== rooms.systemRoomId) system(`Refusing to send to ${roomId}: ${reason}`);
  });
  matrix.onHeldDropped((roomId, count) => {
    if (roomId !== rooms.systemRoomId) system(`${count} held message(s) for ${roomId} dropped`);
  });

  const roomQuota = new RoomQuota();
  const linkDeps: AgentLinkDeps = { config, log: log.child("agent"), matrix, rooms, registry, router, polls, reactions, updates, notify, roomQuota };
  const onConnection = (conn: Parameters<typeof handleConnection>[0]) => handleConnection(conn, linkDeps);

  let detach: (() => void) | undefined;
  let local: LocalServer | undefined;
  let ws: WebSocketServerHandle | undefined;
  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  let started = false;
  let stopping: Promise<void> | undefined;

  async function start(): Promise<void> {
    if (started) throw new Error("daemon already started");
    started = true;
    // a stop() during start() wins: nothing is opened after it, and what was opened is closed
    const aborted = (): boolean => stopping !== undefined;
    detach = router.attach(); // before matrix.start(), so no early event is missed
    try {
      await matrix.start();
      if (aborted()) return;
      await rooms.joinConfigured();
      await rooms.ensureSystemRoom().catch((e: Error) => log.error("system room unavailable:", e?.name ?? "error", e?.message ?? ""));
      await rooms.ensureControlRoom().catch((e: Error) => log.error("control room unavailable:", e?.name ?? "error", e?.message ?? ""));
      if (aborted()) return;
      system(`daemon ${version} started`);
      local = await startLocal({ socketPath: config.socketPath, log: log.child("local"), onConnection });
      if (aborted()) {
        await local.close().catch(() => undefined);
        return;
      }
      if (config.wsListen) {
        ws = await startWebSocket({
          host: config.wsListen.host,
          port: config.wsListen.port,
          log: log.child("ws"),
          healthy: () => matrix.healthy(),
          secretFor: (m) => deps.machines.secretFor(m),
          trustProxyHeader: config.trustProxyHeader,
          onConnection,
        });
        if (aborted()) {
          await ws.close().catch(() => undefined);
          return;
        }
      }
    } catch (e) {
      await stop();
      throw e;
    }
    sweepTimer = setInterval(() => {
      for (const l of registry.sweep()) {
        log.info("dropped dead link:", l.name, `(${l.machine})`);
        system(`${l.name} offline`);
      }
    }, deps.sweepIntervalMs ?? SWEEP_INTERVAL_MS);
    sweepTimer.unref();
    log.info(`daemon ${version} running as ${config.botUser}`);
  }

  function stop(): Promise<void> {
    stopping ??= (async () => {
      if (sweepTimer) clearInterval(sweepTimer);
      updates.cancel();
      polls.close();
      // unregister first, so closing the transports does not post an "offline" notice per agent
      registry.closeAll();
      await Promise.all([local?.close(), ws?.close()].map((p) => p?.catch((e: Error) => log.warn("transport close failed:", e.message))));
      detach?.();
      try {
        matrix.stop();
      } catch (e) {
        log.warn("matrix stop failed:", (e as Error).message);
      }
      log.info("daemon stopped");
    })();
    return stopping;
  }

  return {
    version,
    registry,
    rooms,
    router,
    get wsPort() {
      return ws?.port;
    },
    system,
    start,
    stop,
  };
}

export async function main(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig();
  } catch (e) {
    process.stderr.write(`${e instanceof ConfigError ? e.message : `cannot load configuration: ${(e as Error).message}`}\n`);
    process.exit(2);
  }
  const p = paths();
  const log = createLogger(config.logLevel);
  for (const w of config.warnings) log.warn(w);
  const state = StateStore.load(p.stateFile);
  const matrix = await createMatrix({ config, paths: p, state, log });
  const machines = new MachineStore(machinesFile(p), { log: log.child("machines") });
  const daemon = createDaemon({ config, state, log, matrix, machines });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${signal} received, shutting down`);
    setTimeout(() => {
      log.error("shutdown timed out");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();
    daemon.stop().then(
      () => process.exit(0),
      (e: Error) => {
        log.error("shutdown failed:", e.message);
        process.exit(1);
      },
    );
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await daemon.start();
}

function invokedDirectly(): boolean {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().catch((e: Error) => {
    process.stderr.write(`mxagent: ${e.message}\n`);
    process.exit(1);
  });
}
