import fs from "node:fs";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const PORT = 4173;
const HOST = "127.0.0.1";
const BASE = `http://${HOST}:${PORT}`;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function findModulePath() {
  if (fs.existsSync("plusminus/index.html")) return "/plusminus/";
  if (fs.existsSync("PlusMinus/index.html")) return "/PlusMinus/";
  throw new Error(
    "Nu găsesc modulul. Aștept fie plusminus/index.html, fie PlusMinus/index.html (case-sensitive pe Linux)."
  );
}

async function waitForServerReady() {
  // quick ping loop
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${BASE}/`);
      if (res.ok || res.status === 404) return; // root may 404 if no index; it's fine
    } catch {}
    await sleep(150);
  }
  throw new Error("Serverul local nu a pornit la timp.");
}

async function getProblemSignature(page) {
  return await page.evaluate(() => {
    const eq = document.querySelector(".big-eq");
    const skill = document.querySelector("#uiSkillName")?.textContent?.trim() || "";
    const eqText = eq ? eq.textContent.replace(/\s+/g, " ").trim() : "";
    return `${skill} :: ${eqText}`;
  });
}

async function readProblemData(page) {
  return await page.evaluate(() => {
    const eq = document.querySelector(".big-eq");
    if (!eq) return { kind: "unknown" };

    const kids = Array.from(eq.children).map(el => ({
      id: el.id || "",
      tag: el.tagName,
      text: (el.textContent || "").trim(),
    }));
    const spans = Array.from(eq.querySelectorAll("span")).map(s => (s.textContent || "").trim());
    const dots = document.querySelectorAll(".viz-area .d-pt").length;

    // locate '=' span index in children
    const eqIndex = kids.findIndex(k => k.tag === "SPAN" && k.text === "=");
    const ansIndex = kids.findIndex(k => k.id === "ansBox");

    const eqText = eq.textContent.replace(/\s+/g, " ").trim();

    return { kids, spans, dots, eqIndex, ansIndex, eqText };
  });
}

function computeAnswer(data) {
  // Dots-only: only ansBox in equation, answer is number of dots
  if (data.kids?.length === 1 && data.kids[0].id === "ansBox" && data.dots > 0) {
    return { type: "num", value: data.dots };
  }

  // Compare: spans usually [a, b], and equation has no '=' span
  if (Array.isArray(data.spans) && data.spans.length === 2 && !data.spans.includes("=")) {
    const a = Number(data.spans[0]);
    const b = Number(data.spans[1]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error(`Compară invalid: ${data.eqText}`);
    const sign = (a === b) ? "=" : (a > b ? ">" : "<");
    return { type: "cmp", value: sign };
  }

  // Missing addend: ansBox BEFORE '='
  if (data.eqIndex >= 0 && data.ansIndex >= 0 && data.ansIndex < data.eqIndex) {
    // expected spans like: [a, op, "=", b] OR [a, op, "=", 10]
    const a = Number(data.spans[0]);
    const b = Number(data.spans[data.spans.length - 1]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error(`Missing invalid: ${data.eqText}`);
    return { type: "num", value: b - a };
  }

  // Standard add/sub: spans like [a, op, b, "="]
  if (Array.isArray(data.spans) && data.spans.length >= 3) {
    const a = Number(data.spans[0]);
    const op = data.spans[1];
    const b = Number(data.spans[2]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error(`Operație invalidă: ${data.eqText}`);
    if (op === "+") return { type: "num", value: a + b };
    if (op === "−" || op === "-") return { type: "num", value: a - b };
    // fallback
    throw new Error(`Operator necunoscut "${op}" în: ${data.eqText}`);
  }

  throw new Error(`Nu pot interpreta problema: ${data.eqText}`);
}

async function clickDigitsAndOk(page, n) {
  const s = String(n);
  for (const ch of s) {
    await page.click(`button:has-text("${ch}")`);
  }
  await page.click(`button:has-text("OK")`);
}

async function answerCurrentProblem(page) {
  const data = await readProblemData(page);

  // sanity: avoid NaN/undefined
  if (data.eqText.includes("NaN") || data.eqText.includes("undefined")) {
    throw new Error(`Problema conține NaN/undefined: "${data.eqText}"`);
  }

  const ans = computeAnswer(data);

  if (ans.type === "cmp") {
    await page.click(`button:has-text("${ans.value}")`);
  } else {
    await clickDigitsAndOk(page, ans.value);
  }

  // feedback should appear
  await page.waitForSelector("#uiFeedback", { state: "visible", timeout: 5000 });
}

async function ensureNextChangesExercise(page) {
  const before = await getProblemSignature(page);

  // click next
  await page.click("#btnNext");
  await page.waitForSelector("#uiFeedback", { state: "hidden", timeout: 5000 });

  // sometimes random can repeat; try a few times
  for (let i = 0; i < 5; i++) {
    const after = await getProblemSignature(page);
    if (after && after !== before) return;
    // if repeated, solve again and next again
    await answerCurrentProblem(page);
    await page.click("#btnNext");
    await page.waitForSelector("#uiFeedback", { state: "hidden", timeout: 5000 });
  }

  throw new Error("“Următorul” nu a schimbat exercițiul (după 6 încercări).");
}

async function testPinGate(page) {
  // click Dashboard button
  await page.click(`button:has-text("Dashboard")`);

  // PIN dialog should open
  await page.waitForSelector("#pinDlg[open]", { timeout: 3000 });

  // try wrong pin
  await page.fill("#pinInput", "0000");
  await page.click("#pinOk");
  await page.waitForSelector("#pinMsg", { timeout: 2000 });

  // parent dialog should NOT open
  const parentOpenAfterWrong = await page.evaluate(() => !!document.querySelector("#parentDlg[open]"));
  if (parentOpenAfterWrong) throw new Error("Dashboard părinte s-a deschis cu PIN greșit (NU e ok).");

  // now correct pin (default)
  await page.fill("#pinInput", "2580");
  await page.click("#pinOk");

  // parent dialog should open
  await page.waitForSelector("#parentDlg[open]", { timeout: 3000 });

  // close parent
  await page.click(`#parentDlg button:has-text("Închide")`);
}

async function main() {
  const modulePath = findModulePath();

  // Start a simple static server from repo root
  const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", HOST], {
    stdio: "inherit",
  });

  const cleanup = async () => {
    try { server.kill("SIGTERM"); } catch {}
  };

  process.on("exit", cleanup);
  process.on("SIGINT", async () => { await cleanup(); process.exit(1); });

  try {
    await waitForServerReady();

    const browser = await chromium.launch();
    const page = await browser.newPage();

    const errors = [];

    page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
    });

    await page.goto(`${BASE}${modulePath}`, { waitUntil: "domcontentloaded" });

    // wait for UI to exist
    await page.waitForSelector("#uiProblem", { timeout: 10000 });
    await page.waitForSelector("#uiKbd", { timeout: 10000 });
    await page.waitForSelector("#ansBox", { timeout: 10000 });

    // solve one problem
    await answerCurrentProblem(page);

    // next changes exercise
    await ensureNextChangesExercise(page);

    // PIN gate behavior
    await testPinGate(page);

    await browser.close();

    // If any fatal errors happened, fail
    if (errors.length) {
      throw new Error("Erori JS detectate:\n" + errors.map(e => `- ${e}`).join("\n"));
    }

    console.log("SMOKE TEST OK ✅");
    await cleanup();
    process.exit(0);

  } catch (e) {
    await cleanup();
    console.error("SMOKE TEST FAILED ❌\n" + (e?.stack || e));
    process.exit(1);
  }
}

await main();