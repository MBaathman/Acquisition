// Builds prototype/dist/acquisition-os.html: the prototype UI with the demo dataset inlined.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const root = new URL("../prototype/", import.meta.url);
mkdirSync(new URL("dist/", root), { recursive: true });
const template = readFileSync(new URL("app.html", root), "utf8");
const data = readFileSync(new URL("dist/demo-data.json", root), "utf8");
const html = template.replace("__DATA__", data.replace(/<\//g, "<\\/"));
writeFileSync(new URL("dist/acquisition-os.html", root), html);
console.log(`prototype/dist/acquisition-os.html (${(html.length / 1e6).toFixed(1)} MB)`);
