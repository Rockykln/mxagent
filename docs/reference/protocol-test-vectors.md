<!--
SPDX-FileCopyrightText: 2026 rockykln
SPDX-License-Identifier: Apache-2.0
-->

# Protocol test vectors

Fixed inputs and expected outputs for the "Secure WebSocket handshake" in [protocol.md](protocol.md).
SDKs in other languages should reproduce every value below.

## Inputs

| name | value |
|---|---|
| secret (base64url, used as UTF-8 string) | `QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl8` (bytes `0x40..0x5f`) |
| machine | `laptop` |
| nc (base64) | `AAECAwQFBgcICQoLDA0ODw==` (bytes `0x00..0x0f`) |
| ns (base64) | `EBESExQVFhcYGRobHB0eHw==` (bytes `0x10..0x1f`) |

Note: HKDF input is the UTF-8 bytes of the base64url **string**, not the decoded 32 bytes.

Derived inputs, written out byte by byte:

| name | bytes |
|---|---|
| HMAC message for proof(client) | `"client"` `00` `"laptop"` `00` nc ns (6 + 1 + 6 + 1 + 16 + 16 = 46 bytes) |
| HMAC message for proof(server) | `"server"` `00` `"laptop"` `00` nc ns (46 bytes) |
| session key HKDF salt | nc ns (32 bytes) |
| session key HKDF info | `"session-v1"` `00` `"laptop"` (17 bytes) |

## Expected

| name | value |
|---|---|
| root (hex) | `5348dedae3270728831465d9df320287745e48e3f0779fa5d70ccabdf6b6a201` |
| session key (hex) | `bffc9b6f251d7529119690fede5719630b3845fa85d65c02cf7ab7b3e0acaf36` |
| proof(client) | `PmLX7WYTETMHz+52Y/GlKbCJCPWClmqrxVuo9J5jjBo=` |
| proof(server) | `JtUTRpVfuJt7WMLTHPNWzwlsF7xLD34cp+mETaSosMM=` |

## Encrypted frames

First frame in each direction (counter 1). The plaintexts are real protocol lines including the trailing `\n`
(shown as `\n`, one byte `0x0a`): the client's agent `hello` and the daemon's `authed` carrying proof(server).

| direction | plaintext (UTF-8) | frame |
|---|---|---|
| client → daemon | `{"type":"hello","id":1,"name":"demo"}\n` | `AAAAAAAAAAFWFARG38MQnXCirpK5HmZ/c4xbXaYwkVEBVhA2SevLaG4i6ABxyRQn97I8Yjf5lEdisN+R8xM=` |
| daemon → client | `{"type":"authed","machine":"laptop","mac":"JtUTRpVfuJt7WMLTHPNWzwlsF7xLD34cp+mETaSosMM="}\n` | `AAAAAAAAAAGjMr5VocOwRiRMiDM/+pVr162bHYlCqGJu7FfLWPLo3pbp+PnS+ruJKJsjqi/R+CEh2ILHOG7BG62t3f0zfsbCjCicqYQVZfHSfDDZdP+atEPYUa9okuj6qgijZlUoGEbyTmQBANMmL4By` |

IVs: client → daemon `01 000000 0000000000000001`, daemon → client `02 000000 0000000000000001`.
