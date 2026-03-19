const express = require("express");
const path = require("path");
const https = require("https");

const app = express();
const PORT = process.env.PORT || 3000;

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
  if (cached && Date.now() - cached.time < CACHE_TTL) {
    return res.json(cached.data);
  }

  try {
    const url = `https://celestrak.org/NORAD/elements/gp.php?CATNR=${norad}&FORMAT=TLE`;
    console.log(`TLE fetch: ${norad}`);
    const { status, body } = await httpsGet(url);

    if (status !== 200) {
      console.warn(`CelesTrak ${status} for ${norad}`);
      return res.status(502).json({ error: `CelesTrak ${status}` });
    }

    const lines = body.trim().split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
    let name = null, l1 = null, l2 = null;
    for (const line of lines) {
      if (line.startsWith("1 ") && line.length > 50) l1 = line;
      else if (line.startsWith("2 ") && line.length > 50) l2 = line;
      else if (!name && !line.startsWith("1 ") && !line.startsWith("2 ")) name = line;
    }

    if (!l1 || !l2) {
      console.warn(`No TLE lines for ${norad}: "${body.slice(0,100)}"`);
      return res.status(404).json({ error: `No TLE for ${norad}` });
    }

    const result = { norad, name: name ? name.trim() : String(norad), l1, l2 };
    tleCache[norad] = { time: Date.now(), data: result };
    console.log(`TLE OK: ${result.name}`);
    res.json(result);
  } catch (err) {
    console.error(`TLE error ${norad}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Orbital Register running on port ${PORT}`);
});
