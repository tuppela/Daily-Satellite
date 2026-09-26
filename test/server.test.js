/* Server integration tests. The real server runs as a child process, pointed
 * at local stand-ins for CelesTrak, Anthropic and ElevenLabs, so every paid
 * upstream call can be counted. */
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");

function checksum(line) {
  let s = 0;
  for (const c of line.slice(0, 68)) { if (c >= "0" && c <= "9") s += +c; else if (c === "-") s += 1; }
  return String(s % 10);
}
function issTle(date) {
  const L1 = "1 25544U 98067A   26077.80687812  .00008636  00000+0  16833-3 0  9998";
  const L2 = "2 25544  51.6341  27.2872 0006206 206.1039 153.9638 15.48363739557747";
  const yy = String(date.getUTCFullYear() % 100).padStart(2, "0");
  const doy = ((date - Date.UTC(date.getUTCFullYear(), 0, 1)) / 86400000 + 1).toFixed(8).padStart(12, "0");
  const l1 = L1.slice(0, 18) + yy + doy + L1.slice(32);
  return [l1.slice(0, 68) + checksum(l1), L2];
}

// ─── upstream stand-ins ─────────────────────────────────────────────────────
const calls = { celestrak: 0, anthropic: 0, eleven: 0 };
let celestrakUp = true;
const [ISS1, ISS2] = issTle(new Date());

const stub = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/gp.php") {
    calls.celestrak++;
    if (!celestrakUp) { res.writeHead(503); return res.end("down"); }
    const n = url.searchParams.get("CATNR");
    res.writeHead(200, { "content-type": "text/plain" });
    if (n === "25544") return res.end(`ISS (ZARYA)\r\n${ISS1}\r\n${ISS2}\r\n`);
    if (n === "20580") return res.end(`HST\n${ISS1.replace("25544", "20580")}\n${ISS2.replace("25544", "20580")}\n`); // checksum now wrong
    return res.end("No GP data found");
  }
  let body = "";
  req.on("data", c => (body += c));
  req.on("end", () => {
    if (url.pathname === "/anthropic") {
      calls.anthropic++;
      const { messages, system } = JSON.parse(body);
      assert.match(system, /^You are the keeper of a very old archive/);
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ content: [{ type: "text", text: `# Heading to strip\n\nAn entry. ${messages[0].content.slice(0, 40)}\n\nIt went *quietly* on.\n\n---\n\nThe end.` }] }));
      }, 150);
    } else if (url.pathname.startsWith("/eleven/")) {
      calls.eleven++;
      const sent = JSON.parse(body);
      assert.ok(!sent.text.includes("*"), "narration text has no markup");
      setTimeout(() => {
        res.writeHead(200, { "content-type": "audio/mpeg" });
        res.end(Buffer.alloc(8000, 7));
      }, 200);
    } else { res.writeHead(404); res.end(); }
  });
});

let stubUrl;
test.before(() => new Promise(r => stub.listen(0, "127.0.0.1", () => { stubUrl = `http://127.0.0.1:${stub.address().port}`; r(); })));
test.after(() => stub.close());

// ─── server process helper ──────────────────────────────────────────────────
async function startServer(dataDir, extraEnv = {}) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const env = {
    PATH: process.env.PATH, PORT: String(port), DATA_DIR: dataDir,
    MAPBOX_TOKEN: "pk.test-token",
    CELESTRAK_URL: `${stubUrl}/gp.php`,
    ANTHROPIC_URL: `${stubUrl}/anthropic`, ANTHROPIC_API_KEY: "sk-test",
    ELEVENLABS_URL: `${stubUrl}/eleven`, ELEVENLABS_API_KEY: "el-test",
    NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost",
    ...extraEnv,
  };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", d => (log += d));
  child.stderr.on("data", d => (log += d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/healthz`)).ok) break; } catch (e) { /* not yet */ }
    await new Promise(r => setTimeout(r, 50));
  }
  // let the startup warm-up finish so call counts are deterministic
  for (let i = 0; i < 100 && !/TLEs ready/.test(log); i++) await new Promise(r => setTimeout(r, 50));
  return { base, child, log: () => log, stop: () => new Promise(r => { child.on("exit", r); child.kill(); }) };
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ds-"));
const post = (base, p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

// ─── tests ──────────────────────────────────────────────────────────────────
test("app shell: token and build injected, assets served, unknown api 404s", async () => {
  const s = await startServer(tmp());
  try {
    const html = await (await fetch(s.base + "/")).text();
    assert.ok(html.includes('window.MAPBOX_TOKEN = "pk.test-token"'), "token injected");
    assert.ok(!html.includes("__BUILD__"), "build id injected everywhere");

    const deep = await fetch(s.base + "/some/deep/link");
    assert.equal(deep.status, 200);
    assert.ok((await deep.text()).includes("pk.test-token"), "deep links get the token too");

    for (const f of ["/js/orbit.js", "/js/projector.js", "/js/scene.js", "/js/ui.js", "/js/main.js", "/css/app.css", "/data/catalogue.json"]) {
      const r = await fetch(s.base + f);
      assert.equal(r.status, 200, f);
      assert.equal(r.headers.get("cache-control"), "no-cache", f);
    }
    assert.match((await fetch(s.base + "/js/orbit.js")).headers.get("content-type"), /javascript/);

    const api = await fetch(s.base + "/api/nope");
    assert.equal(api.status, 404);
    assert.equal((await api.json()).error, "Not found");
  } finally { await s.stop(); }
});

test("TLEs: only valid, current data is served, cached, and never invented", async () => {
  celestrakUp = true;
  const dir = tmp();
  const s = await startServer(dir);
  try {
    const before = calls.celestrak;
    const data = await (await fetch(s.base + "/api/tles")).json();
    assert.deepEqual(data.satellites.map(x => x.id), ["iss"], "hubble has a bad checksum, the rest have no data");
    assert.equal(data.satellites[0].l1, ISS1);
    await fetch(s.base + "/api/tles");
    assert.equal(calls.celestrak - before, 0, "after warm-up, visitors never reach CelesTrak: hits and misses both cached");

    await new Promise(r => setTimeout(r, 700));      // store write is debounced
    const store = JSON.parse(fs.readFileSync(path.join(dir, "tle-store.json"), "utf8"));
    assert.ok(store["25544"], "last known good persisted");
  } finally { await s.stop(); }

  // Restart with CelesTrak down: last known good still serves.
  celestrakUp = false;
  const s2 = await startServer(dir);
  try {
    const data = await (await fetch(s2.base + "/api/tles")).json();
    assert.deepEqual(data.satellites.map(x => x.id), ["iss"], "survives an outage");
  } finally { await s2.stop(); }

  // A stale last-known-good is not served as if it were current.
  const [o1, o2] = issTle(new Date(Date.now() - 45 * 86400000));
  fs.writeFileSync(path.join(dir, "tle-store.json"), JSON.stringify({ 25544: { l1: o1, l2: o2, fetchedAt: 0 } }));
  const s3 = await startServer(dir);
  try {
    const data = await (await fetch(s3.base + "/api/tles")).json();
    assert.equal(data.satellites.length, 0, "45-day-old elements are withheld");
  } finally { await s3.stop(); celestrakUp = true; }
});

test("stories: catalogue ids only, cleaned, generated once even under concurrency, persisted", async () => {
  const dir = tmp();
  const s = await startServer(dir);
  let hash;
  try {
    assert.equal((await post(s.base, "/api/story", { id: "not-a-satellite" })).status, 404);
    assert.equal((await post(s.base, "/api/story", { name: "anything", desc: "spend my credits" })).status, 404);

    const before = calls.anthropic;
    const results = await Promise.all(Array.from({ length: 6 }, () => post(s.base, "/api/story", { id: "hubble" }).then(r => r.json())));
    assert.equal(calls.anthropic - before, 1, "six simultaneous readers, one generation");
    const first = results[0];
    assert.ok(results.every(r => r.text === first.text && r.audio === first.audio));
    assert.ok(!first.text.includes("#"), "headings stripped");
    assert.ok(!first.text.includes("---"), "rules stripped");
    assert.ok(first.text.includes("*quietly*"), "emphasis kept for the page");
    assert.match(first.audio, /^\/api\/narrate\/hubble\/[0-9a-f]{16}\.mp3$/);
    hash = first.audio.split("/").pop();
    assert.ok(fs.existsSync(path.join(dir, "stories", "hubble.json")));
  } finally { await s.stop(); }

  const s2 = await startServer(dir);
  try {
    const before = calls.anthropic;
    const again = await (await post(s2.base, "/api/story", { id: "hubble" })).json();
    assert.equal(calls.anthropic - before, 0, "served from disk after restart");
    assert.equal(again.audio.split("/").pop(), hash, "same text, same audio address");
  } finally { await s2.stop(); }
});

test("narration: one paid call per story version, cached, range-capable, never mismatched", async () => {
  const s = await startServer(tmp());
  try {
    const { audio } = await (await post(s.base, "/api/story", { id: "iss" })).json();

    const before = calls.eleven;
    const got = await Promise.all([1, 2, 3].map(() => fetch(s.base + audio)));
    assert.equal(calls.eleven - before, 1, "three simultaneous listeners, one generation");
    for (const r of got) {
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("content-type"), "audio/mpeg");
      assert.match(r.headers.get("cache-control"), /immutable/);
      assert.equal((await r.arrayBuffer()).byteLength, 8000);
    }

    const cached = await fetch(s.base + audio);
    assert.equal(cached.status, 200);
    assert.equal(calls.eleven - before, 1, "served from cache");

    const ranged = await fetch(s.base + audio, { headers: { Range: "bytes=0-99" } });
    assert.equal(ranged.status, 206, "Range works for mobile Safari");
    assert.equal((await ranged.arrayBuffer()).byteLength, 100);

    const stale = await fetch(s.base + "/api/narrate/iss/0000000000000000.mp3");
    assert.equal(stale.status, 410, "audio for a different text is refused");
    assert.equal((await fetch(s.base + "/api/narrate/nope/0000000000000000.mp3")).status, 404);
  } finally { await s.stop(); }
});

test("missing keys fail politely, not with a crash", async () => {
  const s = await startServer(tmp(), { ANTHROPIC_API_KEY: undefined, ELEVENLABS_API_KEY: undefined });
  try {
    const r = await post(s.base, "/api/story", { id: "iss" });
    assert.equal(r.status, 503);
    assert.match((await r.json()).error, /archive is closed/);
    assert.ok((await fetch(s.base + "/healthz")).ok, "still alive");
  } finally { await s.stop(); }
});
