import fs from "node:fs/promises";
import path from "node:path";
import { IfcImporter } from "@thatopen/fragments";
import { config } from "../config.js";
import { AppError } from "../errors.js";
import type { ConversionResult } from "../types.js";
import { ensureDir, ensureInsideRoot } from "../utils/fs.js";
import { IfcMetadataService } from "./ifc-metadata.service.js";

export class IfcToFragService {
  private readonly importer = new IfcImporter();
  private readonly metadataService = new IfcMetadataService();

  // web-ifc WASM 파일 위치를 IfcImporter에 알려줘서 Node 환경에서도 변환할 수 있게 합니다.
  constructor() {
    this.importer.wasm = {
      absolute: true,
      path: this.resolveWasmPath()
    };
  }

  // DB 첨부파일 경로처럼 저장된 경로 문자열을 업로드 루트 안의 안전한 실제 경로로 변환합니다.
  async convertStoredPath(sourcePath: string, attachmentId?: string) {
    const normalizedRelativePath = sourcePath.replace(/^[/\\]+/, "");
    const targetPath = ensureInsideRoot(
      config.uploadRoot,
      path.join(config.uploadRoot, normalizedRelativePath)
    );

    return this.convertFile(targetPath, attachmentId);
  }

  // IFC 파일 하나를 읽어 같은 폴더의 frags 디렉터리에 .frag 파일로 저장하고 메타데이터를 적재합니다.
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
    const fragmentFileName = `${baseName}.frag`;
    const fragmentPath = path.join(fragmentDirectory, fragmentFileName);

    await ensureDir(fragmentDirectory);

    const fragmentBuffer = await this.convertBytes(sourceBytes);

    await fs.writeFile(fragmentPath, fragmentBuffer);

    const result: ConversionResult = {
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

  // That Open IfcImporter에 IFC 바이트를 넘겨 실제 FRAG 바이트를 생성합니다.
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

  // web-ifc WASM 디렉터리 경로가 항상 구분자로 끝나도록 맞춥니다.
  private resolveWasmPath() {
    const wasmPath = config.webIfcPath;
    return wasmPath.endsWith(path.sep) ? wasmPath : `${wasmPath}${path.sep}`;
  }

  // 파일 존재 여부 확인에서 ENOENT 같은 오류를 예외로 올리지 않고 null로 처리합니다.
  private async safeStat(targetPath: string) {
    try {
      return await fs.stat(targetPath);
    } catch {
      return null;
    }
  }

  // 변환 결과 응답에서 /files 경로로 내려줄 수 있도록 업로드 루트 기준 상대 경로를 계산합니다.
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

  // unknown 타입 오류에서 사용자에게 보여줄 메시지만 안전하게 꺼냅니다.
  private getMessage(error: unknown) {
    if (error instanceof Error) {
      return error.message;
    }

    return "알 수 없는 오류";
  }
}
