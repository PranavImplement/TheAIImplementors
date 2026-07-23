# Connecting Signal to real Jira + your AI-Thon key

Your Jira token and your AI-Thon key both stay on this local backend —
never in the browser.

## 1. Get a Jira API token

1. Go to https://id.atlassian.com/manage-profile/security/api-tokens
2. Click **Create API token**, name it, copy it.
3. Note the email address you log into Jira with.

## 2. Get your Jira site URL and project keys

Site URL is whatever you see in the browser using Jira, e.g.
`https://yourcompany.atlassian.net`.

List every project key you want searched — the letters before the dash in
a ticket number (e.g. `SD-1042` → project key `SD`). You can list several,
comma-separated.

## 3. Get your AI-Thon key

This comes from your hackathon organisers, not from Anthropic directly —
it's a shared key with a fixed team budget, routed through your
hackathon's model gateway. Ask in your team's Slack/channel if you don't
have it yet.

## 4. Configure the backend

```bash
cd server
npm install
cp .env.example .env
```

Open `.env` and fill in:

```
JIRA_BASE_URL=https://yourcompany.atlassian.net
JIRA_EMAIL=you@yourcompany.com
JIRA_API_TOKEN=<your Jira token from step 1>
JIRA_PROJECT_KEYS=SD,DEV,PLAT,CLAW,CLI,REPORT

# Confluence — usually needs nothing extra. It defaults to
# JIRA_BASE_URL + "/wiki", using the same email/token as Jira.
# CONFLUENCE_SPACE_KEYS=ENG,SUPPORT   (optional, comma-separated)

AITHON_API_KEY=<your team's AI-Thon key from step 3>
AITHON_BASE_URL=https://labs.shl.com/llm-internal/
AITHON_MODEL=claude-sonnet-5-aithon

# Only if you hit "self-signed certificate in certificate chain" (common on
# corporate VPNs that intercept HTTPS traffic):
ALLOW_INSECURE_TLS=true
```

## 5. Run it

```bash
npm start
```

You should see:
```
Signal Jira backend listening on http://localhost:3001
```

## 6. Verify each piece before using the app

- **Backend up?** `http://localhost:3001/api/health` → `{"ok":true,...}`
- **Can it see each project?** `http://localhost:3001/api/debug/project` →
  reports visibility per project key, individually. Fix any that show
  `canSeeProject:false` before relying on them.
- **Can it reach Confluence?** `http://localhost:3001/api/debug/confluence`
  → shows a sample of visible space keys if it's working.
- **Is the AI-Thon key valid, and how much budget's left?**
  `http://localhost:3001/api/debug/budget`

## 7. Use it in the prototype

1. Open `index.html`.
2. Check **"Live Jira mode"**, top-right.
3. A budget line appears showing your team's remaining credit.
4. Ask a question — it searches across all configured projects, and drafts
   an answer via your AI-Thon key.

Turn the checkbox off anytime to fall back to the safe mock/offline demo.

## Troubleshooting (in the order these usually bite people)

- **"self-signed certificate in certificate chain"** — corporate VPN/SSL
  inspection. Set `ALLOW_INSECURE_TLS=true` in `.env` and restart.
- **"Unbounded JQL queries are not allowed"** — `JIRA_PROJECT_KEYS` is
  empty or wasn't picked up. Check spelling, and make sure you fully
  restarted the server after editing `.env` (env vars are only read at
  startup).
- **"Jira rejected JQL ... (400)"** — a typo'd project key, or trailing
  characters (e.g. `SD-` instead of `SD`).
- **Empty `issues: []}` with no error** — usually a permissions issue: your
  Jira account can't see that project. Check with `/api/debug/project`.
- **"AI-Thon model call failed (401)"** — `AITHON_API_KEY` is missing,
  wrong, or was mistyped (double-check no leading/trailing spaces or
  quotes in `.env`).
- **Request timed out after Ns** — network/VPN stalled mid-request. The
  backend now fails fast (15s) instead of hanging; just retry.
- **Front-end says "Couldn't reach the Jira backend"** — the server isn't
  running, or you renamed/moved it away from `http://localhost:3001`
  (check `BACKEND_URL` near the top of `index.html`'s script).

## Before this touches anything beyond a demo

- Don't commit `.env` — it has real credentials.
- Your Jira token has whatever access your account has — `JIRA_PROJECT_KEYS`
  is a demo convenience, not real access control.
- Your AI-Thon key's budget is shared with your whole team — check
  `/api/debug/budget` before/after heavy testing.
