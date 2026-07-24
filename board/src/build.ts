// Build the board SPA with Bun's own bundler + the official Tailwind plugin.
// No Vite/webpack/esbuild-as-dependency — bundling is Bun's concern per the
// project's fixed stack. Outputs app.js + styles.css + index.html into dist/.
import { cp, rm } from "node:fs/promises";
import tailwind from "bun-plugin-tailwind";

const uiDir = new URL("./ui/", import.meta.url).pathname;
const outdir = new URL("../dist/", import.meta.url).pathname;

await rm(outdir, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: [`${uiDir}app.tsx`, `${uiDir}styles.css`],
  outdir,
  plugins: [tailwind],
  minify: true,
  target: "browser",
  naming: "[name].[ext]",
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error("Board UI build failed");
}

await cp(`${uiDir}index.html`, `${outdir}index.html`);

console.log(
  "Board UI built:",
  result.outputs.map((o) => o.path.split("/").pop()).join(", "),
  "+ index.html",
);
