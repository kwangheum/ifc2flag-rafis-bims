import { build } from "esbuild";
import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const outdir = path.join(root, "bundle");
const wasmSourceDir = path.join(root, "node_modules", "web-ifc");
const wasmTargetDir = path.join(outdir, "web-ifc");

await fs.rm(outdir, { recursive: true, force: true });
await fs.mkdir(outdir, { recursive: true });
await fs.mkdir(wasmTargetDir, { recursive: true });

await build({
  entryPoints: [path.join(root, "src/index.ts")],
  outfile: path.join(outdir, "server.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: false,
  packages: "bundle",
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url); const __dirname = decodeURIComponent(new URL(".", import.meta.url).pathname).replace(/\\/$/, "");',
  },
});

const wasmFiles = await fs.readdir(wasmSourceDir);
for (const file of wasmFiles) {
  if (!file.endsWith(".wasm")) continue;
  await fs.copyFile(
    path.join(wasmSourceDir, file),
    path.join(wasmTargetDir, file),
  );
}

const readme = `Run:
node server.js

Required runtime files in this folder:
- server.js
- web-ifc/*.wasm

API:
- POST /api/conversions/from-path
`;

await fs.writeFile(path.join(outdir, "README.txt"), readme, "utf8");
