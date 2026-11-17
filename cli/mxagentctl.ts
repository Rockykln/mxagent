#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 rockykln
// SPDX-License-Identifier: AGPL-3.0-or-later
import { run } from "./commands/run.ts";

process.exitCode = await run(process.argv.slice(2));
