import { build } from "esbuild";
import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const outdir = path.join(root, "bundle");
const wasmSourceDir = path.join(root, "node_modules", "web-ifc");
const wasmTargetDir = path.join(outdir, "web-ifc");
const publicSourceDir = path.join(root, "public");
const publicTargetDir = path.join(outdir, "public");

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

await build({
  entryPoints: [path.join(root, "src/convert.ts")],
  outfile: path.join(outdir, "convert.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: false,
  packages: "bundle",
});

await build({
  entryPoints: [path.join(root, "src/convertAtt.ts")],
  outfile: path.join(outdir, "convertAtt.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: false,
  packages: "bundle",
});

await fs.writeFile(
  path.join(outdir, "convert.js"),
  'import "./convert.cjs";\n',
  "utf8",
);

await fs.writeFile(
  path.join(outdir, "convertAtt.js"),
  'import "./convertAtt.cjs";\n',
  "utf8",
);

await fs.cp(publicSourceDir, publicTargetDir, { recursive: true });

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
node convert.js
node convertAtt.js

Required runtime files in this folder:
- server.js
- convert.cjs
- convert.js
- convertAtt.cjs
- convertAtt.js
- public/
- web-ifc/*.wasm

convert.js behavior:
- Edit TARGET_ROOT inside convert.cjs
- All .ifc files under that folder are converted recursively
- Output path: <same folder>/frag/<same name>.frag

convertAtt.js behavior:
- Read IFC attachments from TC_CMN_ATCHMNFL
- Convert matching files to FRAG
- Insert metadata into TB_IFC_* tables
`;

await fs.writeFile(path.join(outdir, "README.txt"), readme, "utf8");
