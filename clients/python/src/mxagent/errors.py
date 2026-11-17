# SPDX-FileCopyrightText: 2026 rockykln
# SPDX-License-Identifier: Apache-2.0
class BridgeError(Exception):
    """Base class of every error this package raises; raised directly when the daemon answers with an error."""


class ConfigError(BridgeError, ValueError):
    """Invalid or incomplete connection settings."""


class NotConnectedError(BridgeError):
    """No link to the daemon (or it dropped while a request was pending)."""


class RequestTimeoutError(BridgeError, TimeoutError):
    """The daemon (or the owner, for approvals with a timeout) did not answer in time."""


class AuthenticationError(BridgeError):
    """The secure WebSocket handshake failed."""


class TryLaterError(NotConnectedError):
    """The daemon refused the connection for now (close 4029: lockout, capacity, timeout); never fatal."""
