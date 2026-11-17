# SPDX-FileCopyrightText: 2026 rockykln
# SPDX-License-Identifier: Apache-2.0
"""Secure WebSocket handshake and AES-256-GCM framing (pure functions, no I/O).

See docs/reference/protocol.md, section "Secure WebSocket handshake".
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import os
import re

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

ROOT_SALT = b"mxagent"
ROOT_INFO = b"root-v1"
SESSION_INFO = b"session-v1"
NONCE_BYTES = 16
COUNTER_BYTES = 8
TAG_BYTES = 16
DIR_CLIENT_TO_DAEMON = 1
DIR_DAEMON_TO_CLIENT = 2
_MAX_COUNTER = (1 << 64) - 1
_SECRET_RE = re.compile(r"[A-Za-z0-9_-]{32,256}")
_MACHINE_RE = re.compile(r"[a-z0-9-]{1,32}")


class SecureError(Exception):
    """Handshake or frame verification failed."""


def b64encode(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def b64decode(text: object) -> bytes:
    if not isinstance(text, str):
        raise SecureError("expected base64 string")
    try:
        return base64.b64decode(text, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise SecureError("invalid base64") from exc


def _hkdf(ikm: bytes, salt: bytes, info: bytes) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=salt, info=info).derive(ikm)


def root_key(secret: str) -> bytes:
    """Raises ValueError unless `secret` is 32-256 base64url characters (used verbatim)."""
    if not isinstance(secret, str) or not _SECRET_RE.fullmatch(secret):
        raise ValueError("invalid secret")
    return _hkdf(secret.encode("utf-8"), ROOT_SALT, ROOT_INFO)


def _machine_bytes(machine: str) -> bytes:
    if not isinstance(machine, str) or not _MACHINE_RE.fullmatch(machine):
        raise ValueError("invalid machine name")
    return machine.encode("utf-8")


def session_key(secret: str, machine: str, nc: bytes, ns: bytes) -> bytes:
    """HKDF-SHA256(root, salt = nc || ns, info = "session-v1" || 0x00 || machine)."""
    return _hkdf(root_key(secret), nc + ns, SESSION_INFO + b"\x00" + _machine_bytes(machine))


def nonce() -> bytes:
    return os.urandom(NONCE_BYTES)


def _check_nonces(nc: bytes, ns: bytes) -> None:
    if len(nc) != NONCE_BYTES or len(ns) != NONCE_BYTES:
        raise SecureError("nonces must be 16 bytes")


def proof(secret: str, role: str, machine: str, nc: bytes, ns: bytes) -> str:
    """base64(HMAC-SHA256(root, role || 0x00 || machine || 0x00 || nc || ns)), role "client" or "server"."""
    if role not in ("client", "server"):
        raise ValueError("role must be 'client' or 'server'")
    _check_nonces(nc, ns)
    msg = role.encode("ascii") + b"\x00" + _machine_bytes(machine) + b"\x00" + nc + ns
    mac = hmac.new(root_key(secret), msg, hashlib.sha256).digest()
    return b64encode(mac)


def proof_ok(secret: str, role: str, machine: str, nc: bytes, ns: bytes, mac: object) -> bool:
    try:
        got = b64decode(mac)
    except SecureError:
        return False
    try:
        want = base64.b64decode(proof(secret, role, machine, nc, ns))
    except (ValueError, SecureError):
        return False
    return hmac.compare_digest(got, want)


def _iv(direction: int, counter: int) -> bytes:
    return bytes([direction, 0, 0, 0]) + counter.to_bytes(COUNTER_BYTES, "big")


class Cipher:
    """Per-connection cipher. `role` ("client" or "server") selects the send direction byte."""

    def __init__(self, secret: str, machine: str, nc: bytes, ns: bytes, role: str = "client") -> None:
        if role not in ("client", "server"):
            raise ValueError("role must be 'client' or 'server'")
        _check_nonces(nc, ns)
        self._aead = AESGCM(session_key(secret, machine, nc, ns))
        client = role == "client"
        self._send_dir = DIR_CLIENT_TO_DAEMON if client else DIR_DAEMON_TO_CLIENT
        self._recv_dir = DIR_DAEMON_TO_CLIENT if client else DIR_CLIENT_TO_DAEMON
        self._send_ctr = 0
        self._recv_ctr = 0

    def seal(self, text: str) -> str:
        if self._send_ctr >= _MAX_COUNTER:
            raise SecureError("send counter exhausted")
        self._send_ctr += 1
        ctr = self._send_ctr
        body = self._aead.encrypt(_iv(self._send_dir, ctr), text.encode("utf-8"), None)
        return b64encode(ctr.to_bytes(COUNTER_BYTES, "big") + body)

    def open(self, frame: object) -> str:
        """Decrypt one frame. Raises SecureError on tampering, replay or reordering."""
        if isinstance(frame, (bytes, bytearray)):
            try:
                frame = bytes(frame).decode("ascii")
            except UnicodeDecodeError as exc:
                raise SecureError("invalid frame") from exc
        raw = b64decode(frame)
        if len(raw) < COUNTER_BYTES + TAG_BYTES:
            raise SecureError("short frame")
        ctr = int.from_bytes(raw[:COUNTER_BYTES], "big")
        if ctr != self._recv_ctr + 1:
            raise SecureError("unexpected counter")
        try:
            plain = self._aead.decrypt(_iv(self._recv_dir, ctr), raw[COUNTER_BYTES:], None)
        except Exception as exc:  # cryptography raises InvalidTag
            raise SecureError("frame authentication failed") from exc
        self._recv_ctr = ctr
        try:
            return plain.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise SecureError("frame is not utf-8") from exc
