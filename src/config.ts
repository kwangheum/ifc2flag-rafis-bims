import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const currentFile = typeof __filename !== "undefined" ? __filename : fileURLToPath(import.meta.url);
const srcDir = path.dirname(currentFile);
const dirName = path.basename(srcDir);
const projectRoot = dirName === "src" || dirName === "dist" ? path.resolve(srcDir, "..") : srcDir;

type DatabaseVendor = "oracle" | "tibero";
type DatabaseEnvironment = "test" | "production";

const activeDbEnvironment: DatabaseEnvironment = "test";
const uploadRoot = "/Users/kwangheum/Downloads/files";
const dbConfigs: Record<DatabaseEnvironment, {
  vendor: DatabaseVendor;
  connectString: string;
  user: string;
  password: string;
}> = {
  test: {
    vendor: "oracle",
    connectString: "192.168.123.200:11010/XE",
    user: "RAFIS_BIM",
    password: "RAFIS_BIM"
  },
  production: {
    vendor: "tibero",
    connectString: "DSN=TIBERO6;UID=XE;PWD=RAFIS_BIM",
    user: "RAFIS_BIM",
    password: "RAFIS_BIM"
  }
};
const db = dbConfigs[activeDbEnvironment];

const bundledWebIfcPath = path.join(projectRoot, "web-ifc");
const installedWebIfcPath = path.join(projectRoot, "node_modules", "web-ifc");
const webIfcPath =
  fs.existsSync(bundledWebIfcPath) ? bundledWebIfcPath : installedWebIfcPath;

export const config = {
  port: 3000,
  activeDbEnvironment,
  projectRoot,
  uploadRoot,
  webIfcPath,
  db,
  isExcludeInfo: false//공단에서 BIM 데이터 속성 정보 예시를 A1~6까지 시작하는 것만 넣을지 여부false면 모든 속성정보를 insert 한다.
};
