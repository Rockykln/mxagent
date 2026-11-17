# SPDX-FileCopyrightText: 2026 rockykln
# SPDX-License-Identifier: Apache-2.0
"""Transports: Unix socket and encrypted WebSocket. Both exchange NDJSON text."""

from __future__ import annotations

import asyncio
import codecs
import json
from typing import Any, Optional, Protocol

from .errors import AuthenticationError, NotConnectedError, TryLaterError

MAX_MESSAGE_BYTES = 64 * 1024 * 1024
AUTH_FAILED_CLOSE_CODE = 4003
# Transient refusal (lockout, pending/link/connection cap, handshake timeout): retry later, never fatal.
TRY_LATER_CLOSE_CODE = 4029
HANDSHAKE_TIMEOUT = 10.0
MAX_HANDSHAKE_FRAME = 1024 * 1024
# The daemon closes the link (1009) on inbound WebSocket messages over 1 MiB, i.e. over this much plaintext.
MAX_OUTBOUND_PLAINTEXT = 786408
READ_CHUNK = 1 << 20


class Transport(Protocol):
    async def send(self, data: str) -> None: ...

    async def recv(self) -> Optional[str]:
        """Next chunk of NDJSON text, or None when the connection is closed."""
        ...

    async def close(self) -> None: ...


class WebSocketLike(Protocol):
    async def send(self, message: str) -> None: ...

    async def recv(self) -> Any: ...

    async def close(self) -> None: ...


class UnixTransport:
    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        self._reader = reader
        self._writer = writer
        self._decoder = codecs.getincrementaldecoder("utf-8")("replace")

    @classmethod
    async def open(cls, path: str) -> "UnixTransport":
        reader, writer = await asyncio.open_unix_connection(path, limit=MAX_MESSAGE_BYTES)
        return cls(reader, writer)

    async def send(self, data: str) -> None:
        self._writer.write(data.encode("utf-8"))
        await self._writer.drain()

    async def recv(self) -> Optional[str]:
        chunk = await self._reader.read(READ_CHUNK)
        if not chunk:
            return None
        return self._decoder.decode(chunk)

    async def close(self) -> None:
        self._writer.close()
        try:
            await self._writer.wait_closed()
        except OSError:
            pass


REFUSED = "daemon refused the handshake (wrong secret or unknown machine, close 4003)"
TRY_LATER = "daemon asked to try again later (close 4029: rate limit, capacity or timeout)"


def close_code(exc: BaseException) -> Optional[int]:
    rcvd = getattr(exc, "rcvd", None)
    code = getattr(rcvd, "code", None) if rcvd is not None else getattr(exc, "code", None)
    return code if isinstance(code, int) else None


def _refusal(exc: BaseException) -> Optional[Exception]:
    """Maps a close during the handshake to the error the agent acts on, or None for other failures."""
    code = close_code(exc)
    if code == AUTH_FAILED_CLOSE_CODE:
        return AuthenticationError(REFUSED)
    if code == TRY_LATER_CLOSE_CODE:
        return TryLaterError(TRY_LATER)
    return None


async def _step(op: Any) -> Any:
    try:
        return await op
    except Exception as exc:
        err = _refusal(exc)
        if err is not None:
            raise err from exc
        raise


def _as_text(frame: Any) -> str:
    if isinstance(frame, (bytes, bytearray, str)) and len(frame) > MAX_HANDSHAKE_FRAME:
        raise AuthenticationError("handshake frame too large")
    if isinstance(frame, (bytes, bytearray)):
        return bytes(frame).decode("utf-8")
    if isinstance(frame, str):
        return frame
    raise ValueError("unexpected frame type")


async def secure_handshake(ws: WebSocketLike, machine: str, secret: str, timeout: float = HANDSHAKE_TIMEOUT):
    """Client side of the handshake. Returns the session Cipher once the daemon proved itself.

    Raises AuthenticationError if the daemon refuses the handshake (4003) or cannot prove that it knows
    the secret (malformed challenge, undecryptable or wrong `authed`), TryLaterError if the daemon asks
    to come back later (4029), and NotConnectedError if the handshake does not finish within `timeout` seconds.
    """
    from .secure import SecureError

    try:
        return await asyncio.wait_for(_handshake(ws, machine, secret), timeout)
    except asyncio.TimeoutError:
        raise NotConnectedError("secure handshake timed out") from None
    except (SecureError, ValueError) as exc:
        # ValueError covers malformed JSON, invalid UTF-8 and unexpected frame types.
        raise AuthenticationError(f"secure handshake failed: {exc}") from exc


async def _handshake(ws: WebSocketLike, machine: str, secret: str):
    from . import secure

    nc = secure.nonce()
    await _step(ws.send(json.dumps({"type": "hello", "machine": machine, "nc": secure.b64encode(nc)})))

    challenge = json.loads(_as_text(await _step(ws.recv())))
    if not isinstance(challenge, dict) or challenge.get("type") != "challenge":
        raise secure.SecureError("unexpected handshake message")
    ns = secure.b64decode(challenge.get("ns"))
    if len(ns) != secure.NONCE_BYTES:
        raise secure.SecureError("invalid server nonce")

    cipher = secure.Cipher(secret, machine, nc, ns, "client")
    await _step(ws.send(json.dumps({"type": "proof", "mac": secure.proof(secret, "client", machine, nc, ns)})))

    frame = await _step(ws.recv())
    authed = json.loads(cipher.open(_as_text(frame)))
    if (
        not isinstance(authed, dict)
        or authed.get("type") != "authed"
        or not secure.proof_ok(secret, "server", machine, nc, ns, authed.get("mac"))
    ):
        raise AuthenticationError("daemon could not prove knowledge of the machine secret")
    return cipher


class SecureWebSocketTransport:
    def __init__(self, ws: WebSocketLike, cipher: Any) -> None:
        self._ws = ws
        self._cipher = cipher

    @classmethod
    async def open(cls, url: str, machine: str, secret: str) -> "SecureWebSocketTransport":
        try:
            from websockets.asyncio.client import connect as ws_connect
        except ImportError:
            try:
                from websockets import connect as ws_connect  # type: ignore[no-redef]
            except ImportError as exc:
                raise RuntimeError(
                    "remote mode needs the 'websockets' package: pip install 'mxagent[remote]'"
                ) from exc
        # Encrypted frames are ~4/3 of the plaintext size (base64).
        ws = await ws_connect(url, max_size=MAX_MESSAGE_BYTES * 2, ping_interval=30, ping_timeout=30)
        try:
            cipher = await secure_handshake(ws, machine, secret)
        except BaseException:
            await ws.close()
            raise
        return cls(ws, cipher)

    async def send(self, data: str) -> None:
        if len(data) > MAX_OUTBOUND_PLAINTEXT // 4 and len(data.encode("utf-8")) > MAX_OUTBOUND_PLAINTEXT:
            raise ValueError(f"request too large for the WebSocket transport (max {MAX_OUTBOUND_PLAINTEXT} bytes)")
        frame = self._cipher.seal(data)
        try:
            await self._ws.send(frame)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # websockets.exceptions.ConnectionClosed* and transport errors
            raise ConnectionError(f"WebSocket send failed: {type(exc).__name__}") from exc

    async def recv(self) -> Optional[str]:
        try:
            frame = await self._ws.recv()
        except asyncio.CancelledError:
            raise
        except Exception:
            return None
        return self._cipher.open(frame)

    async def close(self) -> None:
        try:
            await self._ws.close()
        except Exception:
            pass
