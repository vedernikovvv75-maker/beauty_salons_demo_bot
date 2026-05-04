/**
 * Слияние горячих лидов из нескольких JSON-файлов в один сводный.
 *
 * Фильтры:
 *   - reviews2gis < HOT_THRESHOLD (по умолчанию 50) или null
 *   - Есть контакт: telegram или мобильный телефон (+79...)
 *   - Дедупликация по id
 *
 *   node merge_hot_leads.cjs
 *   node merge_hot_leads.cjs --threshold 50 --out ../hot_leads_all.json
 */

const fs = require("fs");
const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const ROOT = path.join(__dirname, "..");

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    sources: [
      path.join(ROOT, "novosibirsk_salons.json"),
      path.join(ROOT, "barnaul_salons_full.json"),
      path.join(ROOT, "barnaul_barbershops.json"),
    ],
    out: path.join(ROOT, "hot_leads_all.json"),
    threshold: parseInt(process.env.HOT_THRESHOLD || "50", 10),
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--threshold" && args[i + 1])
      opts.threshold = parseInt(args[++i], 10);
    else if (args[i] === "--out" && args[i + 1])
      opts.out = path.resolve(args[++i]);
    else if (args[i] === "--file" && args[i + 1])
      opts.sources.push(path.resolve(args[++i]));
  }
  return opts;
}

function hasMobilePhone(salon) {
  const phones = salon.phones || [];
  return phones.some((p) => /^\+79/.test(p));
}

function hasContact(salon) {
  if (salon.telegram) return true;
  return hasMobilePhone(salon);
}

function isHot(salon, threshold) {
  const r = salon.reviews2gis;
  return r === null || r === undefined || r < threshold;
}

function main() {
  const opts = parseArgs();
  console.log("=== Merge Hot Leads ===");
  console.log(`Threshold: reviews2gis < ${opts.threshold}`);
  console.log(`Output: ${opts.out}\n`);

  const seen = new Set();
  const hotLeads = [];
  const stats = { total: 0, hot: 0, withContact: 0, duplicates: 0 };

  for (const src of opts.sources) {
    if (!fs.existsSync(src)) {
      console.log(`  ⚠ ${path.basename(src)} — not found, skipping`);
      continue;
    }
    const fileData = JSON.parse(fs.readFileSync(src, "utf-8"));
    const salons = fileData.salons || [];
    let fileHot = 0;
    let fileAdded = 0;

    for (const s of salons) {
      stats.total++;
      if (!isHot(s, opts.threshold)) continue;
      fileHot++;
      if (!hasContact(s)) continue;
      stats.withContact++;

      const id = s.id || s.url2gis;
      if (seen.has(id)) {
        stats.duplicates++;
        continue;
      }
      seen.add(id);
      s._source = path.basename(src);
      hotLeads.push(s);
      fileAdded++;
    }
    console.log(
      `  ${path.basename(src)}: ${salons.length} total → ${fileHot} hot → ${fileAdded} added`
    );
  }

  stats.hot = hotLeads.length;

  const output = {
    meta: {
      mergedAt: new Date().toISOString(),
      sources: opts.sources.map((s) => path.basename(s)),
      threshold: opts.threshold,
      totalScanned: stats.total,
      duplicatesRemoved: stats.duplicates,
      hotLeads: hotLeads.length,
    },
    salons: hotLeads,
  };

  fs.writeFileSync(opts.out, JSON.stringify(output, null, 2), "utf-8");

  console.log(`\n✓ Done.`);
  console.log(`  Scanned: ${stats.total}`);
  console.log(`  Hot with contacts: ${stats.withContact}`);
  console.log(`  Duplicates removed: ${stats.duplicates}`);
  console.log(`  Final hot leads: ${hotLeads.length}`);
  console.log(`  Saved to ${opts.out}`);
}

main();
