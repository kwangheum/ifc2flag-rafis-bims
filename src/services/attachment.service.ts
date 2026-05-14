import { AppError } from "../errors.js";
import { dbPool } from "./db-pool.js";

interface AttachmentRow {
  savePath: string;
  saveFilename: string;
}

export class AttachmentService {
  async getAttachmentPathParts(attachmentId: string) {
    let connection: import("mariadb").PoolConnection | undefined;

    try {
      connection = await dbPool.getConnection();
      const rows = await connection.query<AttachmentRow[]>(
        `SELECT
           FLPTH AS savePath,
           STRE_NM AS saveFilename
         FROM TC_CMN_ATCHMNFL
         WHERE ATCHMNFL_SN = ?`,
        [attachmentId]
      );

      const attachment = rows[0];
      if (!attachment?.savePath || !attachment?.saveFilename) {
        throw new AppError(404, `첨부파일 정보를 찾을 수 없습니다. attachmentId=${attachmentId}`);
      }

      return {
        savePath: attachment.savePath,
        saveFilename: attachment.saveFilename
      };
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      throw new AppError(500, `첨부파일 조회에 실패했습니다: ${this.getMessage(error)}`);
    } finally {
      connection?.release();
    }
  }

  async updateStatusDone(attachmentId: string) {
    console.log(`[${attachmentId}] ifc 파일 frag로 변환 성공`);
    await this.updateStatus(attachmentId, 3);
  }

  async updateStatusProcessing(attachmentId: string) {
    await this.updateStatus(attachmentId, 1);
  }

  async updateStatusFailed(attachmentId: string) {
    console.error(`[${attachmentId}] ifc 파일 frag로 변환 실패`);
    await this.updateStatus(attachmentId, 2);
  }

  private async updateStatus(attachmentId: string, statusCode: number) {
    let connection: import("mariadb").PoolConnection | undefined;

    try {
      connection = await dbPool.getConnection();
      await connection.query(
        `UPDATE TC_CMN_ATCHMNFL
         SET STTUS_CD = ?
         WHERE ATCHMNFL_SN = ?`,
        [statusCode, attachmentId]
      );
    } catch (error) {
      throw new AppError(500, `첨부파일 상태 업데이트에 실패했습니다: ${this.getMessage(error)}`);
    } finally {
      connection?.release();
    }
  }

  toRelativeSourcePath(savePath: string, saveFilename: string) {
    const normalizedSavePath = savePath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    return `/${normalizedSavePath}/${saveFilename}`;
  }

  private getMessage(error: unknown) {
    const poolState = this.getPoolState();

    if (error instanceof Error) {
      return `${error.message} ${poolState}`;
    }

    return `알 수 없는 오류 ${poolState}`;
  }

  private getPoolState() {
    return `(pool: active=${dbPool.activeConnections()} idle=${dbPool.idleConnections()} total=${dbPool.totalConnections()} queue=${dbPool.taskQueueSize()})`;
  }
}
