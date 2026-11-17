# Deployment

The daemon is a single Node.js process: `node src/daemon/index.ts` (Node.js >= 22.18, no build step).
All settings come from one env file (see [configuration.md](../docs/guide/configuration.md)); state
lives in `$XDG_STATE_HOME/mxagent/` or `MXA_STATE_DIR`. Back up the state directory: it holds the
crypto store, the bot session, the bot's trust anchor, the pinned owner key and the replay log
(plus `sso-session.json` between `login-sso` and the next start), and losing it means re-verifying
the bot. The directory of the config file holds the remote machine secrets (`machines`); protect
and back it up as well. Both directories should be mode 0700 and owned by the user the daemon runs
as.

Every setup needs the same one-time sequence (see
[getting-started.md](../docs/guide/getting-started.md)): prepare the bot account, log in
(`login-password` or `login-sso`), start the daemon once (it creates the rooms and the device keys
and logs the device fingerprint), stop it, run `cross-sign`, start it again. Before `cross-sign`
the daemon sends nothing (the log says "bot identity not anchored"); a
silent system room after the second start usually means an unverified session of the bot or the
owner (see [unverified devices block sending](../docs/guide/getting-started.md#unverified-devices-block-sending)).
The commands that write the state file (`login-*`, `cross-sign`, `remove-room`, `reset-owner-pin`)
refuse to run while the daemon is running.

`cross-sign` asks for the recovery key and, when needed, for confirmations, so run it in a
terminal. It signs only a device whose key matches the one the daemon recorded at startup; `-y`
skips the device question in that case and nothing else. Without a terminal, pass the
fingerprints you checked: `--device-fingerprint <fp>` (from the daemon's `ed25519 fingerprint` log
line) when the daemon has no record of the device, and `--master-fingerprint <fp>` (from a client
logged in as the bot) when the master key is not in secret storage; together with `-y` and
`MXA_RECOVERY_KEY` in the environment of that one command.

The admin CLI runs from the checkout: `node cli/mxagentctl.ts <command>` (or
`npm run ctl -- <command>`). It must see the same `MXA_CONFIG`, `MXA_STATE_DIR` and
`MXA_SOCKET_PATH` as the daemon.

Agents on the same host connect through the Unix socket (`MXA_SOCKET_PATH`, mode 0600, so the agent
must run as the same user). Agents on other machines need `MXA_WS_LISTEN`, which also enables
`GET /health`.

| File | Purpose |
|---|---|
| `systemd/mxagent.service` | system service with a dedicated user and sandboxing |
| `systemd/mxagent.user.service` | user service (systemd `--user`) |
| `docker/Dockerfile`, `docker/compose.yml` | container image and compose setup |
| `../examples/healthcheck.sh` | `/health` probe for cron or uptime monitors |

## Bare metal

```sh
npm ci --omit=dev        # must run install scripts: the crypto library downloads its native binary
```

Do not use `--ignore-scripts`. If the host has no internet access during install, run `npm ci` on a
machine with the same OS and CPU architecture and copy `node_modules/` over.

### System service

```sh
sudo useradd --system --home-dir /var/lib/mxagent --shell /usr/sbin/nologin mxagent
sudo cp -r . /opt/mxagent          # or git clone there, then npm ci --omit=dev
sudo install -d -m 0700 -o mxagent -g mxagent /etc/mxagent /var/lib/mxagent
sudo install -m 0600 -o mxagent -g mxagent bridge.env /etc/mxagent/bridge.env
sudo cp deploy/systemd/mxagent.service /etc/systemd/system/
sudo systemctl daemon-reload
```

Paths used by the unit:

| Path | Content |
|---|---|
| `/opt/mxagent` | code (read-only for the service) |
| `/etc/mxagent/bridge.env` | config (`MXA_CONFIG`); `/etc/mxagent/machines` holds the machine secrets |
| `/var/lib/mxagent` | state (`MXA_STATE_DIR`), including `sso-session.json` after `login-sso` |
| `/run/mxagent/bridge.sock` | agent socket (`MXA_SOCKET_PATH`) |

`/etc/mxagent` and `/var/lib/mxagent` are mode 0700 and owned by the service user; the unit's
`ConfigurationDirectory=`/`StateDirectory=` settings apply this on every start. `mxagentctl` (run as
that user) writes `machines` into the config directory. The service itself sees `/etc` read-only
(`ProtectSystem=strict`) and writes only its state directory, which is why the SSO session lives
there: the daemon can delete it after importing it. A group- or world-readable `bridge.env` makes the
daemon log a warning.

Run `mxagentctl` as the service user with the same environment, for example with a small shell
function:

```sh
mxagentctl() {
  sudo -u mxagent env MXA_CONFIG=/etc/mxagent/bridge.env MXA_STATE_DIR=/var/lib/mxagent \
    MXA_SOCKET_PATH=/run/mxagent/bridge.sock node /opt/mxagent/cli/mxagentctl.ts "$@"
}
mxagentctl status
```

First start:

```sh
mxagentctl login-password                     # or: mxagentctl login-sso --port 8400 (SSH forward)
sudo systemctl start mxagent
journalctl -u mxagent | grep 'ed25519 fingerprint'
sudo systemctl stop mxagent
mxagentctl cross-sign                         # asks for the recovery key, compare the fingerprint
sudo systemctl enable --now mxagent
journalctl -u mxagent -f
```

`add-machine` writes `client-<name>.env` into the current directory, which must be writable by
the service user:

```sh
cd /tmp && mxagentctl add-machine laptop --url wss://bridge.example.org
sudo mv /tmp/client-laptop.env ~/ && sudo chown "$USER" ~/client-laptop.env
```

`systemd-analyze security mxagent` shows the effective sandboxing. `MemoryDenyWriteExecute`
is deliberately not set because the V8 JIT needs it off.

### User service

```sh
git clone https://github.com/Rockykln/mxagent ~/.local/share/mxagent
cd ~/.local/share/mxagent && npm ci --omit=dev
mkdir -p -m 700 ~/.config/mxagent && mkdir -p ~/.config/systemd/user
$EDITOR ~/.config/mxagent/bridge.env && chmod 600 ~/.config/mxagent/bridge.env
cp deploy/systemd/mxagent.user.service ~/.config/systemd/user/mxagent.service
systemctl --user daemon-reload

# first start
node cli/mxagentctl.ts login-password
systemctl --user start mxagent
journalctl --user -u mxagent | grep 'ed25519 fingerprint'
systemctl --user stop mxagent
node cli/mxagentctl.ts cross-sign
systemctl --user enable --now mxagent
loginctl enable-linger "$USER"     # keep it running without an active login session
```

The user unit relies on the daemon defaults (`$XDG_CONFIG_HOME`, `$XDG_STATE_HOME`, `$XDG_RUNTIME_DIR`).
Adjust `WorkingDirectory=` if the code lives elsewhere. A user manager cannot wait for
`network-online.target`; if the homeserver is not reachable at startup, the daemon exits and
`Restart=on-failure` starts it again after 5 s.

## Docker

```sh
cd deploy/docker
cp /path/to/bridge.env ./bridge.env && chmod 600 bridge.env
docker compose build

# first start
docker compose run --rm bridge node cli/mxagentctl.ts login-password
docker compose up -d
docker compose logs bridge | grep 'ed25519 fingerprint'   # repeat until it appears
docker compose stop
docker compose run --rm bridge node cli/mxagentctl.ts cross-sign
docker compose up -d

docker compose logs -f
docker compose exec bridge node cli/mxagentctl.ts status
```

The socket check of `mxagentctl` cannot see a daemon in another container, so always stop the
service (`docker compose stop`) before running `login-*`, `cross-sign`, `remove-room` or
`reset-owner-pin` with `docker compose run`.

- Image: `node:22.<x>-bookworm-slim` (Debian, glibc), pinned by tag and digest in the `NODE_IMAGE`
  build argument; update both together (`docker buildx imagetools inspect <tag>` shows the digest).
  The build loads the native crypto library once, so a failed or truncated download fails the build.
  It runs as the unprivileged `node` user (uid 1000); the compose file adds a read-only root
  filesystem and drops all capabilities.
- The image contains `LICENSE` and `LICENSING.md` in `/app`; keep them when you derive images. The
  daemon is AGPL-3.0-or-later: if you publish the image, also offer the corresponding source, and if
  you run a modified daemon for others over a network, offer them its source (see
  [LICENSING.md](../LICENSING.md#distribution)).
- Settings come from `bridge.env` as environment variables (`env_file`); no config file is read inside
  the container.
- State is in the named volume `state` (`/var/lib/mxagent`).
- The compose file sets `MXA_WS_LISTEN=0.0.0.0:8640` inside the container and publishes the port on
  `127.0.0.1` only; put a TLS reverse proxy in front of it (below).
- The health check calls `/health` inside the container, so it requires `MXA_WS_LISTEN`.
- The socket is on a tmpfs inside the container. To let agent containers use it, replace that tmpfs
  with a named volume mounted into both containers (and run the agent as uid 1000).
- Remote machines: the machines file is stored in the config directory,
  `/home/node/.config/mxagent` inside the container, which is the named volume `config`. The image
  creates that directory owned by uid 1000 with mode 0700, and a new named volume takes over that
  ownership, so it is writable.
  Register machines with
  `docker compose exec -w /home/node/.config/mxagent bridge node /app/cli/mxagentctl.ts add-machine laptop --url wss://bridge.example.org`,
  copy the client file out (`docker compose cp bridge:/home/node/.config/mxagent/client-laptop.env .`),
  delete it in the container (`docker compose exec bridge rm /home/node/.config/mxagent/client-laptop.env`)
  and move it to the agent machine.
  To keep the config on the host instead, mount a directory owned by uid 1000 there in a
  `compose.override.yml` (`- ./config:/home/node/.config/mxagent`, after
  `mkdir -m 700 config && sudo chown 1000:1000 config`).
- `login-sso` needs a browser on the same host as its callback server, so it does not work inside the
  container; use `MXA_BOT_PASSWORD`, or log in on the host and copy the resulting `sso-session.json`
  into the state volume (`docker compose cp sso-session.json bridge:/var/lib/mxagent/`, then make it
  owned by uid 1000 with mode 0600). The daemon imports it on start and deletes the file.
- Multi-arch images build with `docker buildx build --platform linux/amd64,linux/arm64`; the crypto
  library's install script fetches the binary for the target architecture.

## Reverse proxy or tunnel

The WebSocket transport must be reachable over TLS. Its frames are additionally authenticated and
encrypted by the protocol handshake (`docs/reference/protocol.md`), but TLS is still required. Any reverse proxy
or tunnel works as long as it:

- forwards the WebSocket upgrade (`Upgrade` / `Connection` headers, HTTP/1.1 to the backend),
- does not close connections that carry only ping/pong traffic.

**Idle timeouts:** the daemon sends a WebSocket ping every 30 s. Many proxies and tunnels close
connections that look idle after 60-100 s; make sure the proxy's read/idle timeout is clearly above
30 s (a few minutes is a good value). A too-short timeout causes
dropped links, reconnect churn and delayed messages.

**Client addresses:** behind a proxy every connection comes from the proxy's address, so the
handshake rate limit (10 failures per 10 minutes) would lock out all clients at once. If the daemon
port is reachable only through the proxy, set `MXA_TRUST_PROXY_HEADER` to the one header the proxy
overwrites: `x-forwarded-for` (nginx, Caddy; the daemon takes the right-most entry) or
`cf-connecting-ip` (Cloudflare Tunnel). The daemon reads only that header. The proxy must not pass
on a value sent by the client; the nginx example below sets `X-Forwarded-For` itself and clears
`CF-Connecting-IP`.

Expose `/health` publicly only if an external uptime monitor needs it; it can also be restricted to
internal addresses at the proxy.

### nginx

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl;
    http2 on;
    server_name bridge.example.org;

    ssl_certificate     /etc/ssl/bridge.example.org/fullchain.pem;
    ssl_certificate_key /etc/ssl/bridge.example.org/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8640;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        # overwrite, never pass on client values (MXA_TRUST_PROXY_HEADER=x-forwarded-for)
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header CF-Connecting-IP "";
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
        proxy_buffering off;
    }
}
```

### Caddy

Caddy obtains certificates and proxies WebSocket upgrades automatically:

```caddy
bridge.example.org {
    reverse_proxy 127.0.0.1:8640 {
        header_up -CF-Connecting-IP
    }
}
```

Caddy sets `X-Forwarded-For` itself (it ignores client values unless `trusted_proxies` is
configured), so use `MXA_TRUST_PROXY_HEADER=x-forwarded-for`.

Caddy keeps upgraded connections open without an idle timeout by default, so no extra settings are
needed.

### Tunnels

With a tunnel (any service or tool that exposes a local port on a public hostname), point it at
`http://127.0.0.1:8640` and check its documentation for WebSocket support and idle-timeout settings.
An SSH local forward also works for a single remote agent machine (SSH provides the transport encryption
there, the agent connects to `ws://127.0.0.1:8640`):

```sh
ssh -N -L 8640:127.0.0.1:8640 bridge-host     # on the agent machine
```

## Monitoring

`examples/healthcheck.sh` probes `/health` and exits 0 (healthy), 1 (unhealthy), 2 (unreachable) or
3 (usage error). With `MXA_HEALTH_WEBHOOK` set it POSTs a JSON notification (`text`, `state`,
`detail`, `time`) only when the state changes, tracked in a small state file.

Webhook URLs usually contain a secret token. The script hands URLs to curl on stdin, never on its
command line, but a value written on the cron line is still visible to other local users in the
process list. Keep it in a file only the cron user can read (mode 0600), for example
`~/.config/mxagent/healthcheck.env`:

```sh
MXA_HEALTH_URL=https://bridge.example.org/health
MXA_HEALTH_WEBHOOK=https://hooks.example.org/abc
```

```cron
*/5 * * * * set -a; . "$HOME/.config/mxagent/healthcheck.env"; /opt/mxagent/examples/healthcheck.sh >/dev/null 2>&1
```
