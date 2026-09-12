#!/usr/bin/env python3
"""Probe a running disposable Jupyter server for RTC readiness.

Checks, in order:
  1. GET  /api/status                              -> 200
  2. POST /api/contents  {"type": "notebook"}      -> a fresh Untitled*.ipynb
  3. PUT  /api/collaboration/session/<path>
          {"format":"json","type":"notebook"}      -> fileId + sessionId
  4. WS   /api/collaboration/room/json:notebook:<fileId>?sessionId=..&token=..
                                                   -> connect + first frame

Env: PORT (8888), TOKEN (devtoken), HOST (127.0.0.1).
Exits non-zero on the first failure.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from urllib.parse import quote

import httpx
import websockets

HOST = os.environ.get("HOST", "127.0.0.1")
PORT = os.environ.get("PORT", "8888")
TOKEN = os.environ.get("TOKEN", "devtoken")
BASE = f"http://{HOST}:{PORT}"
WS_BASE = f"ws://{HOST}:{PORT}"
HEADERS = {"Authorization": f"token {TOKEN}"}

# Yjs sync step 1 with an empty state vector: [msgSync, stepSync1, len=1, 0x00]
SYNC_STEP1_EMPTY = bytes([0x00, 0x00, 0x01, 0x00])

failures: list[str] = []


def ok(step: str, detail: str = "") -> None:
    print(f"[ OK ] {step}" + (f" :: {detail}" if detail else ""))


def fail(step: str, detail: str) -> None:
    print(f"[FAIL] {step} :: {detail}")
    failures.append(step)


def hexdump(data: bytes, n: int = 32) -> str:
    return " ".join(f"{b:02x}" for b in data[:n])


async def main() -> int:
    print(f"base url : {BASE}")

    async with httpx.AsyncClient(headers=HEADERS, timeout=30.0) as client:
        # 1. status ----------------------------------------------------------
        r = await client.get(f"{BASE}/api/status")
        if r.status_code != 200:
            fail("1 GET /api/status", f"HTTP {r.status_code}: {r.text[:200]}")
            return 1
        ok("1 GET /api/status", json.dumps(r.json(), ensure_ascii=False))

        # 2. create a notebook ----------------------------------------------
        r = await client.post(f"{BASE}/api/contents", json={"type": "notebook"})
        if r.status_code != 201:
            fail("2 POST /api/contents", f"HTTP {r.status_code}: {r.text[:300]}")
            return 1
        created = r.json()
        path = created["path"]
        ok(
            "2 POST /api/contents (type=notebook)",
            f"path={path!r} name={created['name']!r} type={created['type']!r}",
        )

        # 3. collaboration document session ----------------------------------
        sess_url = f"{BASE}/api/collaboration/session/{quote(path, safe='')}"
        r = await client.put(sess_url, json={"format": "json", "type": "notebook"})
        if r.status_code not in (200, 201):
            fail("3 PUT /api/collaboration/session", f"HTTP {r.status_code}: {r.text[:300]}")
            return 1
        session = r.json()
        print("       raw session response JSON:")
        print("       " + json.dumps(session, ensure_ascii=False, sort_keys=True))
        print("       keys: " + ", ".join(f"{k}:{type(v).__name__}" for k, v in sorted(session.items())))
        file_id = session.get("fileId")
        session_id = session.get("sessionId")
        if not file_id or not session_id:
            fail("3 PUT /api/collaboration/session", f"missing fileId/sessionId in {session}")
            return 1
        ok("3 PUT /api/collaboration/session", f"fileId={file_id} sessionId={session_id}")

    # 4. raw websocket to the room -------------------------------------------
    room = f"json:notebook:{file_id}"
    ws_url = (
        f"{WS_BASE}/api/collaboration/room/{quote(room, safe='')}"
        f"?sessionId={quote(session_id, safe='')}&token={quote(TOKEN, safe='')}"
    )
    print(f"       ws url  : {ws_url.replace(TOKEN, '<TOKEN>')}")
    try:
        async with websockets.connect(ws_url, max_size=None, open_timeout=20) as ws:
            try:
                frame = await asyncio.wait_for(ws.recv(), timeout=10)
            except asyncio.TimeoutError:
                # Server waited for us: drive the handshake ourselves.
                print("       no unsolicited frame; sending Yjs SyncStep1 (empty state vector)")
                await ws.send(SYNC_STEP1_EMPTY)
                frame = await asyncio.wait_for(ws.recv(), timeout=15)
            data = frame if isinstance(frame, bytes) else frame.encode()
            ok(
                "4 WS /api/collaboration/room",
                f"connected, first frame {len(data)} bytes",
            )
            print(f"       first 32 bytes (hex): {hexdump(data, 32)}")
    except Exception as exc:  # noqa: BLE001
        fail("4 WS /api/collaboration/room", f"{type(exc).__name__}: {exc}")
        return 1

    if failures:
        print(f"\nFAILED steps: {failures}")
        return 1
    print("\nAll probes passed.")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
