import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const currentFile = typeof __filename !== "undefined" ? __filename : fileURLToPath(import.meta.url);
const srcDir = path.dirname(currentFile);
const dirName = path.basename(srcDir);
const projectRoot = dirName === "src" || dirName === "dist" ? path.resolve(srcDir, "..") : srcDir;

// const uploadRoot = "/data/files/platform";
// const db = {
//   host: "172.26.1.55",
//   port: 3306,
//   database: "krri",
//   user: "krri",
//   password: "Sa@5@W^^1"
// };
const uploadRoot = "/Users/kwangheum/Downloads/files";
const db = {
  host: "ucore.iptime.org",
  port: 11001,
  database: "bimtemp",
  user: "bimtemp",
  password: "bim!!@#"
};

const bundledWebIfcPath = path.join(projectRoot, "web-ifc");
const installedWebIfcPath = path.join(projectRoot, "node_modules", "web-ifc");
const webIfcPath =
  fs.existsSync(bundledWebIfcPath) ? bundledWebIfcPath : installedWebIfcPath;

export const config = {
  port: 3000,
  projectRoot,
  uploadRoot,
  webIfcPath,
  db,
  isExcludeInfo: false//공단에서 BIM 데이터 속성 정보 예시를 A1~6까지 시작하는 것만 넣을지 여부false면 모든 속성정보를 insert 한다.
};
