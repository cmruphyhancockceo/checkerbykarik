
// server.js
const express = require("express");
const rateLimit = require("express-rate-limit");
const cors = require("cors");
const dns = require("dns").promises;
const fetch = require("node-fetch");
const { URL } = require("url");
const { AbortController } = require("abort-controller");

const app = express();
app.use(express.json());
app.use(cors());

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: "Too many requests, please slow down." }
});
app.use(limiter);

async function fetchWithTimeout(url, timeout = 5000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": "EmailLoginFinder/1.0" }
    });
    return { ok: res.ok, status: res.status, url: res.url };
  } catch (err) {
    return { ok: false, error: err.message || "fetch-error" };
  } finally {
    clearTimeout(id);
  }
}

function generateGuesses(domain) {
  domain = domain.replace(/\/+$/, "");
  const guesses = [
    `https://mail.${domain}`,
    `https://webmail.${domain}`,
    `https://owa.${domain}`,
    `https://${domain}/mail`,
    `https://${domain}/webmail`,
    `https://${domain}/owa`,
    `https://${domain}/login`,
    `https://login.${domain}`,
    `https://${domain}/roundcube/`
  ];
  return Array.from(new Set(guesses));
}

app.get("/api/find-login", async (req, res) => {
  const q = (req.query.email || req.query.domain || "").trim().toLowerCase();
  if (!q) return res.status(400).json({ error: "Provide ?email=someone@domain.com" });

  let domain = q.includes("@") ? q.split("@")[1] : q;
  domain = domain.replace(/^https?:\/\//, "").split(/[\/:?#]/)[0];
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) {
    return res.status(400).json({ error: "Invalid domain format." });
  }

  let mxRecords = [];
  try {
    const mx = await dns.resolveMx(domain);
    mxRecords = mx.sort((a, b) => a.priority - b.priority).map(m => `${m.exchange} (prio ${m.priority})`);
  } catch (err) {
    mxRecords = [];
  }

  const guesses = generateGuesses(domain);
  const concurrency = 6;
  const tested = [];

  async function testBatch(urls) {
    return Promise.all(urls.map(u => fetchWithTimeout(u, 5000)));
  }

  for (let i = 0; i < guesses.length; i += concurrency) {
    const chunk = guesses.slice(i, i + concurrency);
    const results = await testBatch(chunk);
    for (let j = 0; j < chunk.length; j++) {
      tested.push({
        guess: chunk[j],
        ok: results[j].ok,
        status: results[j].status || null,
        infoUrl: results[j].url || null,
        error: results[j].error || null
      });
    }
  }

  const successful = tested.filter(t => t.ok && t.status && t.status >= 200 && t.status < 400);
  return res.json({ domain, mxRecords, tested, successful });
});

app.get("/api/ping", (req, res) => res.json({ ok: true, time: Date.now() }));

app.use(express.static("public"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
