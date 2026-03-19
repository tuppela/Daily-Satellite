const express = require("express");
const path = require("path");
const https = require("https");

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());

// ─── TLE PROXY ───────────────────────────────────────────────────────────────
const tleCache = {};
const CACHE_TTL = 60 * 60 * 1000;

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "OrbitalRegister/1.0" } }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("Timeout")); });
    req.on("error", reject);
  });
}

function httpsPost(hostname, path, data, headers) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const options = {
      hostname, path, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), ...headers }
    };
    const req = https.request(options, (res) => {
      let d = "";
      res.on("data", chunk => d += chunk);
      res.on("end", () => resolve({ status: res.statusCode, body: d }));
    });
    req.setTimeout(30000, () => { req.destroy(); reject(new Error("Timeout")); });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

app.get("/api/test", async (req, res) => {
  try {
    const url = "https://celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=TLE";
    const { status, body } = await httpsGet(url);
    res.json({ status, bodyPreview: body.slice(0, 300) });
  } catch(e) {
    res.json({ error: e.message });
  }
});

app.get("/api/tle/:norad", async (req, res) => {
  const norad = parseInt(req.params.norad);
  if (!norad || isNaN(norad)) return res.status(400).json({ error: "Invalid NORAD ID" });

  const cached = tleCache[norad];
  if (cached && Date.now() - cached.time < CACHE_TTL) return res.json(cached.data);

  try {
    const url = `https://celestrak.org/NORAD/elements/gp.php?CATNR=${norad}&FORMAT=TLE`;
    const { status, body } = await httpsGet(url);
    if (status !== 200) return res.status(502).json({ error: `CelesTrak ${status}` });

    const lines = body.trim().split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
    let name = null, l1 = null, l2 = null;
    for (const line of lines) {
      if (line.startsWith("1 ") && line.length > 50) l1 = line;
      else if (line.startsWith("2 ") && line.length > 50) l2 = line;
      else if (!name && !line.startsWith("1 ") && !line.startsWith("2 ")) name = line;
    }
    if (!l1 || !l2) return res.status(404).json({ error: `No TLE for ${norad}` });

    const result = { norad, name: name ? name.trim() : String(norad), l1, l2 };
    tleCache[norad] = { time: Date.now(), data: result };
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── STORY ENDPOINT ──────────────────────────────────────────────────────────
const storyCache = {};

app.post("/api/story", async (req, res) => {
  const { id, name, desc } = req.body;
  if (!name) return res.status(400).json({ error: "Missing satellite name" });

  const cacheKey = id || name;
  const cached = storyCache[cacheKey];
  if (cached && Date.now() - cached.time < 24 * 60 * 60 * 1000) {
    return res.json(cached.data);
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "API key not configured" });

  const systemPrompt = `You are the keeper of a very old archive of objects in Earth orbit. You have been alone with this material for a long time and have developed a deep, unsentimental familiarity with each object — when it was made, why, what it has witnessed, what became of it. You write as someone who is genuinely delighted when another person shows interest, but who expresses that delight quietly. You do not perform enthusiasm. You do not oversell. You trust the facts to be interesting, because they are. Your tone is warm but never sentimental. Precise but never cold. You allow dark things — failures, cover-ups, debris fields, forgotten machines — to simply be what they are, without dramatising or softening them. When something is absurd, you note it briefly and move on. You write in the tradition of Mika Waltari and long-form literary journalism — flowing prose, no lists, no headers. You are helping someone understand something for the first time and you take that quietly seriously. Write until the story is told, then stop. Some entries will be 300 words, some 600. Follow the shape of the story. Every entry should end by opening outward — from the specific satellite into something larger about time, human ambition, or the strangeness of what we have put into the sky.`;

  try {
    const { status, body } = await httpsPost(
      "api.anthropic.com",
      "/v1/messages",
      {
        model: "claude-opus-4-5",
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: "user", content: `Write an entry for the satellite: ${name}. What we know about it: ${desc || ""}` }]
      },
      {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      }
    );

    if (status !== 200) {
      console.error(`Anthropic API error ${status}: ${body.slice(0, 200)}`);
      return res.status(502).json({ error: `API error ${status}` });
    }

    const parsed = JSON.parse(body);
    const text = parsed.content?.[0]?.text || "";
    const result = { text };
    storyCache[cacheKey] = { time: Date.now(), data: result };
    res.json(result);
  } catch (err) {
    console.error("Story error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── STATIC ──────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Orbital Register running on port ${PORT}`);
});
