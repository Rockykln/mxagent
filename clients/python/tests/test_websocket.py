# SPDX-FileCopyrightText: 2026 rockykln
# SPDX-License-Identifier: Apache-2.0
"""Secure handshake and encrypted transport over an in-memory WebSocket pair (no network)."""

import asyncio
import base64
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

try:
    from mxagent import secure
except ImportError as exc:
    secure = None
    SKIP_REASON = f"cryptography not installed: {exc}"
else:
    SKIP_REASON = ""

from unittest import mock

import mxagent.agent as agent_module
from mxagent import Agent, AuthenticationError, NotConnectedError, Settings, TryLaterError
from mxagent.transport import SecureWebSocketTransport, secure_handshake

SECRET = "s3cret-" + "x" * 36  # 43 base64url characters, like a generated machine secret
WRONG_SECRET = "wrong-" + "y" * 37


class ConnectionClosed(Exception):
    def __init__(self, code):
        super().__init__(f"closed with code {code}")
        self.code = code


class MemoryWebSocket:
    def __init__(self):
        self.inbox = asyncio.Queue()
        self.peer = None
        self.closed_code = None

    @staticmethod
    def pair():
        a, b = MemoryWebSocket(), MemoryWebSocket()
        a.peer, b.peer = b, a
        return a, b

    async def send(self, message):
        if self.closed_code is not None:
            raise ConnectionClosed(self.closed_code)
        await self.peer.inbox.put(message)

    async def recv(self):
        item = await self.inbox.get()
        if isinstance(item, ConnectionClosed):
            self.closed_code = item.code
            raise item
        return item

    async def close(self, code=1000):
        if self.closed_code is None:
            self.closed_code = code
            await self.peer.inbox.put(ConnectionClosed(code))


class FakeSecureDaemon:
    """Daemon side: handshake, then NDJSON protocol inside encrypted frames."""

    def __init__(self, machines, server_secret_override=None):
        self.machines = machines
        self.override = server_secret_override
        self.received = []
        self.links = []
        self.silent = False
        self.try_later_at = None  # "hello" or "proof": answer with close 4029 at that step

    async def serve(self, ws):
        hello = json.loads(await ws.recv())
        if self.try_later_at == "hello":
            await ws.close(4029)
            return
        nc = secure.b64decode(hello["nc"])
        ns = secure.nonce()
        secret = self.machines.get(hello["machine"]) or base64.urlsafe_b64encode(os.urandom(32)).rstrip(b"=").decode()
        await ws.send(json.dumps({"type": "challenge", "ns": secure.b64encode(ns)}))
        proof = json.loads(await ws.recv())
        if self.try_later_at == "proof":
            await ws.close(4029)
            return
        if not secure.proof_ok(secret, "client", hello["machine"], nc, ns, proof.get("mac")):
            await ws.close(4003)
            return
        server_secret = self.override or secret
        cipher = secure.Cipher(server_secret, hello["machine"], nc, ns, "server")
        await ws.send(cipher.seal(json.dumps({"type": "authed", "machine": hello["machine"],
                                              "mac": secure.proof(server_secret, "server", hello["machine"], nc, ns)})))
        self.links.append((ws, cipher))
        try:
            while True:
                text = cipher.open(await ws.recv())
                for line in filter(None, text.split("\n")):
                    msg = json.loads(line)
                    self.received.append(msg)
                    if self.silent and msg["type"] != "hello":
                        continue
                    if msg["type"] == "hello":
                        out = {"type": "welcome", "id": msg["id"], "room_id": "!r:example.org"}
                    else:
                        out = {"type": "ok", "id": msg["id"], "held": True}
                    await ws.send(cipher.seal(json.dumps(out) + "\n"))
        except ConnectionClosed:
            pass

    async def push(self, msg):
        ws, cipher = self.links[-1]
        await ws.send(cipher.seal(json.dumps(msg) + "\n"))


@unittest.skipIf(secure is None, SKIP_REASON)
class HandshakeTests(unittest.IsolatedAsyncioTestCase):
    async def run_pair(self, daemon, machine, secret):
        client_ws, server_ws = MemoryWebSocket.pair()
        server = asyncio.ensure_future(daemon.serve(server_ws))
        try:
            return await asyncio.wait_for(secure_handshake(client_ws, machine, secret), 2), client_ws
        finally:
            if server.done():
                server.result()

    async def test_success(self):
        daemon = FakeSecureDaemon({"laptop": SECRET})
        cipher, _ = await self.run_pair(daemon, "laptop", SECRET)
        self.assertIsInstance(cipher, secure.Cipher)

    async def test_wrong_secret_gets_4003(self):
        daemon = FakeSecureDaemon({"laptop": SECRET})
        with self.assertRaisesRegex(AuthenticationError, "refused the handshake"):
            await self.run_pair(daemon, "laptop", WRONG_SECRET)

    async def test_4029_at_hello_and_after_proof_is_try_later(self):
        for step in ("hello", "proof"):
            daemon = FakeSecureDaemon({"laptop": SECRET})
            daemon.try_later_at = step
            with self.assertRaisesRegex(TryLaterError, "4029") as cm:
                await self.run_pair(daemon, "laptop", SECRET)
            self.assertIsInstance(cm.exception, NotConnectedError)
            self.assertNotIsInstance(cm.exception, AuthenticationError)

    async def test_unknown_machine_gets_challenge_then_4003(self):
        daemon = FakeSecureDaemon({})
        with self.assertRaises(AuthenticationError):
            await self.run_pair(daemon, "ghost", WRONG_SECRET)

    async def test_impostor_daemon_rejected(self):
        # A daemon that accepts any proof but does not know the secret cannot authenticate itself.
        class Impostor(FakeSecureDaemon):
            async def serve(self, ws):
                json.loads(await ws.recv())
                ns = secure.nonce()
                await ws.send(json.dumps({"type": "challenge", "ns": secure.b64encode(ns)}))
                await ws.recv()
                await ws.send(secure.b64encode(b"\x00" * 40))

        with self.assertRaisesRegex(AuthenticationError, "handshake failed"):
            await self.run_pair(Impostor({}), "laptop", SECRET)

    async def test_bad_challenge(self):
        class Bad(FakeSecureDaemon):
            async def serve(self, ws):
                await ws.recv()
                await ws.send(json.dumps({"type": "challenge", "ns": "AAAA"}))

        with self.assertRaisesRegex(AuthenticationError, "invalid server nonce"):
            await self.run_pair(Bad({}), "laptop", SECRET)

    async def test_agent_over_encrypted_transport(self):
        daemon = FakeSecureDaemon({"laptop": SECRET})
        servers = []

        async def factory():
            client_ws, server_ws = MemoryWebSocket.pair()
            servers.append(asyncio.ensure_future(daemon.serve(server_ws)))
            cipher = await secure_handshake(client_ws, "laptop", SECRET)
            return SecureWebSocketTransport(client_ws, cipher)

        settings = Settings(url="wss://bridge.example.org/agent", machine="laptop", secret=SECRET)
        agent = Agent("remote", settings, transport_factory=factory, request_timeout=1, backoff_initial=0.02)
        got = asyncio.Event()

        @agent.on_message
        def on_msg(msg):
            got.set()

        await agent.start()
        try:
            self.assertEqual(agent.room_id, "!r:example.org")
            self.assertEqual(await agent.reply("hi ñ"), {"held": True})
            self.assertEqual(daemon.received[-1]["text"], "hi ñ")
            await daemon.push({"type": "message", "kind": "text", "text": "yo", "sender": "s", "via": "room"})
            await asyncio.wait_for(got.wait(), 2)

            # Daemon drops the link: agent re-handshakes with fresh nonces and registers again.
            ws, _ = daemon.links[-1]
            await ws.close()
            for _ in range(200):
                if len(daemon.links) == 2 and agent.connected:
                    break
                await asyncio.sleep(0.01)
            self.assertEqual(len(daemon.links), 2)
            self.assertIsNone(await agent.status("again"))
            self.assertEqual(daemon.received[-1]["type"], "status")
        finally:
            await agent.close()
            for s in servers:
                s.cancel()


    async def test_malformed_challenge_json(self):
        class Garbage(FakeSecureDaemon):
            async def serve(self, ws):
                await ws.recv()
                await ws.send("{not json")

        with self.assertRaises(AuthenticationError):
            await self.run_pair(Garbage({}), "laptop", SECRET)

    async def test_handshake_timeout_without_challenge(self):
        client_ws, server_ws = MemoryWebSocket.pair()
        with self.assertRaisesRegex(NotConnectedError, "timed out"):
            await secure_handshake(client_ws, "laptop", SECRET, timeout=0.1)
        self.assertEqual(json.loads(server_ws.inbox.get_nowait())["type"], "hello")

    async def test_handshake_timeout_without_authed(self):
        class Mute(FakeSecureDaemon):
            async def serve(self, ws):
                await ws.recv()
                await ws.send(json.dumps({"type": "challenge", "ns": secure.b64encode(secure.nonce())}))
                await ws.recv()  # proof; never answers with authed

        client_ws, server_ws = MemoryWebSocket.pair()
        server = asyncio.ensure_future(Mute({}).serve(server_ws))
        with self.assertRaisesRegex(NotConnectedError, "timed out"):
            await secure_handshake(client_ws, "laptop", SECRET, timeout=0.2)
        await server

    async def test_oversized_handshake_frame_rejected(self):
        class Flood(FakeSecureDaemon):
            async def serve(self, ws):
                await ws.recv()
                await ws.send("x" * (1024 * 1024 + 1))

        with self.assertRaisesRegex(AuthenticationError, "too large"):
            await self.run_pair(Flood({}), "laptop", SECRET)

    async def test_agent_reconnects_after_handshake_timeout(self):
        daemon = FakeSecureDaemon({"laptop": SECRET})
        servers = []
        calls = []

        async def factory():
            calls.append(1)
            client_ws, server_ws = MemoryWebSocket.pair()
            if len(calls) == 2:
                # The daemon accepts the connection but never answers the hello.
                cipher = await secure_handshake(client_ws, "laptop", SECRET, timeout=0.1)
            else:
                servers.append(asyncio.ensure_future(daemon.serve(server_ws)))
                cipher = await secure_handshake(client_ws, "laptop", SECRET)
            return SecureWebSocketTransport(client_ws, cipher)

        settings = Settings(url="wss://bridge.example.org/agent", machine="laptop", secret=SECRET)
        agent = Agent("remote", settings, transport_factory=factory, request_timeout=2, backoff_initial=0.02)
        await agent.start()
        try:
            ws, _ = daemon.links[-1]
            with self.assertLogs("mxagent", level="WARNING") as logs:
                await ws.close()
                for _ in range(300):
                    if len(calls) >= 3 and agent.connected:
                        break
                    await asyncio.sleep(0.01)
            self.assertTrue(any("timed out" in m for m in logs.output))
            self.assertEqual(len(calls), 3)
            self.assertEqual(len(daemon.links), 2)
            self.assertIsNone(await agent.status("after timeout"))
        finally:
            await agent.close()
            for s in servers:
                s.cancel()

    async def make_remote(self, daemon, calls=None, **kw):
        servers = []
        calls = [] if calls is None else calls

        async def factory():
            calls.append(1)
            client_ws, server_ws = MemoryWebSocket.pair()
            servers.append(asyncio.ensure_future(daemon.serve(server_ws)))
            cipher = await secure_handshake(client_ws, "laptop", SECRET)
            return SecureWebSocketTransport(client_ws, cipher)

        kw.setdefault("request_timeout", 1)
        kw.setdefault("backoff_initial", 0.02)
        settings = Settings(url="wss://bridge.example.org/agent", machine="laptop", secret=SECRET)
        agent = Agent("remote", settings, transport_factory=factory, **kw)
        self.addAsyncCleanup(self._cleanup, agent, servers)
        await agent.start()
        return agent

    async def _cleanup(self, agent, servers):
        await agent.close()
        for s in servers:
            s.cancel()

    async def wait_until(self, pred, timeout=3.0):
        for _ in range(int(timeout / 0.01)):
            if pred():
                return
            await asyncio.sleep(0.01)
        self.fail("condition not met in time")

    async def test_auth_failure_on_reconnect_stops_agent(self):
        daemon = FakeSecureDaemon({"laptop": SECRET})
        calls = []
        agent = await self.make_remote(daemon, calls)
        daemon.machines["laptop"] = WRONG_SECRET  # machine secret revoked / rotated on the daemon
        with self.assertLogs("mxagent", level="ERROR") as logs:
            ws, _ = daemon.links[-1]
            await ws.close()
            await asyncio.wait_for(agent.wait_closed(), 3)
        self.assertTrue(any("not reconnecting" in m for m in logs.output))
        self.assertEqual(len(calls), 2)
        with self.assertRaises(NotConnectedError):
            await agent.status("x")

    async def test_auth_failure_retried_when_enabled(self):
        daemon = FakeSecureDaemon({"laptop": SECRET})
        calls = []
        agent = await self.make_remote(daemon, calls, retry_auth_failures=True, backoff_max=0.05)
        daemon.machines["laptop"] = WRONG_SECRET
        with self.assertLogs("mxagent", level="WARNING"):
            ws, _ = daemon.links[-1]
            await ws.close()
            await self.wait_until(lambda: len(calls) >= 3)
            daemon.machines["laptop"] = SECRET
            await self.wait_until(lambda: agent.connected and len(daemon.links) == 2)
        self.assertIsNone(await agent.status("back"))

    async def test_try_later_on_reconnect_waits_and_never_stops(self):
        daemon = FakeSecureDaemon({"laptop": SECRET})
        calls = []
        agent = await self.make_remote(daemon, calls)
        sleeps = []
        real_sleep = asyncio.sleep

        async def fake_sleep(delay, *a, **kw):
            sleeps.append(delay)
            await real_sleep(0.01)

        daemon.try_later_at = "hello"
        with mock.patch.object(agent_module.asyncio, "sleep", fake_sleep), self.assertLogs("mxagent", level="WARNING"):
            ws, _ = daemon.links[-1]
            await ws.close()
            await self.wait_until(lambda: len(calls) >= 3)
            daemon.try_later_at = None
            await self.wait_until(lambda: agent.connected and len(daemon.links) == 2)
        self.assertFalse(agent._closing)
        # every wait after a 4029 is at least TRY_LATER_MIN and at most TRY_LATER_MIN + TRY_LATER_JITTER
        try_later_waits = [d for d in sleeps if d >= agent_module.TRY_LATER_MIN]
        self.assertGreaterEqual(len(try_later_waits), 2)
        self.assertTrue(all(d <= agent_module.TRY_LATER_MIN + agent_module.TRY_LATER_JITTER for d in try_later_waits))
        self.assertIsNone(await agent.status("back"))

    async def test_first_attempt_auth_failure_raises(self):
        daemon = FakeSecureDaemon({"laptop": WRONG_SECRET})
        with self.assertRaises(AuthenticationError):
            await self.make_remote(daemon)

    async def test_send_on_closed_websocket_is_not_connected_error(self):
        daemon = FakeSecureDaemon({"laptop": SECRET})
        agent = await self.make_remote(daemon)
        client_ws = daemon.links[-1][0].peer

        async def closed_send(message):
            raise ConnectionClosed(1006)
        client_ws.send = closed_send
        with self.assertRaisesRegex(NotConnectedError, "connection to the bridge daemon lost"):
            await agent.status("x")

    async def test_oversized_request_rejected_before_sending(self):
        daemon = FakeSecureDaemon({"laptop": SECRET})
        agent = await self.make_remote(daemon)
        with self.assertRaisesRegex(ValueError, "too large"):
            await agent.reply("x" * 800_000)
        self.assertIsNone(await agent.status("still connected"))
        self.assertEqual(len(daemon.links), 1)

    async def test_dead_link_detection_remote(self):
        daemon = FakeSecureDaemon({"laptop": SECRET})
        agent = await self.make_remote(daemon, dead_link_timeout=0.3)
        with self.assertLogs("mxagent", level="WARNING") as logs:
            await self.wait_until(lambda: len(daemon.links) == 2 and agent.connected)
        self.assertTrue(any("link is dead" in m for m in logs.output))

    async def test_remote_heartbeat_keeps_link(self):
        daemon = FakeSecureDaemon({"laptop": SECRET})
        agent = await self.make_remote(daemon, dead_link_timeout=0.3)
        for _ in range(6):
            await daemon.push({"type": "heartbeat"})
            await asyncio.sleep(0.1)
        self.assertEqual(len(daemon.links), 1)
        self.assertTrue(agent.connected)


if __name__ == "__main__":
    unittest.main()
