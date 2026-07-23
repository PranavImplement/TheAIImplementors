# Signal — Enterprise Knowledge & Support AI (Hackathon Prototype)

A working prototype of an AI-powered support assistant: ask a plain-language
question, it searches historical tickets, and drafts a grounded first
response (root cause, next steps, similar past incidents, escalate-or-not).

## Three modes (toggle checkboxes, top-right of `index.html`)

1. **Mock tickets** (default) — 16 built-in fake tickets, calls a real model
   directly from the browser using a personal API key you paste in. Good
   for showing the concept with zero setup.
2. **Offline demo mode** — no key, no internet, no backend. Assembles an
   answer straight from the mock tickets' own fields. Use this if venue
   wifi/VPN is unreliable during your actual demo slot.
3. **Live Jira mode** — the real thing. Talks to a local backend
   (`/server`) that searches your actual Jira Cloud projects and drafts
   answers via your hackathon's AI-Thon shared model gateway. See
   `server/JIRA_SETUP.md` for setup.

## Quick start

For mock/offline modes: just open `index.html` in a browser. Nothing to
install.

For Live Jira mode: see `server/JIRA_SETUP.md` for the full walkthrough
(Jira API token, AI-Thon key, `.env` setup, running the backend).

## What's in the backend (`server/server.js`)

- Searches across **multiple Jira projects at once** (`JIRA_PROJECT_KEYS` in
  `.env`, comma-separated — e.g. `SD,DEV,PLAT,CLAW,CLI,REPORT`)
- Calls your hackathon's **AI-Thon shared model gateway**
  (`AITHON_API_KEY`/`AITHON_MODEL` in `.env`) instead of a personal Anthropic
  key — this is a shared-budget key for your whole team, not a personal one
- Flattens Jira's rich-text (ADF) format into plain text for the model
- **Times out network calls after 15s** instead of hanging forever if a
  corporate VPN/proxy stalls
- Exposes diagnostics: `/api/health`, `/api/debug/project` (checks
  visibility into each configured project), `/api/debug/budget` (remaining
  team credit)
- A minimal in-memory **feedback endpoint** (`/api/feedback`) — thumbs
  up/down on answers, shown live in the UI

## Demo script (suggested, ~90 seconds)

1. "Support engineers spend hours re-investigating issues that already have
   a documented fix." → ask a real question in Live Jira mode.
2. Point at the matched-issues panel: "These are real tickets from our
   Service Desk, Dev, and Platform projects — not made up."
3. Read the answer: root cause, next steps, ticket IDs, escalation call.
4. Ask something deliberately vague, and show the AI correctly says "too
   generic to pinpoint a cause" instead of guessing — that's a feature, not
   a failure.
5. Click 👍/👎 on an answer — "this feeds a feedback loop, same idea as the
   roadmap in our original proposal."
6. If wifi/VPN is shaky, flip to Offline mode and say so plainly — it's a
   legitimate fallback, not a trick.

## Known limitations (say these out loud before a judge asks)

- Keyword-based Jira search (`text ~`), not semantic/vector search — good
  enough for a demo, not for tens of thousands of tickets with varied
  phrasing.
- Your AI-Thon key is shared across your whole team's budget — every call
  this app makes eats into the same pool everyone else on your team is
  using. The in-UI budget indicator (Live Jira mode) shows what's left.
- No RBAC/multi-tenant isolation — whatever your Jira account can see, this
  tool can see. Fine for a same-company internal demo; not fine for
  production with real client boundaries.
- Feedback is in-memory only — resets when the backend restarts.

## Turning this into the real platform (roadmap)

1. Real vector-based retrieval instead of keyword search (embeddings + a
   vector DB), for better recall on paraphrased questions.
2. Persistent feedback storage, used to tune retrieval ranking over time.
3. RBAC + per-tenant isolation enforced server-side, not just via which
   projects happen to be configured.
4. Wire the "should this be escalated?" output into actually creating a
   Jira ticket or a Slack/Teams alert.
5. PII masking before ticket content goes to any model.
