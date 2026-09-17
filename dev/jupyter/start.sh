#!/usr/bin/env bash
# Start a disposable JupyterLab server with RTC (jupyter-collaboration) enabled.
#
# Env:
#   PORT    default 8888
#   TOKEN   default devtoken
#   ROOT    default <here>/.runtime/<PORT>/root
#   RESTART default 0; set to 1 to stop a live server on this port and start again
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-8888}"
TOKEN="${TOKEN:-devtoken}"
RUNTIME="$HERE/.runtime/$PORT"
ROOT="${ROOT:-$RUNTIME/root}"
PIDFILE="$RUNTIME/jupyter.pid"
LOGFILE="$RUNTIME/jupyter.log"
URLFILE="$RUNTIME/base_url"
BASE_URL="http://127.0.0.1:$PORT"

mkdir -p "$RUNTIME" "$ROOT"

# --- idempotency: refuse if already running, unless RESTART=1 -----------------
if [ -f "$PIDFILE" ]; then
  OLDPID="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [ -n "${OLDPID:-}" ] && kill -0 "$OLDPID" 2>/dev/null; then
    if [ "${RESTART:-0}" = "1" ]; then
      echo "start.sh: RESTART=1, stopping live server pid=$OLDPID on port $PORT" >&2
      PORT="$PORT" "$HERE/stop.sh"
    else
      echo "start.sh: server already running on port $PORT (pid=$OLDPID): $BASE_URL" >&2
      echo "start.sh: refusing to start a second one; use RESTART=1 or ./stop.sh" >&2
      exit 3
    fi
  else
    echo "start.sh: removing stale pid file ($PIDFILE)" >&2
    rm -f "$PIDFILE"
  fi
fi

# SQLiteYStore resolves its database path against the server process cwd.
# Keep every stand's persistence under its port-specific runtime directory so
# independently assigned ports cannot contend for one database.
cd "$RUNTIME"

: > "$LOGFILE"
nohup uv run --project "$HERE" jupyter lab \
  --no-browser \
  --ServerApp.open_browser=False \
  --ServerApp.ip=127.0.0.1 \
  --ServerApp.port="$PORT" \
  --ServerApp.port_retries=0 \
  --ServerApp.token="$TOKEN" \
  --ServerApp.password='' \
  --ServerApp.disable_check_xsrf=True \
  --ServerApp.root_dir="$ROOT" \
  --ServerApp.allow_origin='*' \
  --IdentityProvider.token="$TOKEN" \
  --LabApp.check_for_updates_class=jupyterlab.handlers.announcements.NeverCheckForUpdate \
  --LabApp.news_url=None \
  --YDocExtension.disable_rtc=False \
  >>"$LOGFILE" 2>&1 &

PID=$!
echo "$PID" > "$PIDFILE"

# --- wait for /api/status 200 -------------------------------------------------
DEADLINE=$(( $(date +%s) + 90 ))
ok=0
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "start.sh: jupyter process died; last log lines:" >&2
    tail -40 "$LOGFILE" >&2
    rm -f "$PIDFILE"
    exit 1
  fi
  code="$(curl -s -o /dev/null -w '%{http_code}' \
      -H "Authorization: token $TOKEN" "$BASE_URL/api/status" || true)"
  if [ "$code" = "200" ]; then ok=1; break; fi
  sleep 0.5
done

if [ "$ok" != "1" ]; then
  echo "start.sh: timed out waiting for $BASE_URL/api/status; last log lines:" >&2
  tail -40 "$LOGFILE" >&2
  kill "$PID" 2>/dev/null || true
  rm -f "$PIDFILE"
  exit 1
fi

# --- confirm the collaboration server extension is enabled --------------------
EXTLIST="$(uv run --project "$HERE" jupyter server extension list 2>&1 || true)"
if ! printf '%s' "$EXTLIST" | grep -q 'jupyter_server_ydoc.*enabled'; then
  echo "start.sh: WARNING jupyter_server_ydoc is not listed as enabled:" >&2
  printf '%s\n' "$EXTLIST" >&2
fi
printf '%s\n' "$EXTLIST" | grep -E 'jupyter_server_ydoc|jupyter_collaboration' || true

echo "$BASE_URL" > "$URLFILE"
echo "pid      : $PID"
echo "root     : $ROOT"
echo "log      : $LOGFILE"
echo "base_url : $BASE_URL"
echo "$BASE_URL"
