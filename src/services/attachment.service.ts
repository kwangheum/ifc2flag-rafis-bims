import { AppError } from "../errors.js";
import { dbPool, type DbConnection } from "./db-pool.js";

interface AttachmentPathRow {
  savePath: string;
  saveFilename: string;
}

interface AffectedRowsLike {
  affectedRows: number | bigint;
}

export class AttachmentService {
  // 첨부파일 번호로 BIM_CM010D_TB의 FLPTH/STRE_NM을 조회해 원본 IFC 상대 경로를 만듭니다.
  async getSourcePath(attachmentId: string) {
    let connection: DbConnection | undefined;

    try {
      connection = await dbPool.getConnection();
      const rows = await connection.query<AttachmentPathRow[]>(
        `SELECT
           BIM_FILE_PATH AS "savePath",
           BIM_FILE_NM AS "saveFilename"
         FROM BIM_CM010D_TB
         WHERE BIM_FILE_ID = ?`,
        [attachmentId]
      );

      const attachment = rows[0];
      if (!attachment?.savePath || !attachment?.saveFilename) {
        throw new AppError(404, `첨부파일 정보를 찾을 수 없습니다. attachmentId=${attachmentId}`);
      }

      return this.joinSourcePath(attachment.savePath, attachment.saveFilename);
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      throw new AppError(500, `첨부파일 경로 조회에 실패했습니다: ${this.getMessage(error)}`);
    } finally {
      connection?.release();
    }
  }

  // 변환 요청이 들어오면 BIM_CM010D_TB 기준으로 BIM_CM011D_TB에 변환대기 row를 먼저 생성합니다.
  async initializeConversionModel(attachmentId: string) {
    let connection: DbConnection | undefined;

    try {
      connection = await dbPool.getConnection();
      await connection.beginTransaction();

      await this.deleteExistingConversionModel(connection, attachmentId);

      const result = await connection.query<AffectedRowsLike>(
        `INSERT INTO BIM_CM011D_TB (
          BIM_FILE_ID,
          PROCESS_STTUS_CD,
          PROCESS_FAILURE_CN,
          FRST_REGISTER_ID,
          FRST_REGIST_DT,
          LAST_UPDUSR_ID,
          LAST_UPDT_DT
        )
        SELECT
          BIM_FILE_ID,
          ?,
          NULL,
          LAST_UPDUSR_ID,
          LAST_UPDT_DT,
          LAST_UPDUSR_ID,
          LAST_UPDT_DT
        FROM BIM_CM010D_TB
        WHERE BIM_FILE_ID = ?`,
        [1, attachmentId]
      );

      if (Number(result.affectedRows) === 0) {
        throw new AppError(404, `BIM 파일 정보를 찾을 수 없습니다. BIM_FILE_ID=${attachmentId}`);
      }

      await connection.commit();
    } catch (error) {
      await connection?.rollback().catch(() => undefined);

      if (error instanceof AppError) {
        throw error;
      }

      throw new AppError(500, `변환대기 모델 생성에 실패했습니다: ${this.getMessage(error)}`);
    } finally {
      connection?.release();
    }
  }

  // 변환 성공 상태를 DB에 기록합니다.
  async updateStatusDone(attachmentId: string) {
    console.log(`[${attachmentId}] ifc 파일 frag로 변환 성공`);
    await this.updateStatus(attachmentId, 3, null);
  }

  // 변환 진행 중 상태를 DB에 기록합니다.
  async updateStatusProcessing(attachmentId: string) {
    await this.updateStatus(attachmentId, 2, null);
  }

  // 변환 실패 상태를 DB에 기록합니다.
  async updateStatusFailed(attachmentId: string, reason: string) {
    console.error(`[${attachmentId}] ifc 파일 frag로 변환 실패`);
    await this.updateStatus(attachmentId, 4, reason);
  }

  // 첨부파일 테이블의 상태 코드만 공통으로 업데이트합니다.
  private async updateStatus(
    attachmentId: string,
    statusCode: number,
    failureReason: string | null
  ) {
    let connection: DbConnection | undefined;

    try {
      connection = await dbPool.getConnection();
      await connection.query(
        `UPDATE BIM_CM011D_TB
         SET PROCESS_STTUS_CD = ?,
             PROCESS_FAILURE_CN = ?
         WHERE BIM_FILE_ID = ?`,
        [statusCode, failureReason, attachmentId]
      );
    } catch (error) {
      throw new AppError(500, `첨부파일 상태 업데이트에 실패했습니다: ${this.getMessage(error)}`);
    } finally {
      connection?.release();
    }
  }

  // BIM_FILE_PATH + "/" + BIM_FILE_NM 형태를 업로드 루트 기준 상대 경로로 정리합니다.
  private joinSourcePath(savePath: string, saveFilename: string) {
    const normalizedSavePath = savePath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    return `/${normalizedSavePath}/${saveFilename}`;
  }

  private async deleteExistingConversionModel(
    connection: DbConnection,
    attachmentId: string
  ) {
    const metadataTables = [
      "BIM_CM018D_TB",
      "BIM_CM017D_TB",
      "BIM_CM016D_TB",
      "BIM_CM011D_TB"
    ];

    for (const tableName of metadataTables) {
      await connection.query(
        `DELETE FROM ${tableName}
         WHERE BIM_FILE_ID = ?`,
        [attachmentId]
      );
    }
  }

  // DB 오류 메시지에 커넥션 풀 상태를 붙여 운영 로그에서 원인을 보기 쉽게 합니다.
  private getMessage(error: unknown) {
    const poolState = this.getPoolState();

    if (error instanceof Error) {
      return `${error.message} ${poolState}`;
    }

    return `알 수 없는 오류 ${poolState}`;
  }

  // DB 커넥션 풀의 현재 사용량을 짧은 문자열로 만듭니다.
  private getPoolState() {
    return `(pool: active=${dbPool.activeConnections()} idle=${dbPool.idleConnections()} total=${dbPool.totalConnections()} queue=${dbPool.taskQueueSize()})`;
  }
}
