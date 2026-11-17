# SPDX-FileCopyrightText: 2026 rockykln
# SPDX-License-Identifier: Apache-2.0
"""Agent link to the bridge daemon: registration, requests, inbound events, reconnects."""

from __future__ import annotations

import asyncio
import inspect
import json
import logging
import os
import random
import secrets
from typing import Any, Awaitable, Callable, Optional, Sequence, Union

from . import __version__
from .config import Settings, resolve, validate_remote
from .errors import AuthenticationError, BridgeError, NotConnectedError, RequestTimeoutError, TryLaterError
from .transport import MAX_MESSAGE_BYTES, SecureWebSocketTransport, Transport, UnixTransport

log = logging.getLogger("mxagent")

Handler = Callable[..., Union[None, Awaitable[None]]]
TransportFactory = Callable[[], Awaitable[Transport]]

MESSAGE_KINDS = frozenset({"text", "attachment", "location", "poll_started", "poll_answer", "reaction"})
DEFAULT_CLIENT = f"mxagent-python/{__version__}"
# Shared by every agent of this process, so a re-created agent replaces its stale link on the daemon.
PROCESS_INSTANCE = f"{os.getpid()}-{secrets.token_hex(8)}"
# The daemon sends a heartbeat line every 30 s; a link silent for this long is dead (protocol "Keepalive").
DEAD_LINK_TIMEOUT = 75.0
# After close 4029 ("try later") wait at least this long, plus up to TRY_LATER_JITTER seconds.
TRY_LATER_MIN = 60.0
TRY_LATER_JITTER = 30.0
MAX_REQUEST_ID = 200


class Agent:
    def __init__(
        self,
        name: str,
        settings: Settings,
        *,
        instance: Optional[str] = None,
        client: Optional[str] = None,
        version: Optional[str] = None,
        request_timeout: float = 30.0,
        connect_timeout: float = 15.0,
        reconnect: bool = True,
        backoff_initial: float = 0.5,
        backoff_max: float = 30.0,
        dead_link_timeout: float = DEAD_LINK_TIMEOUT,
        retry_auth_failures: bool = False,
        transport_factory: Optional[TransportFactory] = None,
    ) -> None:
        if not isinstance(name, str) or not name.strip():
            raise ValueError("name must be a non-empty string")
        if settings.remote:
            validate_remote(settings.url, settings.machine, settings.secret)
        self.name = name
        self.instance = instance or PROCESS_INSTANCE
        self.client = client or DEFAULT_CLIENT
        self.version = version
        self.settings = settings
        self.request_timeout = request_timeout
        self.connect_timeout = connect_timeout
        self.reconnect = reconnect
        self.dead_link_timeout = dead_link_timeout
        self.retry_auth_failures = retry_auth_failures
        self._backoff_initial = backoff_initial
        self._backoff_max = backoff_max
        self._transport_factory = transport_factory or self._default_transport

        self.room_id: Optional[str] = None
        self._message_handlers: list[Handler] = []
        self._update_handlers: list[Handler] = []
        self._transport: Optional[Transport] = None
        self._ready = asyncio.Event()
        self._send_lock = asyncio.Lock()
        self._next_id = 1
        self._pending: dict[int, asyncio.Future] = {}
        self._approvals: dict[str, asyncio.Future] = {}
        self._tasks: set[asyncio.Future] = set()
        self._runner: Optional[asyncio.Task] = None
        self._first: Optional[asyncio.Future] = None
        self._closing = False
        self._closed = asyncio.Event()

    # ---- decorators -------------------------------------------------------

    def on_message(self, fn: Handler) -> Handler:
        """Register a handler for inbound `message` events (sync or async, gets the message dict)."""
        self._message_handlers.append(fn)
        return fn

    def on_update(self, fn: Handler) -> Handler:
        """Register a handler for the daemon's `update` request (owner asked agents to update)."""
        self._update_handlers.append(fn)
        return fn

    # ---- lifecycle --------------------------------------------------------

    @property
    def connected(self) -> bool:
        return self._ready.is_set()

    async def start(self) -> None:
        """Connect and register. Raises if the first attempt fails; later drops reconnect silently."""
        if self._closing:
            raise NotConnectedError("agent is closed")
        if self._runner is not None:
            # A concurrent start(): wait for the same first attempt.
            assert self._first is not None
            await asyncio.shield(self._first)
            return
        loop = asyncio.get_running_loop()
        self._first = loop.create_future()
        # Mark the exception as retrieved even if nobody awaits the future.
        self._first.add_done_callback(lambda f: f.cancelled() or f.exception())
        self._runner = loop.create_task(self._run())
        try:
            await asyncio.wait_for(asyncio.shield(self._first), self.connect_timeout)
        except asyncio.TimeoutError:
            await self.close()
            raise NotConnectedError("not connected to the bridge daemon") from None
        except BaseException:
            await self.close()
            raise

    async def close(self) -> None:
        if self._closing:
            await self._closed.wait()
            return
        self._closing = True
        self._ready.clear()
        if self._first is not None and not self._first.done():
            self._first.set_exception(NotConnectedError("agent is closed"))
        current = asyncio.current_task()
        runner = self._runner
        if runner is not None and runner is not current:
            runner.cancel()
            try:
                await runner
            except BaseException:
                pass
        await self._drop_transport()
        self._fail_pending(NotConnectedError("agent is closed"))
        self._fail_approvals(NotConnectedError("agent is closed"))
        tasks = [t for t in self._tasks if t is not current]
        for t in tasks:
            t.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._closed.set()

    async def wait_closed(self) -> None:
        await self._closed.wait()

    async def __aenter__(self) -> "Agent":
        await self.start()
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.close()

    # ---- requests ---------------------------------------------------------

    async def reply(self, text: str) -> dict:
        """Message in the agent's own room. Returns {"held": bool}."""
        res = await self._request("reply", text=_text(text, "text"))
        return {"held": bool(res.get("held", False))}

    async def status(self, text: str) -> None:
        await self._request("status", text=_text(text, "text"))

    async def ask(self, text: str) -> None:
        await self._request("ask", text=_text(text, "text"))

    async def poll(self, question: str, options: Sequence[str]) -> None:
        opts = list(options)
        if not 2 <= len(opts) <= 20 or not all(isinstance(o, str) and o for o in opts):
            raise ValueError("a poll needs 2 to 20 non-empty string options")
        await self._request("poll", question=_text(question, "question"), options=opts)

    async def vote(self, answer: Union[str, int]) -> None:
        """Vote in the owner's latest poll by option text or 1-based option number."""
        if isinstance(answer, bool) or not isinstance(answer, (str, int)):
            raise ValueError("answer must be option text or a 1-based number")
        if isinstance(answer, int) and answer < 1:
            raise ValueError("option numbers start at 1")
        # The protocol carries option numbers as strings ("2").
        await self._request("vote", answer=_text(str(answer), "answer"))

    async def react(self, emoji: str) -> None:
        await self._request("react", emoji=_text(emoji, "emoji"))

    async def request_approval(
        self,
        title: str,
        detail: Optional[str] = None,
        request_id: Optional[str] = None,
        timeout: Optional[float] = None,
    ) -> str:
        """Ask the owner to allow or deny something. Waits for the decision ("allow" | "deny").

        `timeout` (seconds) bounds the wait for the owner; None waits indefinitely. When the wait ends
        without a decision (timeout or cancellation) the agent withdraws the request (`approval_cancel`).
        """
        request_id = _text(request_id, "request_id") if request_id is not None else secrets.token_hex(8)
        if len(request_id) > MAX_REQUEST_ID:
            raise ValueError(f"request_id must be at most {MAX_REQUEST_ID} characters")
        if request_id in self._approvals:
            raise ValueError("an approval with this request_id is already pending")
        fields: dict[str, Any] = {"request_id": request_id, "title": _text(title, "title")}
        if detail is not None:
            fields["detail"] = _text(detail, "detail", allow_empty=True)
        fut = asyncio.get_running_loop().create_future()
        self._approvals[request_id] = fut
        try:
            try:
                await self._request("approval_request", **fields)
                if timeout is None:
                    return await asyncio.shield(fut)
                try:
                    return await asyncio.wait_for(asyncio.shield(fut), timeout)
                except asyncio.TimeoutError:
                    raise RequestTimeoutError("no approval decision in time") from None
            except (RequestTimeoutError, asyncio.CancelledError):
                self._spawn(self._cancel_approval(request_id))
                raise
        finally:
            self._approvals.pop(request_id, None)

    async def _cancel_approval(self, request_id: str) -> None:
        """Best effort: the daemon answers with an error if the approval is no longer pending."""
        try:
            await self._request("approval_cancel", request_id=request_id)
        except BridgeError as exc:
            log.debug("approval_cancel failed: %s", _describe(exc))

    async def report_updated(self, from_version: str) -> None:
        await self._request("updated", **{"from": _text(from_version, "from_version")})

    async def report_update_failed(self, error: Union[str, BaseException]) -> None:
        if isinstance(error, BaseException):
            error = str(error) or type(error).__name__
        await self._request("update_failed", error=_text(error, "error"))

    async def _request(self, type_: str, **fields: Any) -> dict:
        if self._closing:
            raise NotConnectedError("agent is closed")
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self.request_timeout
        if not self._ready.is_set():
            await self._wait_ready(self.request_timeout)
            if self._closing:
                raise NotConnectedError("agent is closed")
        req_id = self._alloc_id()
        fut = loop.create_future()
        self._pending[req_id] = fut
        try:
            await self._send({"type": type_, "id": req_id, **fields})
            res = await asyncio.wait_for(fut, max(0.0, deadline - loop.time()))
        except asyncio.TimeoutError:
            raise RequestTimeoutError(f"{type_}: no answer from the daemon") from None
        except (OSError, ConnectionError) as exc:
            raise NotConnectedError("connection to the bridge daemon lost") from exc
        finally:
            self._pending.pop(req_id, None)
        if res.get("type") == "error":
            raise BridgeError(str(res.get("error") or "unknown error"))
        return res

    async def _wait_ready(self, timeout: float) -> None:
        """Wait for registration; returns early if the agent closes meanwhile."""
        ready = asyncio.ensure_future(self._ready.wait())
        closed = asyncio.ensure_future(self._closed.wait())
        try:
            await asyncio.wait({ready, closed}, timeout=timeout, return_when=asyncio.FIRST_COMPLETED)
        finally:
            ready.cancel()
            closed.cancel()
        if not self._ready.is_set() and not self._closing:
            raise NotConnectedError("not connected to the bridge daemon")

    # ---- connection loop --------------------------------------------------

    async def _default_transport(self) -> Transport:
        s = self.settings
        if s.remote:
            assert s.url and s.machine and s.secret
            return await SecureWebSocketTransport.open(s.url, s.machine, s.secret)
        assert s.socket_path
        return await UnixTransport.open(s.socket_path)

    def _alloc_id(self) -> int:
        i = self._next_id
        self._next_id += 1
        return i

    async def _send(self, msg: dict) -> None:
        transport = self._transport
        if transport is None:
            raise NotConnectedError("not connected to the bridge daemon")
        line = json.dumps(msg, ensure_ascii=False, separators=(",", ":")) + "\n"
        async with self._send_lock:
            await transport.send(line)

    async def _run(self) -> None:
        delay = self._backoff_initial
        while not self._closing:
            registered = False
            auth_failed = False
            try_later = False
            try:
                registered = await self._attempt()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                auth_failed = isinstance(exc, AuthenticationError)
                try_later = isinstance(exc, TryLaterError)
                if not self._report_first_failure(exc):
                    if auth_failed and not self.retry_auth_failures:
                        log.error("bridge link failed: %s; not reconnecting", _describe(exc))
                    else:
                        log.warning("bridge link failed: %s", _describe(exc))
            finally:
                self._ready.clear()
                await self._drop_transport()
                self._fail_pending(NotConnectedError("connection to the bridge daemon lost"))
            if self._closing:
                break
            if not self.reconnect or (auth_failed and not self.retry_auth_failures):
                # close() skips awaiting the current task (this runner).
                await self.close()
                break
            if registered:
                delay = self._backoff_initial
            if try_later:
                # Lockout, capacity or timeout on the daemon: come back much later, out of step with other agents.
                await asyncio.sleep(TRY_LATER_MIN + random.uniform(0, TRY_LATER_JITTER))
                continue
            # Failed handshakes count towards the daemon's address lockout: retry them slowly.
            wait = max(delay, self._backoff_max) if auth_failed else delay
            await asyncio.sleep(wait * random.uniform(0.8, 1.2))
            delay = min(delay * 2, self._backoff_max)

    async def _attempt(self) -> bool:
        """One connection attempt; connecting and registering must finish within connect_timeout."""
        deadline = asyncio.get_running_loop().time() + self.connect_timeout
        try:
            self._transport = await asyncio.wait_for(self._transport_factory(), self.connect_timeout)
        except asyncio.TimeoutError:
            raise NotConnectedError("timed out connecting to the bridge daemon") from None
        return await self._session(deadline)

    def _report_first_failure(self, exc: BaseException) -> bool:
        if self._first is not None and not self._first.done():
            if not isinstance(exc, BridgeError):
                wrapped = NotConnectedError(f"cannot reach the bridge daemon: {_describe(exc)}")
                wrapped.__cause__ = exc
                exc = wrapped
            self._first.set_exception(exc)
            return True
        return False

    async def _session(self, deadline: float) -> bool:
        """Register (before `deadline`) and process inbound lines until the link drops."""
        hello_id = self._alloc_id()
        hello: dict[str, Any] = {"type": "hello", "id": hello_id, "name": self.name, "client": self.client,
                                 "instance": self.instance}
        if self.version:
            hello["version"] = self.version
        await self._send(hello)

        registered = False
        # Unfinished line as a list of chunks; joined once its newline arrives (linear in the line length).
        parts: list[str] = []
        size = 0
        transport = self._transport
        assert transport is not None
        loop = asyncio.get_running_loop()
        while True:
            timeout = self.dead_link_timeout
            waiting_for_welcome = False
            if not registered:
                remaining = deadline - loop.time()
                if remaining < timeout:
                    timeout, waiting_for_welcome = max(0.0, remaining), True
            try:
                chunk = await asyncio.wait_for(transport.recv(), timeout)
            except asyncio.TimeoutError:
                if waiting_for_welcome:
                    raise NotConnectedError(
                        f"no welcome from the daemon within {self.connect_timeout:g} s") from None
                raise NotConnectedError(
                    f"no data from the daemon for {self.dead_link_timeout:g} s, link is dead") from None
            if chunk is None:
                if not registered:
                    raise NotConnectedError("daemon closed the connection during registration")
                return registered
            if "\n" not in chunk:
                size += len(chunk)
                if size > MAX_MESSAGE_BYTES:
                    raise BridgeError("incoming line too long")
                parts.append(chunk)
                continue
            pieces = chunk.split("\n")
            parts.append(pieces[0])
            lines = ["".join(parts), *pieces[1:-1]]
            tail = pieces[-1]
            parts = [tail] if tail else []
            size = len(tail)
            if size > MAX_MESSAGE_BYTES or any(len(line) > MAX_MESSAGE_BYTES for line in lines):
                raise BridgeError("incoming line too long")
            for line in lines:
                msg = _parse(line)
                if msg is None:
                    continue
                kind = msg["type"]
                if not registered:
                    if kind == "welcome" and isinstance(msg.get("room_id"), str):
                        registered = True
                        self.room_id = msg["room_id"]
                        self._ready.set()
                        if self._first is not None and not self._first.done():
                            self._first.set_result(None)
                        log.info("registered as %s", self.name)
                    elif kind == "error" and msg.get("id") in (hello_id, None):
                        raise BridgeError(f"daemon rejected registration: {msg.get('error')}")
                    continue
                self._dispatch(msg)

    def _dispatch(self, msg: dict) -> None:
        kind = msg["type"]
        if kind in ("ok", "error"):
            fut = self._pending.get(msg.get("id")) if isinstance(msg.get("id"), int) else None
            if fut is not None and not fut.done():
                fut.set_result(msg)
            elif kind == "error":
                log.warning("daemon error: %s", msg.get("error"))
        elif kind == "message":
            if msg.get("kind") in MESSAGE_KINDS and isinstance(msg.get("text"), str):
                self._fire(self._message_handlers, msg)
        elif kind == "approval_result":
            fut = self._approvals.get(msg.get("request_id"))  # type: ignore[arg-type]
            if fut is not None and not fut.done():
                fut.set_result("allow" if msg.get("decision") == "allow" else "deny")
        elif kind == "update":
            self._fire(self._update_handlers)
        elif kind == "welcome" and isinstance(msg.get("room_id"), str):
            self.room_id = msg["room_id"]

    def _fire(self, handlers: list[Handler], *args: Any) -> None:
        for fn in handlers:
            try:
                result = fn(*args)
            except Exception:
                log.exception("handler %s raised", getattr(fn, "__name__", fn))
                continue
            if inspect.isawaitable(result):
                self._spawn(result)

    def _spawn(self, aw: Awaitable[Any]) -> None:
        """Run a handler or background request; close() cancels and awaits it."""
        task = asyncio.ensure_future(aw)
        self._tasks.add(task)
        task.add_done_callback(self._handler_done)

    def _handler_done(self, task: asyncio.Future) -> None:
        self._tasks.discard(task)
        if not task.cancelled() and task.exception() is not None:
            log.error("handler raised", exc_info=task.exception())

    async def _drop_transport(self) -> None:
        transport, self._transport = self._transport, None
        if transport is not None:
            await transport.close()

    def _fail_approvals(self, exc: BaseException) -> None:
        for fut in self._approvals.values():
            if not fut.done():
                fut.set_exception(exc)
        self._approvals.clear()

    def _fail_pending(self, exc: BaseException) -> None:
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(exc)
        self._pending.clear()


def _text(value: Any, field: str, allow_empty: bool = False) -> str:
    if not isinstance(value, str) or (not value and not allow_empty):
        raise ValueError(f"{field} must be a non-empty string")
    return value


def _parse(line: str) -> Optional[dict]:
    line = line.strip()
    if not line:
        return None
    try:
        msg = json.loads(line)
    except ValueError:
        return None
    if not isinstance(msg, dict) or not isinstance(msg.get("type"), str):
        return None
    return msg


def _describe(exc: BaseException) -> str:
    if isinstance(exc, (AuthenticationError, BridgeError)):
        return str(exc)
    return f"{type(exc).__name__}: {exc}"


async def connect(
    name: str,
    instance: Optional[str] = None,
    client: Optional[str] = None,
    socket_path: Optional[str] = None,
    url: Optional[str] = None,
    machine: Optional[str] = None,
    secret: Optional[str] = None,
    *,
    version: Optional[str] = None,
    config_file: Optional[str] = None,
    reconnect: bool = True,
    request_timeout: float = 30.0,
    connect_timeout: float = 15.0,
    dead_link_timeout: float = DEAD_LINK_TIMEOUT,
    retry_auth_failures: bool = False,
) -> Agent:
    """Connect to the bridge daemon and register as `name`.

    Settings fall back to MXA_SOCKET_PATH / MXA_URL / MXA_MACHINE / MXA_SECRET and then to
    $XDG_CONFIG_HOME/mxagent/client.env. A URL selects the encrypted WebSocket transport.
    """
    settings = resolve(socket_path=socket_path, url=url, machine=machine, secret=secret, env_file=config_file)
    agent = Agent(
        name,
        settings,
        instance=instance,
        client=client,
        version=version,
        reconnect=reconnect,
        request_timeout=request_timeout,
        connect_timeout=connect_timeout,
        dead_link_timeout=dead_link_timeout,
        retry_auth_failures=retry_auth_failures,
    )
    await agent.start()
    return agent
