/**
 * Signal — Jira Cloud + AI-Thon gateway backend
 * -----------------------------------------------
 * Keeps your Jira API token and AI-Thon key server-side. The front-end
 * (index.html) talks to THIS server, never to Jira or the model gateway
 * directly, once you switch it to "Live Jira" mode.
 *
 * Run:
 *   cd server
 *   npm install
 *   cp .env.example .env   (then fill in .env)
 *   npm start
 *
 * Requires Node.js 18+ (uses the built-in fetch).
 */

require("dotenv").config();

/**
 * Corporate VPNs / security tools (Zscaler, Netskope, etc.) often intercept
 * HTTPS traffic and re-sign it with their own certificate. Your browser
 * already trusts that certificate (IT installed it system-wide); Node.js
 * does not, so outbound fetch() calls fail with
 * "self-signed certificate in certificate chain".
 *
 * Setting ALLOW_INSECURE_TLS=true in .env skips certificate verification
 * for this local dev server so it can get through. This is fine for a
 * local hackathon prototype on your own machine — do NOT ship this to any
 * real deployment. Leave this unset/false anywhere that isn't your laptop.
 */
if (process.env.ALLOW_INSECURE_TLS === "true") {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  console.warn("⚠️  ALLOW_INSECURE_TLS is on — TLS certificate checks are disabled. Local/demo use only.");
}

const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const {
  JIRA_BASE_URL,      // e.g. https://yourcompany.atlassian.net
  JIRA_EMAIL,         // the email you log into Jira with
  JIRA_API_TOKEN,     // from https://id.atlassian.com/manage-profile/security/api-tokens
  JIRA_PROJECT_KEYS,  // optional, comma-separated, e.g. "SD,DEV,PLAT,CLAW,CLI,REPORT"
  CONFLUENCE_BASE_URL, // optional — defaults to JIRA_BASE_URL + "/wiki" (same Atlassian site)
  CONFLUENCE_SPACE_KEYS, // optional, comma-separated — scopes search to specific spaces
  AITHON_API_KEY,     // from the AI-Thon organisers — your team's shared key
  AITHON_BASE_URL = "https://labs.shl.com/llm-internal/", // AI-Thon shared endpoint
  AITHON_MODEL = "claude-sonnet-5-aithon", // swap to gpt-5.4-mini-aithon if you're low on budget
  PORT = 3001
} = process.env;

/** Confluence Cloud lives at the same Atlassian site as Jira by default, under /wiki. */
function confluenceBase() {
  if (CONFLUENCE_BASE_URL) return CONFLUENCE_BASE_URL.replace(/\/$/, "");
  return JIRA_BASE_URL ? JIRA_BASE_URL.replace(/\/$/, "") + "/wiki" : "";
}

function getSpaceKeys() {
  if (!CONFLUENCE_SPACE_KEYS) return [];
  return CONFLUENCE_SPACE_KEYS.split(",").map(k => k.trim()).filter(Boolean);
}

/** Parses JIRA_PROJECT_KEYS ("SD, DEV,PLAT") into a clean array of keys. */
function getProjectKeys() {
  if (!JIRA_PROJECT_KEYS) return [];
  return JIRA_PROJECT_KEYS.split(",").map(k => k.trim()).filter(Boolean);
}

function requireEnv(res) {
  const missing = [];
  if (!JIRA_BASE_URL) missing.push("JIRA_BASE_URL");
  if (!JIRA_EMAIL) missing.push("JIRA_EMAIL");
  if (!JIRA_API_TOKEN) missing.push("JIRA_API_TOKEN");
  if (!AITHON_API_KEY) missing.push("AITHON_API_KEY");
  if (missing.length) {
    res.status(500).json({ error: `Missing required .env values: ${missing.join(", ")}` });
    return false;
  }
  return true;
}

/** Joins the AI-Thon base URL with a relative path, handling slashes safely. */
function aithonUrl(path) {
  return AITHON_BASE_URL.replace(/\/$/, "") + "/" + path.replace(/^\//, "");
}

/** Wraps fetch with a timeout so a stalled VPN/network doesn't hang forever mid-demo. */
async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`Request to ${new URL(url).host} timed out after ${timeoutMs / 1000}s. Check your VPN/network.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function jiraAuthHeader() {
  const token = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString("base64");
  return `Basic ${token}`;
}

/**
 * Jira Cloud stores rich text (description, comments) as Atlassian
 * Document Format (ADF) JSON, not plain text. This walks the tree
 * and pulls out just the text content.
 */
function adfToText(node) {
  if (!node) return "";
  if (typeof node === "string") return node;
  let text = "";
  if (node.text) text += node.text;
  if (Array.isArray(node.content)) {
    for (const child of node.content) {
      text += adfToText(child);
      if (child.type === "paragraph") text += "\n";
    }
  }
  return text;
}

/** Escape a user query for safe embedding inside a JQL string literal. */
function escapeJql(str) {
  return str.replace(/["\\]/g, "\\$&");
}

/** Escape a user query for safe embedding inside a CQL (Confluence) string literal. */
function escapeCql(str) {
  return str.replace(/["\\]/g, "\\$&");
}

/** Confluence page bodies come back as storage-format HTML. Strip tags for a quick plain-text version. */
function htmlToText(html) {
  if (!html) return "";
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

async function searchConfluence(query, maxResults = 5) {
  const base = confluenceBase();
  if (!base) return [];

  const cqlParts = [`text ~ "${escapeCql(query)}"`, `type = "page"`];
  const spaceKeys = getSpaceKeys();
  if (spaceKeys.length === 1) {
    cqlParts.push(`space = "${escapeCql(spaceKeys[0])}"`);
  } else if (spaceKeys.length > 1) {
    cqlParts.push(`space IN (${spaceKeys.map(k => `"${escapeCql(k)}"`).join(", ")})`);
  }
  const cql = cqlParts.join(" AND ") + " ORDER BY lastmodified DESC";

  const url = `${base}/rest/api/content/search?${new URLSearchParams({
    cql, limit: String(maxResults), expand: "body.storage,space"
  })}`;

  const resp = await fetchWithTimeout(url, {
    headers: { Authorization: jiraAuthHeader(), Accept: "application/json" }
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Confluence search failed (${resp.status}): ${body.slice(0, 400)}`);
  }
  const data = await resp.json();
  return (data.results || []).map(page => ({
    id: page.id,
    title: page.title,
    space: page.space?.key || "unknown",
    url: `${base}${page._links?.webui || ""}`,
    excerpt: htmlToText(page.body?.storage?.value).slice(0, 800)
  }));
}

async function searchJira(query, maxResults = 5) {
  const jqlParts = [];
  const projectKeys = getProjectKeys();
  if (projectKeys.length === 1) {
    jqlParts.push(`project = "${escapeJql(projectKeys[0])}"`);
  } else if (projectKeys.length > 1) {
    jqlParts.push(`project IN (${projectKeys.map(k => `"${escapeJql(k)}"`).join(", ")})`);
  }
  jqlParts.push(`text ~ "${escapeJql(query)}"`);
  const jql = jqlParts.join(" AND ") + " ORDER BY updated DESC";

  const url = `${JIRA_BASE_URL.replace(/\/$/, "")}/rest/api/3/search/jql`;
  const resp = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      Authorization: jiraAuthHeader(),
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify({
      jql,
      maxResults,
      fields: ["summary", "description", "status", "issuetype", "resolution", "labels", "components", "updated", "comment"]
    })
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Jira search failed (${resp.status}): ${body.slice(0, 400)}`);
  }
  const data = await resp.json();
  return (data.issues || []).map(issue => {
    const f = issue.fields || {};
    const comments = (f.comment?.comments || [])
      .slice(-3)
      .map(c => adfToText(c.body).trim())
      .filter(Boolean);
    return {
      id: issue.key,
      url: `${JIRA_BASE_URL.replace(/\/$/, "")}/browse/${issue.key}`,
      title: f.summary || "(no summary)",
      category: f.issuetype?.name || "Unknown",
      status: f.status?.name || "Unknown",
      description: adfToText(f.description).trim() || "(no description)",
      resolution: f.resolution?.name || "(unresolved / not set)",
      labels: f.labels || [],
      components: (f.components || []).map(c => c.name),
      recentComments: comments
    };
  });
}

function buildContext(issues, pages) {
  const issueText = issues.length ? issues.map(t => (
`[${t.id}] ${t.title}
URL: ${t.url}
Type: ${t.category} | Status: ${t.status} | Resolution field: ${t.resolution}
Labels: ${t.labels.join(", ") || "none"} | Components: ${t.components.join(", ") || "none"}
Description: ${t.description}
Recent comments: ${t.recentComments.join(" | ") || "none"}`
  )).join("\n\n---\n\n") : "";

  const pageText = pages.length ? pages.map(p => (
`[Confluence: ${p.title}] (space: ${p.space})
URL: ${p.url}
Excerpt: ${p.excerpt}`
  )).join("\n\n---\n\n") : "";

  const parts = [];
  if (issueText) parts.push("JIRA ISSUES:\n" + issueText);
  if (pageText) parts.push("CONFLUENCE DOCUMENTATION:\n" + pageText);
  return parts.join("\n\n===\n\n");
}

async function askClaude(query, issues, pages = []) {
  const context = (issues.length || pages.length)
    ? buildContext(issues, pages)
    : "No matching Jira issues or Confluence pages were found for this query.";

  const systemPrompt = `You are Signal, an internal enterprise support assistant with access to real Jira issues and Confluence documentation from this company's instance.
Only use the information given below — do not invent issue keys, page titles, causes, or resolutions that aren't in the provided context. Jira issues here may be missing a clean "root cause" field; infer it cautiously from the description/comments and say so if it's not explicit.
Structure your answer as plain text with inline labels (no markdown headers): "Likely root cause:", "Recommended next steps:", "Similar past issues:" (cite issue keys), "Relevant documentation:" (cite Confluence page titles, only if any were given), "Escalate?".
Keep it concise. If the context doesn't contain a good match, say so and recommend escalation rather than guessing.

${context}`;

  // AI-Thon's shared endpoint is OpenAI-compatible (it proxies to Claude/GPT
  // behind the scenes via LiteLLM), so this uses chat/completions + Bearer
  // auth + choices[].message.content — not Anthropic's native Messages API.
  const resp = await fetchWithTimeout(aithonUrl("chat/completions"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${AITHON_API_KEY}`
    },
    body: JSON.stringify({
      model: AITHON_MODEL,
      max_tokens: 700,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `New incident report: ${query}` }
      ]
    })
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`AI-Thon model call failed (${resp.status}): ${body.slice(0, 400)}`);
  }
  const data = await resp.json();
  return data.choices?.[0]?.message?.content?.trim() || "No response text returned.";
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, jiraConfigured: Boolean(JIRA_BASE_URL && JIRA_EMAIL && JIRA_API_TOKEN) });
});

// Diagnostic: confirms whether the configured token can see each configured project.
app.get("/api/debug/project", async (req, res) => {
  if (!requireEnv(res)) return;
  const projectKeys = getProjectKeys();
  if (!projectKeys.length) return res.json({ note: "JIRA_PROJECT_KEYS is not set in .env, so no projects to check." });
  try {
    const results = await Promise.all(projectKeys.map(async (key) => {
      const url = `${JIRA_BASE_URL.replace(/\/$/, "")}/rest/api/3/project/${encodeURIComponent(key)}`;
      const r = await fetchWithTimeout(url, { headers: { Authorization: jiraAuthHeader(), Accept: "application/json" } });
      const body = await r.text();
      let parsed;
      try { parsed = JSON.parse(body); } catch { parsed = body; }
      if (!r.ok) {
        return { key, canSeeProject: false, status: r.status, detail: parsed };
      }
      return { key, canSeeProject: true, projectName: parsed.name, projectId: parsed.id };
    }));
    res.json({ projects: results });
  } catch (err) {
    res.status(500).json({ error: err.message, cause: err.cause ? String(err.cause.message || err.cause) : null });
  }
});

// Diagnostic: confirms the token can reach Confluence at the configured base URL.
app.get("/api/debug/confluence", async (req, res) => {
  if (!requireEnv(res)) return;
  const base = confluenceBase();
  if (!base) return res.json({ note: "No Confluence base URL available (JIRA_BASE_URL not set either)." });
  try {
    const url = `${base}/rest/api/space?limit=5`;
    const r = await fetchWithTimeout(url, { headers: { Authorization: jiraAuthHeader(), Accept: "application/json" } });
    const body = await r.text();
    let parsed;
    try { parsed = JSON.parse(body); } catch { parsed = body; }
    if (!r.ok) {
      return res.status(r.status).json({ reachable: true, ok: false, baseUsed: base, status: r.status, detail: parsed });
    }
    res.json({
      reachable: true,
      ok: true,
      baseUsed: base,
      spaceKeysConfigured: getSpaceKeys(),
      sampleVisibleSpaces: (parsed.results || []).map(s => s.key)
    });
  } catch (err) {
    res.status(500).json({ error: err.message, cause: err.cause ? String(err.cause.message || err.cause) : null, baseUsed: base });
  }
});

// Lets the front-end show a browsable list of real recent issues, like the mock ticket panel.
app.get("/api/tickets/recent", async (req, res) => {
  if (!requireEnv(res)) return;
  try {
    const jqlParts = [];
    const projectKeys = getProjectKeys();
    if (projectKeys.length === 1) {
      jqlParts.push(`project = "${escapeJql(projectKeys[0])}"`);
    } else if (projectKeys.length > 1) {
      jqlParts.push(`project IN (${projectKeys.map(k => `"${escapeJql(k)}"`).join(", ")})`);
    }
    const jql = (jqlParts.length ? jqlParts.join(" AND ") + " " : "") + "ORDER BY updated DESC";
    const url = `${JIRA_BASE_URL.replace(/\/$/, "")}/rest/api/3/search/jql`;
    const r = await fetchWithTimeout(url, {
      method: "POST",
      headers: { Authorization: jiraAuthHeader(), "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ jql, maxResults: 20, fields: ["summary", "status", "issuetype", "updated", "project"] })
    });
    const d = await r.json();
    if (!r.ok) {
      throw new Error(`Jira rejected JQL "${jql}" (${r.status}): ${(d.errorMessages || []).join("; ") || JSON.stringify(d)}`);
    }
    const issues = (d.issues || []).map(i => ({
      id: i.key,
      url: `${JIRA_BASE_URL.replace(/\/$/, "")}/browse/${i.key}`,
      title: i.fields.summary,
      category: i.fields.issuetype?.name,
      status: i.fields.status?.name,
      project: i.fields.project?.key,
      description: "", resolution: "", labels: [], components: [], recentComments: []
    }));
    res.json({ issues, jqlUsed: jql, jiraProjectKeysUsed: projectKeys.length ? projectKeys : "(none set — searching all accessible projects)" });
  } catch (err) {
    console.error("Error in /api/tickets/recent:", err);
    if (err.cause) console.error("Underlying cause:", err.cause);
    res.status(500).json({
      error: err.message,
      cause: err.cause ? String(err.cause.message || err.cause) : null,
      jiraBaseUrlUsed: JIRA_BASE_URL
    });
  }
});

// Mirrors the "budget check" cell in the AI-Thon notebook — see how much of
// your team's credit is left before/after running the demo.
app.get("/api/debug/budget", async (req, res) => {
  if (!AITHON_API_KEY) return res.status(500).json({ error: "AITHON_API_KEY is not set in .env" });
  try {
    const r = await fetchWithTimeout(aithonUrl("key/info"), {
      headers: { Authorization: `Bearer ${AITHON_API_KEY}` }
    });
    const body = await r.text();
    let parsed;
    try { parsed = JSON.parse(body); } catch { parsed = body; }
    res.status(r.status).json(parsed);
  } catch (err) {
    res.status(500).json({ error: err.message, cause: err.cause ? String(err.cause.message || err.cause) : null });
  }
});

// Tracks every question asked (Live Jira mode only) so we can surface the
// most-asked questions in the UI. In-memory only — resets on restart.
const questionLog = [];
function logQuestion(query) {
  questionLog.push({ query, normalized: query.trim().toLowerCase(), at: new Date().toISOString() });
}
app.get("/api/stats/top-questions", (req, res) => {
  const counts = {};
  for (const q of questionLog) {
    if (!counts[q.normalized]) counts[q.normalized] = { display: q.query, count: 0, lastAsked: q.at };
    counts[q.normalized].count += 1;
    counts[q.normalized].lastAsked = q.at;
  }
  const top = Object.values(counts).sort((a, b) => b.count - a.count).slice(0, 8);
  res.json({ totalQuestions: questionLog.length, uniqueQuestions: Object.keys(counts).length, top });
});

app.post("/api/ask", async (req, res) => {
  if (!requireEnv(res)) return;
  const query = (req.body?.query || "").trim();
  if (!query) return res.status(400).json({ error: "Missing 'query' in request body." });

  try {
    const [matches, pages] = await Promise.all([
      searchJira(query, 8),
      searchConfluence(query, 5).catch(err => {
        console.warn("Confluence search failed (continuing with Jira only):", err.message);
        return [];
      })
    ]);
    logQuestion(query);
    const answer = await askClaude(query, matches, pages);
    res.json({ answer, matches, pages });
  } catch (err) {
    console.error("Error in /api/ask:", err);
    if (err.cause) console.error("Underlying cause:", err.cause);
    res.status(500).json({
      error: err.message,
      cause: err.cause ? String(err.cause.message || err.cause) : null,
      jiraBaseUrlUsed: JIRA_BASE_URL
    });
  }
});

// Lightweight feedback loop (in-memory only — resets when the server
// restarts). Enough to demo the concept from the roadmap without a database.
const feedbackLog = [];
app.post("/api/feedback", (req, res) => {
  const { query, helpful } = req.body || {};
  if (typeof helpful !== "boolean") return res.status(400).json({ error: "Missing boolean 'helpful' in request body." });
  feedbackLog.push({ query: query || "(unknown)", helpful, at: new Date().toISOString() });
  const up = feedbackLog.filter(f => f.helpful).length;
  const down = feedbackLog.filter(f => !f.helpful).length;
  res.json({ ok: true, totals: { up, down, total: feedbackLog.length } });
});
app.get("/api/feedback", (req, res) => {
  const up = feedbackLog.filter(f => f.helpful).length;
  const down = feedbackLog.filter(f => !f.helpful).length;
  res.json({ totals: { up, down, total: feedbackLog.length }, log: feedbackLog.slice(-20) });
});

// Rewrites an internal-facing answer into a customer-facing reply. Doesn't
// re-search anything — just reframes what was already found.
app.post("/api/draft-customer-reply", async (req, res) => {
  if (!AITHON_API_KEY) return res.status(500).json({ error: "AITHON_API_KEY is not set in .env" });
  const { query, answer } = req.body || {};
  if (!answer) return res.status(400).json({ error: "Missing 'answer' in request body." });

  const systemPrompt = `You rewrite an internal support engineer's notes into a short, polite, customer-facing reply.
Rules:
- No internal ticket IDs, internal team names, or internal jargon.
- No speculation the engineer wasn't confident about — if the internal notes say the cause isn't confirmed, say something like "we're actively investigating" rather than stating a guess as fact.
- Acknowledge the issue, give a plain-language summary of what's being done, and give a realistic next step or timeframe if one is implied. If none is implied, ask for the specific details needed (without sounding like an interrogation).
- Warm but professional tone, 3-6 sentences, no headers or bullet points.`;

  try {
    const resp = await fetchWithTimeout(aithonUrl("chat/completions"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${AITHON_API_KEY}` },
      body: JSON.stringify({
        model: AITHON_MODEL,
        max_tokens: 300,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Customer's original question: ${query || "(not given)"}\n\nInternal support notes to rewrite:\n${answer}` }
        ]
      })
    });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`AI-Thon model call failed (${resp.status}): ${body.slice(0, 400)}`);
    }
    const data = await resp.json();
    res.json({ reply: data.choices?.[0]?.message?.content?.trim() || "" });
  } catch (err) {
    res.status(500).json({ error: err.message, cause: err.cause ? String(err.cause.message || err.cause) : null });
  }
});

app.listen(PORT, () => {
  console.log(`Signal Jira backend listening on http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
});