#!/usr/bin/env bash
# Stop the disposable Jupyter server for PORT and clean the pid file.
# Env: PORT (default 8888)
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-8888}"
RUNTIME="$HERE/.runtime/$PORT"
PIDFILE="$RUNTIME/jupyter.pid"
URLFILE="$RUNTIME/base_url"

if [ ! -f "$PIDFILE" ]; then
  echo "stop.sh: no pid file for port $PORT ($PIDFILE); nothing to stop"
  rm -f "$URLFILE"
  exit 0
fi

PID="$(cat "$PIDFILE" 2>/dev/null || true)"
if [ -z "${PID:-}" ] || ! kill -0 "$PID" 2>/dev/null; then
  echo "stop.sh: stale pid file for port $PORT (pid='${PID:-}'); cleaning"
  rm -f "$PIDFILE" "$URLFILE"
  exit 0
fi

echo "stop.sh: stopping pid $PID on port $PORT"
kill -TERM "$PID" 2>/dev/null

for _ in $(seq 1 60); do
  kill -0 "$PID" 2>/dev/null || break
  sleep 0.5
done

if kill -0 "$PID" 2>/dev/null; then
  echo "stop.sh: still alive after SIGTERM, sending SIGKILL"
  kill -KILL "$PID" 2>/dev/null
  sleep 1
fi

rm -f "$PIDFILE" "$URLFILE"
if kill -0 "$PID" 2>/dev/null; then
  echo "stop.sh: FAILED to stop pid $PID" >&2
  exit 1
fi
echo "stop.sh: stopped"
