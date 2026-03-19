const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// Try public folder first, fall back to root
app.use(express.static(path.join(__dirname, "public")));
app.use(express.static(path.join(__dirname)));

app.get("*", (req, res) => {
  // Try public/index.html first, then root index.html
  const publicPath = path.join(__dirname, "public", "index.html");
  const rootPath = path.join(__dirname, "index.html");
  
  const fs = require("fs");
  if (fs.existsSync(publicPath)) {
    res.sendFile(publicPath);
  } else if (fs.existsSync(rootPath)) {
    res.sendFile(rootPath);
  } else {
    res.status(404).send("index.html not found");
  }
});

app.listen(PORT, () => {
  console.log(`Orbital Register running on port ${PORT}`);
});
