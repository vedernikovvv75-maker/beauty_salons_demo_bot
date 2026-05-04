/**
 * Парсинг 2ГИС через перехват markers/clustered при навигации по карте.
 * Навигирует браузер к разным участкам карты → перехватывает API-ответы → собирает уникальные фирмы.
 *
 *   node scrape_catalog_api.cjs
 *   node scrape_catalog_api.cjs --query "барбершоп" --city novosibirsk
 */

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
require("dotenv").config({ path: path.join(__dirname, ".env") });

const HEADLESS = !["0", "false", "no"].includes(
  String(process.env.HEADLESS || "true").toLowerCase()
);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const CITY_BOUNDS = {
  novosibirsk: { latMin: 54.83, latMax: 55.19, lonMin: 82.70, lonMax: 83.20 },
  barnaul: { latMin: 53.30, latMax: 53.42, lonMin: 83.60, lonMax: 83.85 },
};

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    query: "салон красоты",
    city: "novosibirsk",
    out: path.join(__dirname, "..", "novosibirsk_salons.json"),
    zoom: 15,
    latStep: 0.018,
    lonStep: 0.036,
    pauseMs: 3500,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--query" && args[i + 1]) opts.query = args[++i];
    else if (args[i] === "--city" && args[i + 1]) opts.city = args[++i];
    else if (args[i] === "--out" && args[i + 1]) opts.out = path.resolve(args[++i]);
    else if (args[i] === "--zoom" && args[i + 1]) opts.zoom = parseFloat(args[++i]);
    else if (args[i] === "--lat-step" && args[i + 1]) opts.latStep = parseFloat(args[++i]);
    else if (args[i] === "--lon-step" && args[i + 1]) opts.lonStep = parseFloat(args[++i]);
    else if (args[i] === "--pause" && args[i + 1]) opts.pauseMs = parseInt(args[++i], 10);
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

function apiItemToSalon(item, city) {
  const id = String(item.id).split("_")[0];
  const name = (item.name || item.full_name || "")
    .replace(/,\s*салон красоты$/i, "")
    .replace(/,\s*парикмахерская$/i, "")
    .trim();

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
        if (type === "phone") {
          const norm = normPhone(value);
          if (norm && !phones.includes(norm)) phones.push(norm);
        } else if (type === "email") {
          email = email || value;
        } else if (type === "website") {
          const v = value.toLowerCase();
          if (/t\.me/i.test(v)) telegram = telegram || value;
          else if (/vk\.com/i.test(v)) vk = vk || value;
          else website = website || value;
        }
      }
    }
  }

  let address = "";
  if (item.address_name) address = item.address_name;
  else if (item.address) address = item.address.name || "";

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
    url2gis: `https://2gis.ru/${city}/firm/${id}`,
    rating2gis,
    reviews2gis,
    reviewsTab2gis: null,
    urlYandex: "",
    ratingYandex: null,
    reviewsYandex: null,
    reviewsTabYandex: null,
    url2gisReviews: `https://2gis.ru/${city}/firm/${id}/tab/reviews`,
    urlYandexReviews: "",
  };
}

async function main() {
  const opts = parseArgs();
  const bounds = CITY_BOUNDS[opts.city];
  if (!bounds) {
    console.error(`Unknown city. Known: ${Object.keys(CITY_BOUNDS).join(", ")}`);
    process.exit(1);
  }

  // Generate grid cells
  const cells = [];
  for (let lat = bounds.latMin; lat <= bounds.latMax; lat += opts.latStep) {
    for (let lon = bounds.lonMin; lon <= bounds.lonMax; lon += opts.lonStep) {
      cells.push({
        lat: Math.round((lat + opts.latStep / 2) * 1e6) / 1e6,
        lon: Math.round((lon + opts.lonStep / 2) * 1e6) / 1e6,
      });
    }
  }

  console.log("=== 2GIS Markers Intercept (Navigation) ===");
  console.log(`Query: "${opts.query}" | City: ${opts.city}`);
  console.log(`Grid: ${cells.length} cells (${opts.latStep}° × ${opts.lonStep}°, zoom ${opts.zoom})`);
  console.log(`Output: ${opts.out}\n`);

  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({
    locale: "ru-RU",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1400, height: 900 },
  });
  const page = await context.newPage();

  const allItems = new Map();

  page.on("response", async (response) => {
    const url = response.url();
    if (!url.includes("markers/clustered")) return;
    try {
      const json = await response.json();
      if (json.result && json.result.items) {
        for (const item of json.result.items) {
          const cleanId = String(item.id).split("_")[0];
          if (!allItems.has(cleanId)) {
            item._cleanId = cleanId;
            allItems.set(cleanId, item);
          }
        }
      }
    } catch {}
  });

  const enc = encodeURIComponent(opts.query);

  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    const mapParam = `m=${cell.lon}%2C${cell.lat}%2F${opts.zoom}`;
    const url = `https://2gis.ru/${opts.city}/search/${enc}?${mapParam}`;

    const prevSize = allItems.size;

    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(opts.pauseMs);
    } catch (e) {
      console.log(`  [${i + 1}/${cells.length}] timeout: ${e.message}`);
      continue;
    }

    const newCount = allItems.size - prevSize;
    if (newCount > 0 || (i + 1) % 10 === 0) {
      console.log(
        `  [${i + 1}/${cells.length}] (${cell.lat}, ${cell.lon}) +${newCount} new | total: ${allItems.size}`
      );
    }
  }

  console.log(`\n► Collected ${allItems.size} unique firms\n`);

  const salons = [...allItems.values()].map((item) => apiItemToSalon(item, opts.city));

  const result = {
    meta: {
      queryPath: `/${opts.city}/search/${encodeURIComponent(opts.query)}`,
      total: salons.length,
      scrapedAt: new Date().toISOString(),
      method: "markers_intercept_navigation",
      gridCells: cells.length,
      zoom: opts.zoom,
      skipYandex: true,
    },
    salons,
  };

  fs.writeFileSync(opts.out, JSON.stringify(result, null, 2), "utf-8");
  console.log(`✓ Saved ${salons.length} salons to ${opts.out}`);

  await browser.close();
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
