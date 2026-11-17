// SPDX-FileCopyrightText: 2026 rockykln
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configFromVars, loadConfig, paths } from "../src/daemon/config.ts";

const base = {
  MXA_HOMESERVER: "https://matrix.example.org",
  MXA_BOT_USER: "@bot:example.org",
  MXA_OWNER: "@owner:example.org",
  MXA_SPACE_ID: "!space:example.org",
};

test("attachment limit is capped so base64 lines fit the clients' 64 MiB limit", () => {
  assert.equal(configFromVars({ ...base, MXA_MAX_ATTACHMENT_MB: "45" }).maxAttachmentBytes, 45 * 1024 * 1024);
  assert.throws(() => configFromVars({ ...base, MXA_MAX_ATTACHMENT_MB: "46" }), /greater than 0 and at most 45/);
  assert.throws(() => configFromVars({ ...base, MXA_MAX_ATTACHMENT_MB: "0" }), /greater than 0/);
});

test("homeserver URLs with a query or fragment are rejected", () => {
  assert.throws(() => configFromVars({ ...base, MXA_HOMESERVER: "https://matrix.example.org/?x=1" }), /query or fragment/);
  assert.throws(() => configFromVars({ ...base, MXA_HOMESERVER: "https://matrix.example.org/#a" }), /query or fragment/);
});

test("the SSO session file and replay log live in the state directory", () => {
  const p = paths({ MXA_CONFIG: "/etc/mxagent/bridge.env", MXA_STATE_DIR: "/var/lib/mxagent" });
  assert.equal(p.ssoSessionFile, path.join("/var/lib/mxagent", "sso-session.json"));
  assert.equal(p.replayFile, path.join("/var/lib/mxagent", "replay.log"));
});

test("MXA_STATE_DIR from the config file is honoured; the environment wins", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mxa-config-"));
  try {
    const file = path.join(dir, "bridge.env");
    const stateDir = path.join(dir, "from-file");
    const lines = Object.entries({ ...base, MXA_STATE_DIR: stateDir }).map(([k, v]) => `${k}=${v}`);
    fs.writeFileSync(file, lines.join("\n") + "\n", { mode: 0o600 });
    const env = { MXA_CONFIG: file, HOME: dir };
    assert.equal(paths(env).stateDir, stateDir);
    assert.equal(paths(env).stateFile, path.join(stateDir, "state.json"));
    assert.equal(loadConfig(env).socketPath, path.join(stateDir, "bridge.sock"));
    assert.equal(paths({ ...env, MXA_STATE_DIR: path.join(dir, "env") }).stateDir, path.join(dir, "env"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MXA_APPROVAL_TTL_MINUTES: default 15, whole minutes from 1 to 1440", () => {
  assert.equal(configFromVars(base).approvalTtlMs, 15 * 60_000);
  assert.equal(configFromVars({ ...base, MXA_APPROVAL_TTL_MINUTES: "1" }).approvalTtlMs, 60_000);
  assert.equal(configFromVars({ ...base, MXA_APPROVAL_TTL_MINUTES: "1440" }).approvalTtlMs, 1440 * 60_000);
  for (const bad of ["0", "1441", "2.5", "abc", "-3"]) {
    assert.throws(() => configFromVars({ ...base, MXA_APPROVAL_TTL_MINUTES: bad }), /MXA_APPROVAL_TTL_MINUTES must be a whole number from 1 to 1440/, bad);
  }
});

test("the proxy header mode is exposed as trustProxyHeader", () => {
  const c = configFromVars({ ...base, MXA_TRUST_PROXY_HEADER: "cf-connecting-ip" });
  assert.equal(c.trustProxyHeader, "cf-connecting-ip");
  assert.equal("trustProxyHeaders" in c, false);
});

test("the daemon package cannot be confused with the npm client package", () => {
  const read = (p: string) => JSON.parse(fs.readFileSync(new URL(p, import.meta.url), "utf8"));
  const root = read("../package.json");
  const lock = read("../package-lock.json");
  const client = read("../clients/js/package.json");
  assert.equal(root.name, "mxagent-daemon");
  assert.equal(root.private, true);
  assert.notEqual(root.name, client.name);
  assert.equal(lock.name, root.name);
  assert.equal(lock.packages[""].name, root.name);
  assert.equal(lock.packages[""].license, root.license);
  assert.equal(lock.version, root.version);
});
