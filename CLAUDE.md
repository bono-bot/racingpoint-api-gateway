# racingpoint-api-gateway — Standing Rules

> Canonical source: `C:/Users/bono/racingpoint/racecontrol/CLAUDE.md`
> This file contains the RELEVANT SUBSET for this repo. Always defer to racecontrol CLAUDE.md for the full ruleset.

## Repo Identity

- **Purpose:** API gateway / reverse proxy for cloud services
- **Path:** `C:/Users/bono/racingpoint/racingpoint-api-gateway/`
- **Language:** Node.js / TypeScript

## Standing Rules

### Code Quality

- **No `any` in TypeScript** — type everything explicitly.
  _Why: `any` hides real type errors that surface at runtime, not compile time._
- **Cascade updates:** When changing a process, update ALL linked references (training data, playbooks, prompts, docs, memory). Never change one place and leave stale references.
  _Why: Stale references in playbooks or prompts cause both AIs to apply the old behavior after a fix._
- **Git Bash JSON:** Write JSON payloads to a file with Write tool, then `curl -d @file`. Bash string escaping mangles backslashes.
  _Why: Inline JSON in Git Bash strips backslashes from Windows paths, corrupting the payload._
- **No Fake Data** — use `TEST_ONLY`, `0000000000`, or leave empty. Never real-looking identifiers.
  _Why: Realistic-looking fake data (names, IDs, emails) has leaked into production databases twice._

### Process

- **Refactor Second** — characterization tests first, verify green, then refactor. No exceptions.
  _Why: Refactoring without a green test baseline turns every compile error into an unknown regression._
- **Cross-Process Updates** — changing a feature? Update ALL: rc-agent, racecontrol, PWA, Admin, Gateway, Dashboard.
  _Why: Single-crate updates leave other components speaking a different protocol version, causing silent data corruption._
- **No Fake Data** — use `TEST_ONLY`, `0000000000`, or leave empty. Never real-looking identifiers.
  _Why: Realistic-looking fake data (names, IDs, emails) has leaked into production databases twice._
- **Prompt Quality Check** — missing clarity/specificity/actionability/scope → ask one focused question before acting.
  _Why: Acting on ambiguous prompts produces work that must be redone; one question costs less than one wrong implementation._
- **Links and References = "Apply Now"** — when the user shares a link, article, or methodology alongside a problem, apply it to the current problem FIRST, document it SECOND. A reference shared during active work is a tool to use, not information to file.
  _Why: User shared 4 debugging methodologies during an active crash investigation. James wrote a comparison table and updated rules instead of applying them to the open bug. Three prompts wasted before actual debugging happened._
- **Learn From Past Fixes** — check LOGBOOK + commit history before re-investigating.
  _Why: Re-investigating solved problems wastes session time; LOGBOOK has resolved the same issue in under 2 minutes._
- **LOGBOOK:** After every commit, append `| timestamp IST | James | hash | summary |` to `LOGBOOK.md`.
  _Why: LOGBOOK is Tier 2 debugging — without consistent entries, memory-based debugging fails._

### Comms

- **Bono INBOX.md:** Append to `C:\Users\bono\racingpoint\comms-link\INBOX.md` → `git add INBOX.md && git commit && git push`. Entry format: `## YYYY-MM-DD HH:MM IST — from james`. Then also send via WS (send-message.js). Git push alone is insufficient — Bono does not auto-pull.
  _Why: Git-only comms left Bono's context stale on three occasions; WS+git is the required dual channel._
- **Auto-push + notify (atomic sequence):** `git push` → comms-link WS message → INBOX.md entry. Do all three before marking tasks complete, starting new work, or responding to Uday. Every push, every commit — even cleanup/docs/logbook. No ranking of "important" vs "minor" commits.
  _Why: Commits without push leave Bono's context stale and break deploy chains; treating minor commits as optional caused missed notifications._
- **Bono VPS exec (v18.0 — DEFAULT):** Use comms-link relay, not SSH. Single: `curl -s -X POST http://localhost:8766/relay/exec/run -H "Content-Type: application/json" -d '{"command":"git_pull"}'`. Chain: `curl -s -X POST http://localhost:8766/relay/chain/run -d '{"steps":[...]}'`. SSH (`ssh root@100.70.177.44`) only when relay is down.
  _Why: SSH requires Tailscale up and leaves no audit trail; relay is always-on and returns structured results._
- **Standing Rules Sync:** After modifying CLAUDE.md standing rules, always sync to Bono via comms-link so both AIs operate under the same rules.
  _Why: Rules drift between AIs causes inconsistent behavior and contradictory decisions in multi-agent tasks._
