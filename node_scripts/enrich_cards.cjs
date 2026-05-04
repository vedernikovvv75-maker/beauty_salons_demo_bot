/**
 * Обогащение JSON-файла контактами с карточек 2ГИС.
 * Обходит карточку каждого салона и дополняет phones, telegram, vk, email, address.
 * Сохраняет прогресс каждые N записей.
 *
 *   node enrich_cards.cjs                                   # по умолчанию ../novosibirsk_salons.json
 *   node enrich_cards.cjs --file ../novosibirsk_salons.json
 *   node enrich_cards.cjs --file ../file.json --start 100   # начать с 100-го салона
 *   node enrich_cards.cjs --file ../file.json --save-every 25
 */

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
require("dotenv").config({ path: path.join(__dirname, ".env") });

const { extract2gisStats, sleep } = require("./salon_metrics.cjs");

const HEADLESS = !["0", "false", "no"].includes(
  String(process.env.HEADLESS || "true").toLowerCase()
);
const REQUEST_PAUSE_MS = Math.round(
  parseFloat(process.env.REQUEST_PAUSE_SEC || "1.5") * 1000
);

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    file: path.join(__dirname, "..", "novosibirsk_salons.json"),
    start: 0,
    saveEvery: 50,
    mobileOnly: true,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--file" && args[i + 1]) opts.file = path.resolve(args[++i]);
    else if (args[i] === "--start" && args[i + 1]) opts.start = parseInt(args[++i], 10);
    else if (args[i] === "--save-every" && args[i + 1]) opts.saveEvery = parseInt(args[++i], 10);
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

async function scrapeFirmCard(page, salon) {
  const url2gis = salon.url2gis;
  await page.goto(url2gis, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForSelector("span._1dvs8n, a[href^='tel:'], h1", { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(2500);

  const data = await page.evaluate(() => {
    const text = document.body ? document.body.innerText : "";

    const nameEl =
      document.querySelector("h1") ||
      document.querySelector("[class*='orgpage-header'] span");
    const name = nameEl ? nameEl.textContent.trim() : "";

    let address = "";
    const addrEl = document.querySelector(
      "[class*='address-item__value'], [class*='orgpage-header__address']"
    );
    if (addrEl) address = addrEl.textContent.trim();
    if (!address) {
      const m = text.match(
        /(?:улица|проспект|переулок|тракт|бульвар|площадь)[^,\n]{3,60},?\s*\d{0,5}/iu
      );
      if (m) address = m[0].trim();
    }

    const links = [...document.querySelectorAll("a[href]")].map((a) =>
      a.href.toLowerCase()
    );

    let telegram = "";
    let vk = "";
    let email = "";
    let website = "";

    for (const href of links) {
      if (!telegram && /t\.me\b/.test(href))
        telegram = href.replace(/^http:/, "https:");
      if (!vk && /vk\.com\b/.test(href)) vk = href;
    }

    if (!telegram) {
      for (const span of document.querySelectorAll("span._1dvs8n, span[class*='contact']")) {
        const txt = span.textContent.trim().toLowerCase();
        if (txt === "telegram" || txt === "телеграм") {
          const parent = span.closest("a[href]");
          if (parent && parent.href) {
            telegram = parent.href.replace(/^http:/, "https:");
            break;
          }
          const sibling = span.parentElement && span.parentElement.querySelector("a[href]");
          if (sibling && sibling.href) {
            telegram = sibling.href.replace(/^http:/, "https:");
            break;
          }
        }
      }
    }

    const emailMatch = text.match(
      /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-z]{2,}/i
    );
    if (emailMatch) email = emailMatch[0];

    const siteEls = document.querySelectorAll(
      'a[href*="://"][target="_blank"], a[class*="website"]'
    );
    for (const el of siteEls) {
      const h = el.href || "";
      if (
        h &&
        !h.includes("2gis.") &&
        !h.includes("t.me") &&
        !h.includes("vk.com") &&
        !h.includes("yandex.") &&
        !h.includes("google.") &&
        !h.includes("instagram.") &&
        !h.includes("facebook.")
      ) {
        website = h;
        break;
      }
    }

    let branches = "";
    const branchMatch = text.match(/(\d+)\s*филиал/iu);
    if (branchMatch) branches = branchMatch[1];

    const phones = [];
    for (const a of document.querySelectorAll('a[href^="tel:"]')) {
      const raw = a.href.replace("tel:", "").replace(/[\s\-()]/g, "");
      if (raw && !phones.includes(raw)) phones.push(raw);
    }
    if (!phones.length) {
      const phoneRe =
        /(?:\+7|8)\s*[\-\(]?\s*9\d{2}\s*[\-\)]?\s*\d{3}\s*[\-]?\s*\d{2}\s*[\-]?\s*\d{2}/g;
      const bodyText = document.body ? document.body.innerText : "";
      for (const m of bodyText.matchAll(phoneRe)) {
        const raw = m[0].replace(/[\s\-()]/g, "");
        if (!phones.includes(raw)) phones.push(raw);
      }
    }

    return { name, address, telegram, vk, email, website, branches, phones };
  });

  let baseline2gis = { rating2gis: null, reviews2gis: null, reviewsTab2gis: null };
  try {
    baseline2gis = await extract2gisStats(page);
  } catch {}

  return { data, baseline2gis };
}

async function main() {
  const opts = parseArgs();
  console.log("=== Enrich Cards ===");
  console.log(`File: ${opts.file}`);
  console.log(`Start from: ${opts.start}`);
  console.log(`Save every: ${opts.saveEvery}\n`);

  const fileData = JSON.parse(fs.readFileSync(opts.file, "utf-8"));
  const salons = fileData.salons;

  const needsEnrich = salons.filter(
    (s, i) => i >= opts.start && (!s._enriched)
  );
  console.log(`Total salons: ${salons.length}`);
  console.log(`Already enriched: ${salons.filter(s => s._enriched).length}`);
  console.log(`To enrich (from ${opts.start}): ${needsEnrich.length}\n`);

  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({
    locale: "ru-RU",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1400, height: 900 },
  });
  const page = await context.newPage();

  let enriched = 0;
  let withPhones = 0;

  try {
    for (let i = opts.start; i < salons.length; i++) {
      const s = salons[i];
      if (s._enriched) continue;

      console.log(`  [${i + 1}/${salons.length}] ${s.name || s.id} → ${s.url2gis}`);

      try {
        const { data, baseline2gis } = await scrapeFirmCard(page, s);

        if (data.name) s.name = data.name;

        const normalized = data.phones.map(normPhone).filter(Boolean);
        const unique = [...new Set(normalized)];
        s.phones = opts.mobileOnly ? unique.filter(isMobile) : unique;

        if (!s.telegram && data.telegram) s.telegram = data.telegram;
        if (!s.vk && data.vk) s.vk = data.vk;
        if (!s.email && data.email) s.email = data.email;

        const other = [
          data.branches ? `филиалов: ${data.branches}` : "",
          data.address ? `адрес: ${data.address}` : "",
          data.website ? `сайт: ${data.website}` : "",
        ]
          .filter(Boolean)
          .join(" | ");
        if (other) s.other = other;

        if (baseline2gis.rating2gis != null) s.rating2gis = baseline2gis.rating2gis;
        if (baseline2gis.reviews2gis != null) s.reviews2gis = baseline2gis.reviews2gis;
        if (baseline2gis.reviewsTab2gis != null) s.reviewsTab2gis = baseline2gis.reviewsTab2gis;

        s._enriched = true;
        enriched++;

        const info = [];
        if (s.phones.length) { info.push(`📱 ${s.phones.join(", ")}`); withPhones++; }
        if (s.telegram) info.push("tg");
        if (s.vk) info.push("vk");
        console.log(`    → ${data.name || "(no name)"}  ${info.join(" | ") || "no contacts"}`);
      } catch (e) {
        console.error(`    ✗ ${e.message}`);
      }

      if ((enriched % opts.saveEvery === 0) && enriched > 0) {
        fileData.meta.enrichedAt = new Date().toISOString();
        fs.writeFileSync(opts.file, JSON.stringify(fileData, null, 2), "utf-8");
        console.log(`  ... saved progress (${enriched} enriched, ${i + 1}/${salons.length}) ...`);
      }

      await sleep(REQUEST_PAUSE_MS);
    }
  } finally {
    await browser.close();
  }

  // Clean up temp field and save
  for (const s of salons) delete s._enriched;
  fileData.meta.enrichedAt = new Date().toISOString();
  fileData.meta.phonesEnrichedAt = new Date().toISOString();
  fs.writeFileSync(opts.file, JSON.stringify(fileData, null, 2), "utf-8");

  const totalWithPhones = salons.filter(s => s.phones && s.phones.length > 0).length;
  console.log(`\n✓ Done. Enriched ${enriched} salons.`);
  console.log(`  With phones: ${totalWithPhones}/${salons.length}`);
  console.log(`  Saved to ${opts.file}`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
