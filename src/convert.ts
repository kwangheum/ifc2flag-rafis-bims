import fs from "node:fs/promises";
import path from "node:path";
import { IfcToFragService } from "./services/ifc-to-frag.service.js";

// Change this path before running `node convert.js`.
const TARGET_ROOT = "/data/files/platform/2026/4";
// const TARGET_ROOT = "/Users/kwangheum/Downloads/files";

const service = new IfcToFragService();

async function findIfcFiles(rootPath: string, results: string[] = []) {
  const entries = await fs.readdir(rootPath, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === "frag" || entry.name === "frags") {
        continue;
      }
      await findIfcFiles(entryPath, results);
      continue;
    }

    if (entry.isFile() && entry.name.toLowerCase().endsWith(".ifc")) {
      results.push(entryPath);
    }
  }

  return results;
}

async function run() {
  const rootPath = path.resolve(TARGET_ROOT);
  const ifcFiles = await findIfcFiles(rootPath);

  if (ifcFiles.length === 0) {
    console.log(`${rootPath} 아래에 IFC 파일이 없습니다.`);
    return;
  }

  console.log(`${rootPath} 아래에서 IFC 파일 ${ifcFiles.length}개를 찾았습니다.`);

  for (const ifcFile of ifcFiles) {
    const fragmentDir = path.join(path.dirname(ifcFile), "frags");
    const fragmentName = `${path.basename(ifcFile, path.extname(ifcFile))}.frag`;
    const fragmentPath = path.join(fragmentDir, fragmentName);

    try {
      console.log(`변환 중: ${ifcFile}`);
      await service.convertFileToPath(ifcFile, fragmentPath);
      console.log(`생성 완료: ${fragmentPath}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.";
      console.error(`건너뜀: ${ifcFile}`);
      console.error(`사유: ${message}`);
    }
  }
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.";
  console.error(message);
  process.exit(1);
});
