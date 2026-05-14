export interface ConversionResult {
  conversionId: string;
  sourceFileName: string;
  sourcePath: string;
  sourceRelativePath: string | null;
  fragmentFileName: string;
  fragmentPath: string;
  fragmentRelativePath: string | null;
  fragmentSize: number;
  createdAt: string;
}
