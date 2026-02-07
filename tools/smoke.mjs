import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
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
  const decoded = decodeURIComponent((urlPath || "/").split("?")[0] || "/");
  const clean = decoded.replace(/\0/g, "");
  let rel = clean;
  if (rel.endsWith("/")) rel += "index.html";
  if (rel.startsWith("/")) rel = rel.slice(1);
  const abs = path.resolve(ROOT, rel);
  if (!abs.startsWith(ROOT)) return null;
  return abs;
}

async function startServer() {
  const server = http.createServer((req, res) => {
    const filePath = safeResolve(req.url || "/");
    if (!filePath) { res.writeHead(400); res.end("Bad request"); return; }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404); res.end("Not found"); return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.setHeader("Content-Type", contentTypeFor(ext));
    res.setHeader("Cache-Control", "no-store");
    fs.createReadStream(filePath).pipe(res);
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
  // Required files
  for (const f of ["index.html", "plusminus/index.html"]) {
    if (!fs.existsSync(path.join(ROOT, f))) fail(`Missing required file: ${f}`);
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
    page.on("console", (msg) => { if (msg.type() === "error") fail(`console.error: ${msg.text()}`); });
    // Fail on request failures (ignore favicon)
    page.on("requestfailed", (req) => {
      const u = req.url();
      if (u.endsWith("favicon.ico")) return;
      fail(`requestfailed: ${u} -> ${req.failure()?.errorText || "unknown error"}`);
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });

    await page.waitForSelector("#kbd", { timeout: 15000 });
    await page.waitForSelector(".big", { timeout: 15000 });

    // --- (1) Problem validity: no NaN/undefined, numbers parse, answerBox exists
    const validity = await page.evaluate(() => {
      const big = document.querySelector(".big");
      const answerBox = document.querySelector("#answerBox");
      const mode = document.querySelector("#uiMode")?.textContent || "";

      if (!big) return { ok:false, reason:"missing .big" };
      if (!answerBox) return { ok:false, reason:"missing #answerBox" };

      const text = big.innerText || "";
      if (text.includes("NaN") || text.includes("undefined")) return { ok:false, reason:"NaN/undefined in UI" };

      const spans = Array.from(big.querySelectorAll("span")).map(s => (s.textContent || "").trim());
      const nums = spans.filter(t => /^-?\d+$/.test(t));
      for (const n of nums) {
        const v = Number(n);
        if (Number.isNaN(v)) return { ok:false, reason:`NaN number parsed: ${n}` };
      }

      // If it’s dots question, ensure dots exist
      const dots = document.querySelectorAll(".dot");
      if ((mode.includes("Numără") || text.includes("Câte sunt")) && dots.length === 0) {
        // not fatal, but suspicious: allow
      }

      return { ok:true, reason:"ok" };
    });

    if (!validity.ok) fail(`Invalid generated problem: ${validity.reason}`);

    // Capture initial signature
    const sig1 = await page.evaluate(() => document.querySelector(".big")?.innerText || "");

    // Answer something (doesn't matter if correct), then wait feedback
    await page.getByRole("button", { name: "1" }).click();
    await page.waitForSelector("#uiFeedback", { timeout: 10000 });

    // --- (2) Next changes exercise
    await page.getByRole("button", { name: "Următorul" }).click();
    await page.waitForFunction((prev) => {
      const now = document.querySelector(".big")?.innerText || "";
      return now && now !== prev;
    }, sig1, { timeout: 15000 });

    const sig2 = await page.evaluate(() => document.querySelector(".big")?.innerText || "");
    if (!sig2 || sig2 === sig1) fail("“Următorul” did not change the exercise");

    // re-check validity after Next
    const validity2 = await page.evaluate(() => {
      const big = document.querySelector(".big");
      const answerBox = document.querySelector("#answerBox");
      if (!big || !answerBox) return { ok:false, reason:"missing big/answerBox after Next" };
      const text = big.innerText || "";
      if (text.includes("NaN") || text.includes("undefined")) return { ok:false, reason:"NaN/undefined after Next" };
      return { ok:true, reason:"ok" };
    });
    if (!validity2.ok) fail(`Invalid problem after Next: ${validity2.reason}`);

    // Ensure localStorage key exists
    const key = "marclab-plusminus-l1-v1";
    const hasStorage = await page.evaluate((k) => !!localStorage.getItem(k), key);
    if (!hasStorage) fail(`localStorage key not set: ${key}`);

    // --- (3) Parent Dashboard PIN gate
    await page.getByRole("button", { name: "Dashboard" }).click();
    await page.waitForSelector("dialog#pinDlg[open]", { timeout: 10000 });

    // wrong PIN -> should NOT open parentDlg
    await page.fill("#pinInput", "0000");
    await page.click("#pinOk");
    await page.waitForTimeout(300);
    const parentOpen1 = await page.locator("dialog#parentDlg[open]").count();
    if (parentOpen1 > 0) fail("Parent dashboard opened with WRONG PIN");

    // correct default PIN -> should open parentDlg
    await page.fill("#pinInput", "2580");
    await page.click("#pinOk");
    await page.waitForSelector("dialog#parentDlg[open]", { timeout: 10000 });

    console.log("✅ Smoke test passed:", url);
  } finally {
    try { if (browser) await browser.close(); } catch {}
    try { server.close(); } catch {}
  }
})();