/**
 * CLI для Python: JSON в argv → JSON в stdout.
 *   node fetch_metrics.cjs '{"url2gis":"...","urlYandex":"...","name":"...","skipYandex":false}'
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
require("dotenv").config({ path: path.join(__dirname, ".env") });

const { fetchSalonMetricsFresh } = require("./salon_metrics.cjs");

const arg = process.argv[2];
if (!arg) {
  console.error(JSON.stringify({ error: "no_json_arg" }));
  process.exit(1);
}

let opts;
try {
  opts = JSON.parse(arg);
} catch (e) {
  console.error(JSON.stringify({ error: "invalid_json", message: e.message }));
  process.exit(1);
}

fetchSalonMetricsFresh({
  url2gis: opts.url2gis || undefined,
  urlYandex: opts.urlYandex || undefined,
  name: opts.name || undefined,
  skipYandex: !!opts.skipYandex,
})
  .then((r) => {
    console.log(JSON.stringify(r));
  })
  .catch((e) => {
    console.error(JSON.stringify({ error: e.message || String(e) }));
    process.exit(1);
  });
