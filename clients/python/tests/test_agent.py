# SPDX-FileCopyrightText: 2026 rockykln
# SPDX-License-Identifier: Apache-2.0
import asyncio
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from mxagent import (
    Agent,
    BridgeError,
    NotConnectedError,
    RequestTimeoutError,
    Settings,
    connect,
)


class FakeDaemon:
    """Minimal daemon side of the protocol over a Unix socket."""

    def __init__(self, path):
        self.path = path
        self.received = []
        self.hellos = []
        self.links = []
        self.held = False
        self.decision = "allow"
        self.reject_hello = False
        self.ignore = set()
        self.fail = {}
        self.mute_hello = False
        self.server = None

    async def start(self):
        self.server = await asyncio.start_unix_server(self._handle, path=self.path)

    async def stop(self):
        for w in self.links:
            w.close()
        self.server.close()
        await self.server.wait_closed()

    @property
    def current(self):
        return self.links[-1]

    def send(self, msg, writer=None):
        (writer or self.current).write((json.dumps(msg) + "\n").encode())

    def drop(self):
        self.current.close()

    async def _handle(self, reader, writer):
        self.links.append(writer)
        while True:
            try:
                line = await reader.readline()
            except ConnectionError:
                break
            if not line:
                break
            msg = json.loads(line)
            self.received.append(msg)
            t, rid = msg["type"], msg.get("id")
            if t == "hello":
                self.hellos.append(msg)
                if self.mute_hello:
                    pass
                elif self.reject_hello:
                    self.send({"type": "error", "id": rid, "error": "name in use"}, writer)
                else:
                    self.send({"type": "welcome", "id": rid, "room_id": "!room:example.org"}, writer)
            elif t in self.ignore:
                pass
            elif t in self.fail:
                self.send({"type": "error", "id": rid, "error": self.fail[t]}, writer)
            elif t == "reply":
                self.send({"type": "ok", "id": rid, "held": self.held}, writer)
            elif t == "approval_request":
                self.send({"type": "ok", "id": rid}, writer)
                self.send({"type": "approval_result", "request_id": msg["request_id"], "decision": self.decision},
                          writer)
            else:
                self.send({"type": "ok", "id": rid}, writer)
            try:
                await writer.drain()
            except ConnectionError:
                break

    async def wait_for(self, pred, timeout=2.0):
        loop = asyncio.get_running_loop()
        end = loop.time() + timeout
        while not pred():
            if loop.time() > end:
                raise AssertionError("condition not met in time")
            await asyncio.sleep(0.01)


class AgentTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.sock = os.path.join(self.tmp.name, "bridge.sock")
        self.daemon = FakeDaemon(self.sock)
        await self.daemon.start()
        self.agents = []

    async def asyncTearDown(self):
        for a in self.agents:
            await a.close()
        await self.daemon.stop()
        self.tmp.cleanup()

    async def make(self, **kw):
        kw.setdefault("request_timeout", 1.0)
        kw.setdefault("connect_timeout", 2.0)
        kw.setdefault("backoff_initial", 0.02)
        agent = Agent("builder", Settings(socket_path=self.sock), **kw)
        self.agents.append(agent)
        await agent.start()
        return agent

    async def test_connect_function_and_hello(self):
        agent = await connect(name="builder", socket_path=self.sock, client="test/1", instance="i1", version="2.0")
        self.agents.append(agent)
        self.assertTrue(agent.connected)
        self.assertEqual(agent.room_id, "!room:example.org")
        hello = self.daemon.hellos[0]
        self.assertEqual(
            {k: hello[k] for k in ("name", "client", "instance", "version")},
            {"name": "builder", "client": "test/1", "instance": "i1", "version": "2.0"},
        )
        self.assertIsInstance(hello["id"], int)

    async def test_requests(self):
        agent = await self.make()
        self.assertEqual(await agent.reply("hi"), {"held": False})
        self.daemon.held = True
        self.assertEqual(await agent.reply("hi"), {"held": True})
        await agent.status("working")
        await agent.ask("which branch?")
        await agent.poll("pick", ["a", "b"])
        await agent.vote(2)
        await agent.vote("a")
        await agent.react("✅")
        await agent.report_updated("0.9.0")
        await agent.report_update_failed("disk full")
        await agent.report_update_failed(RuntimeError("boom"))
        got = [{k: v for k, v in m.items() if k != "id"} for m in self.daemon.received[1:]]
        self.assertEqual(got, [
            {"type": "reply", "text": "hi"},
            {"type": "reply", "text": "hi"},
            {"type": "status", "text": "working"},
            {"type": "ask", "text": "which branch?"},
            {"type": "poll", "question": "pick", "options": ["a", "b"]},
            {"type": "vote", "answer": "2"},
            {"type": "vote", "answer": "a"},
            {"type": "react", "emoji": "✅"},
            {"type": "updated", "from": "0.9.0"},
            {"type": "update_failed", "error": "disk full"},
            {"type": "update_failed", "error": "boom"},
        ])
        ids = [m["id"] for m in self.daemon.received]
        self.assertEqual(len(ids), len(set(ids)))

    async def test_input_validation(self):
        agent = await self.make()
        with self.assertRaises(ValueError):
            await agent.poll("q", ["only one"])
        with self.assertRaises(ValueError):
            await agent.poll("q", [str(i) for i in range(21)])
        with self.assertRaises(ValueError):
            await agent.vote(0)
        with self.assertRaises(ValueError):
            await agent.reply("")
        with self.assertRaises(ValueError):
            await agent.vote(True)
        with self.assertRaises(ValueError):
            await agent.poll("q", ["a", ""])

    async def test_error_response(self):
        agent = await self.make()
        self.daemon.fail["status"] = "rate limited"
        with self.assertRaisesRegex(BridgeError, "rate limited"):
            await agent.status("x")

    async def test_request_timeout(self):
        agent = await self.make(request_timeout=0.2)
        self.daemon.ignore.add("ask")
        with self.assertRaises(RequestTimeoutError):
            await agent.ask("hello?")
        self.assertEqual(agent._pending, {})

    async def test_approval(self):
        agent = await self.make()
        self.assertEqual(await agent.request_approval("deploy", detail="to prod"), "allow")
        req = self.daemon.received[-1]
        self.assertEqual((req["type"], req["title"], req["detail"]), ("approval_request", "deploy", "to prod"))
        self.daemon.decision = "deny"
        self.assertEqual(await agent.request_approval("rm -rf", request_id="r-1"), "deny")
        self.assertEqual(self.daemon.received[-1]["request_id"], "r-1")
        self.daemon.decision = "weird"
        self.assertEqual(await agent.request_approval("x"), "deny")

    async def test_approval_timeout(self):
        agent = await self.make()
        orig = self.daemon.send

        def no_result(msg, writer=None):
            if msg.get("type") != "approval_result":
                orig(msg, writer)
        self.daemon.send = no_result
        with self.assertRaises(RequestTimeoutError):
            await agent.request_approval("x", request_id="r-9", timeout=0.1)
        self.assertEqual(agent._approvals, {})
        await self.daemon.wait_for(lambda: self.daemon.received[-1]["type"] == "approval_cancel")
        self.assertEqual(self.daemon.received[-1]["request_id"], "r-9")

    async def test_approval_cancel_when_caller_cancels(self):
        agent = await self.make()
        orig = self.daemon.send

        def no_result(msg, writer=None):
            if msg.get("type") != "approval_result":
                orig(msg, writer)
        self.daemon.send = no_result
        task = asyncio.ensure_future(agent.request_approval("x", request_id="r-c"))
        await self.daemon.wait_for(lambda: self.daemon.received[-1]["type"] == "approval_request")
        await asyncio.sleep(0.05)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        await self.daemon.wait_for(lambda: self.daemon.received[-1]["type"] == "approval_cancel")
        self.assertEqual(self.daemon.received[-1]["request_id"], "r-c")
        self.assertEqual(agent._approvals, {})

    async def test_no_approval_cancel_after_decision(self):
        agent = await self.make()
        self.assertEqual(await agent.request_approval("x", timeout=1), "allow")
        await asyncio.sleep(0.05)
        self.assertNotIn("approval_cancel", [m["type"] for m in self.daemon.received])

    async def test_approval_request_id_validation(self):
        agent = await self.make()
        with self.assertRaises(ValueError):
            await agent.request_approval("x", request_id="r" * 201)
        with self.assertRaises(ValueError):
            await agent.request_approval("x", request_id="")

    async def test_messages_and_update(self):
        agent = await self.make()
        got, sync_got, updates = [], [], []
        done = asyncio.Event()

        @agent.on_message
        async def handle(msg):
            got.append(msg)
            if len(got) == 2:
                done.set()

        @agent.on_message
        def handle_sync(msg):
            sync_got.append(msg["kind"])

        @agent.on_update
        def upd():
            updates.append(1)

        self.daemon.send({"type": "message", "kind": "text", "text": "hello", "sender": "@o:example.org", "via": "room"})
        self.daemon.send({"type": "message", "kind": "bogus", "text": "x", "sender": "s", "via": "room"})
        self.daemon.send({"type": "message", "kind": "text", "sender": "s", "via": "room"})  # no text
        self.daemon.current.write(b"not json\n[1,2]\n")
        self.daemon.send({"type": "message", "kind": "location", "text": "[location] 1, 2", "lat": 1, "lon": 2,
                          "sender": "s", "via": "control"})
        self.daemon.send({"type": "update"})
        await asyncio.wait_for(done.wait(), 2)
        await self.daemon.wait_for(lambda: updates)
        self.assertEqual([m["kind"] for m in got], ["text", "location"])
        self.assertEqual(got[1]["lat"], 1)
        self.assertEqual(sync_got, ["text", "location"])

    async def test_handler_exception_does_not_break_link(self):
        agent = await self.make()

        @agent.on_message
        async def boom(msg):
            raise RuntimeError("handler bug")

        with self.assertLogs("mxagent", level="ERROR"):
            self.daemon.send({"type": "message", "kind": "text", "text": "x", "sender": "s", "via": "room"})
            await asyncio.sleep(0.1)
        self.assertEqual(await agent.reply("still here"), {"held": False})

    async def test_heartbeat_keeps_link_and_silence_reconnects(self):
        agent = await self.make(dead_link_timeout=0.3)
        for _ in range(6):
            self.daemon.send({"type": "heartbeat"})
            await asyncio.sleep(0.1)
        self.assertEqual(len(self.daemon.hellos), 1)
        self.assertTrue(agent.connected)
        with self.assertLogs("mxagent", level="WARNING") as logs:
            await self.daemon.wait_for(lambda: len(self.daemon.hellos) == 2)
        self.assertTrue(any("link is dead" in m for m in logs.output))
        await self.daemon.wait_for(lambda: agent.connected)
        self.assertEqual(await agent.reply("back"), {"held": False})

    async def test_registration_timeout_on_reconnect(self):
        agent = await self.make(connect_timeout=0.3)
        self.daemon.mute_hello = True
        with self.assertLogs("mxagent", level="WARNING") as logs:
            self.daemon.drop()
            await self.daemon.wait_for(lambda: len(self.daemon.hellos) >= 3)
            self.daemon.mute_hello = False
            await self.daemon.wait_for(lambda: agent.connected)
        self.assertTrue(any("no welcome" in m for m in logs.output))
        self.assertEqual(await agent.reply("back"), {"held": False})

    async def test_reconnect(self):
        agent = await self.make()
        self.daemon.drop()
        await self.daemon.wait_for(lambda: len(self.daemon.hellos) == 2)
        self.assertEqual(self.daemon.hellos[0]["instance"], self.daemon.hellos[1]["instance"])
        self.assertEqual(await agent.reply("back"), {"held": False})

    async def test_request_waits_for_reconnect(self):
        agent = await self.make(backoff_initial=0.2)
        self.daemon.drop()
        await self.daemon.wait_for(lambda: not agent.connected)
        self.assertEqual(await agent.reply("queued"), {"held": False})

    async def test_pending_fails_on_drop(self):
        agent = await self.make()
        self.daemon.ignore.add("ask")
        task = asyncio.ensure_future(agent.ask("q"))
        await self.daemon.wait_for(lambda: self.daemon.received[-1]["type"] == "ask")
        self.daemon.drop()
        with self.assertRaises(NotConnectedError):
            await task

    async def test_no_reconnect(self):
        agent = await self.make(reconnect=False)
        self.daemon.drop()
        await asyncio.wait_for(agent.wait_closed(), 2)
        with self.assertRaises(NotConnectedError):
            await agent.reply("x")

    async def test_hello_rejected(self):
        self.daemon.reject_hello = True
        with self.assertRaisesRegex(BridgeError, "name in use"):
            await self.make()

    async def test_no_daemon(self):
        agent = Agent("x", Settings(socket_path=os.path.join(self.tmp.name, "nope.sock")), connect_timeout=1)
        with self.assertRaises(NotConnectedError):
            await agent.start()

    async def test_instance_is_shared_per_process(self):
        a = Agent("one", Settings(socket_path=self.sock))
        b = Agent("two", Settings(socket_path=self.sock))
        self.assertEqual(a.instance, b.instance)
        self.assertEqual(Agent("x", Settings(socket_path=self.sock), instance="i").instance, "i")

    async def test_line_too_long_drops_link(self):
        import mxagent.agent as agent_mod
        orig = agent_mod.MAX_MESSAGE_BYTES
        agent_mod.MAX_MESSAGE_BYTES = 1000
        try:
            agent = await self.make()
            with self.assertLogs("mxagent", level="WARNING") as logs:
                self.daemon.current.write(b"x" * 2000)
                await self.daemon.wait_for(lambda: len(self.daemon.hellos) == 2)
            self.assertTrue(any("incoming line too long" in m for m in logs.output))
            self.assertEqual(await agent.reply("back"), {"held": False})
        finally:
            agent_mod.MAX_MESSAGE_BYTES = orig

    async def test_close_while_waiting_for_link(self):
        agent = await self.make(backoff_initial=5.0, request_timeout=5.0)
        self.daemon.drop()
        await self.daemon.wait_for(lambda: not agent.connected)
        task = asyncio.ensure_future(agent.reply("x"))
        await asyncio.sleep(0.05)
        await agent.close()
        with self.assertRaisesRegex(NotConnectedError, "agent is closed"):
            await asyncio.wait_for(task, 1)

    async def test_close_cancels_handler_tasks(self):
        agent = await self.make()
        started, cancelled = asyncio.Event(), []

        @agent.on_message
        async def slow(msg):
            started.set()
            try:
                await asyncio.sleep(60)
            except asyncio.CancelledError:
                cancelled.append(1)
                raise

        self.daemon.send({"type": "message", "kind": "text", "text": "x", "sender": "s", "via": "room"})
        await asyncio.wait_for(started.wait(), 2)
        await asyncio.wait_for(agent.close(), 2)
        self.assertEqual(cancelled, [1])
        self.assertEqual(agent._tasks, set())

    async def test_close_from_handler(self):
        agent = await self.make()

        @agent.on_message
        async def stop(msg):
            await agent.close()

        self.daemon.send({"type": "message", "kind": "text", "text": "x", "sender": "s", "via": "room"})
        await asyncio.wait_for(agent.wait_closed(), 2)
        self.assertFalse(agent.connected)

    async def test_close_during_start(self):
        self.daemon.mute_hello = True
        agent = Agent("builder", Settings(socket_path=self.sock), connect_timeout=5)
        self.agents.append(agent)
        first = asyncio.ensure_future(agent.start())
        await self.daemon.wait_for(lambda: self.daemon.hellos)
        second = asyncio.ensure_future(agent.start())
        await asyncio.sleep(0.01)
        await agent.close()
        for task in (first, second):
            with self.assertRaisesRegex(NotConnectedError, "agent is closed"):
                await asyncio.wait_for(task, 1)
        with self.assertRaisesRegex(NotConnectedError, "agent is closed"):
            await agent.start()

    async def test_concurrent_start_waits_for_registration(self):
        agent = Agent("builder", Settings(socket_path=self.sock), connect_timeout=2)
        self.agents.append(agent)
        await asyncio.gather(agent.start(), agent.start())
        self.assertTrue(agent.connected)
        self.assertEqual(len(self.daemon.hellos), 1)

    async def test_close(self):
        agent = await self.make()
        await agent.close()
        await agent.close()
        self.assertFalse(agent.connected)
        with self.assertRaises(NotConnectedError):
            await agent.status("x")

    async def test_large_message(self):
        agent = await self.make()
        got = asyncio.Event()
        box = []

        @agent.on_message
        def h(msg):
            box.append(msg)
            got.set()

        data = "A" * (3 * 1024 * 1024)
        self.daemon.send({"type": "message", "kind": "attachment", "text": "", "sender": "s", "via": "room",
                          "attachment": {"name": "a.bin", "mime": "application/octet-stream", "kind": "file",
                                         "data": data, "size": len(data)}})
        await asyncio.wait_for(got.wait(), 5)
        self.assertEqual(box[0]["attachment"]["data"], data)


class ChunkTransport:
    """In-memory transport that answers hello and feeds queued chunks to the agent."""

    def __init__(self):
        self.inbox = asyncio.Queue()
        self.sent = []

    async def send(self, data):
        msg = json.loads(data)
        self.sent.append(msg)
        if msg["type"] == "hello":
            await self.inbox.put(json.dumps({"type": "welcome", "id": msg["id"], "room_id": "!r:example.org"}) + "\n")

    async def recv(self):
        await asyncio.sleep(0)  # a real socket read yields to the loop
        return await self.inbox.get()

    async def close(self):
        await self.inbox.put(None)


class BufferingPerformanceTests(unittest.IsolatedAsyncioTestCase):
    async def test_large_line_in_small_chunks_is_linear(self):
        asyncio.get_running_loop().slow_callback_duration = 10  # building the 33 MB fixture is slow by design
        transport = ChunkTransport()

        async def factory():
            return transport

        agent = Agent("builder", Settings(socket_path="/nonexistent"), transport_factory=factory)
        got = asyncio.Event()
        box = []

        @agent.on_message
        def h(msg):
            box.append(msg)
            got.set()

        await agent.start()
        try:
            # A 25 MB attachment is a ~33 MB base64 line; deliver it in 64 KiB reads like a socket would.
            data = "A" * (33 * 1024 * 1024)
            line = json.dumps({"type": "message", "kind": "attachment", "text": "", "sender": "s", "via": "room",
                               "attachment": {"name": "a.bin", "mime": "application/octet-stream", "kind": "file",
                                              "data": data, "size": len(data)}}) + "\n"
            step = 64 * 1024
            for i in range(0, len(line), step):
                transport.inbox.put_nowait(line[i:i + step])
            del line

            loop = asyncio.get_running_loop()
            gaps = []

            async def ticker():
                last = loop.time()
                while not got.is_set():
                    await asyncio.sleep(0.01)
                    now = loop.time()
                    gaps.append(now - last)
                    last = now

            start = loop.time()
            await asyncio.wait_for(asyncio.gather(got.wait(), ticker()), 30)
            elapsed = loop.time() - start
            self.assertEqual(len(box[0]["attachment"]["data"]), len(data))
            # Generous bounds: quadratic buffering took ~6 s for this size with the loop blocked throughout.
            self.assertLess(elapsed, 5.0)
            self.assertLess(max(gaps, default=0.0), 2.0)
        finally:
            await agent.close()


if __name__ == "__main__":
    unittest.main()
