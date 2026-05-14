import fs from "node:fs/promises";
import path from "node:path";

export async function ensureDir(dirPath: string) {
  await fs.mkdir(dirPath, { recursive: true });
}

export function ensureInsideRoot(root: string, target: string) {
  const normalizedRoot = path.resolve(root);
  const normalizedTarget = path.resolve(target);

  if (
    normalizedTarget !== normalizedRoot &&
    !normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`)
  ) {
    throw new Error("허용된 저장 경로를 벗어난 파일 경로입니다.");
  }

  return normalizedTarget;
}
