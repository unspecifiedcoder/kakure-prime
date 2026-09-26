import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await build({
  entryPoints: ["background", "bridge", "inpage", "popup", "approval"].map((name) => resolve(root, `src/${name}.ts`)),
  outdir: dist,
  bundle: true,
  format: "iife",
  target: "chrome120",
  minify: true,
  sourcemap: false,
});

for (const file of ["manifest.json", "popup.html", "approval.html", "wallet.css"]) {
  await cp(resolve(root, `static/${file}`), resolve(dist, file));
}
