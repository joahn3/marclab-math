import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Repo root = one level above /tools
const ROOT = path.resolve(__dirname, "..");

function contentTypeFor(ext) {
  switch (ext) {
    case ".html": return "text/html; charset=utf-8";
    case ".js": return "application/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".svg": return "image/svg+xml";
    case ".ico": return "image/x-icon";
    case ".txt": return "text/plain; charset=utf-8";
    default: return "application/octet-stream";
  }
}

function safeResolve(urlPath) {
  // normalize + prevent path traversal
  const decoded = decodeURIComponent(urlPath.split("?")[0] || "/");
  const clean = decoded.replace(/\0/g, "");
  let rel = clean;

  // map directories -> index.html
  if (rel.endsWith("/")) rel += "index.html";

  // remove leading slash
  if (rel.startsWith("/")) rel = rel.slice(1);

  const abs = path.resolve(ROOT, rel);
  if (!abs.startsWith(ROOT)) return null;
  return abs;
}

async function startServer() {
  const server = http.createServer((req, res) => {
    const filePath = safeResolve(req.url || "/");
    if (!filePath) {
      res.writeHead(400);
      res.end("Bad request");
      return;
    }

    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.setHeader("Content-Type", contentTypeFor(ext));
    res.setHeader("Cache-Control", "no-store");

    const stream = fs.createReadStream(filePath);
    stream.on("error", () => {
      res.writeHead(500);
      res.end("Server error");
    });
    stream.pipe(res);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  return { server, port };
}

function fail(msg) {
  console.error(`\n❌ SMOKE FAIL: ${msg}\n`);
  process.exit(1);
}

(async () => {
  // Basic sanity: required files
  const required = [
    path.join(ROOT, "index.html"),
    path.join(ROOT, "plusminus", "index.html"),
  ];
  for (const f of required) {
    if (!fs.existsSync(f)) fail(`Missing required file: ${path.relative(ROOT, f)}`);
  }

  const { server, port } = await startServer();
  const baseUrl = `http://127.0.0.1:${port}`;
  const url = `${baseUrl}/plusminus/`;

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    // Fail hard on JS runtime errors
    page.on("pageerror", (err) => fail(`pageerror: ${err?.message || String(err)}`));

    // Fail on console.error
    page.on("console", (msg) => {
      if (msg.type() === "error") fail(`console.error: ${msg.text()}`);
    });

    // Fail on request failures (ignore favicon)
    page.on("requestfailed", (req) => {
      const u = req.url();
      if (u.endsWith("favicon.ico")) return;
      fail(`requestfailed: ${u} -> ${req.failure()?.errorText || "unknown error"}`);
    });

    // Go
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });

    // Key UI must exist
    await page.waitForSelector("#kbd", { timeout: 15000 });

    // Brand text check
    const titleText = await page.textContent(".brand b");
    if (!titleText || !titleText.includes("MarcLab")) fail("Brand header not found / wrong");

    // Small interaction: press a number, then expect feedback
    // We don't know if answer is correct; we only need "feedback shown".
    await page.getByRole("button", { name: "1" }).click();
    await page.waitForSelector("#uiFeedback", { timeout: 10000 });

    // Ensure state persisted after one answer
    const key = "marclab-plusminus-l1-v1";
    const hasStorage = await page.evaluate((k) => !!localStorage.getItem(k), key);
    if (!hasStorage) fail(`localStorage key not set: ${key}`);

    console.log("✅ Smoke test passed:", url);
  } finally {
    try { if (browser) await browser.close(); } catch {}
    try { server.close(); } catch {}
  }
})();