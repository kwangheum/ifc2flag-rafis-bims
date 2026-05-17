import { Router } from "express";
import { AppError } from "../errors.js";
import { AttachmentService } from "../services/attachment.service.js";
import { IfcToFragService } from "../services/ifc-to-frag.service.js";

const router = Router();
const service = new IfcToFragService();
const attachmentService = new AttachmentService();

// 변환 결과에 브라우저에서 접근 가능한 파일 URL을 덧붙입니다.
function toResponse(result: Awaited<ReturnType<IfcToFragService["convertFile"]>>) {
  return {
    ...result,
    uploadUrl: result.sourceRelativePath ? `/files/${result.sourceRelativePath}` : null,
    fragmentUrl: result.fragmentRelativePath ? `/files/${result.fragmentRelativePath}` : null,
    downloadUrl: result.fragmentRelativePath ? `/files/${result.fragmentRelativePath}` : null
  };
}

router.get("/ifc", async (req, res, next) => {
  const rawAttachmentId = req.query?.attachmentId;
  const attachmentId =
    typeof rawAttachmentId === "string" || typeof rawAttachmentId === "number"
      ? String(rawAttachmentId).trim()
      : "";

  if (attachmentId === "") {
    next(new AppError(400, "쿼리 파라미터 'attachmentId'가 필요합니다."));
    return;
  }

  try {
    await attachmentService.initializeConversionModel(attachmentId);
    const sourcePath = await attachmentService.getSourcePath(attachmentId);
    await attachmentService.updateStatusProcessing(attachmentId);
    const result = await service.convertStoredPath(sourcePath, attachmentId);
    await attachmentService.updateStatusDone(attachmentId);
    res.status(201).json(toResponse(result));
  } catch (error) {
    try {
      await attachmentService.updateStatusFailed(
        attachmentId,
        error instanceof Error ? error.message : "알 수 없는 오류"
      );
    } catch {
      // Ignore status update failures and return the original error.
    }
    next(error);
  }
});

router.post("/ifc", async (req, res, next) => {
  const rawAttachmentId = req.body?.attachmentId;
  const attachmentId =
    typeof rawAttachmentId === "string" || typeof rawAttachmentId === "number"
      ? String(rawAttachmentId).trim()
      : "";

  if (attachmentId === "") {
    next(new AppError(400, "본문 필드 'attachmentId'가 필요합니다."));
    return;
  }

  try {
    await attachmentService.initializeConversionModel(attachmentId);
    const sourcePath = await attachmentService.getSourcePath(attachmentId);
    await attachmentService.updateStatusProcessing(attachmentId);
    const result = await service.convertStoredPath(sourcePath, attachmentId);
    await attachmentService.updateStatusDone(attachmentId);
    res.status(201).json(toResponse(result));
  } catch (error) {
    try {
      await attachmentService.updateStatusFailed(
        attachmentId,
        error instanceof Error ? error.message : "알 수 없는 오류"
      );
    } catch {
      // Ignore status update failures and return the original error.
    }
    next(error);
  }
});

export { router as conversionRouter };
