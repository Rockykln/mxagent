# SPDX-FileCopyrightText: 2026 rockykln
# SPDX-License-Identifier: Apache-2.0
"""Python SDK for mxagent: connect an agent to its Matrix room through the bridge daemon."""

__version__ = "1.0.0"

from .agent import Agent, connect
from .config import Settings, resolve
from .errors import AuthenticationError, BridgeError, ConfigError, NotConnectedError, RequestTimeoutError, TryLaterError

__all__ = [
    "Agent",
    "AuthenticationError",
    "BridgeError",
    "ConfigError",
    "NotConnectedError",
    "RequestTimeoutError",
    "Settings",
    "TryLaterError",
    "__version__",
    "connect",
    "resolve",
]
