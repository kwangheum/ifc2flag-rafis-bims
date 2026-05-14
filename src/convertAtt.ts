import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { IfcToFragService } from "./services/ifc-to-frag.service.js";
import { AttachmentService } from "./services/attachment.service.js";
import { dbPool } from "./services/db-pool.js";

interface AttachmentRow {
  attachmentId: number | string | bigint;
  savePath: string;
  saveFilename: string;
  originalFilename: string;
  extension: string;
}

const service = new IfcToFragService();
const attachmentService = new AttachmentService();

async function getIfcAttachments() {
  let connection: import("mariadb").PoolConnection | undefined;

  try {
    connection = await dbPool.getConnection();
    const rows = await connection.query<AttachmentRow[]>(
      `SELECT
         ATCHMNFL_SN AS attachmentId,
         FLPTH AS savePath,
         STRE_NM AS saveFilename,
         ORGINL_NM AS originalFilename,
         EXTSN AS extension
       FROM TC_CMN_ATCHMNFL
       WHERE LOWER(EXTSN) = 'ifc'
       ORDER BY ATCHMNFL_SN`
    );

    return rows;
  } finally {
    connection?.release();
  }
}

async function fileExists(targetPath: string) {
  try {
    const stat = await fs.stat(targetPath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function run() {
  const attachments = await getIfcAttachments();

  if (attachments.length === 0) {
    console.log("TC_CMN_ATCHMNFL 테이블에서 IFC 첨부파일을 찾지 못했습니다.");
    return;
  }

  console.log(`TC_CMN_ATCHMNFL 테이블에서 IFC 첨부파일 ${attachments.length}건을 찾았습니다.`);

  for (const attachment of attachments) {
    const attachmentId = String(attachment.attachmentId);
    const relativeSourcePath = attachmentService.toRelativeSourcePath(
      attachment.savePath,
      attachment.saveFilename
    );
    const absoluteSourcePath = path.join(
      config.uploadRoot,
      relativeSourcePath.replace(/^[/\\]+/, "")
    );

    if (!(await fileExists(absoluteSourcePath))) {
      console.warn(
        `[${attachmentId}] 원본 파일을 찾지 못해 건너뜁니다. original=${attachment.originalFilename}, path=${absoluteSourcePath}`
      );
      continue;
    }

    try {
      console.log(
        `[${attachmentId}] 변환 시작: original=${attachment.originalFilename}, stored=${attachment.saveFilename}`
      );
      await attachmentService.updateStatusProcessing(attachmentId);
      const result = await service.convertStoredPath(relativeSourcePath, attachmentId);
      await attachmentService.updateStatusDone(attachmentId);
      console.log(
        `[${attachmentId}] 변환 완료: source=${result.sourcePath}, fragment=${result.fragmentPath}`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.";
      console.error(`[${attachmentId}] 변환 실패: ${message}`);

      try {
        await attachmentService.updateStatusFailed(attachmentId);
      } catch (statusError) {
        const statusMessage =
          statusError instanceof Error ? statusError.message : "알 수 없는 상태 업데이트 오류";
        console.error(`[${attachmentId}] 실패 상태 업데이트 오류: ${statusMessage}`);
      }
    }
  }
}

run()
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.";
    console.error(message);
    process.exit(1);
  })
  .finally(async () => {
    await dbPool.end().catch(() => undefined);
  });
