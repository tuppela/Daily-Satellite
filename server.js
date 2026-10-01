/* Daily Satellite server
 *
 * - Serves the app with the Mapbox token and a build id injected.
 * - /api/tles: orbital elements for the whole catalogue in one request.
 *   Checksum-validated, cached, and persisted as last-known-good. There are
 *   no invented fallbacks: a satellite without real data is simply absent.
 * - /api/story and /api/narrate/:id/:hash.mp3 only accept catalogue ids, so
 *   nobody can spend the API credits on arbitrary text.
 * - Stories are generated once and kept. Audio is keyed by a hash of the exact
 *   story text, so narration can never drift out of step with what is shown.
 * - Concurrent requests for the same story or audio share one upstream call.
 */
const express = require("express");
const path = require("path");
const fs = require("fs");
const fsp = fs.promises;
const crypto = require("crypto");
const http = require("http");
const https = require("https");

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, "public");
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, ".data");
const STORY_DIR = path.join(DATA_DIR, "stories");
const AUDIO_DIR = path.join(DATA_DIR, "audio");
const TLE_STORE = path.join(DATA_DIR, "tle-store.json");

const CELESTRAK_URL = process.env.CELESTRAK_URL || "https://celestrak.org/NORAD/elements/gp.php";
const SATNOGS_URL = process.env.SATNOGS_URL || "https://db.satnogs.org/api/tle/";
const TLEAPI_URL = process.env.TLEAPI_URL || "https://tle.ivanstanojevic.me/api/tle";
const SOURCE_TIMEOUT_MS = +process.env.SOURCE_TIMEOUT_MS || 8000;
const ANTHROPIC_URL =process.env.ANTHROPIC_URL || "https://api.anthropic.com/v1/messages";
const ELEVENLABS_URL = process.env.ELEVENLABS_URL || "https://api.elevenlabs.io/v1/text-to-speech";
const STORY_MODEL = process.env.STORY_MODEL || "claude-opus-4-5";
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "jiCqTo2ITOfNYppNYZtK";

const BUILD = (process.env.RENDER_GIT_COMMIT || String(Date.now())).slice(0, 12);
const TLE_TTL_MS = 2 * 3600 * 1000;            // CelesTrak asks for no more than this
const TLE_RETRY_MS = 10 * 60 * 1000;           // after a failed refresh of a known satellite
const MISS_NO_DATA_MS = 6 * 3600 * 1000;       // decayed or unknown: it will not come back soon
const MISS_ERROR_MS = 10 * 60 * 1000;          // network or server trouble: try again shortly
const TLE_MAX_AGE_DAYS = 30;                   // older elements are fiction

for (const d of [DATA_DIR, STORY_DIR, AUDIO_DIR]) fs.mkdirSync(d, { recursive: true });

const CATALOGUE = JSON.parse(fs.readFileSync(path.join(PUBLIC, "data", "catalogue.json"), "utf8"));
const BY_ID = new Map(CATALOGUE.map(s => [s.id, s]));

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "4kb" }));

// ─── shared helpers ───────────────────────────────────────────────────────
const inflight = new Map();
function once(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = Promise.resolve().then(fn).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, file);
}

// Outbound HTTP through Node's http/https modules rather than global fetch.
// On Render, fetch (undici) tried IPv6 first and every connection sat until
// its 10 s connect timeout. net.connect's autoSelectFamily races IPv4 and
// IPv6 instead, which is what the old server relied on without knowing it.
// Returns a small fetch-like object so call sites stay readable.
function fetchWithTimeout(url, opts = {}, ms = 15000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "http:" ? http : https;
    const body = opts.body == null ? null : Buffer.from(opts.body);
    const headers = { ...(opts.headers || {}) };
    if (body) headers["Content-Length"] = body.length;

    const req = lib.request(u, {
      method: opts.method || "GET",
      headers,
      autoSelectFamily: true,
      autoSelectFamilyAttemptTimeout: 500,
    }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("error", reject);
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          ok: res.statusCode >= 200 && res.statusCode < 300,
          text: async () => buf.toString("utf8"),
          json: async () => JSON.parse(buf.toString("utf8")),
          arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length),
        });
      });
    });
    req.setTimeout(ms, () => req.destroy(Object.assign(new Error(`timed out after ${ms} ms`), { code: "ETIMEDOUT" })));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// "fetch failed" told us nothing; the code and host do.
const describe = e => [e.message, e.code, e.cause && e.cause.code].filter(Boolean).join(" / ");

const httpError = (status, message, extra = {}) => Object.assign(new Error(message), { status }, extra);

// ─── TLEs ─────────────────────────────────────────────────────────────────
function checksumOk(line) {
  if (typeof line !== "string" || line.length < 69) return false;
  let sum = 0;
  for (let i = 0; i < 68; i++) {
    const c = line[i];
    if (c >= "0" && c <= "9") sum += c.charCodeAt(0) - 48;
    else if (c === "-") sum += 1;
  }
  return sum % 10 === line.charCodeAt(68) - 48;
}

function epochOf(l1) {
  const yy = +l1.slice(18, 20), doy = +l1.slice(20, 32);
  const year = yy < 57 ? 2000 + yy : 1900 + yy;
  return new Date(Date.UTC(year, 0, 1) + (doy - 1) * 86400000);
}

function parseTle(body, norad) {
  const lines = String(body).split(/\r?\n/).map(l => l.trimEnd()).filter(Boolean);
  const l1 = lines.find(l => l.startsWith("1 ") && l.length >= 69);
  const l2 = lines.find(l => l.startsWith("2 ") && l.length >= 69);
  if (!l1 || !l2 || !checksumOk(l1) || !checksumOk(l2)) return null;
  if (+l1.slice(2, 7) !== norad || +l2.slice(2, 7) !== norad) return null;
  return { l1: l1.slice(0, 69), l2: l2.slice(0, 69) };
}

const tles = new Map();                        // norad -> { l1, l2, fetchedAt, nextRefresh }
const misses = new Map();                      // norad -> do not ask CelesTrak again before this time

function loadTleStore() {
  try {
    const saved = JSON.parse(fs.readFileSync(TLE_STORE, "utf8"));
    for (const [norad, t] of Object.entries(saved)) {
      if (checksumOk(t.l1) && checksumOk(t.l2)) tles.set(+norad, { ...t, nextRefresh: 0 });
    }
  } catch (e) { /* first run */ }
}

let storeTimer = null;
function saveTleStoreSoon() {
  clearTimeout(storeTimer);
  storeTimer = setTimeout(() => {
    const out = {};
    for (const [norad, t] of tles) out[norad] = { l1: t.l1, l2: t.l2, source: t.source, fetchedAt: t.fetchedAt };
    writeAtomic(TLE_STORE, JSON.stringify(out)).catch(e => console.warn("TLE store write failed:", e.message));
  }, 500);
}

function fresh(t) {
  return !!t && (Date.now() - epochOf(t.l1).getTime()) / 86400000 <= TLE_MAX_AGE_DAYS;
}

/* Sources, tried in order. CelesTrak is the origin; the other two republish
 * the same public element sets. From Render, CelesTrak does not answer at all
 * (connections time out on IPv4 and IPv6 alike), so the mirrors are not a
 * nicety. Whatever a source returns must still pass the checksum, catalogue
 * number and freshness checks, so a mirror cannot slip in bad data. */
const UA = { "User-Agent": "DailySatellite/2.0 (+https://daily-satellite.onrender.com)" };
const SOURCES = [
  {
    name: "CelesTrak",
    url: n => `${CELESTRAK_URL}?CATNR=${n}&FORMAT=TLE`,
    lines: body => (/no gp data/i.test(body) ? "" : body),
  },
  {
    name: "SatNOGS",
    url: n => `${SATNOGS_URL}?norad_cat_id=${n}&format=json`,
    lines: body => { const a = JSON.parse(body); return a.length ? `${a[0].tle1}\n${a[0].tle2}` : ""; },
  },
  {
    name: "TLE API",
    url: n => `${TLEAPI_URL}/${n}`,
    lines: body => { const j = JSON.parse(body); return j.line1 ? `${j.line1}\n${j.line2}` : ""; },
    notFound: 404,
  },
];
const SOURCE_DOWN_MS = 30 * 60 * 1000;
const sourceDownUntil = new Map();             // name -> time; a source that timed out is skipped a while

async function fromSource(src, norad) {
  let res;
  try {
    res = await fetchWithTimeout(src.url(norad), { headers: UA }, SOURCE_TIMEOUT_MS);
  } catch (e) {
    sourceDownUntil.set(src.name, Date.now() + SOURCE_DOWN_MS);
    console.warn(`${src.name} unreachable (${describe(e)}); skipping it for ${SOURCE_DOWN_MS / 60000} min`);
    throw e;
  }
  if (res.status === src.notFound) return { noData: true };
  if (!res.ok) throw new Error(`${src.name} ${res.status}`);
  const text = src.lines(await res.text());
  if (!text) return { noData: true };
  const parsed = parseTle(text, norad);
  if (!parsed) throw new Error(`${src.name} sent an invalid TLE`);
  return { parsed };
}

async function refreshTle(norad) {
  return once(`tle:${norad}`, async () => {
    let best = null, noData = 0, tried = 0;
    const problems = [];
    for (const src of SOURCES) {
      if (Date.now() < (sourceDownUntil.get(src.name) || 0)) continue;
      tried++;
      try {
        const r = await fromSource(src, norad);
        if (r.noData) { noData++; continue; }
        const cand = { ...r.parsed, source: src.name };
        if (!best || epochOf(cand.l1) > epochOf(best.l1)) best = cand;
        if (fresh(cand)) break;                      // good enough; do not bother the rest
      } catch (e) {
        problems.push(`${src.name}: ${describe(e)}`);
      }
    }
    if (!best) {
      const allNoData = tried > 0 && noData === tried;
      throw httpError(502, allNoData ? "no current data from any source (decayed?)" : problems.join("; ") || "no source reachable", { noData: allNoData });
    }
    const t = { l1: best.l1, l2: best.l2, source: best.source, fetchedAt: Date.now(), nextRefresh: Date.now() + TLE_TTL_MS };
    tles.set(norad, t);
    saveTleStoreSoon();
    return t;
  });
}

async function getTle(norad) {
  const t = tles.get(norad);
  if (t && Date.now() < t.nextRefresh) return fresh(t) ? t : null;
  if (!t && Date.now() < (misses.get(norad) || 0)) return null;   // asked recently, nothing there
  try {
    const got = await refreshTle(norad);
    misses.delete(norad);
    return got;
  } catch (e) {
    if (t) t.nextRefresh = Date.now() + TLE_RETRY_MS;
    else misses.set(norad, Date.now() + (e.noData ? MISS_NO_DATA_MS : MISS_ERROR_MS));
    console.warn(`TLE ${norad}: ${describe(e)}${t ? " (keeping last known good)" : ""}`);
    return fresh(t) ? t : null;
  }
}

async function allTles() {
  const out = [];
  const queue = CATALOGUE.slice();
  const worker = async () => {
    while (queue.length) {
      const sat = queue.shift();
      const t = await getTle(sat.norad);
      if (t) out.push({ id: sat.id, norad: sat.norad, l1: t.l1, l2: t.l2, source: t.source || "stored" });
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  const order = new Map(CATALOGUE.map((s, i) => [s.id, i]));
  return out.sort((a, b) => order.get(a.id) - order.get(b.id));
}

app.get("/api/tles", async (req, res) => {
  try {
    const satellites = await allTles();
    res.set("Cache-Control", "public, max-age=300");
    res.json({ generatedAt: new Date().toISOString(), satellites });
  } catch (e) {
    res.status(500).json({ error: e.message, satellites: [] });
  }
});

// ─── stories ──────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are the keeper of a very old archive of objects in Earth orbit. You have been alone with this material for a long time and have developed a deep, unsentimental familiarity with each object — when it was made, why, what it has witnessed, what became of it. You write as someone who is genuinely delighted when another person shows interest, but who expresses that delight quietly. You do not perform enthusiasm. You do not oversell. You trust the facts to be interesting, because they are. Your tone is warm but never sentimental. Precise but never cold. You allow dark things — failures, cover-ups, debris fields, forgotten machines — to simply be what they are, without dramatising or softening them. When something is absurd, you note it briefly and move on. You write in the tradition of Mika Waltari and long-form literary journalism — flowing prose, no lists, no headers. You are helping someone understand something for the first time and you take that quietly seriously. Write until the story is told, then stop. Some entries will be 300 words, some 600. Follow the shape of the story. Every entry should end by opening outward — from the specific satellite into something larger about time, human ambition, or the strangeness of what we have put into the sky.`;

/* Story versions.
 * v1: the original prompt above, with one line of description per satellite.
 * v2: archive/voice.md as the system prompt, plus an editorial brief and
 *     fact sheet per satellite from archive/briefs/<id>.md.
 * The live site uses v1 unless STORY_VERSION=v2, and even then only for
 * satellites that have a brief. /preview shows both side by side. */
const ARCHIVE_DIR = path.join(__dirname, "archive");
const STORY_VERSION = process.env.STORY_VERSION === "v2" ? "v2" : "v1";

function briefFor(id) {
  try { return fs.readFileSync(path.join(ARCHIVE_DIR, "briefs", `${id}.md`), "utf8"); }
  catch (e) { return null; }
}
const briefIds = () => CATALOGUE.map(s => s.id).filter(id => briefFor(id));
const liveVersion = id => (STORY_VERSION === "v2" && briefFor(id) ? "v2" : "v1");
const storyFile = (id, v) => path.join(STORY_DIR, v === "v1" ? `${id}.json` : `${id}.${v}.json`);

const stories = new Map();                     // "v:id" -> { text, hash, createdAt }

const hashOf = text => crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);

// Whatever the model returns, keep only prose paragraphs.
function cleanStory(raw) {
  return String(raw)
    .split(/\n+/)
    .map(l => l.trim())
    .filter(l => l && !l.startsWith("#") && !/^[-*_]{3,}$/.test(l))
    .join("\n\n");
}

function requestFor(id, v) {
  const sat = BY_ID.get(id);
  if (v === "v1") {
    return {
      system: SYSTEM_PROMPT,
      max_tokens: 1400,
      content: `Write an entry for the satellite: ${sat.name}. What we know about it: ${sat.desc}`,
    };
  }
  const brief = briefFor(id);
  if (!brief) throw httpError(404, "There is no brief for this satellite yet.");
  return {
    system: fs.readFileSync(path.join(ARCHIVE_DIR, "voice.md"), "utf8"),
    max_tokens: 2200,
    content: `Write the entry for ${sat.name}, following this brief and fact sheet.\n\n${brief}`,
  };
}

async function readStory(id, v = liveVersion(id)) {
  const key = `${v}:${id}`;
  if (stories.has(key)) return stories.get(key);
  try {
    const saved = JSON.parse(await fsp.readFile(storyFile(id, v), "utf8"));
    if (saved && saved.text) {
      const s = { text: saved.text, hash: hashOf(saved.text), createdAt: saved.createdAt, changes: saved.changes || [] };
      stories.set(key, s);
      return s;
    }
  } catch (e) { /* not written yet */ }
  return null;
}

async function getStory(id, v = liveVersion(id)) {
  const existing = await readStory(id, v);
  if (existing) return existing;

  return once(`story:${v}:${id}`, async () => {
    const again = await readStory(id, v);
    if (again) return again;

    const r = requestFor(id, v);
    const draft = cleanStory(await askClaude(r.system, r.content, r.max_tokens));
    if (!draft) throw httpError(502, "The archivist returned an empty page.");

    // v2 gets a second pair of eyes: every specific claim checked against the sheet.
    let text = draft, changes = [];
    if (v !== "v1") ({ text, changes } = await factCheck(id, draft));

    const createdAt = new Date().toISOString();
    await writeAtomic(storyFile(id, v), JSON.stringify({ id, version: v, text, draft, changes, model: STORY_MODEL, createdAt }, null, 2));
    // Kept in the log too, so a draft can be read without the page.
    for (const c of changes) console.log(`FACTCHECK ${v} ${id} | ${c}`);
    for (const para of text.split("\n\n")) console.log(`STORY ${v} ${id} | ${para}`);
    const s = { text, hash: hashOf(text), createdAt, changes };
    stories.set(`${v}:${id}`, s);
    return s;
  });
}

async function askClaude(system, content, maxTokens) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw httpError(503, "The archive is closed (no Anthropic key configured).");
  const res = await fetchWithTimeout(ANTHROPIC_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: STORY_MODEL, max_tokens: maxTokens, system, messages: [{ role: "user", content }] }),
  }, 150000);
  if (!res.ok) {
    console.error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
    throw httpError(502, "The archivist could not be reached.");
  }
  const data = await res.json();
  return (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
}

// Returns the checked entry and the list of changes. If the checker's reply
// cannot be parsed, the draft stands and the problem is logged; a missing
// check must never lose a story.
async function factCheck(id, draft) {
  const system = fs.readFileSync(path.join(ARCHIVE_DIR, "fact-check.md"), "utf8");
  const reply = await askClaude(system, `BRIEF AND FACT SHEET:\n\n${briefFor(id)}\n\nDRAFT ENTRY:\n\n${draft}`, 3000);
  const m = reply.match(/^CHANGES:\s*\n([\s\S]*?)\n\s*ENTRY:\s*\n([\s\S]+)$/m);
  if (!m) {
    console.warn(`Fact-check for ${id} came back in an unexpected format; keeping the draft.`);
    return { text: draft, changes: ["(fact-check reply unreadable; draft kept unchanged)"] };
  }
  const changes = m[1].split("\n").map(l => l.replace(/^\s*-\s*/, "").trim()).filter(l => l && l.toLowerCase() !== "none");
  // House style: no em dashes, whatever the writer or checker did.
  const noDashes = t => t.replace(/\s*\u2014\s*/g, ", ");
  const text = noDashes(cleanStory(m[2]));
  return text ? { text, changes } : { text: noDashes(draft), changes: ["(fact-check returned an empty entry; draft kept)"] };
}

async function forgetStory(id, v) {
  stories.delete(`${v}:${id}`);
  await fsp.rm(storyFile(id, v), { force: true });
}

app.post("/api/story", async (req, res) => {
  const id = req.body && req.body.id;
  if (!BY_ID.has(id)) return res.status(404).json({ error: "Unknown satellite." });
  try {
    const s = await getStory(id);
    res.json({ text: s.text, audio: `/api/narrate/${id}/${s.hash}.mp3` });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ─── preview: current and new stories side by side ─────────────────────────
// Private: only with ?key=PREVIEW_KEY, and absent entirely without one.
const PREVIEW_KEY = process.env.PREVIEW_KEY || "";
const previewErrors = new Map();               // "v:id" -> message from the last failed attempt

const esc = t => String(t).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const storyHtml = text => text.split("\n\n")
  .map(p => `<p>${esc(p).replace(/\*([^*\n]+)\*/g, "<em>$1</em>")}</p>`).join("\n");
const words = text => text.split(/\s+/).filter(Boolean).length;

function previewPage(title, body, refresh) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">${refresh ? `<meta http-equiv="refresh" content="${refresh}">` : ""}
<title>${esc(title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Libre+Baskerville:ital,wght@0,400;0,700;1,400&family=Source+Code+Pro:wght@400;700&display=swap" rel="stylesheet">
<style>
  :root { --bg: #eee9dd; --ink: #1a1610; --faint: rgba(26,22,16,0.45); --rule: rgba(26,22,16,0.14); }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font-family: 'Libre Baskerville', Georgia, serif; }
  header, main, footer { max-width: 1240px; margin: 0 auto; padding: 24px 16px; }
  .meta, a.btn, .label { font-family: 'Source Code Pro', monospace; font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; }
  .meta { color: var(--faint); }
  h1 { font-size: 34px; margin: 8px 0 0; }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 48px; }
  @media (max-width: 900px) { .cols { grid-template-columns: 1fr; } }
  .col h2 { font-family: 'Source Code Pro', monospace; font-size: 12px; letter-spacing: 0.14em; text-transform: uppercase; border-bottom: 1px solid var(--rule); padding-bottom: 10px; display: flex; justify-content: space-between; }
  .col p { font-size: 15px; line-height: 1.82; margin: 0 0 1.1em; }
  .waiting { font-style: italic; color: var(--faint); }
  .error { font-style: italic; color: #8a2a1a; }
  a { color: var(--ink); }
  a.btn { display: inline-block; border: 1px solid var(--ink); padding: 8px 12px; text-decoration: none; margin-right: 8px; }
  details { border-top: 1px solid var(--rule); padding-top: 16px; }
  pre { white-space: pre-wrap; font-family: 'Source Code Pro', monospace; font-size: 12px; line-height: 1.6; }
  ul { line-height: 2; }
  .checks ul { font-family: 'Source Code Pro', monospace; font-size: 12px; line-height: 1.6; padding-left: 18px; }
  .checks li { margin-bottom: 6px; }
</style></head><body>${body}</body></html>`;
}

function previewGuard(req, res) {
  if (!PREVIEW_KEY || req.query.key !== PREVIEW_KEY) { res.status(404).type("text").send("Not found"); return false; }
  res.set("Cache-Control", "no-store");
  return true;
}

app.get("/preview", (req, res) => {
  if (!previewGuard(req, res)) return;
  const k = encodeURIComponent(req.query.key);
  const items = briefIds().map(id => `<li><a href="/preview/${id}?key=${k}">${esc(BY_ID.get(id).name)}</a></li>`).join("");
  res.type("html").send(previewPage("Story preview", `<header><div class="meta">Daily Satellite · story preview · live version: ${STORY_VERSION}</div>
<h1>Satellites with a brief</h1></header><main><ul>${items}</ul></main>`));
});

app.get("/preview/:id", async (req, res) => {
  if (!previewGuard(req, res)) return;
  const id = req.params.id;
  if (!BY_ID.has(id)) return res.status(404).type("text").send("Unknown satellite");
  const k = encodeURIComponent(req.query.key);
  const self = `/preview/${id}?key=${k}`;

  if (req.query.fresh === "1") {
    await forgetStory(id, "v2");
    previewErrors.delete(`v2:${id}`);
    return res.redirect(303, self);            // so a reload does not regenerate again
  }

  let waiting = false;
  const column = async (v, label) => {
    const s = await readStory(id, v);
    if (s) {
      const checked = v === "v1" ? "" : `<details class="checks"><summary class="label">Fact-checker: ${s.changes.length ? s.changes.length + " change" + (s.changes.length > 1 ? "s" : "") : "no changes"}</summary><ul>${s.changes.map(c => `<li>${esc(c)}</li>`).join("")}</ul></details>`;
      return `<section class="col"><h2><span>${label}</span><span>${words(s.text)} words</span></h2>${storyHtml(s.text)}${checked}</section>`;
    }
    const errKey = `${v}:${id}`;
    if (previewErrors.has(errKey)) {
      return `<section class="col"><h2><span>${label}</span></h2><p class="error">${esc(previewErrors.get(errKey))}</p></section>`;
    }
    waiting = true;
    if (!inflight.has(`story:${v}:${id}`)) {
      getStory(id, v).catch(e => previewErrors.set(errKey, e.message));
    }
    return `<section class="col"><h2><span>${label}</span></h2><p class="waiting">The archivist is writing. This page refreshes itself.</p></section>`;
  };

  const left = await column("v1", "Current");
  const right = briefFor(id)
    ? await column("v2", "New, from the brief")
    : `<section class="col"><h2><span>New</span></h2><p class="waiting">No brief yet for this satellite.</p></section>`;
  const brief = briefFor(id);

  res.type("html").send(previewPage(`${BY_ID.get(id).name}: preview`, `<header>
<div class="meta"><a href="/preview?key=${k}">All previews</a> · live version: ${STORY_VERSION}</div>
<h1>${esc(BY_ID.get(id).name)}</h1></header>
<main><div class="cols">${left}${right}</div></main>
<footer>${brief ? `<p><a class="btn" href="${self}&fresh=1">Write the new version again</a></p>
<details><summary class="label">The brief and fact sheet</summary><pre>${esc(brief)}</pre></details>` : ""}</footer>`,
    waiting ? 6 : 0));
});

// ─── narration ────────────────────────────────────────────────────────────
// Read the prose, not the markup.
const spoken = text => text.replace(/\*([^*\n]+)\*/g, "$1");

async function getAudio(id, story) {
  const file = path.join(AUDIO_DIR, `${id}-${story.hash}.mp3`);
  try { await fsp.access(file); return file; } catch (e) { /* generate */ }

  return once(`audio:${id}:${story.hash}`, async () => {
    try { await fsp.access(file); return file; } catch (e) { /* still missing */ }

    const key = process.env.ELEVENLABS_API_KEY;
    if (!key) throw httpError(503, "Narration is not configured.");

    const res = await fetchWithTimeout(`${ELEVENLABS_URL}/${VOICE_ID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "xi-api-key": key, Accept: "audio/mpeg" },
      body: JSON.stringify({
        text: spoken(story.text),
        model_id: "eleven_turbo_v2_5",
        voice_settings: { stability: 0.55, similarity_boost: 0.75 },
      }),
    }, 120000);

    if (!res.ok) {
      console.error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 200)}`);
      throw httpError(502, `Narration unavailable (${res.status}).`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1000) throw httpError(502, "Narration came back empty.");
    await writeAtomic(file, buf);
    console.log(`Audio cached: ${path.basename(file)} (${Math.round(buf.length / 1024)} KB)`);
    return file;
  });
}

app.get("/api/narrate/:id/:hash.mp3", async (req, res) => {
  const { id, hash } = req.params;
  if (!BY_ID.has(id)) return res.status(404).end();
  try {
    const story = await readStory(id, liveVersion(id));
    if (!story) return res.status(404).json({ error: "No entry yet." });
    if (story.hash !== hash) return res.status(410).json({ error: "This entry has been rewritten." });
    const file = await getAudio(id, story);
    // Content-addressed, so it can be cached forever. sendFile handles Range
    // requests, which mobile Safari needs for audio.
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    res.type("audio/mpeg");
    res.sendFile(file);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ─── app shell ────────────────────────────────────────────────────────────
app.get("/healthz", (req, res) => res.json({ ok: true, build: BUILD, satellites: tles.size }));

const indexPath = path.join(PUBLIC, "index.html");
function serveIndex(req, res) {
  const token = JSON.stringify(process.env.MAPBOX_TOKEN || "");
  const html = fs.readFileSync(indexPath, "utf8")
    .replace('window.MAPBOX_TOKEN || ""', token)
    .replace(/__BUILD__/g, BUILD);
  res.set("Cache-Control", "no-cache");
  res.type("html").send(html);
}

app.get("/", serveIndex);
app.use(express.static(PUBLIC, {
  index: false,
  setHeaders: res => res.set("Cache-Control", "no-cache"),     // revalidate; cheap 304s
}));
app.use("/api", (req, res) => res.status(404).json({ error: "Not found" }));
app.get("*", serveIndex);

// ─── start ────────────────────────────────────────────────────────────────
loadTleStore();

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Daily Satellite ${BUILD} on port ${PORT}`);

    // Warm the element cache so the first visitor does not wait, and keep it fresh.
    const warm = () => allTles().then(s => {
      const by = {};
      for (const x of s) by[x.source] = (by[x.source] || 0) + 1;
      console.log(`TLEs ready: ${s.length}/${CATALOGUE.length} ${JSON.stringify(by)}`);
    });
    warm();
    setInterval(warm, TLE_TTL_MS).unref();

    // PREVIEW_WARM=1: write both versions of every briefed story at start-up,
    // one at a time, so the preview pages are ready before anyone opens them.
    if (PREVIEW_KEY && process.env.PREVIEW_WARM === "1") {
      (async () => {
        for (const id of briefIds()) {
          for (const v of ["v1", "v2"]) {
            try { await getStory(id, v); }
            catch (e) { previewErrors.set(`${v}:${id}`, e.message); console.warn(`Preview ${v} ${id}: ${e.message}`); }
          }
        }
        console.log("Preview warm-up done");
      })();
    }

    // Keep the free Render instance awake by visiting ourselves. This hits a
    // local health check, never CelesTrak.
    const self = process.env.RENDER_EXTERNAL_URL;
    if (self) {
      setInterval(() => {
        fetchWithTimeout(`${self}/healthz`).catch(e => console.warn("Self-ping failed:", describe(e)));
      }, 10 * 60 * 1000).unref();
    }
  });
}

module.exports = { app, checksumOk, parseTle, epochOf, cleanStory };
