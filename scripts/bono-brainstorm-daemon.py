#!/usr/bin/env python3
"""
Bono Brainstorm Daemon v2
Architecture: Haiku (questioner) <-> Sonnet (answerer) continuous loop

Features:
- Haiku asks focused questions, Sonnet gives detailed answers
- Repetition detection: Haiku pivots when answers get stale
- Pause 5 mins after every 1000 lines (waits for complete answer first)
- 4-hour WhatsApp check-ins to Uday
- WhatsApp commands: stop, topic change, continue
- Usage tracking with cost estimation
- Rate limit handling with time-to-exhaust reporting
"""

import json
import os
import signal
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta

# === Configuration ===
ANTHROPIC_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
SMALL_MODEL = "claude-haiku-4-5-20251001"    # Questioner
LARGE_MODEL = "claude-sonnet-4-20250514"     # Answerer

# File paths
LOG_FILE = "/root/bono-brainstorm.log"
OUTPUT_FILE = "/root/bono-brainstorm-output.md"
USAGE_FILE = "/root/.bono-brainstorm-usage"
TOPIC_FILE = "/root/.bono-brainstorm-topic"
STOP_FILE = "/root/.bono-brainstorm-stop"
PID_FILE = "/root/.bono-brainstorm-pid"
STATE_FILE = "/root/.bono-brainstorm-state"
WA_LASTCHECK_FILE = "/root/.bono-brainstorm-wa-lastcheck"

# Thresholds
PAUSE_DURATION = 300       # 5 minutes
LINE_THRESHOLD = 1000      # Pause after this many lines
CHECKIN_INTERVAL = 4 * 3600  # 4 hours
MAX_HISTORY = 6            # Keep last N Q&A pairs in context

# WhatsApp config
EVOLUTION_URL = "http://localhost:53622"
EVOLUTION_KEY = "zNAKEHsXudyqL3dFngyBJAZWw9W4hWN0"
INSTANCE = "Racing Point Reception"
UDAY_JID = "917981264279@s.whatsapp.net"
WA_DB = "/root/racingpoint-whatsapp-bot/data/conversations.db"

DEFAULT_TOPIC = "customer acquisition and growth strategies for RacingPoint, a sim racing venue in India"

# Pricing per million tokens
PRICING = {
    SMALL_MODEL: {"input": 0.80, "output": 4.00},
    LARGE_MODEL: {"input": 3.00, "output": 15.00},
}


class BrainstormDaemon:
    def __init__(self):
        self.lines_since_pause = 0
        self.total_lines = 0
        self.session_start = time.time()
        self.last_checkin = time.time()
        self.history = []  # [(question, answer), ...]
        self.running = True
        self.pause_count = 0
        self.topic = self._load_topic()

        # Per-model token tracking
        self.tokens = {
            SMALL_MODEL: {"input": 0, "output": 0},
            LARGE_MODEL: {"input": 0, "output": 0},
        }

    def _load_topic(self):
        if os.path.exists(TOPIC_FILE):
            with open(TOPIC_FILE) as f:
                t = f.read().strip()
                if t:
                    return t
        return DEFAULT_TOPIC

    def log(self, msg):
        ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        line = f"[{ts}] {msg}"
        with open(LOG_FILE, "a") as f:
            f.write(line + "\n")
        print(line)

    # --- WhatsApp ---

    def send_wa(self, text):
        try:
            data = json.dumps({"number": UDAY_JID, "text": text}).encode()
            req = urllib.request.Request(
                f"{EVOLUTION_URL}/message/sendText/{urllib.parse.quote(INSTANCE)}",
                data=data,
                headers={"Content-Type": "application/json", "apikey": EVOLUTION_KEY},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=10):
                return True
        except Exception as e:
            self.log(f"WhatsApp send error: {e}")
            return False

    def check_wa_commands(self):
        """Check recent WhatsApp messages from Uday for brainstorm commands."""
        try:
            try:
                with open(WA_LASTCHECK_FILE) as f:
                    last = f.read().strip()
            except FileNotFoundError:
                last = (datetime.utcnow() - timedelta(minutes=2)).strftime("%Y-%m-%d %H:%M:%S")

            conn = sqlite3.connect(WA_DB)
            c = conn.cursor()
            c.execute(
                "SELECT content, created_at FROM messages "
                "WHERE remote_jid=? AND created_at>? AND role='user' "
                "ORDER BY created_at ASC",
                (UDAY_JID, last),
            )
            rows = c.fetchall()
            conn.close()

            if rows:
                with open(WA_LASTCHECK_FILE, "w") as f:
                    f.write(rows[-1][1])

                for content, _ts in rows:
                    lower = content.lower().strip()
                    # Stop commands
                    if lower in (
                        "stop", "no", "stop brainstorm", "pause", "enough",
                        "stop it", "shut up", "quit", "end",
                    ):
                        return ("stop", None)
                    # Topic change
                    if lower.startswith("topic:") or lower.startswith("brainstorm:"):
                        new_topic = content.split(":", 1)[1].strip()
                        if new_topic:
                            return ("topic", new_topic)
                    # Continue / resume
                    if lower in ("continue", "yes", "go", "resume", "ok", "sure"):
                        return ("continue", None)
        except Exception as e:
            self.log(f"WhatsApp check error: {e}")
        return (None, None)

    # --- Anthropic API ---

    def call_api(self, model, system, messages, max_tokens=1024):
        """Call Anthropic Messages API. Returns (text, usage). Raises on error."""
        req_body = json.dumps({
            "model": model,
            "max_tokens": max_tokens,
            "system": system,
            "messages": messages,
        })

        req = urllib.request.Request(
            "https://api.anthropic.com/v1/messages",
            data=req_body.encode(),
            headers={
                "Content-Type": "application/json",
                "x-api-key": ANTHROPIC_KEY,
                "anthropic-version": "2023-06-01",
            },
        )

        with urllib.request.urlopen(req, timeout=120) as resp:
            result = json.loads(resp.read())
            text = result["content"][0]["text"]
            usage = result.get("usage", {})
            self.tokens[model]["input"] += usage.get("input_tokens", 0)
            self.tokens[model]["output"] += usage.get("output_tokens", 0)
            return text, usage

    # --- Brainstorm Logic ---

    def ask_question(self):
        """Haiku generates the next question."""
        system = (
            f"You are a sharp, curious business strategist conducting a deep-dive brainstorm about:\n"
            f"{self.topic}\n\n"
            "Context: RacingPoint is a sim racing venue in India with Assetto Corsa, F1 25, Forza, "
            "iRacing. Multiple rigs with Conspit wheelbases. Walk-in sessions (Rs700/30min, Rs900/60min), "
            "birthday parties, corporate events, tournaments.\n"
            'Tagline: "May the Fastest Win." Instagram: @racingpoint.esports\n\n'
            "Rules:\n"
            "- Ask ONE specific, insightful question\n"
            "- If previous answers seem repetitive or circular, PIVOT to a completely new angle\n"
            "- Dig into specifics: numbers, timelines, competition, demographics, unit economics\n"
            "- Questions should lead to actionable business insights\n"
            "- Output ONLY the question, nothing else"
        )

        if not self.history:
            messages = [{
                "role": "user",
                "content": f"Start the brainstorm. Ask your first question about: {self.topic}",
            }]
        else:
            # Format recent history for Haiku
            context_parts = ["Previous brainstorm exchanges:\n"]
            for i, (q, a) in enumerate(self.history[-MAX_HISTORY:], 1):
                # Truncate long answers to keep Haiku context small
                a_short = a[:600] + "..." if len(a) > 600 else a
                context_parts.append(f"Q{i}: {q}\nA{i}: {a_short}\n")
            context = "\n".join(context_parts)
            messages = [{
                "role": "user",
                "content": (
                    f"{context}\n\n"
                    "Based on the above, ask your next question. "
                    "Go deeper or pivot to a fresh angle if answers are getting repetitive."
                ),
            }]

        text, _ = self.call_api(SMALL_MODEL, system, messages, max_tokens=300)
        return text.strip()

    def answer_question(self, question):
        """Sonnet answers the question in detail."""
        system = (
            "You are a world-class business consultant with deep expertise in entertainment venues, "
            "esports, gaming cafes, and the Indian consumer market.\n\n"
            f"Topic: {self.topic}\n"
            "Business: RacingPoint — sim racing venue in India. Premium experience with Assetto Corsa, "
            "F1 25, Forza, iRacing on professional rigs (Conspit wheelbases).\n"
            "Pricing: Walk-in Rs700/30min, Rs900/60min, 5min free trial. "
            "Also birthday parties, corporate events, tournaments.\n"
            'Instagram: @racingpoint.esports | Tagline: "May the Fastest Win."\n\n'
            "Give detailed, actionable answers:\n"
            "- Specific strategies with implementation steps\n"
            "- Real numbers: costs, timelines, expected ROI where possible\n"
            "- Examples from similar businesses worldwide\n"
            "- Address Indian market specifics (pricing sensitivity, cultural factors)\n"
            "- Use headers and bullet points for clarity\n"
            "- Be thorough — this is a deep brainstorm, not a surface-level chat"
        )

        # Build conversation for Sonnet (it sees its own prior answers)
        messages = []
        for q, a in self.history[-MAX_HISTORY:]:
            messages.append({"role": "user", "content": q})
            messages.append({"role": "assistant", "content": a})
        messages.append({"role": "user", "content": question})

        text, _ = self.call_api(LARGE_MODEL, system, messages, max_tokens=2048)
        return text

    # --- Output & Stats ---

    def save_output(self, label, text):
        with open(OUTPUT_FILE, "a") as f:
            ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            f.write(f"\n### [{ts}] {label}\n\n{text}\n\n---\n")
        lines = len(text.strip().split("\n"))
        self.lines_since_pause += lines
        self.total_lines += lines
        return lines

    def cost_estimate(self):
        total = 0.0
        parts = []
        for model, toks in self.tokens.items():
            price = PRICING.get(model, {"input": 0, "output": 0})
            cost = (toks["input"] * price["input"] + toks["output"] * price["output"]) / 1_000_000
            total += cost
            short_name = "Haiku" if "haiku" in model else "Sonnet"
            parts.append(f"  {short_name}: {toks['input']+toks['output']:,} tok (${cost:.4f})")
        return total, "\n".join(parts)

    def usage_summary(self):
        elapsed = time.time() - self.session_start
        total_cost, cost_detail = self.cost_estimate()
        total_tok = sum(t["input"] + t["output"] for t in self.tokens.values())
        return (
            f"Q&A cycles: {len(self.history)} | Lines: {self.total_lines}\n"
            f"Tokens: {total_tok:,}\n"
            f"{cost_detail}\n"
            f"Est. cost: ${total_cost:.4f}\n"
            f"Duration: {int(elapsed // 3600)}h {int((elapsed % 3600) // 60)}m\n"
            f"Pauses: {self.pause_count}"
        )

    def save_usage(self):
        elapsed = time.time() - self.session_start
        total_cost, _ = self.cost_estimate()
        data = {
            "tokens": {
                model: {"input": t["input"], "output": t["output"], "total": t["input"] + t["output"]}
                for model, t in self.tokens.items()
            },
            "total_tokens": sum(t["input"] + t["output"] for t in self.tokens.values()),
            "estimated_cost_usd": round(total_cost, 4),
            "total_lines": self.total_lines,
            "qa_cycles": len(self.history),
            "pauses": self.pause_count,
            "elapsed_seconds": int(elapsed),
            "elapsed_human": f"{int(elapsed // 3600)}h {int((elapsed % 3600) // 60)}m",
            "session_start": datetime.fromtimestamp(self.session_start).isoformat(),
            "last_updated": datetime.now().isoformat(),
            "topic": self.topic,
        }
        with open(USAGE_FILE, "w") as f:
            json.dump(data, f, indent=2)

    # --- Pause Logic ---

    def do_pause(self):
        """Pause for PAUSE_DURATION seconds, checking for commands during pause."""
        self.pause_count += 1
        self.log(f"=== PAUSE #{self.pause_count} at {self.lines_since_pause} lines ===")
        self.send_wa(
            f"Brainstorm pause #{self.pause_count}\n\n"
            f"{self.usage_summary()}\n\n"
            f"Resuming in {PAUSE_DURATION // 60} minutes..."
        )
        self.save_usage()
        self.lines_since_pause = 0

        pause_end = time.time() + PAUSE_DURATION
        while time.time() < pause_end and self.running:
            time.sleep(10)
            if os.path.exists(STOP_FILE):
                self.running = False
                return
            cmd, data = self.check_wa_commands()
            if cmd == "stop":
                self.running = False
                self.send_wa(f"Brainstorm stopped during pause.\n\n{self.usage_summary()}")
                return
            elif cmd == "topic":
                self._change_topic(data)

        if self.running:
            self.log("=== RESUME after pause ===")

    def _change_topic(self, new_topic):
        self.topic = new_topic
        with open(TOPIC_FILE, "w") as f:
            f.write(new_topic)
        self.history = []  # Reset context for new topic
        self.log(f"Topic changed -> {new_topic}")
        self.send_wa(f"Brainstorm topic changed to:\n{new_topic}")
        with open(OUTPUT_FILE, "a") as f:
            f.write(
                f"\n\n# Topic Changed -- {datetime.now().strftime('%Y-%m-%d %H:%M')}\n"
                f"**New Topic:** {new_topic}\n\n"
            )

    # --- Main Loop ---

    def run(self):
        # PID file
        with open(PID_FILE, "w") as f:
            f.write(str(os.getpid()))

        # Remove stop file for fresh start
        if os.path.exists(STOP_FILE):
            os.remove(STOP_FILE)

        self.log("=" * 50)
        self.log("Brainstorm Daemon v2 STARTED")
        self.log(f"Topic: {self.topic}")
        self.log(f"Questioner: {SMALL_MODEL}")
        self.log(f"Answerer:   {LARGE_MODEL}")
        self.log(f"Line threshold: {LINE_THRESHOLD} -> pause {PAUSE_DURATION}s")
        self.log("=" * 50)

        # Session header in output file
        with open(OUTPUT_FILE, "a") as f:
            f.write(
                f"\n\n{'=' * 60}\n"
                f"# Brainstorm Session -- {datetime.now().strftime('%Y-%m-%d %H:%M')}\n"
                f"**Topic:** {self.topic}\n"
                f"**Models:** {SMALL_MODEL} (Q) + {LARGE_MODEL} (A)\n\n"
            )

        while self.running:
            # --- Pre-cycle checks ---

            if os.path.exists(STOP_FILE):
                self.log("Stop file detected")
                break

            cmd, data = self.check_wa_commands()
            if cmd == "stop":
                self.log("STOP command from WhatsApp")
                self.send_wa(f"Brainstorm stopped.\n\n{self.usage_summary()}")
                break
            elif cmd == "topic":
                self._change_topic(data)

            # 4-hour check-in
            if time.time() - self.last_checkin >= CHECKIN_INTERVAL:
                self.send_wa(
                    f"Brainstorm check-in ({int((time.time() - self.session_start) / 3600)}h in)\n\n"
                    f"Topic: {self.topic}\n"
                    f"{self.usage_summary()}\n\n"
                    "Reply 'stop' to pause\n"
                    "Reply 'topic: X' to change topic\n"
                    "No reply = continue"
                )
                self.last_checkin = time.time()

            # --- Q&A Cycle ---

            try:
                cycle_num = len(self.history) + 1

                # 1. Haiku asks a question
                self.log(f"[{cycle_num}] Haiku asking...")
                question = self.ask_question()
                self.save_output(f"Question #{cycle_num} (Haiku)", question)
                self.log(f"[{cycle_num}] Q: {question[:100]}...")

                # 2. Sonnet answers
                self.log(f"[{cycle_num}] Sonnet answering...")
                answer = self.answer_question(question)
                a_lines = self.save_output(f"Answer #{cycle_num} (Sonnet)", answer)
                self.log(
                    f"[{cycle_num}] A: {a_lines} lines "
                    f"(since_pause: {self.lines_since_pause}, total: {self.total_lines})"
                )

                # 3. Store in history
                self.history.append((question, answer))

                # 4. Update state file (keeps James comms cron happy)
                with open(STATE_FILE, "w") as f:
                    f.write(str(int(time.time())))

                # 5. Save usage stats
                self.save_usage()

                # 6. Check line threshold -- answer is complete, safe to pause
                if self.lines_since_pause >= LINE_THRESHOLD:
                    self.do_pause()

            except urllib.error.HTTPError as e:
                error_body = ""
                try:
                    error_body = e.read().decode()
                except Exception:
                    pass
                self.log(f"HTTP {e.code}: {error_body[:300]}")

                if e.code == 429:
                    # Rate limited
                    elapsed = time.time() - self.session_start
                    retry_after = 60
                    try:
                        retry_after = int(e.headers.get("retry-after", 60))
                    except (ValueError, TypeError):
                        pass

                    self.log(f"RATE LIMITED after {int(elapsed)}s. Retry-after: {retry_after}s")
                    self.send_wa(
                        f"API rate limit reached!\n\n"
                        f"Time to exhaust usage: {int(elapsed // 60)} minutes "
                        f"({int(elapsed // 3600)}h {int((elapsed % 3600) // 60)}m)\n"
                        f"{self.usage_summary()}\n\n"
                        f"Pausing {retry_after}s for reset..."
                    )
                    self.save_usage()

                    # Wait for rate limit reset, checking for stop commands
                    wait_end = time.time() + retry_after
                    while time.time() < wait_end and self.running:
                        time.sleep(10)
                        if os.path.exists(STOP_FILE):
                            self.running = False
                            break
                        cmd, data = self.check_wa_commands()
                        if cmd == "stop":
                            self.running = False
                            break

                elif e.code == 529:
                    self.log("API overloaded, waiting 30s")
                    time.sleep(30)
                else:
                    self.log(f"Unexpected API error {e.code}, waiting 60s")
                    time.sleep(60)

            except Exception as e:
                self.log(f"ERROR: {type(e).__name__}: {e}")
                time.sleep(30)

        # --- Shutdown ---
        self.save_usage()
        try:
            os.remove(PID_FILE)
        except OSError:
            pass
        self.log("=" * 50)
        self.log("Brainstorm Daemon v2 STOPPED")
        self.log(f"Final: {self.usage_summary()}")
        self.log("=" * 50)


def main():
    # Check for stale PID
    if os.path.exists(PID_FILE):
        with open(PID_FILE) as f:
            try:
                pid = int(f.read().strip())
                os.kill(pid, 0)  # Check if alive
                print(f"Daemon already running (PID {pid}). Kill it first or remove {PID_FILE}")
                sys.exit(1)
            except (ProcessLookupError, ValueError):
                os.remove(PID_FILE)  # Stale

    daemon = BrainstormDaemon()

    def handle_signal(signum, frame):
        daemon.log(f"Signal {signum} received, shutting down...")
        daemon.running = False

    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)

    daemon.run()


if __name__ == "__main__":
    main()
