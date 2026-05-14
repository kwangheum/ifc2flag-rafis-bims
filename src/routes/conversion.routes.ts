import path from "node:path";
import { Router } from "express";
import multer from "multer";
import { config } from "../config.js";
import { AppError } from "../errors.js";
import { AttachmentService } from "../services/attachment.service.js";
import { IfcToFragService } from "../services/ifc-to-frag.service.js";
import { ensureDir } from "../utils/fs.js";

const router = Router();
const service = new IfcToFragService();
const attachmentService = new AttachmentService();

function toResponse(result: Awaited<ReturnType<IfcToFragService["convertFile"]>>) {
  return {
    ...result,
    uploadUrl: result.sourceRelativePath ? `/files/${result.sourceRelativePath}` : null,
    fragmentUrl: result.fragmentRelativePath ? `/files/${result.fragmentRelativePath}` : null,
    downloadUrl: result.fragmentRelativePath ? `/files/${result.fragmentRelativePath}` : null
  };
}

function getUploadFolderParts() {
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, "0");

  return { year, month };
}

const storage = multer.diskStorage({
  destination: async (_req, _file, callback) => {
    const { year, month } = getUploadFolderParts();
    const destinationPath = path.join(config.uploadRoot, year, month);

    try {
      await ensureDir(destinationPath);
      callback(null, destinationPath);
    } catch (error) {
      callback(error as Error, destinationPath);
    }
  },
  filename: (_req, file, callback) => {
    const safeName = file.originalname.replace(/[^\w.-]/g, "_");
    callback(null, `${Date.now()}-${safeName}`);
  }
});

const upload = multer({
  storage,
  fileFilter: (_req, file, callback) => {
    if (path.extname(file.originalname).toLowerCase() !== ".ifc") {
      callback(new AppError(400, ".ifc 파일만 업로드할 수 있습니다."));
      return;
    }

    callback(null, true);
  }
});

router.post("/upload", upload.single("file"), async (req, res, next) => {
  const uploadedFile = req.file;

  if (!uploadedFile) {
    next(new AppError(400, "멀티파트 필드 'file'이 필요합니다."));
    return;
  }

  try {
    const result = await service.convertFile(uploadedFile.path);
    res.status(201).json(toResponse(result));
  } catch (error) {
    next(error);
  }
});

router.post("/from-upload", async (req, res, next) => {
  const uploadedFilePath = req.body?.uploadedFilePath;
  if (typeof uploadedFilePath !== "string" || uploadedFilePath.trim() === "") {
    next(new AppError(400, "본문 필드 'uploadedFilePath'가 필요합니다."));
    return;
  }

  try {
    const result = await service.convertStoredUpload(uploadedFilePath);
    res.status(201).json(toResponse(result));
  } catch (error) {
    next(error);
  }
});

router.post("/from-path", async (req, res, next) => {
  const attachmentId = req.body?.attachmentId;
  console.log("attachmentId : ",attachmentId)
  if (typeof attachmentId !== "string" || attachmentId.trim() === "") {
    next(new AppError(400, "본문 필드 'attachmentId'가 필요합니다."));
    return;
  }
  const sourcePath = req.body?.sourcePath;
  console.log("sourcePath : ",sourcePath)
  if (typeof sourcePath !== "string" || sourcePath.trim() === "") {
    next(new AppError(400, "본문 필드 'sourcePath'가 필요합니다."));
    return;
  }

  try {
    await attachmentService.updateStatusProcessing(attachmentId);
    // const attachment = await attachmentService.getAttachmentPathParts(attachmentId);
    // const sourcePath = attachmentService.toRelativeSourcePath(
    //   attachment.savePath,
    //   attachment.saveFilename
    // );
    const result = await service.convertStoredPath(sourcePath, attachmentId);
    await attachmentService.updateStatusDone(attachmentId);
    res.status(201).json(toResponse(result));
  } catch (error) {
    try {
      console.error(error)
      await attachmentService.updateStatusFailed(attachmentId);
    } catch {
      // Ignore status update failures and return the original error.
    }
    next(error);
  }
});

router.get("/:conversionId", async (req, res, next) => {
  next(new AppError(410, "변환 메타데이터 저장이 비활성화되어 있습니다."));
});

router.get("/:conversionId/file", async (req, res, next) => {
  next(new AppError(410, "변환 메타데이터 저장이 비활성화되어 있습니다."));
});

export { router as conversionRouter };
