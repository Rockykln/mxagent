#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 rockykln
# SPDX-License-Identifier: Apache-2.0
"""Echoes every owner message back and confirms it with a reaction.

Usage: python3 examples/python/echo_agent.py [name]
"""

import asyncio
import signal
import sys
from pathlib import Path

try:
    from mxagent import connect
except ImportError:  # running from a checkout without installing the package
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "clients" / "python" / "src"))
    from mxagent import connect


def describe(msg: dict) -> str | None:
    kind = msg["kind"]
    if kind == "text":
        return f"echo: {msg['text']}"
    if kind == "attachment":
        a = msg["attachment"]
        caption = f' "{msg["text"]}"' if msg.get("text") else ""
        return f"got {a['kind']} {a['name']} ({a['mime']}, {a['size']} bytes){caption}"
    if kind == "location":
        return f"got location {msg['lat']}, {msg['lon']}"
    if kind == "reaction":
        return None  # reacting to a reaction would loop
    return f"got {kind}: {msg['text']}"


async def main() -> None:
    name = sys.argv[1] if len(sys.argv) > 1 else "echo-py"
    agent = await connect(name=name)

    @agent.on_message
    async def handle(msg: dict) -> None:
        answer = describe(msg)
        if answer is None:
            return
        await agent.reply(answer)
        await agent.react("✅")

    await agent.status("echo agent online")

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)
    await stop.wait()
    await agent.close()


if __name__ == "__main__":
    asyncio.run(main())
