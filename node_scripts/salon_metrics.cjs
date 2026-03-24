/**
 * Свежие метрики одного салона (2ГИС + Яндекс.Карты).
 * Правила полей — PARSING_PROMPT.md.
 *
 *   const { fetchSalonMetricsFresh } = require("./salon_metrics.cjs");
 *   const m = await fetchSalonMetricsFresh({ url2gis, urlYandex, name });
 */

const path = require("path");
const { chromium } = require("playwright");

require("dotenv").config({ path: path.join(__dirname, ".env") });

const HEADLESS = !["0", "false", "no"].includes(
  String(process.env.HEADLESS || "true").toLowerCase()
);

const YANDEX_SEARCH_BASE =
  process.env.YANDEX_SEARCH_BASE ||
  "https://yandex.ru/maps/197/barnaul/search";

const YANDEX_MAP_PARAMS =
  process.env.YANDEX_MAP_PARAMS ||
  "ll=83.662857%2C53.369517&sll=83.662193%2C53.369855&sspn=0.060854%2C0.024075&z=13.96";

const REQUEST_PAUSE_MS = Math.round(
  parseFloat(process.env.REQUEST_PAUSE_SEC || "1.2") * 1000
);

const GIS_SEL_RATING = "._y10azs";
const GIS_SEL_MARKS = "._jspzdm";
const GIS_SEL_TAB_REVIEWS = "._98ekgh";

const YANDEX_SEL_RATING =
  ".business-rating-badge-view._weight_medium .business-rating-badge-view__rating";
const YANDEX_SEL_RATING_FB = ".business-rating-badge-view__rating";
const YANDEX_SEL_HEADER_COUNT =
  ".business-header-rating-view__text:not(:first-child)";
const YANDEX_SEL_TAB_TITLE = ".tabs-select-view__title";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseFloatRu(s) {
  if (s == null || s === "") return null;
  const t = String(s).replace(/\s/g, "").replace(",", ".");
  const n = parseFloat(t.match(/[\d.]+/)?.[0] || "");
  return Number.isFinite(n) ? n : null;
}

function parseIntRu(s) {
  if (s == null || s === "") return null;
  const n = parseInt(String(s).replace(/\D/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

function parse2gisFromHtml(html) {
  let rating = null;
  let reviews = null;
  const cardLine = html.match(
    /(\d+[.,]\d)\s+(\d{1,6})\s+(?:оценок|оценки|оценка)/i
  );
  if (cardLine) {
    return {
      rating: parseFloat(cardLine[1].replace(",", ".")),
      reviews: parseInt(cardLine[2], 10),
    };
  }
  const r1 = html.match(
    /"rating"\s*:\s*\{\s*"value"\s*:\s*([\d.]+)\s*,\s*"count"\s*:\s*(\d+)/
  );
  if (r1) {
    rating = parseFloat(r1[1]);
    reviews = parseInt(r1[2], 10);
    return { rating, reviews };
  }
  const r2 = html.match(
    /"ratingValue"\s*:\s*([\d.]+)[\s\S]{0,200}?"(?:ratingCount|reviewCount)"\s*:\s*(\d+)/
  );
  if (r2) {
    rating = parseFloat(r2[1]);
    reviews = parseInt(r2[2], 10);
    return { rating, reviews };
  }
  const r3 = html.match(
    /"(?:generalRating|orgRating|ratingScore)"\s*:\s*\{[^}]*"value"\s*:\s*([\d.]+)[^}]*"count"\s*:\s*(\d+)/s
  );
  if (r3) {
    rating = parseFloat(r3[1]);
    reviews = parseInt(r3[2], 10);
    return { rating, reviews };
  }
  const rv = html.match(/"ratingValue"\s*:\s*([\d.]+)/);
  const rc = html.match(
    /"(?:ratingCount|reviewsCount|reviewCount)"\s*:\s*(\d+)/
  );
  if (rv) rating = parseFloat(rv[1]);
  if (rc) reviews = parseInt(rc[1], 10);
  return { rating, reviews };
}

async function extract2gisStats(page) {
  await page.waitForTimeout(800);

  // Wait for SPA to render rating-related text (longer timeout for slow pages)
  for (const pattern of [/оценок|оценки|оценка/i, /отзыв/i]) {
    try {
      await page.waitForFunction(
        (re) => document.body && new RegExp(re).test(document.body.innerText),
        pattern.source,
        { timeout: 20000 }
      );
      break;
    } catch {
      /* try next pattern or give up */
    }
  }
  await page.waitForTimeout(800);

  // Strategy 1: known CSS selectors (may break when 2GIS redeploys)
  const gisUi = await page.evaluate(
    ([selR, selM, selT]) => {
      const pick = (sel) => {
        const el = document.querySelector(sel);
        return el ? (el.textContent || "").trim() : "";
      };
      const ratingText = pick(selR);
      const marksText = pick(selM);
      const tabText = pick(selT);
      let rating = null;
      let marks = null;
      let tabReviews = null;
      if (ratingText) {
        const m = ratingText.match(/(\d+[.,]\d)/);
        if (m) rating = m[1].replace(",", ".");
      }
      if (marksText) {
        const m =
          marksText.match(/(\d{1,7})\s*(?:оценок|оценки|оценка)/i) ||
          marksText.match(/^(\d{1,7})\b/);
        if (m) marks = m[1];
      }
      if (tabText) {
        const m = tabText.match(/(\d{1,7})/);
        if (m) tabReviews = m[1];
      }
      return { rating, marks, tabReviews };
    },
    [GIS_SEL_RATING, GIS_SEL_MARKS, GIS_SEL_TAB_REVIEWS]
  );

  let rating = parseFloatRu(gisUi.rating);
  let reviews = parseIntRu(gisUi.marks);
  let reviewsTab2gis = parseIntRu(gisUi.tabReviews);

  // Strategy 2: DOM proximity — find element with "оценок" and walk up to find rating
  if (rating == null || reviews == null) {
    const proximity = await page.evaluate(() => {
      let rating = null;
      let reviews = null;

      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
        null
      );
      while (walker.nextNode()) {
        const t = walker.currentNode.textContent.trim();
        if (/\d+\s*(?:оценок|оценки|оценка)/i.test(t)) {
          const rm = t.match(/(\d[\d\s]*)\s*(?:оценок|оценки|оценка)/i);
          if (rm && !reviews) reviews = rm[1].replace(/\s/g, "");

          let container = walker.currentNode.parentElement;
          for (let depth = 0; depth < 6 && container; depth++) {
            const ct = container.textContent || "";
            const ratingMatch = ct.match(
              /(\d[.,]\d)\s*[\s·•\-]?\s*\d{1,6}\s*(?:оценок|оценки|оценка)/i
            );
            if (ratingMatch) {
              rating = ratingMatch[1].replace(",", ".");
              break;
            }
            container = container.parentElement;
          }
          if (rating) break;
        }
      }

      if (!rating) {
        const body = document.body.innerText;
        const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);
        for (let i = 0; i < lines.length; i++) {
          if (/\d+\s*(?:оценок|оценки|оценка)/i.test(lines[i])) {
            const rm = lines[i].match(/(\d[\d\s]*)\s*(?:оценок|оценки|оценка)/i);
            if (rm && !reviews) reviews = rm[1].replace(/\s/g, "");

            const rInLine = lines[i].match(/(\d[.,]\d)/);
            if (rInLine) {
              rating = rInLine[1].replace(",", ".");
              break;
            }
            if (i > 0) {
              const prev = lines[i - 1].match(/^(\d[.,]\d)$/);
              if (prev) {
                rating = prev[1].replace(",", ".");
                break;
              }
            }
          }
        }
      }

      return { rating, reviews };
    });
    if (rating == null && proximity.rating) rating = parseFloat(proximity.rating);
    if (reviews == null && proximity.reviews) reviews = parseInt(proximity.reviews, 10);
  }

  // Strategy 3: classic one-line pattern with flexible separators
  const cardFromDom = await page.evaluate(() => {
    const body = document.body ? document.body.innerText : "";
    const patterns = [
      /(\d+[.,]\d)\s+(\d{1,6})\s+(?:оценок|оценки|оценка)/i,
      /(\d+[.,]\d)\s*[·•\-|]\s*(\d{1,6})\s*(?:оценок|оценки|оценка)/i,
      /(\d+[.,]\d)\n(\d{1,6})\s*(?:оценок|оценки|оценка)/i,
    ];
    for (const re of patterns) {
      const m = body.match(re);
      if (m) {
        return { rating: m[1].replace(",", "."), reviews: m[2] };
      }
    }
    for (const line of body.split("\n")) {
      const t = line.trim();
      for (const re of patterns) {
        const m = t.match(re);
        if (m) return { rating: m[1].replace(",", "."), reviews: m[2] };
      }
    }
    return null;
  });
  if (rating == null && cardFromDom) rating = parseFloat(cardFromDom.rating);
  if (reviews == null && cardFromDom) reviews = parseInt(cardFromDom.reviews, 10);

  // Strategy 4: parse raw HTML (structured data, JSON-LD, inline JSON)
  const html = await page.content();
  const parsed = parse2gisFromHtml(html);
  if (rating == null && parsed.rating != null) rating = parsed.rating;
  if (reviews == null && parsed.reviews != null) reviews = parsed.reviews;

  // Strategy 5: embedded JSON in <script> tags
  if (rating == null || reviews == null) {
    const scriptData = await page.evaluate(() => {
      let rating = null;
      let reviews = null;
      for (const sc of document.querySelectorAll(
        'script[type="application/ld+json"], script:not([src])'
      )) {
        const t = sc.textContent || "";
        if (!rating) {
          const m =
            t.match(/"ratingValue"\s*:\s*"?([\d.]+)"?/) ||
            t.match(/"value"\s*:\s*([\d.]+)\s*,\s*"count"/) ||
            t.match(/"rating"\s*:\s*([\d.]+)/);
          if (m) rating = m[1];
        }
        if (!reviews) {
          const m =
            t.match(/"ratingCount"\s*:\s*"?(\d+)"?/) ||
            t.match(/"reviewCount"\s*:\s*"?(\d+)"?/) ||
            t.match(/"count"\s*:\s*(\d+)/);
          if (m) reviews = m[1];
        }
      }
      return { rating, reviews };
    });
    if (rating == null && scriptData.rating) rating = parseFloat(scriptData.rating);
    if (reviews == null && scriptData.reviews) reviews = parseInt(scriptData.reviews, 10);
  }

  // Strategy 6: itemprop / microdata
  const ev = await page.evaluate(() => {
    function pickRating() {
      const rv = document.querySelector('[itemprop="ratingValue"]');
      if (rv) {
        const c = rv.getAttribute("content") || rv.textContent;
        return c ? String(c).trim() : null;
      }
      return null;
    }
    function pickReviews() {
      const rc = document.querySelector(
        '[itemprop="ratingCount"], [itemprop="reviewCount"]'
      );
      if (rc) {
        const c = rc.getAttribute("content") || rc.textContent;
        return c ? String(c).trim() : null;
      }
      return null;
    }
    let r = pickRating();
    let rev = pickReviews();
    const body = document.body ? document.body.innerText : "";
    if (!rev) {
      const lines = body.split("\n");
      for (const line of lines) {
        const m = line.match(/^(\d{1,5})\s*(оценк|отзыв)/iu);
        if (m) { rev = m[1]; break; }
      }
    }
    if (!r) {
      const m = body.match(/(\d+[.,]\d)\s*(?:из\s*5|★)/u);
      if (m) r = m[1];
    }
    return { rating: r, reviews: rev };
  });
  if (rating == null) rating = parseFloatRu(ev.rating);
  if (reviews == null) reviews = parseIntRu(ev.reviews);

  // Strategy 7: broad DOM class-name search for rating elements
  if (rating == null) {
    const domR = await page.evaluate(() => {
      const body = document.body ? document.body.innerText : "";
      const m1 = body.match(/(\d+[.,]\d)\s*(?:из\s*5|\/\s*5)/);
      if (m1) return m1[1].replace(",", ".");
      const m2 = body.match(/★\s*(\d+[.,]\d)|(\d+[.,]\d)\s*★/);
      if (m2) return (m2[1] || m2[2]).replace(",", ".");

      const selectors = [
        "[class*='rating'] span",
        "[class*='Rating'] span",
        "[class*='_rating']",
        "[class*='score']",
        "[class*='stars']",
        "[data-rating]",
      ];
      for (const sel of selectors) {
        for (const el of document.querySelectorAll(sel)) {
          const t = (el.textContent || "").trim();
          const m = t.match(/^(\d[.,]\d)$/);
          if (m) return m[1].replace(",", ".");
          const attr = el.getAttribute("data-rating") || el.getAttribute("content");
          if (attr) {
            const am = String(attr).match(/^(\d[.,]\d)$/);
            if (am) return am[1].replace(",", ".");
          }
        }
      }
      return null;
    });
    if (domR) rating = parseFloat(domR);
  }

  // Strategy 8: aria-label attributes
  if (rating == null || reviews == null) {
    const aria = await page.evaluate(() => {
      const nodes = document.querySelectorAll(
        "[aria-label*='оценк'],[aria-label*='Оценк'],[aria-label*='рейтинг'],[aria-label*='из 5'],[aria-label*='rating']"
      );
      let rating = null;
      let reviews = null;
      for (const el of nodes) {
        const a = el.getAttribute("aria-label") || "";
        if (!reviews) {
          const rm = a.match(/(\d{1,5})\s*оценк/i);
          if (rm) reviews = rm[1];
        }
        if (!rating) {
          const rv = a.match(/(\d+[.,]\d)\s*из\s*5/i) || a.match(/(\d+[.,]\d)/);
          if (rv) rating = rv[1].replace(",", ".");
        }
      }
      return { rating, reviews };
    });
    if (rating == null && aria.rating) rating = parseFloat(aria.rating);
    if (reviews == null && aria.reviews) reviews = parseInt(aria.reviews, 10);
  }

  // Strategy 9: tab reviews — broader selector fallback
  if (reviewsTab2gis == null) {
    reviewsTab2gis = await page.evaluate(() => {
      for (const el of document.querySelectorAll(
        "a[href*='tab/reviews'], [class*='tab'] span, [role='tab']"
      )) {
        const t = (el.textContent || "").trim();
        if (/отзыв/i.test(t)) {
          const m = t.match(/(\d{1,7})/);
          if (m) return parseInt(m[1], 10);
        }
      }
      const body = document.body ? document.body.innerText : "";
      const m = body.match(/Отзывы\s+(\d{1,7})/i);
      if (m) return parseInt(m[1], 10);
      return null;
    });
  }

  // Sanity bounds
  if (reviews != null && (reviews < 0 || reviews > 50000)) reviews = null;
  if (reviewsTab2gis != null && (reviewsTab2gis < 0 || reviewsTab2gis > 50000))
    reviewsTab2gis = null;
  if (rating != null && (rating < 1 || rating > 5.01)) rating = null;

  return {
    rating2gis: rating,
    reviews2gis: reviews,
    reviewsTab2gis,
  };
}

async function extractYandexStats(page) {
  await page.waitForTimeout(500);

  const yandexUi = await page.evaluate(
    ([selR, selFb, selH, selTab]) => {
      const ratingEl =
        document.querySelector(selR) || document.querySelector(selFb);
      let rating = null;
      if (ratingEl) {
        const t = (ratingEl.textContent || "").trim();
        const m = t.match(/(\d+[.,]\d)/);
        if (m) rating = m[1].replace(",", ".");
      }

      let reviewsHeader = null;
      const headerEl = document.querySelector(selH);
      if (headerEl) {
        const t = (headerEl.textContent || "").trim();
        const m =
          t.match(/(\d{1,7})\s*(?:оценок|оценки|оценка|отзывов|отзыва)/i) ||
          t.match(/^(\d{1,7})\b/);
        if (m) reviewsHeader = m[1];
      }

      let reviewsTab = null;
      for (const el of document.querySelectorAll(selTab)) {
        const t = (el.textContent || "").trim();
        if (/отзыв|оценк/i.test(t)) {
          const m = t.match(/(\d{1,7})/);
          if (m) {
            reviewsTab = m[1];
            break;
          }
        }
      }
      return { rating, reviewsHeader, reviewsTab };
    },
    [
      YANDEX_SEL_RATING,
      YANDEX_SEL_RATING_FB,
      YANDEX_SEL_HEADER_COUNT,
      YANDEX_SEL_TAB_TITLE,
    ]
  );

  let rating = parseFloatRu(yandexUi.rating);
  let reviews =
    parseIntRu(yandexUi.reviewsHeader) ?? parseIntRu(yandexUi.reviewsTab);
  let reviewsTabYandex = parseIntRu(yandexUi.reviewsTab);

  const html = await page.content();
  const yandexCardLine = html.match(
    /(\d+[.,]\d)\s+(\d{1,6})\s+(?:оценок|оценки|оценка|отзывов|отзыва)/i
  );
  const fromJson =
    html.match(/"ratingValue"\s*:\s*([\d.]+)/) ||
    html.match(/ratingValue["']?\s*:\s*([\d.]+)/);
  const cntJson =
    html.match(/"(?:ratingCount|reviewsCount|userRatingCount)"\s*:\s*(\d+)/) ||
    html.match(/reviewsCount["']?\s*:\s*(\d+)/i);

  const ev = await page.evaluate(() => {
    let rating = null;
    let reviews = null;
    const rv = document.querySelector('[itemprop="ratingValue"]');
    if (rv) {
      const c = rv.getAttribute("content") || rv.textContent;
      if (c) rating = String(c).trim();
    }
    const badge = document.querySelector(
      ".business-rating-badge-view__rating, [class*='business-rating-view__rating']"
    );
    if (!rating && badge) rating = badge.textContent.trim();

    const rc = document.querySelector(
      '[itemprop="ratingCount"], [itemprop="reviewCount"]'
    );
    if (rc) {
      const c = rc.getAttribute("content") || rc.textContent;
      if (c) reviews = String(c).trim();
    }
    const body = document.body ? document.body.innerText : "";
    if (!reviews) {
      const lineCard = body.match(
        /(\d+[.,]\d)\s+(\d{1,6})\s+(?:оценок|оценки|оценка|отзывов|отзыва)/i
      );
      if (lineCard) reviews = lineCard[2];
    }
    if (!reviews) {
      const m =
        body.match(/(\d[\d\s]*)\s*(оценк|отзыв)/iu) ||
        body.match(/(\d+)\s+оценк/iu) ||
        body.match(/(\d+)\s+отзыв/iu);
      if (m) reviews = m[1].replace(/\s/g, "");
    }
    if (!rating) {
      const m = body.match(/(\d+[.,]\d)/);
      if (m) rating = m[1];
    }
    return { rating, reviews };
  });

  if (rating == null) rating = parseFloatRu(ev.rating);
  if (reviews == null) reviews = parseIntRu(ev.reviews);
  if (rating == null && fromJson) rating = parseFloat(fromJson[1]);
  if (reviews == null && cntJson) reviews = parseInt(cntJson[1], 10);

  if (yandexCardLine) {
    const r = parseFloat(String(yandexCardLine[1]).replace(",", "."));
    const c = parseInt(yandexCardLine[2], 10);
    if (rating == null && Number.isFinite(r)) rating = r;
    if (reviews == null && Number.isFinite(c)) reviews = c;
  }

  if (reviews != null && (reviews < 0 || reviews > 500000)) {
    reviews = null;
  }
  if (
    reviewsTabYandex != null &&
    (reviewsTabYandex < 0 || reviewsTabYandex > 500000)
  ) {
    reviewsTabYandex = null;
  }

  if (rating === 0) rating = null;

  return {
    ratingYandex: rating,
    reviewsYandex: reviews,
    reviewsTabYandex,
  };
}

function buildYandexSearchUrl(name) {
  const enc = encodeURIComponent(name.trim());
  return `${YANDEX_SEARCH_BASE}/${enc}/?${YANDEX_MAP_PARAMS}`;
}

async function openFirstYandexOrgFromSearch(page, salonName) {
  const url = buildYandexSearchUrl(salonName);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(1200);
  const html = await page.content();
  if (html.includes("SmartCaptcha") || html.includes("робот")) {
    return { orgUrl: null, captcha: true };
  }
  try {
    await page.waitForSelector('a[href*="/org/"]', { timeout: 20000 });
  } catch {
    return { orgUrl: null, captcha: false };
  }
  const first = page.locator('a[href*="/org/"]').first();
  const href = await first.getAttribute("href");
  if (!href) return { orgUrl: null, captcha: false };
  const orgUrl = href.startsWith("/")
    ? "https://yandex.ru" + href.split("?")[0]
    : href.split("?")[0];
  return { orgUrl, captcha: false };
}

/**
 * Обновляет метрики для одного салона, используя переданную страницу Playwright.
 * @param {import('playwright').Page} page
 * @param {{ url2gis?: string, urlYandex?: string, name?: string, skipYandex?: boolean }} opts
 */
async function enrichSalonMetricsOnPage(page, opts) {
  const { url2gis, urlYandex, name, skipYandex } = opts;
  const errors = {};
  const out = {
    rating2gis: null,
    reviews2gis: null,
    reviewsTab2gis: null,
    ratingYandex: null,
    reviewsYandex: null,
    reviewsTabYandex: null,
    urlYandexResolved: urlYandex || null,
    yandexCaptcha: false,
    errors,
  };

  if (url2gis) {
    try {
      await page.goto(url2gis, {
        waitUntil: "domcontentloaded",
        timeout: 90000,
      });
      const st = await extract2gisStats(page);
      out.rating2gis = st.rating2gis;
      out.reviews2gis = st.reviews2gis;
      out.reviewsTab2gis = st.reviewsTab2gis;
    } catch (e) {
      errors.gis = e.message;
    }
    await sleep(REQUEST_PAUSE_MS);
  }

  if (skipYandex) {
    return out;
  }

  try {
    let orgUrl = urlYandex || null;
    if (orgUrl) {
      await page.goto(orgUrl, {
        waitUntil: "domcontentloaded",
        timeout: 90000,
      });
      const html = await page.content();
      if (html.includes("SmartCaptcha") || html.includes("робот")) {
        out.yandexCaptcha = true;
        errors.yandex = "captcha_or_robot";
        return out;
      }
    } else if (name && name.trim()) {
      const search = await openFirstYandexOrgFromSearch(page, name);
      if (search.captcha) {
        out.yandexCaptcha = true;
        errors.yandex = "captcha_or_robot";
        return out;
      }
      orgUrl = search.orgUrl;
      out.urlYandexResolved = orgUrl;
      if (!orgUrl) {
        errors.yandex = "org_not_found";
        return out;
      }
      await page.goto(orgUrl, {
        waitUntil: "domcontentloaded",
        timeout: 90000,
      });
    } else {
      errors.yandex = "no_url_and_no_name";
      return out;
    }

    const yt = await extractYandexStats(page);
    out.ratingYandex = yt.ratingYandex;
    out.reviewsYandex = yt.reviewsYandex;
    out.reviewsTabYandex = yt.reviewsTabYandex;
  } catch (e) {
    errors.yandex = e.message;
  }

  return out;
}

/**
 * Запускает браузер, снимает метрики, закрывает браузер.
 */
async function fetchSalonMetricsFresh(opts) {
  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({
    locale: "ru-RU",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1400, height: 900 },
  });
  const page = await context.newPage();
  try {
    const result = await enrichSalonMetricsOnPage(page, opts);
    result.parsedAt = new Date().toISOString();
    return result;
  } finally {
    await browser.close();
  }
}

module.exports = {
  extract2gisStats,
  extractYandexStats,
  enrichSalonMetricsOnPage,
  fetchSalonMetricsFresh,
  buildYandexSearchUrl,
  openFirstYandexOrgFromSearch,
  sleep,
};
