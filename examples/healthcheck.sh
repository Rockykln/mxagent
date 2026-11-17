#!/bin/sh
# SPDX-FileCopyrightText: 2026 rockykln
# SPDX-License-Identifier: Apache-2.0
# Health check for the bridge daemon's HTTP endpoint (GET /health, enabled by MXA_WS_LISTEN).
# Suitable for cron and uptime monitors.
#
# Exit codes: 0 healthy, 1 unhealthy (HTTP status other than 200), 2 unreachable, 3 usage error.
#
# Environment:
#   MXA_HEALTH_URL      default http://127.0.0.1:8640/health
#   MXA_HEALTH_TIMEOUT  seconds, default 10
#   MXA_HEALTH_WEBHOOK  optional URL; receives a JSON POST only when the state changes
#   (URLs are handed to curl on stdin, never on its command line.)
#   MXA_HEALTH_STATE    state file, default ${XDG_STATE_HOME:-$HOME/.local/state}/mxagent-healthcheck/state
#
# Cron example (every 5 minutes, quiet unless the webhook fires). The webhook URL usually holds a
# secret, so keep it in a file only you can read (chmod 600) instead of on the cron line, which
# other users can see in the process list:
#   */5 * * * * set -a; . "$HOME/.config/mxagent/healthcheck.env"; /path/to/healthcheck.sh >/dev/null 2>&1
# with healthcheck.env containing for example
#   MXA_HEALTH_WEBHOOK=https://hooks.example.org/abc

set -u

url=${MXA_HEALTH_URL:-http://127.0.0.1:8640/health}
timeout=${MXA_HEALTH_TIMEOUT:-10}
webhook=${MXA_HEALTH_WEBHOOK:-}
state_file=${MXA_HEALTH_STATE:-${XDG_STATE_HOME:-${HOME:-/tmp}/.local/state}/mxagent-healthcheck/state}

case $timeout in
  ''|*[!0-9]*|0|0*) echo "MXA_HEALTH_TIMEOUT must be a positive integer" >&2; exit 3 ;;
esac
nl='
'
case $url$webhook in
  *"$nl"*) echo "MXA_HEALTH_URL and MXA_HEALTH_WEBHOOK must not contain newlines" >&2; exit 3 ;;
esac
if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required" >&2
  exit 3
fi

# URLs can carry secret tokens, so they are passed to curl as a config file on stdin
# instead of on the command line, where other local users could read them (ps, /proc).
curl_url_config() {
  printf 'url = "%s"\n' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"
}

code=$(curl_url_config "$url" | curl -K - -s -o /dev/null -w '%{http_code}' --max-time "$timeout")
curl_rc=$?

if [ "$curl_rc" -ne 0 ] || [ "$code" = "000" ]; then
  state=down; detail="unreachable (curl exit $curl_rc)"; rc=2
elif [ "$code" = "200" ]; then
  state=up; detail="HTTP 200"; rc=0
else
  state=down; detail="HTTP $code"; rc=1
fi

printf '%s: %s %s\n' "$state" "$url" "$detail"

[ -n "$webhook" ] || exit "$rc"

# A missing state file counts as "up", so the first failure is reported but a healthy first run is not.
previous=up
[ -r "$state_file" ] && previous=$(cat "$state_file" 2>/dev/null || echo up)

if [ "$state" != "$previous" ]; then
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  text="mxagent is $state: $detail"
  # Values come from this script only (no quotes or backslashes), so no JSON escaping is needed.
  payload=$(printf '{"text":"%s","state":"%s","detail":"%s","time":"%s"}' "$text" "$state" "$detail" "$now")
  if curl_url_config "$webhook" | curl -K - -s -o /dev/null --fail --max-time "$timeout" \
       -H 'Content-Type: application/json' -d "$payload"; then
    mkdir -p "$(dirname "$state_file")" && printf '%s\n' "$state" > "$state_file"
  else
    # State is not saved, so the notification is retried on the next run.
    echo "webhook notification failed" >&2
  fi
fi

exit "$rc"
