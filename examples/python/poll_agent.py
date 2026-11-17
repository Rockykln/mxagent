#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 rockykln
# SPDX-License-Identifier: Apache-2.0
"""Asks the owner which disk report to produce and runs it.

Starts a poll, waits for the answer (delivered as a message of kind
"poll_answer"), runs the chosen action and replies with the result.

Usage: python3 examples/python/poll_agent.py [path]
"""

import asyncio
import shutil
import sys
from pathlib import Path

try:
    from mxagent import connect
except ImportError:  # running from a checkout without installing the package
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "clients" / "python" / "src"))
    from mxagent import connect

QUESTION = "Which report do you want?"


def free_space(path: Path) -> str:
    usage = shutil.disk_usage(path)
    return f"{path}: {usage.free / 1e9:.1f} GB free of {usage.total / 1e9:.1f} GB"


def largest_files(path: Path, n: int = 5) -> str:
    files = []
    for p in path.rglob("*"):
        try:
            if p.is_file() and not p.is_symlink():
                files.append((p.stat().st_size, p))
        except OSError:
            continue
    files.sort(reverse=True)
    lines = [f"{size / 1e6:9.1f} MB  {p.relative_to(path)}" for size, p in files[:n]]
    return "\n".join(lines) or "no files"


ACTIONS = {
    "Free space": free_space,
    "Largest files": largest_files,
    "Nothing": None,
}


async def main() -> None:
    path = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
    agent = await connect(name="poll-py")
    answered: asyncio.Future[str] = asyncio.get_running_loop().create_future()

    @agent.on_message
    async def handle(msg: dict) -> None:
        if msg["kind"] == "poll_answer" and msg.get("question") == QUESTION and not answered.done():
            choices = msg.get("choices") or []
            answered.set_result(choices[0] if choices else "Nothing")

    await agent.poll(QUESTION, list(ACTIONS))
    choice = await answered

    action = ACTIONS.get(choice)
    if action is None:
        await agent.reply("ok, nothing to do")
    else:
        # Blocking file system work runs off the event loop.
        result = await asyncio.to_thread(action, path)
        await agent.reply(result)
        await agent.status(f"report '{choice}' sent")
    await agent.close()


if __name__ == "__main__":
    asyncio.run(main())
