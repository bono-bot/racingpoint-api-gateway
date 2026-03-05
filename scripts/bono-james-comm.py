#!/usr/bin/env python3
"""
Bono-James Instant Comm Link

Modes:
  listen              Daemon — polls every 1s, executes commands from partner
  send "command"      Send command to partner and wait for result
  send -n "command"   Send command, don't wait (fire and forget)

Config (env vars or defaults for Bono's machine):
  COMM_SELF=bono         Who am I
  COMM_PARTNER=james     Who's my partner
  COMM_API_URL=http://localhost:3100/api/comms
  COMM_API_KEY=rp-gateway-2026-secure-key
"""

import json
import os
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime

# === Config ===
SELF = os.environ.get("COMM_SELF", "bono")
PARTNER = os.environ.get("COMM_PARTNER", "james")
COMMS_URL = os.environ.get("COMM_API_URL", "http://localhost:3100/api/comms")
API_KEY = os.environ.get("COMM_API_KEY", "rp-gateway-2026-secure-key")

POLL_INTERVAL = 1      # seconds between polls
CMD_TIMEOUT = 120      # max command execution time
RESULT_TIMEOUT = 120   # max wait for result in send mode

LOG_FILE = f"/root/{SELF}-comm.log"
PID_FILE = f"/root/.{SELF}-comm-pid"


def log(msg):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] {msg}"
    with open(LOG_FILE, "a") as f:
        f.write(line + "\n")
    print(line, flush=True)


# === Comms API helpers ===

def api_get(path):
    req = urllib.request.Request(
        f"{COMMS_URL}/{path}",
        headers={"x-api-key": API_KEY},
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read())


def api_post(data):
    req = urllib.request.Request(
        f"{COMMS_URL}/messages",
        data=json.dumps(data).encode(),
        headers={"Content-Type": "application/json", "x-api-key": API_KEY},
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read())


def mark_read(msg_id):
    req = urllib.request.Request(
        f"{COMMS_URL}/messages/{msg_id}/read",
        method="PATCH",
        headers={"x-api-key": API_KEY},
    )
    try:
        urllib.request.urlopen(req, timeout=5)
    except Exception:
        pass


# === Command Execution ===

def execute_command(cmd):
    """Execute shell command, return (exit_code, output)."""
    try:
        result = subprocess.run(
            cmd, shell=True, capture_output=True, text=True, timeout=CMD_TIMEOUT,
        )
        output = result.stdout
        if result.stderr:
            output += f"\n[STDERR]\n{result.stderr}"
        return result.returncode, output.strip()
    except subprocess.TimeoutExpired:
        return 124, f"[TIMEOUT] Command timed out after {CMD_TIMEOUT}s"
    except Exception as e:
        return 1, f"[ERROR] {e}"


# === Daemon Mode ===

running = True


def listen():
    """Poll for commands from partner and execute them."""
    global running

    # PID check
    if os.path.exists(PID_FILE):
        with open(PID_FILE) as f:
            try:
                pid = int(f.read().strip())
                os.kill(pid, 0)
                print(f"Already running (PID {pid}). Kill it or remove {PID_FILE}")
                sys.exit(1)
            except (ProcessLookupError, ValueError):
                pass

    with open(PID_FILE, "w") as f:
        f.write(str(os.getpid()))

    def handle_signal(signum, frame):
        global running
        running = False

    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)

    log(f"=== Comm Link started: {SELF} listening for {PARTNER} (poll {POLL_INTERVAL}s) ===")

    while running:
        try:
            data = api_get(
                f"messages?recipient={SELF}&sender={PARTNER}&status=unread"
            )
            messages = data.get("messages", [])

            for msg in sorted(messages, key=lambda m: m.get("id", 0)):
                msg_type = msg.get("type", "")

                # Only process command messages
                if msg_type != "command":
                    continue

                msg_id = msg["id"]
                cmd = msg.get("body", "").strip()

                if not cmd:
                    mark_read(msg_id)
                    continue

                log(f"CMD #{msg_id} from {PARTNER}: {cmd}")
                mark_read(msg_id)

                # Execute
                exit_code, output = execute_command(cmd)
                log(f"Result #{msg_id} (exit {exit_code}): {output[:200]}...")

                # Truncate long output
                if len(output) > 8000:
                    output = output[:8000] + f"\n\n[TRUNCATED - {len(output)} chars total]"

                # Send result back
                api_post({
                    "sender": SELF,
                    "recipient": PARTNER,
                    "type": "command_result",
                    "priority": "high",
                    "subject": f"exit:{exit_code}",
                    "body": output,
                    "ref_id": msg_id,
                })
                log(f"Result sent for CMD #{msg_id}")

        except Exception as e:
            # Don't spam logs on transient errors
            log(f"Poll error: {e}")
            time.sleep(5)
            continue

        time.sleep(POLL_INTERVAL)

    # Cleanup
    try:
        os.remove(PID_FILE)
    except OSError:
        pass
    log("=== Comm Link stopped ===")


# === Send Mode ===

def send(cmd, wait=True):
    """Send command to partner. Optionally wait for result."""
    result = api_post({
        "sender": SELF,
        "recipient": PARTNER,
        "type": "command",
        "priority": "high",
        "subject": "CMD",
        "body": cmd,
    })
    msg_id = result["id"]
    print(f">> Sent to {PARTNER} (#{msg_id}): {cmd}")

    if not wait:
        print("(fire-and-forget, not waiting for result)")
        return

    print(f"Waiting for result...", end="", flush=True)
    start = time.time()

    while time.time() - start < RESULT_TIMEOUT:
        time.sleep(1)
        print(".", end="", flush=True)
        try:
            data = api_get(
                f"messages?recipient={SELF}&sender={PARTNER}&status=unread"
            )
            for msg in data.get("messages", []):
                if msg.get("type") == "command_result" and msg.get("ref_id") == msg_id:
                    elapsed = time.time() - start
                    exit_code_str = msg.get("subject", "exit:0")
                    try:
                        exit_code = int(exit_code_str.split(":")[-1])
                    except ValueError:
                        exit_code = 0
                    output = msg.get("body", "")

                    mark_read(msg["id"])

                    print(f"\n\n--- {PARTNER} result ({elapsed:.1f}s, exit {exit_code}) ---")
                    print(output)
                    print(f"--- end ---")
                    sys.exit(exit_code)
        except Exception:
            pass

    print(f"\n[TIMEOUT] No result from {PARTNER} after {RESULT_TIMEOUT}s")
    sys.exit(124)


# === CLI ===

def usage():
    print("Usage:")
    print(f"  {sys.argv[0]} listen              Start daemon (polls for commands)")
    print(f"  {sys.argv[0]} send 'command'      Send command and wait for result")
    print(f"  {sys.argv[0]} send -n 'command'   Send command, don't wait")
    print()
    print(f"  Self: {SELF}, Partner: {PARTNER}")
    print(f"  Set COMM_SELF / COMM_PARTNER env vars to change")
    sys.exit(1)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        usage()

    mode = sys.argv[1]

    if mode == "listen":
        listen()
    elif mode == "send":
        if len(sys.argv) < 3:
            usage()
        no_wait = sys.argv[2] == "-n"
        if no_wait:
            if len(sys.argv) < 4:
                usage()
            cmd = " ".join(sys.argv[3:])
        else:
            cmd = " ".join(sys.argv[2:])
        send(cmd, wait=not no_wait)
    else:
        usage()
