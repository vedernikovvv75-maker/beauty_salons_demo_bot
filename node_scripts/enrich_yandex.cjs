/**
 * Обогащение Яндекс-метриками только «горячих» салонов (reviews2gis < порог).
 * Ищет каждый салон по имени на Яндекс.Картах → парсит рейтинг, кол-во отзывов.
 * Сохраняет прогресс каждые N записей.
 *
 *   node enrich_yandex.cjs                                          # НСК, порог <50
 *   node enrich_yandex.cjs --file ../novosibirsk_salons.json --threshold 50
 *   node enrich_yandex.cjs --file ../file.json --start 100          # продолжить
 *   node enrich_yandex.cjs --all                                    # все салоны, не только горячие
 */

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
require("dotenv").config({ path: path.join(__dirname, ".env") });

const {
  extractYandexStats,
  openFirstYandexOrgFromSearch,
  sleep,
} = require("./salon_metrics.cjs");

const HEADLESS = !["0", "false", "no"].includes(
  String(process.env.HEADLESS || "true").toLowerCase()
);
const REQUEST_PAUSE_MS = Math.round(
  parseFloat(process.env.REQUEST_PAUSE_SEC || "1.5") * 1000
);

const CITY_YANDEX = {
  novosibirsk: {
    searchBase: "https://yandex.ru/maps/65/novosibirsk/search",
    mapParams:
      "ll=82.920430%2C55.030199&sll=82.920430%2C55.030199&sspn=0.300000%2C0.150000&z=12",
  },
  barnaul: {
    searchBase: "https://yandex.ru/maps/197/barnaul/search",
    mapParams:
      "ll=83.662857%2C53.369517&sll=83.662193%2C53.369855&sspn=0.060854%2C0.024075&z=13.96",
  },
};

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    file: path.join(__dirname, "..", "novosibirsk_salons.json"),
    city: "novosibirsk",
    threshold: 50,
    all: false,
    start: 0,
    saveEvery: 25,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--file" && args[i + 1]) opts.file = path.resolve(args[++i]);
    else if (args[i] === "--city" && args[i + 1]) opts.city = args[++i];
    else if (args[i] === "--threshold" && args[i + 1]) opts.threshold = parseInt(args[++i], 10);
    else if (args[i] === "--all") opts.all = true;
    else if (args[i] === "--start" && args[i + 1]) opts.start = parseInt(args[++i], 10);
    else if (args[i] === "--save-every" && args[i + 1]) opts.saveEvery = parseInt(args[++i], 10);
  }
  return opts;
}

function isHot(salon, threshold) {
  const r = salon.reviews2gis;
  return r === null || r === undefined || r < threshold;
}

async function enrichOneYandex(page, salon, yandexConfig) {
  const name = salon.name;
  if (!name || !name.trim()) return { error: "no_name" };

  const origSearchBase = process.env.YANDEX_SEARCH_BASE;
  const origMapParams = process.env.YANDEX_MAP_PARAMS;
  process.env.YANDEX_SEARCH_BASE = yandexConfig.searchBase;
  process.env.YANDEX_MAP_PARAMS = yandexConfig.mapParams;

  try {
    const searchUrl = `${yandexConfig.searchBase}/${encodeURIComponent(name.trim())}/?${yandexConfig.mapParams}`;
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForTimeout(1200);

    const html = await page.content();
    if (html.includes("SmartCaptcha") || html.includes("робот")) {
      return { captcha: true };
    }

    let orgUrl = null;
    try {
      await page.waitForSelector('a[href*="/org/"]', { timeout: 15000 });
      const first = page.locator('a[href*="/org/"]').first();
      const href = await first.getAttribute("href");
      if (href) {
        orgUrl = href.startsWith("/")
          ? "https://yandex.ru" + href.split("?")[0]
          : href.split("?")[0];
      }
    } catch {
      return { orgUrl: null, notFound: true };
    }

    if (!orgUrl) return { orgUrl: null, notFound: true };

    await page.goto(orgUrl, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForTimeout(1500);

    const captchaCheck = await page.content();
    if (captchaCheck.includes("SmartCaptcha") || captchaCheck.includes("робот")) {
      return { captcha: true };
    }

    const stats = await extractYandexStats(page);
    return {
      orgUrl,
      ratingYandex: stats.ratingYandex,
      reviewsYandex: stats.reviewsYandex,
      reviewsTabYandex: stats.reviewsTabYandex,
    };
  } finally {
    if (origSearchBase !== undefined) process.env.YANDEX_SEARCH_BASE = origSearchBase;
    else delete process.env.YANDEX_SEARCH_BASE;
    if (origMapParams !== undefined) process.env.YANDEX_MAP_PARAMS = origMapParams;
    else delete process.env.YANDEX_MAP_PARAMS;
  }
}

async function main() {
  const opts = parseArgs();
  const yandexConfig = CITY_YANDEX[opts.city];
  if (!yandexConfig) {
    console.error(`Unknown city: ${opts.city}. Known: ${Object.keys(CITY_YANDEX).join(", ")}`);
    process.exit(1);
  }

  console.log("=== Enrich Yandex (Hot Leads) ===");
  console.log(`File: ${opts.file}`);
  console.log(`City: ${opts.city}`);
  console.log(`Threshold: reviews2gis < ${opts.threshold}${opts.all ? " (ALL — threshold ignored)" : ""}`);
  console.log(`Start from: ${opts.start}`);
  console.log(`Save every: ${opts.saveEvery}\n`);

  const fileData = JSON.parse(fs.readFileSync(opts.file, "utf-8"));
  const salons = fileData.salons;

  const targets = [];
  for (let i = 0; i < salons.length; i++) {
    const s = salons[i];
    if (i < opts.start) continue;
    if (s.ratingYandex !== null && s.ratingYandex !== undefined) continue;
    if (!opts.all && !isHot(s, opts.threshold)) continue;
    targets.push({ index: i, salon: s });
  }

  console.log(`Total salons: ${salons.length}`);
  console.log(`Hot (reviews2gis < ${opts.threshold}): ${salons.filter(s => isHot(s, opts.threshold)).length}`);
  console.log(`Already have Yandex data: ${salons.filter(s => s.ratingYandex != null).length}`);
  console.log(`To enrich: ${targets.length}\n`);

  if (targets.length === 0) {
    console.log("Nothing to enrich.");
    return;
  }

  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({
    locale: "ru-RU",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1400, height: 900 },
  });
  const page = await context.newPage();

  let enriched = 0;
  let withYandex = 0;
  let captchaCount = 0;
  let notFoundCount = 0;

  try {
    for (let t = 0; t < targets.length; t++) {
      const { index, salon } = targets[t];
      console.log(
        `  [${t + 1}/${targets.length}] #${index} ${salon.name || salon.id} (2GIS: ${salon.reviews2gis ?? "–"})`
      );

      const result = await enrichOneYandex(page, salon, yandexConfig);

      if (result.captcha) {
        captchaCount++;
        console.log(`    ⚠ CAPTCHA — пауза 30 сек...`);
        await sleep(30000);

        const retry = await enrichOneYandex(page, salon, yandexConfig);
        if (retry.captcha) {
          console.log(`    ✗ Повторная CAPTCHA — пропуск. Если продолжается, прервите и запустите позже.`);
          if (captchaCount >= 5) {
            console.log(`\n  ✗ Слишком много капч (${captchaCount}) — останавливаюсь.`);
            break;
          }
          continue;
        }
        Object.assign(result, retry);
        captchaCount = 0;
      }

      if (result.notFound) {
        notFoundCount++;
        console.log(`    – не найден на Яндекс.Картах`);
      } else if (result.error) {
        console.log(`    – ${result.error}`);
      } else {
        salon.urlYandex = result.orgUrl || "";
        salon.ratingYandex = result.ratingYandex ?? null;
        salon.reviewsYandex = result.reviewsYandex ?? null;
        salon.reviewsTabYandex = result.reviewsTabYandex ?? null;
        if (result.orgUrl) {
          salon.urlYandexReviews = result.orgUrl.replace(/\/?$/, "/reviews/");
        }
        enriched++;
        if (result.ratingYandex != null) withYandex++;
        console.log(
          `    → Яндекс: ${result.ratingYandex ?? "–"} (${result.reviewsYandex ?? "–"} отз.)`
        );
      }

      if ((enriched + 1) % opts.saveEvery === 0 && enriched > 0) {
        fileData.meta.yandexEnrichedAt = new Date().toISOString();
        fs.writeFileSync(opts.file, JSON.stringify(fileData, null, 2), "utf-8");
        console.log(`  ... saved (${enriched} enriched, ${t + 1}/${targets.length}) ...`);
      }

      await sleep(REQUEST_PAUSE_MS);
    }
  } finally {
    await browser.close();
  }

  fileData.meta.yandexEnrichedAt = new Date().toISOString();
  fs.writeFileSync(opts.file, JSON.stringify(fileData, null, 2), "utf-8");

  const totalWithYandex = salons.filter(s => s.ratingYandex != null).length;
  console.log(`\n✓ Done.`);
  console.log(`  Enriched: ${enriched}`);
  console.log(`  With Yandex data: ${withYandex}`);
  console.log(`  Not found on Yandex: ${notFoundCount}`);
  console.log(`  Captcha blocks: ${captchaCount}`);
  console.log(`  Total with Yandex: ${totalWithYandex}/${salons.length}`);
  console.log(`  Saved to ${opts.file}`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
