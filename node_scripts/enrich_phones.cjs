/**
 * Обогащение существующего JSON-файла телефонами с 2ГИС.
 *
 *   node enrich_phones.cjs                          # по умолчанию ../barnaul_barbershops.json
 *   node enrich_phones.cjs --file ../my_salons.json
 *   node enrich_phones.cjs --mobile-only            # только мобильные (9xx)
 */

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
require("dotenv").config({ path: path.join(__dirname, ".env") });

const { sleep } = require("./salon_metrics.cjs");

const HEADLESS = !["0", "false", "no"].includes(
  String(process.env.HEADLESS || "true").toLowerCase()
);
const REQUEST_PAUSE_MS = Math.round(
  parseFloat(process.env.REQUEST_PAUSE_SEC || "1.5") * 1000
);

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    file: path.join(__dirname, "..", "barnaul_barbershops.json"),
    mobileOnly: true,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--file" && args[i + 1])
      opts.file = path.resolve(args[++i]);
    else if (args[i] === "--mobile-only") opts.mobileOnly = true;
    else if (args[i] === "--all-phones") opts.mobileOnly = false;
  }
  return opts;
}

function normPhone(raw) {
  let d = raw.replace(/[\s\-\(\)+]/g, "");
  if (d.startsWith("8") && d.length === 11) d = "7" + d.slice(1);
  if (d.startsWith("7") && d.length === 10) d = "7" + d;
  if (d.length !== 11 || !d.startsWith("7")) return null;
  return "+7" + d.slice(1);
}

function isMobile(normalized) {
  return /^\+79/.test(normalized);
}

async function extractPhones(page) {
  return page.evaluate(() => {
    const phones = [];

    for (const a of document.querySelectorAll('a[href^="tel:"]')) {
      const raw = a.href.replace("tel:", "").trim();
      if (raw && !phones.includes(raw)) phones.push(raw);
    }

    if (!phones.length) {
      const re =
        /(?:\+7|8)\s*[\-\(]?\s*\d{3}\s*[\-\)]?\s*\d{3}\s*[\-]?\s*\d{2}\s*[\-]?\s*\d{2}/g;
      const text = document.body ? document.body.innerText : "";
      for (const m of text.matchAll(re)) {
        const raw = m[0].trim();
        if (!phones.includes(raw)) phones.push(raw);
      }
    }

    return phones;
  });
}

async function main() {
  const opts = parseArgs();
  console.log(`=== Enrich Phones ===`);
  console.log(`File: ${opts.file}`);
  console.log(`Mobile only: ${opts.mobileOnly}\n`);

  const data = JSON.parse(fs.readFileSync(opts.file, "utf-8"));
  const salons = data.salons;

  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({
    locale: "ru-RU",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1400, height: 900 },
  });
  const page = await context.newPage();

  let found = 0;
  let mobileFound = 0;

  try {
    for (let i = 0; i < salons.length; i++) {
      const s = salons[i];

      if (s.phones && s.phones.length > 0) {
        console.log(
          `  [${i + 1}/${salons.length}] ${s.name || s.id} — already has phones, skip`
        );
        continue;
      }

      console.log(
        `  [${i + 1}/${salons.length}] ${s.name || s.id} → ${s.url2gis}`
      );

      try {
        await page.goto(s.url2gis, {
          waitUntil: "domcontentloaded",
          timeout: 90000,
        });
        await page.waitForTimeout(2000);

        const rawPhones = await extractPhones(page);
        const normalized = rawPhones
          .map(normPhone)
          .filter(Boolean);

        const unique = [...new Set(normalized)];
        const mobile = unique.filter(isMobile);
        const result = opts.mobileOnly ? mobile : unique;

        s.phones = result;

        if (result.length) {
          found++;
          if (mobile.length) mobileFound++;
          console.log(`    ✓ ${result.join(", ")}`);
        } else if (rawPhones.length) {
          console.log(
            `    – raw phones found but no mobile: ${rawPhones.join(", ")}`
          );
        } else {
          console.log(`    – no phones`);
        }
      } catch (e) {
        console.error(`    ✗ error: ${e.message}`);
        s.phones = [];
      }

      await sleep(REQUEST_PAUSE_MS);
    }
  } finally {
    await browser.close();
  }

  data.meta.phonesEnrichedAt = new Date().toISOString();
  fs.writeFileSync(opts.file, JSON.stringify(data, null, 2), "utf-8");

  const totalMobile = salons.filter(
    (s) => s.phones && s.phones.some(isMobile)
  ).length;

  console.log(`\n✓ Done. Saved to ${opts.file}`);
  console.log(
    `  Salons with phones: ${found} | With mobile: ${totalMobile} / ${salons.length}`
  );
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
