# Commands and rooms

You talk to agents from your Matrix client. There are three kinds of rooms in your space:

| Room | What it is for |
|---|---|
| one room per agent | a private conversation with that agent |
| control room | short status lines from all agents, questions, and commands to many agents |
| system room | notices from the daemon itself: start, agents online/offline, undelivered messages, update results |

Only your own messages, sent from a verified session, are accepted. Messages from other people
are ignored; your own messages from an unverified session are rejected with a notice. See [security.md](security.md#who-can-talk-to-your-agents).

## Talk to one agent

Write in the agent's room. Everything you send there goes to that agent: text (edits arrive as
`[edited] …`), files, images, audio, video, locations, polls, poll votes and reactions to the agent's messages.

Details: [protocol.md, message kinds](../reference/protocol.md#daemon--agent).

## Commands in the control room

| You write | What happens |
|---|---|
| `@builder fix the tests` | sends `fix the tests` to the agent `builder` |
| `@all good morning` | sends the text to all connected agents (also `@room`) |
| `@list` | shows the connected agents: name, machine, version and since when |
| `@update` | asks all agents to update themselves |
| `@update builder` | asks one agent to update itself (`@update all` = all agents) |
| a reply to a message the daemon posted for an agent | goes to that agent (see below) |
| a poll | goes to all connected agents |
| anything else | not delivered; a hint appears in the system room |

Agent names are not case-sensitive: `@Builder` and `@builder` are the same agent. `@builder:` and
`@builder,` work too. A message that mentions the whole room (`@room` in most clients) is a
broadcast too, unless it starts with an explicit `@name`.

**Replies.** Replying to an agent's status line, question or approval mention (any `[name] …`
message the daemon posted) sends your reply to that agent. This works only for messages the daemon
sent since its last start; a reply to anything else, or to an older message, is treated like normal
control-room text. A message that starts with an explicit command (`@name …`, `@all`, `@list`,
`@update`) always follows that command, even when it is a reply. Edits are never treated as replies.

Details: [protocol.md, owner commands](../reference/protocol.md#owner-commands-in-the-control-room).

## Delivery reactions

The daemon reacts to your message to show whether it arrived.

| Reaction | Meaning |
|---|---|
| 👀 | delivered to the agent |
| 💤 | the agent is not connected (or an attachment could not be downloaded); the message was **not** delivered and is not queued. A notice in the agent room or the system room says so |

## Update agents

`@update` tells agents to reload themselves. Agents on the same machine are updated one after
another (8 seconds apart), so they do not all restart at once. The daemon reacts to your command
with 👀 right away and again when it is done:

| Reaction | Meaning |
|---|---|
| ✅ | all agents reported success on the same version |
| ⚠️ | at least one agent failed, did not answer in time (60 seconds plus 10 per agent), or the agents report different versions |

The details are posted in the system room. A new `@update` replaces one that is still running.

Agents do not have to support updates.

## Polls and votes in the control room

All agents share one bot account. Matrix allows only one vote or one identical reaction per
account and message, so agents cannot each vote visibly on a control-room poll. The daemon
collects their votes and posts a summary instead. The same goes for reactions from several
agents on one control-room message.

In an agent's own room this limit does not matter: there is only one agent.

## What agents can send you

| Agent does | You see it in |
|---|---|
| reply | the agent's room |
| status | the control room, prefixed with `[agent name]` |
| ask | the control room, with a mention. Reply to it to answer |
| poll | the agent's room |
| approval request | an Allow/Deny poll in the agent's room and a mention in the control room |

## Approvals

Vote Allow or Deny in the poll. The first vote from a verified session decides; ending the poll
counts as Deny. A request you do not answer expires after 15 minutes (`MXA_APPROVAL_TTL_MINUTES`):
the agent gets Deny and "Expired: …" is posted. An agent that stops waiting withdraws its request
("Cancelled: …"). A vote on a request that is no longer pending changes nothing; the daemon says so.

Reactions are never used as approvals. Your reactions reach the agent as hints only, marked as
unverified unless they were encrypted and sent from a verified session.

Details: [protocol.md, agent requests](../reference/protocol.md#agent--daemon).
