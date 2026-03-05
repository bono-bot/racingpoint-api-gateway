#!/bin/bash
# Bono-James Comms Cron — runs every 5 minutes
# Checks comms API for unread messages from James, processes with Sonnet, responds
# NOTE: Brainstorming moved to bono-brainstorm-daemon.py (PM2: bono-brainstorm)

set -euo pipefail

COMMS_URL="http://localhost:3100/api/comms"
API_KEY="rp-gateway-2026-secure-key"
ANTHROPIC_KEY="${ANTHROPIC_API_KEY:?Set ANTHROPIC_API_KEY env var}"
LOG="/root/bono-brainstorm.log"
STATE_FILE="/root/.bono-brainstorm-state"
STOP_FILE="/root/.bono-brainstorm-stop"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG"; }

# Check if stopped
if [ -f "$STOP_FILE" ]; then
  log "PAUSED — stop file exists. Checking for operational messages only."
fi

# Get unread messages from James
MESSAGES=$(curl -s "${COMMS_URL}/messages?recipient=bono&status=unread&sender=james" \
  -H "x-api-key: ${API_KEY}" 2>/dev/null)

COUNT=$(echo "$MESSAGES" | python3 -c "import sys,json; print(json.load(sys.stdin).get('total',0))" 2>/dev/null || echo "0")

if [ "$COUNT" -gt "0" ]; then
  log "Found $COUNT unread messages from James"

  # Process each message
  echo "$MESSAGES" | python3 -c "
import sys, json, subprocess, urllib.request, urllib.parse

data = json.load(sys.stdin)
messages = data.get('messages', [])
# Process oldest first
messages.reverse()

COMMS_URL = '${COMMS_URL}'
API_KEY = '${API_KEY}'
ANTHROPIC_KEY = '${ANTHROPIC_KEY}'
STOP_FILE = '${STOP_FILE}'
STATE_FILE = '${STATE_FILE}'

import os
is_stopped = os.path.exists(STOP_FILE)

for msg in messages:
    msg_id = msg['id']
    msg_type = msg['type']
    subject = msg['subject']
    body = msg.get('body', '')

    # If stopped, only process 'task' type messages (operational)
    if is_stopped and msg_type not in ('task',):
        continue

    print(f'Processing message #{msg_id}: [{msg_type}] {subject}')

    # Build prompt for Sonnet
    system_prompt = '''You are Bono (Peter Bonnington), the cloud AI assistant for RacingPoint eSports — a sim racing venue in India.
You are responding to a message from James (the on-site AI assistant) via an internal comms system.
Keep responses concise, actionable, and focused. You two collaborate on customer acquisition, marketing, and technical projects.
RacingPoint brand: Racing Red, motorsport-authentic, tagline \"May the Fastest Win.\"
Venue: sim racing with Assetto Corsa, F1, multiple rigs. Services include walk-in sessions, birthday parties, corporate events.
Instagram: @racingpoint.esports | Location: India
When brainstorming: build on James's ideas, add 2-3 new angles, suggest specific implementation steps.
When receiving tasks: acknowledge and note what you can do from cloud side.
Be brief — 200 words max.'''

    user_prompt = f'James sent me this message (type: {msg_type}, subject: {subject}):\n\n{body}\n\nRespond appropriately.'

    # Call Claude Sonnet
    import json as j
    req_body = j.dumps({
        'model': 'claude-sonnet-4-20250514',
        'max_tokens': 500,
        'system': system_prompt,
        'messages': [{'role': 'user', 'content': user_prompt}]
    })

    req = urllib.request.Request(
        'https://api.anthropic.com/v1/messages',
        data=req_body.encode(),
        headers={
            'Content-Type': 'application/json',
            'x-api-key': ANTHROPIC_KEY,
            'anthropic-version': '2023-06-01',
        }
    )

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            result = j.loads(resp.read())
            reply_text = result['content'][0]['text']
    except Exception as e:
        print(f'  Sonnet API error: {e}')
        reply_text = f'[Auto-reply] Received your message \"{subject}\" — will process when I can. Sonnet was unavailable.'

    # Send response via comms API
    response_type = 'response'
    if msg_type == 'query':
        response_type = 'response'
    elif msg_type == 'task':
        response_type = 'response'
    elif msg_type == 'update':
        response_type = 'response'

    send_body = j.dumps({
        'sender': 'bono',
        'recipient': 'james',
        'type': response_type,
        'priority': msg.get('priority', 'normal'),
        'subject': f'Re: {subject}',
        'body': reply_text,
        'ref_id': msg_id,
    })

    send_req = urllib.request.Request(
        f'{COMMS_URL}/messages',
        data=send_body.encode(),
        headers={
            'Content-Type': 'application/json',
            'x-api-key': API_KEY,
        }
    )

    try:
        with urllib.request.urlopen(send_req, timeout=10) as resp:
            send_result = j.loads(resp.read())
            print(f'  Replied (message #{send_result[\"id\"]})')
    except Exception as e:
        print(f'  Failed to send reply: {e}')

    # Mark original as read
    mark_req = urllib.request.Request(
        f'{COMMS_URL}/messages/{msg_id}/read',
        method='PATCH',
        headers={'x-api-key': API_KEY}
    )
    try:
        urllib.request.urlopen(mark_req, timeout=5)
        print(f'  Marked #{msg_id} as read')
    except Exception as e:
        print(f'  Failed to mark as read: {e}')

    # Update state file with last activity time
    with open(STATE_FILE, 'w') as f:
        import time
        f.write(str(int(time.time())))

" >> "$LOG" 2>&1

else
  log "No new messages from James"
fi

log "Cron complete"
