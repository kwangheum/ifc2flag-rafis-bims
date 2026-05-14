import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { IfcImporter } from "@thatopen/fragments";
import { config } from "../config.js";
import { AppError } from "../errors.js";
import type { ConversionResult } from "../types.js";
import { ensureDir, ensureInsideRoot } from "../utils/fs.js";
import { IfcMetadataService } from "./ifc-metadata.service.js";

export class IfcToFragService {
  private readonly importer = new IfcImporter();
  private readonly metadataService = new IfcMetadataService();

  constructor() {
    this.importer.wasm = {
      absolute: true,
      path: this.resolveWasmPath()
    };
  }

  async convertStoredUpload(relativeFilePath: string) {
    const sourcePath = ensureInsideRoot(
      config.uploadRoot,
      path.join(config.uploadRoot, relativeFilePath)
    );

    return this.convertFile(sourcePath);
  }

  async convertStoredPath(sourcePath: string, attachmentId?: string) {
    const normalizedRelativePath = sourcePath.replace(/^[/\\]+/, "");
    const targetPath = ensureInsideRoot(
      config.uploadRoot,
      path.join(config.uploadRoot, normalizedRelativePath)
    );

    return this.convertFile(targetPath, attachmentId);
  }

  async convertFile(sourcePath: string, attachmentId?: string): Promise<ConversionResult> {
    const normalizedSourcePath = path.resolve(sourcePath);
    const stat = await this.safeStat(normalizedSourcePath);
    if (!stat?.isFile()) {
      throw new AppError(404, "IFC 원본 파일을 찾을 수 없습니다.");
    }

    if (path.extname(normalizedSourcePath).toLowerCase() !== ".ifc") {
      throw new AppError(400, ".ifc 파일만 변환할 수 있습니다.");
    }

    const sourceBytes = await fs.readFile(normalizedSourcePath);
    const baseName = path.basename(normalizedSourcePath, path.extname(normalizedSourcePath));
    const sourceDirectory = path.dirname(normalizedSourcePath);
    const fragmentDirectory = path.join(sourceDirectory, "frags");
    const conversionId = randomUUID();
    const fragmentFileName = `${baseName}.frag`;
    const fragmentPath = path.join(fragmentDirectory, fragmentFileName);

    await ensureDir(fragmentDirectory);

    const fragmentBuffer = await this.convertBytes(sourceBytes);

    await fs.writeFile(fragmentPath, fragmentBuffer);

    const result: ConversionResult = {
      conversionId,
      sourceFileName: path.basename(normalizedSourcePath),
      sourcePath: normalizedSourcePath,
      sourceRelativePath: this.getRelativePathIfInsideUploadRoot(normalizedSourcePath),
      fragmentFileName,
      fragmentPath,
      fragmentRelativePath: this.getRelativePathIfInsideUploadRoot(fragmentPath),
      fragmentSize: fragmentBuffer.byteLength,
      createdAt: new Date().toISOString()
    };

    await this.metadataService.persistConversionMetadata({
      attachmentId: attachmentId ?? null,
      sourcePath: normalizedSourcePath,
      sourceRelativePath: result.sourceRelativePath,
      sourceFileName: result.sourceFileName,
      fragmentPath,
      fragmentRelativePath: result.fragmentRelativePath,
      fragmentFileName,
      fragmentSize: result.fragmentSize
    });

    return result;
  }

  async convertFileToPath(sourcePath: string, fragmentPath: string) {
    const normalizedSourcePath = path.resolve(sourcePath);
    const normalizedFragmentPath = path.resolve(fragmentPath);
    const stat = await this.safeStat(normalizedSourcePath);

    if (!stat?.isFile()) {
      throw new AppError(404, "IFC 원본 파일을 찾을 수 없습니다.");
    }

    if (path.extname(normalizedSourcePath).toLowerCase() !== ".ifc") {
      throw new AppError(400, ".ifc 파일만 변환할 수 있습니다.");
    }

    await ensureDir(path.dirname(normalizedFragmentPath));
    const sourceBytes = await fs.readFile(normalizedSourcePath);
    const fragmentBuffer = await this.convertBytes(sourceBytes);
    await fs.writeFile(normalizedFragmentPath, fragmentBuffer);

    return {
      sourcePath: normalizedSourcePath,
      fragmentPath: normalizedFragmentPath,
      fragmentSize: fragmentBuffer.byteLength
    };
  }

  private async convertBytes(sourceBytes: Buffer) {
    let fragmentBytes: ArrayBuffer | Uint8Array;

    try {
      fragmentBytes = await this.importer.process({
        bytes: new Uint8Array(sourceBytes)
      });
    } catch (error) {
      throw new AppError(
        500,
        `IFC를 FRAG로 변환하지 못했습니다: ${this.getMessage(error)}`
      );
    }

    return fragmentBytes instanceof Uint8Array
      ? Buffer.from(fragmentBytes)
      : Buffer.from(new Uint8Array(fragmentBytes));
  }

  async getResult(conversionId: string): Promise<ConversionResult> {
    throw new AppError(410, `변환 메타데이터 저장이 비활성화되어 있습니다. conversionId=${conversionId}`);
  }

  private resolveWasmPath() {
    const wasmPath = config.webIfcPath;
    return wasmPath.endsWith(path.sep) ? wasmPath : `${wasmPath}${path.sep}`;
  }

  private async safeStat(targetPath: string) {
    try {
      return await fs.stat(targetPath);
    } catch {
      return null;
    }
  }

  private getRelativePathIfInsideUploadRoot(targetPath: string) {
    const normalizedRoot = path.resolve(config.uploadRoot);
    const normalizedTarget = path.resolve(targetPath);

    if (
      normalizedTarget !== normalizedRoot &&
      !normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`)
    ) {
      return null;
    }

    return path.relative(normalizedRoot, normalizedTarget);
  }

  private getMessage(error: unknown) {
    if (error instanceof Error) {
      return error.message;
    }

    return "알 수 없는 오류";
  }
}
