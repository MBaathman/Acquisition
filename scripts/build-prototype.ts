// Builds prototype/dist/acquisition-os.html: the prototype UI with the engine's
// builder, schema validation, planner, intelligence layer and engine bundled for
// the browser, the presets and agent knowledge, and
// the demo dataset inlined.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { buildSync } from "esbuild";

const root = new URL("../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), "utf8");
mkdirSync(new URL("prototype/dist/", root), { recursive: true });

const bundle = buildSync({
  entryPoints: [new URL("src/browser.ts", root).pathname],
  bundle: true, format: "iife", globalName: "AcqEngine", platform: "browser", minify: true, write: false, target: "es2020",
}).outputFiles[0]!.text;

const presets = JSON.stringify({ outcomes: JSON.parse(read("presets/outcomes.json")).presets, intents: JSON.parse(read("presets/replies.json")).intents, knowledge: JSON.parse(read("presets/knowledge.json")) });
const safe = (s: string) => s.replace(/<\//g, "<\\/");
const html = read("prototype/app.html")
  .replace("/*__ENGINE__*/", () => safe(bundle))
  .replace("__PRESETS__", () => safe(presets))
  .replace("__DATA__", () => safe(read("prototype/dist/demo-data.json")));
writeFileSync(new URL("prototype/dist/acquisition-os.html", root), html);
console.log(`prototype/dist/acquisition-os.html (${(html.length / 1e6).toFixed(1)} MB, engine bundle ${(bundle.length / 1e3).toFixed(0)} KB)`);
