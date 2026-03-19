const express = require("express");
const path = require("path");
const https = require("https");

const app = express();
const PORT = process.env.PORT || 3000;

// ─── TLE PROXY — must be before static middleware ─────────────────────────────
const tleCache = {};
const CACHE_TTL = 60 * 60 * 1000;

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "OrbitalRegister/1.0" } }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    }).on("error", reject);
  });
}

app.get("/api/test", async (req, res) => {
  try {
    const url = "https://celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=JSON";
    const { status, body } = await httpsGet(url);
    res.setHeader("Content-Type", "application/json");
    res.send(JSON.stringify({ status, bodyPreview: body.slice(0, 500) }));
  } catch(e) {
    res.setHeader("Content-Type", "application/json");
    res.send(JSON.stringify({ error: e.message }));
  }
});

app.get("/api/tle/:norad", async (req, res) => {
  const norad = parseInt(req.params.norad);
  if (!norad) return res.status(400).json({ error: "Invalid NORAD ID" });

  const cached = tleCache[norad];
  if (cached && Date.now() - cached.time < CACHE_TTL) {
    console.log(`TLE cache hit: ${norad}`);
    return res.json(cached.data);
  }

  try {
    const url = `https://celestrak.org/NORAD/elements/gp.php?CATNR=${norad}&FORMAT=JSON`;
    console.log(`Fetching TLE for NORAD ${norad}...`);
    const { status, body } = await httpsGet(url);
    console.log(`CelesTrak status: ${status}, body: ${body.slice(0, 100)}`);

    if (status !== 200) return res.status(502).json({ error: `CelesTrak ${status}` });

    const json = JSON.parse(body);
    if (!json || json.length === 0) return res.status(404).json({ error: `No data for ${norad}` });

    const obj = json[0];
    const l1 = obj.TLE_LINE1;
    const l2 = obj.TLE_LINE2;
    const name = obj.OBJECT_NAME || String(norad);

    if (!l1 || !l2) return res.status(404).json({ error: `No TLE lines for ${norad}`, obj });

    const result = { norad, name, l1, l2 };
    tleCache[norad] = { time: Date.now(), data: result };
    console.log(`TLE OK: ${name}`);
    res.json(result);
  } catch (err) {
    console.error(`TLE error for ${norad}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── STATIC FILES — after API routes ─────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Orbital Register running on port ${PORT}`);
});
