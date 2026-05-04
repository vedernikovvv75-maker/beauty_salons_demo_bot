/**
 * Краулер поисковой выдачи 2ГИС + обогащение Яндекс-метриками.
 *
 * Использование:
 *   node scrape_search.cjs                        # параметры по умолчанию (барбершоп, Барнаул)
 *   node scrape_search.cjs --query "салон красоты" --city barnaul --out ../result.json
 *   node scrape_search.cjs --enrich-limit 0       # без обогащения (только список)
 *   node scrape_search.cjs --skip-yandex          # без Яндекс-метрик
 */

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
require("dotenv").config({ path: path.join(__dirname, ".env") });

const {
  extract2gisStats,
  enrichSalonMetricsOnPage,
  openFirstYandexOrgFromSearch,
  sleep,
} = require("./salon_metrics.cjs");

const HEADLESS = !["0", "false", "no"].includes(
  String(process.env.HEADLESS || "true").toLowerCase()
);
const REQUEST_PAUSE_MS = Math.round(
  parseFloat(process.env.REQUEST_PAUSE_SEC || "1.5") * 1000
);

// ─── CLI args ───────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    query: "барбершоп",
    city: "barnaul",
    mapParams: "m=83.779215%2C53.349179%2F10.72",
    out: path.join(__dirname, "..", "barnaul_barbershops.json"),
    enrichLimit: Infinity,
    skipYandex: false,
    maxPages: 50,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--query" && args[i + 1]) opts.query = args[++i];
    else if (args[i] === "--city" && args[i + 1]) opts.city = args[++i];
    else if (args[i] === "--map" && args[i + 1]) opts.mapParams = args[++i];
    else if (args[i] === "--out" && args[i + 1])
      opts.out = path.resolve(args[++i]);
    else if (args[i] === "--enrich-limit" && args[i + 1])
      opts.enrichLimit = parseInt(args[++i], 10) || 0;
    else if (args[i] === "--skip-yandex") opts.skipYandex = true;
    else if (args[i] === "--max-pages" && args[i + 1])
      opts.maxPages = parseInt(args[++i], 10) || 50;
  }
  return opts;
}

// ─── 2GIS search pagination ────────────────────────────────────────────────

function buildSearchUrl(city, query, mapParams, page) {
  const enc = encodeURIComponent(query);
  const base = `https://2gis.ru/${city}/search/${enc}`;
  const qs = mapParams ? `?${mapParams}` : "";
  return page > 1 ? `${base}/page/${page}${qs}` : `${base}${qs}`;
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

async function scrapeSearchPages(page, city, query, mapParams, maxPages) {
  const allIds = [];
  const seen = new Set();
  let pagesVisited = 0;

  for (let p = 1; p <= maxPages; p++) {
    const url = buildSearchUrl(city, query, mapParams, p);
    console.log(`  [page ${p}] ${url}`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForTimeout(2000);

    const ids = await collectFirmIdsFromPage(page);
    const newIds = ids.filter((id) => !seen.has(id));
    if (newIds.length === 0) {
      console.log(`  [page ${p}] 0 new firms — end of pagination`);
      break;
    }
    newIds.forEach((id) => seen.add(id));
    allIds.push(...newIds);
    pagesVisited = p;
    console.log(
      `  [page ${p}] +${newIds.length} firms (total ${allIds.length})`
    );
    await sleep(REQUEST_PAUSE_MS);
  }
  return { firmIds: allIds, pagesVisited };
}

// ─── 2GIS firm card: contacts ──────────────────────────────────────────────

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

  // Extract baseline 2GIS metrics while we're already on the firm page
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

// ─── main ───────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();
  console.log("=== 2GIS Search Scraper ===");
  console.log(`Query: "${opts.query}" | City: ${opts.city}`);
  console.log(`Output: ${opts.out}`);
  console.log(`Enrich limit: ${opts.enrichLimit === Infinity ? "all" : opts.enrichLimit}`);
  console.log(`Skip Yandex: ${opts.skipYandex}`);
  console.log();

  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({
    locale: "ru-RU",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1400, height: 900 },
  });
  const page = await context.newPage();

  try {
    // Step 1: collect firm IDs from search
    console.log("► Step 1: Collecting firm IDs from search pages...");
    const { firmIds, pagesVisited } = await scrapeSearchPages(
      page,
      opts.city,
      opts.query,
      opts.mapParams,
      opts.maxPages
    );
    console.log(`\n  Found ${firmIds.length} firms across ${pagesVisited} pages.\n`);

    // Step 2: visit each firm card
    console.log("► Step 2: Scraping firm cards (contacts)...");
    const salons = [];
    for (let i = 0; i < firmIds.length; i++) {
      const fid = firmIds[i];
      console.log(`  [${i + 1}/${firmIds.length}] firm ${fid}`);
      try {
        const card = await scrapeFirmCard(page, opts.city, fid);
        const bl = card._baseline2gis || {};
        const blInfo = `${bl.rating2gis ?? "–"} (${bl.reviews2gis ?? "–"})`;
        console.log(`    → ${card.name || "(no name)"}  [2GIS baseline: ${blInfo}]`);
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
      await sleep(REQUEST_PAUSE_MS);
    }

    // Step 3: enrich with 2GIS + Yandex metrics
    const enrichCount = Math.min(salons.length, opts.enrichLimit);
    console.log(
      `\n► Step 3: Enriching ${enrichCount}/${salons.length} salons with metrics...\n`
    );

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

      if (i >= enrichCount) continue;

      const has2gis = s.rating2gis != null && s.reviews2gis != null;
      const needsYandex = !opts.skipYandex;
      const skip2gisRefetch = has2gis;

      console.log(
        `  [${i + 1}/${enrichCount}] ${s.name || s.id}` +
          (skip2gisRefetch ? " — 2GIS from baseline, fetching Yandex..." : " — enriching...")
      );
      try {
        const metrics = await enrichSalonMetricsOnPage(page, {
          url2gis: skip2gisRefetch ? null : s.url2gis,
          urlYandex: null,
          name: needsYandex ? (s.name || null) : null,
          skipYandex: opts.skipYandex,
        });

        if (!skip2gisRefetch) {
          s.rating2gis = metrics.rating2gis ?? s.rating2gis;
          s.reviews2gis = metrics.reviews2gis ?? s.reviews2gis;
          s.reviewsTab2gis = metrics.reviewsTab2gis ?? s.reviewsTab2gis;
        }
        s.ratingYandex = metrics.ratingYandex;
        s.reviewsYandex = metrics.reviewsYandex;
        s.reviewsTabYandex = metrics.reviewsTabYandex;

        if (metrics.urlYandexResolved) {
          s.urlYandex = metrics.urlYandexResolved;
          s.urlYandexReviews = metrics.urlYandexResolved.replace(/\/?$/, "/reviews/");
        }

        if (metrics.yandexCaptcha) {
          console.log(`    ⚠ Yandex captcha — skipping Yandex for remaining`);
        }

        console.log(
          `    2GIS: ${s.rating2gis ?? "–"} (${s.reviews2gis ?? "–"}) | ` +
            `Yandex: ${s.ratingYandex ?? "–"} (${s.reviewsYandex ?? "–"})`
        );
      } catch (e) {
        console.error(`    ✗ enrich error: ${e.message}`);
      }
      await sleep(REQUEST_PAUSE_MS);
    }

    // Step 4: save
    const result = {
      meta: {
        queryPath: `/${opts.city}/search/${encodeURIComponent(opts.query)}`,
        mapQuery: opts.mapParams,
        paginationMode: true,
        maxSearchPage: opts.maxPages,
        searchPagesVisited: pagesVisited,
        total: salons.length,
        scrapedAt: new Date().toISOString(),
        enrichedRatings: enrichCount > 0,
        enrichedAt: enrichCount > 0 ? new Date().toISOString() : null,
        enrichLimit: opts.enrichLimit === Infinity ? null : opts.enrichLimit,
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
