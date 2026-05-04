/**
 * Сеточный краулер 2ГИС — обходит лимит ~60 результатов пагинации,
 * разбивая карту города на ячейки с высоким зумом.
 *
 *   node scrape_grid.cjs --query "салон красоты" --city novosibirsk --out ../novosibirsk_salons.json
 *   node scrape_grid.cjs --ids-only                     # только сбор ID, без карточек
 *   node scrape_grid.cjs --resume ../novosibirsk_salons.json  # продолжить обход карточек
 */

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
require("dotenv").config({ path: path.join(__dirname, ".env") });

const {
  extract2gisStats,
  enrichSalonMetricsOnPage,
  sleep,
} = require("./salon_metrics.cjs");

const HEADLESS = !["0", "false", "no"].includes(
  String(process.env.HEADLESS || "true").toLowerCase()
);
const REQUEST_PAUSE_MS = Math.round(
  parseFloat(process.env.REQUEST_PAUSE_SEC || "1.5") * 1000
);

const CITY_BOUNDS = {
  novosibirsk: {
    latMin: 54.83,
    latMax: 55.19,
    lonMin: 82.70,
    lonMax: 83.20,
  },
  barnaul: {
    latMin: 53.30,
    latMax: 53.42,
    lonMin: 83.60,
    lonMax: 83.85,
  },
};

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    query: "салон красоты",
    city: "novosibirsk",
    out: path.join(__dirname, "..", "novosibirsk_salons.json"),
    zoom: 14,
    latStep: 0.035,
    lonStep: 0.07,
    maxPagesPerCell: 5,
    idsOnly: false,
    resume: null,
    skipYandex: true,
    enrichLimit: Infinity,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--query" && args[i + 1]) opts.query = args[++i];
    else if (args[i] === "--city" && args[i + 1]) opts.city = args[++i];
    else if (args[i] === "--out" && args[i + 1]) opts.out = path.resolve(args[++i]);
    else if (args[i] === "--zoom" && args[i + 1]) opts.zoom = parseFloat(args[++i]);
    else if (args[i] === "--lat-step" && args[i + 1]) opts.latStep = parseFloat(args[++i]);
    else if (args[i] === "--lon-step" && args[i + 1]) opts.lonStep = parseFloat(args[++i]);
    else if (args[i] === "--ids-only") opts.idsOnly = true;
    else if (args[i] === "--resume" && args[i + 1]) opts.resume = path.resolve(args[++i]);
    else if (args[i] === "--skip-yandex") opts.skipYandex = true;
    else if (args[i] === "--with-yandex") opts.skipYandex = false;
    else if (args[i] === "--enrich-limit" && args[i + 1])
      opts.enrichLimit = parseInt(args[++i], 10) || 0;
  }
  return opts;
}

function generateGrid(bounds, latStep, lonStep) {
  const cells = [];
  for (let lat = bounds.latMin; lat <= bounds.latMax; lat += latStep) {
    for (let lon = bounds.lonMin; lon <= bounds.lonMax; lon += lonStep) {
      cells.push({
        lat: Math.round((lat + latStep / 2) * 1e6) / 1e6,
        lon: Math.round((lon + lonStep / 2) * 1e6) / 1e6,
      });
    }
  }
  return cells;
}

function buildSearchUrl(city, query, lon, lat, zoom, page) {
  const enc = encodeURIComponent(query);
  const mapParam = `m=${lon}%2C${lat}%2F${zoom}`;
  const base = `https://2gis.ru/${city}/search/${enc}`;
  return page > 1 ? `${base}/page/${page}?${mapParam}` : `${base}?${mapParam}`;
}

async function collectFirmIdsFromPage(page) {
  return page.evaluate(() => {
    const ids = new Set();
    for (const a of document.querySelectorAll('a[href*="/firm/"]')) {
      const m = a.href.match(/\/firm\/(\d+)/);
      if (m) ids.add(m[1]);
    }
    return [...ids];
  });
}

async function collectIdsFromCell(page, city, query, cell, zoom, maxPages) {
  const cellIds = [];
  const seen = new Set();

  for (let p = 1; p <= maxPages; p++) {
    const url = buildSearchUrl(city, query, cell.lon, cell.lat, zoom, p);
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
      await page.waitForTimeout(2000);
    } catch (e) {
      console.log(`      page ${p} timeout: ${e.message}`);
      break;
    }

    const ids = await collectFirmIdsFromPage(page);
    const newIds = ids.filter((id) => !seen.has(id));
    if (newIds.length === 0) break;
    newIds.forEach((id) => seen.add(id));
    cellIds.push(...newIds);

    if (newIds.length < 10) break;
    await sleep(REQUEST_PAUSE_MS);
  }
  return cellIds;
}

async function scrapeFirmCard(page, city, firmId) {
  const url2gis = `https://2gis.ru/${city}/firm/${firmId}`;
  await page.goto(url2gis, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(1800);

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
  } catch { /* will be retried during enrichment */ }

  const other = [
    data.branches ? `филиалов: ${data.branches}` : "",
    data.address ? `адрес: ${data.address}` : "",
    data.website ? `сайт: ${data.website}` : "",
  ]
    .filter(Boolean)
    .join(" | ");

  return {
    id: firmId,
    name: data.name,
    telegram: data.telegram,
    vk: data.vk,
    email: data.email,
    phones: data.phones || [],
    other,
    url2gis,
    _baseline2gis: baseline2gis,
  };
}

function saveProgress(filePath, meta, salons) {
  const result = { meta, salons };
  fs.writeFileSync(filePath, JSON.stringify(result, null, 2), "utf-8");
}

async function main() {
  const opts = parseArgs();
  const bounds = CITY_BOUNDS[opts.city];
  if (!bounds) {
    console.error(`Unknown city: ${opts.city}. Add bounds to CITY_BOUNDS.`);
    process.exit(1);
  }

  console.log("=== 2GIS Grid Scraper ===");
  console.log(`Query: "${opts.query}" | City: ${opts.city}`);
  console.log(`Output: ${opts.out}`);
  console.log(`Zoom: ${opts.zoom} | Grid: ${opts.latStep}° lat × ${opts.lonStep}° lon`);
  console.log(`IDs only: ${opts.idsOnly} | Skip Yandex: ${opts.skipYandex}`);
  console.log();

  // ──── Resume mode: skip to card scraping ────
  if (opts.resume) {
    console.log(`► Resuming from ${opts.resume}`);
    const existing = JSON.parse(fs.readFileSync(opts.resume, "utf-8"));
    const firmIds = existing.salons
      .filter((s) => !s.name && s.other === "")
      .map((s) => s.id);
    const done = existing.salons.filter((s) => s.name || s.other !== "");
    console.log(`  ${done.length} already scraped, ${firmIds.length} remaining\n`);
    console.warn(
      "Resume (дособор карточек из частичного JSON) в этом скрипте не реализован. " +
        "Запустите полный проход без --resume или дорисуйте пайплайн вручную.",
    );
    return;
  }

  const grid = generateGrid(bounds, opts.latStep, opts.lonStep);
  console.log(`Generated ${grid.length} grid cells\n`);

  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({
    locale: "ru-RU",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1400, height: 900 },
  });
  const page = await context.newPage();

  try {
    // ──── Step 1: collect firm IDs from grid cells ────
    console.log("► Step 1: Collecting firm IDs from grid cells...");
    const allIds = new Set();
    let cellsWithResults = 0;

    for (let i = 0; i < grid.length; i++) {
      const cell = grid[i];
      process.stdout.write(
        `  [cell ${i + 1}/${grid.length}] (${cell.lat}, ${cell.lon}) `
      );

      const ids = await collectIdsFromCell(
        page, opts.city, opts.query, cell, opts.zoom, opts.maxPagesPerCell
      );

      const newCount = ids.filter((id) => !allIds.has(id)).length;
      ids.forEach((id) => allIds.add(id));

      if (ids.length > 0) cellsWithResults++;
      console.log(
        `→ ${ids.length} firms (+${newCount} new) | total unique: ${allIds.size}`
      );

      await sleep(REQUEST_PAUSE_MS);
    }

    const firmIds = [...allIds];
    console.log(
      `\n  Grid done: ${firmIds.length} unique firms from ${cellsWithResults}/${grid.length} cells.\n`
    );

    if (opts.idsOnly) {
      const result = {
        meta: {
          queryPath: `/${opts.city}/search/${encodeURIComponent(opts.query)}`,
          gridZoom: opts.zoom,
          gridCells: grid.length,
          cellsWithResults,
          total: firmIds.length,
          scrapedAt: new Date().toISOString(),
          idsOnly: true,
        },
        salons: firmIds.map((id) => ({
          id,
          name: "",
          telegram: "",
          vk: "",
          email: "",
          phones: [],
          other: "",
          url2gis: `https://2gis.ru/${opts.city}/firm/${id}`,
        })),
      };
      fs.writeFileSync(opts.out, JSON.stringify(result, null, 2), "utf-8");
      console.log(`✓ Saved ${firmIds.length} firm IDs to ${opts.out}`);
      return;
    }

    // ──── Step 2: visit each firm card ────
    console.log(`► Step 2: Scraping ${firmIds.length} firm cards...\n`);
    const salons = [];

    for (let i = 0; i < firmIds.length; i++) {
      const fid = firmIds[i];
      console.log(`  [${i + 1}/${firmIds.length}] firm ${fid}`);
      try {
        const card = await scrapeFirmCard(page, opts.city, fid);
        const bl = card._baseline2gis || {};
        console.log(
          `    → ${card.name || "(no name)"}  [2GIS: ${bl.rating2gis ?? "–"} (${bl.reviews2gis ?? "–"})]`
        );
        salons.push(card);
      } catch (e) {
        console.error(`    ✗ error: ${e.message}`);
        salons.push({
          id: fid,
          name: "",
          telegram: "",
          vk: "",
          email: "",
          phones: [],
          other: `error: ${e.message}`,
          url2gis: `https://2gis.ru/${opts.city}/firm/${fid}`,
          _baseline2gis: {},
        });
      }

      if ((i + 1) % 50 === 0) {
        console.log(`  ... saving progress (${i + 1}/${firmIds.length}) ...`);
        saveProgress(opts.out, { partial: true, progress: i + 1, total: firmIds.length }, salons);
      }

      await sleep(REQUEST_PAUSE_MS);
    }

    // ──── Step 3: finalize metrics ────
    console.log(`\n► Step 3: Finalizing metrics for ${salons.length} salons...\n`);

    for (let i = 0; i < salons.length; i++) {
      const s = salons[i];
      const bl = s._baseline2gis || {};
      delete s._baseline2gis;

      s.rating2gis = bl.rating2gis ?? null;
      s.reviews2gis = bl.reviews2gis ?? null;
      s.reviewsTab2gis = bl.reviewsTab2gis ?? null;
      s.urlYandex = "";
      s.ratingYandex = null;
      s.reviewsYandex = null;
      s.reviewsTabYandex = null;
      s.url2gisReviews = s.url2gis + "/tab/reviews";
      s.urlYandexReviews = "";
    }

    // ──── Step 4: save ────
    const result = {
      meta: {
        queryPath: `/${opts.city}/search/${encodeURIComponent(opts.query)}`,
        gridZoom: opts.zoom,
        gridCells: grid.length,
        cellsWithResults,
        total: salons.length,
        scrapedAt: new Date().toISOString(),
        enrichedRatings: true,
        enrichedAt: new Date().toISOString(),
        skipYandex: opts.skipYandex,
      },
      salons,
    };

    fs.writeFileSync(opts.out, JSON.stringify(result, null, 2), "utf-8");
    console.log(`\n✓ Saved ${salons.length} salons to ${opts.out}`);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
