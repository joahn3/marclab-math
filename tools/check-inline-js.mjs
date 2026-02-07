import fs from "node:fs";
import vm from "node:vm";

const files = ["index.html", "plusminus/index.html"];

function extractScripts(html) {
  const scripts = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1] || "";
    const code = m[2] || "";

    // skip external scripts
    if (/\bsrc\s*=/.test(attrs)) continue;

    // skip JSON/LD or other non-JS script types
    const typeMatch = attrs.match(/\btype\s*=\s*["']([^"']+)["']/i);
    const type = typeMatch ? typeMatch[1].toLowerCase() : "";
    if (type && !["text/javascript", "application/javascript", "module"].includes(type)) continue;

    if (code.trim().length === 0) continue;
    scripts.push(code);
  }
  return scripts;
}

let ok = true;

for (const file of files) {
  if (!fs.existsSync(file)) {
    console.error(`❌ Missing file: ${file}`);
    ok = false;
    continue;
  }

  const html = fs.readFileSync(file, "utf8");
  const scripts = extractScripts(html);

  scripts.forEach((code, i) => {
    try {
      new vm.Script(code, { filename: `${file}::script#${i + 1}` });
    } catch (err) {
      ok = false;
      console.error(`\n❌ JS syntax error in ${file} (script #${i + 1})`);
      console.error(String(err));
    }
  });
}

if (!ok) process.exit(1);
console.log("✅ Inline JS syntax check passed");