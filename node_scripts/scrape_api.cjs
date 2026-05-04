/**
 * Перехват API 2ГИС — определяем эндпоинт и ключ, затем парсим напрямую.
 *
 *   node scrape_api.cjs --query "салон красоты" --city novosibirsk
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
    query: "салон красоты",
    city: "novosibirsk",
    mapParams: "m=82.942926%2C55.014682%2F10.72",
    out: path.join(__dirname, "..", "novosibirsk_salons.json"),
    skipYandex: true,
    maxItems: 10000,
    pageSize: 50,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--query" && args[i + 1]) opts.query = args[++i];
    else if (args[i] === "--city" && args[i + 1]) opts.city = args[++i];
    else if (args[i] === "--map" && args[i + 1]) opts.mapParams = args[++i];
    else if (args[i] === "--out" && args[i + 1]) opts.out = path.resolve(args[++i]);
    else if (args[i] === "--max-items" && args[i + 1]) opts.maxItems = parseInt(args[++i], 10);
    else if (args[i] === "--skip-yandex") opts.skipYandex = true;
  }
  return opts;
}

async function main() {
  const opts = parseArgs();
  console.log("=== 2GIS API Interceptor ===");
  console.log(`Query: "${opts.query}" | City: ${opts.city}`);
  console.log(`Output: ${opts.out}\n`);

  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({
    locale: "ru-RU",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1400, height: 900 },
  });
  const page = await context.newPage();

  const capturedApis = {};
  const capturedItems = [];
  const seenIds = new Set();
  let itemsApiUrl = null;
  let itemsApiKey = null;
  let regionId = null;
  let apiTotal = null;

  page.on("response", async (response) => {
    const url = response.url();
    if (!url.includes("catalog.api.2gis") && !url.includes("api.2gis")) return;
    try {
      const json = await response.json();
      const u = new URL(url);
      const endpoint = u.pathname;
      const key = u.searchParams.get("key");
      const rid = u.searchParams.get("region_id");

      capturedApis[endpoint] = {
        url: url.substring(0, 200),
        key,
        regionId: rid,
        hasItems: !!(json.result && json.result.items),
        itemCount: json.result?.items?.length || 0,
        total: json.result?.total || null,
      };

      if (json.result && json.result.items && !endpoint.includes("marker") && !endpoint.includes("cluster")) {
        if (!itemsApiUrl) {
          itemsApiUrl = `${u.origin}${u.pathname}`;
          itemsApiKey = key;
          regionId = rid;
          apiTotal = json.result.total || null;
          console.log(`  ✓ Items API: ${itemsApiUrl}`);
          console.log(`    Key: ${itemsApiKey}`);
          console.log(`    Region: ${regionId}`);
          console.log(`    Total: ${apiTotal}`);
        }
        for (const item of json.result.items) {
          const cleanId = String(item.id).split("_")[0];
          if (cleanId && !seenIds.has(cleanId)) {
            seenIds.add(cleanId);
            item._cleanId = cleanId;
            capturedItems.push(item);
          }
        }
        console.log(`  Intercepted ${endpoint}: ${json.result.items.length} items (unique: ${capturedItems.length})`);
      }
    } catch {}
  });

  // Load search page to intercept API calls
  const searchUrl = `https://2gis.ru/${opts.city}/search/${encodeURIComponent(opts.query)}?${opts.mapParams}`;
  console.log(`► Loading: ${searchUrl}\n`);
  await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(5000);

  console.log(`\n  After initial load: ${capturedItems.length} items captured`);
  console.log("  All captured endpoints:", JSON.stringify(capturedApis, null, 2));

  // Try navigating to page 2 via URL to trigger more API calls
  for (let p = 2; p <= 5; p++) {
    const pageUrl = `https://2gis.ru/${opts.city}/search/${encodeURIComponent(opts.query)}/page/${p}?${opts.mapParams}`;
    console.log(`\n  → page ${p}: ${pageUrl}`);
    await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForTimeout(3000);
    console.log(`    captured so far: ${capturedItems.length}`);
  }

  console.log("\n  All endpoints after pagination:", Object.keys(capturedApis));

  // Direct API pagination using captured key
  if (itemsApiUrl && itemsApiKey) {
    console.log(`\n► Direct API pagination: ${itemsApiUrl}`);
    console.log(`  Key: ${itemsApiKey} | Region: ${regionId} | Total: ${apiTotal}\n`);

    const maxPages = Math.min(Math.ceil((apiTotal || opts.maxItems) / 12), 500);

    for (let p = 2; p <= maxPages; p++) {
      const apiUrl = `${itemsApiUrl}?q=${encodeURIComponent(opts.query)}&key=${itemsApiKey}&page=${p}&page_size=12&locale=ru_RU&type=branch&fields=items.point,items.name,items.full_name,items.address,items.org,items.contact_groups,items.external_content,items.reviews,items.schedule,items.rubrics${regionId ? `&region_id=${regionId}` : ""}`;

      try {
        const resp = await page.evaluate(async (url) => {
          const r = await fetch(url);
          return r.json();
        }, apiUrl);

        if (!resp.result || !resp.result.items || resp.result.items.length === 0) {
          console.log(`  page ${p}: empty — done`);
          break;
        }

        let newCount = 0;
        for (const item of resp.result.items) {
          const cleanId = String(item.id).split("_")[0];
          if (cleanId && !seenIds.has(cleanId)) {
            seenIds.add(cleanId);
            item._cleanId = cleanId;
            capturedItems.push(item);
            newCount++;
          }
        }

        if (p % 20 === 0 || p <= 5) {
          console.log(
            `  page ${p}: ${resp.result.items.length} items (+${newCount} new) | total: ${capturedItems.length}`
          );
        }

        if (newCount === 0) {
          console.log(`  page ${p}: no new items — done`);
          break;
        }

        await sleep(300);
      } catch (e) {
        console.error(`  page ${p} error: ${e.message}`);
        break;
      }
    }
  } else {
    console.log("\n⚠ Could not find items API endpoint. Only have clustered markers.");
  }

  console.log(`\n► Total captured: ${capturedItems.length} items\n`);

  // Convert API items to our salon format
  console.log("► Converting to salon format...\n");
  const salons = capturedItems.map((item) => {
    const id = item._cleanId || String(item.id).split("_")[0];
    const name = item.name || item.full_name || "";

    let telegram = "";
    let vk = "";
    let email = "";
    let website = "";
    const phones = [];

    if (item.contact_groups) {
      for (const group of item.contact_groups) {
        for (const contact of group.contacts || []) {
          const type = contact.type;
          const value = contact.value || contact.text || "";
          if (type === "phone") phones.push(value);
          else if (type === "email") email = email || value;
          else if (type === "website") {
            if (/t\.me/i.test(value)) telegram = telegram || value;
            else if (/vk\.com/i.test(value)) vk = vk || value;
            else website = website || value;
          }
        }
      }
    }

    let address = "";
    if (item.address) {
      address = item.address.name || item.address.components?.map(c => c.name).join(", ") || "";
    }

    let branches = "";
    if (item.org && item.org.branch_count > 1) branches = String(item.org.branch_count);

    let rating2gis = null;
    let reviews2gis = null;
    if (item.reviews) {
      rating2gis = item.reviews.general_rating ?? null;
      reviews2gis = item.reviews.general_review_count ?? null;
    }

    const other = [
      branches ? `филиалов: ${branches}` : "",
      address ? `адрес: ${address}` : "",
      website ? `сайт: ${website}` : "",
    ]
      .filter(Boolean)
      .join(" | ");

    return {
      id,
      name,
      telegram,
      vk,
      email,
      phones,
      other,
      url2gis: `https://2gis.ru/${opts.city}/firm/${id}`,
      rating2gis,
      reviews2gis,
      reviewsTab2gis: null,
      urlYandex: "",
      ratingYandex: null,
      reviewsYandex: null,
      reviewsTabYandex: null,
      url2gisReviews: `https://2gis.ru/${opts.city}/firm/${id}/tab/reviews`,
      urlYandexReviews: "",
    };
  });

  const result = {
    meta: {
      queryPath: `/${opts.city}/search/${encodeURIComponent(opts.query)}`,
      mapQuery: opts.mapParams,
      total: salons.length,
      scrapedAt: new Date().toISOString(),
      method: "api_intercept",
      skipYandex: opts.skipYandex,
    },
    salons,
  };

  fs.writeFileSync(opts.out, JSON.stringify(result, null, 2), "utf-8");
  console.log(`\n✓ Saved ${salons.length} salons to ${opts.out}`);

  await browser.close();
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
