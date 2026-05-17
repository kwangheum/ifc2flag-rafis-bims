import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SingleThreadedFragmentsModel } from "@thatopen/fragments";
import type { PoolConnection } from "mariadb";
import * as WebIFC from "web-ifc";
import { AppError } from "../errors.js";
import { config } from "../config.js";
import { dbPool } from "./db-pool.js";

const currentFile = typeof __filename !== "undefined" ? __filename : fileURLToPath(import.meta.url);

interface AffectedRowsLike {
  affectedRows: number | bigint;
}

interface FileAuditMetadata {
  lastUpdusrId: string;
  lastUpdtDt: Date | string;
}

type MetadataValue = string | number | Date | null;

interface PersistMetadataInput {
  attachmentId?: string | null;
  sourcePath: string;
  sourceRelativePath: string | null;
  sourceFileName: string;
  fragmentPath: string;
  fragmentRelativePath: string | null;
  fragmentFileName: string;
  fragmentSize: number;
}

interface ExtractedModelMetadata {
  modelGuid: string | null;
  projectName: string | null;
  schemaName: string | null;
  fileSize: number;
  elements: ExtractedElement[];
}

interface ExtractedElement {
  expressId: number;
  localId: number | null;
  globalId: string | null;
  ifcClass: string;
  name: string | null;
  description: string | null;
  objectType: string | null;
  predefinedType: string | null;
  tag: string | null;
  levelName: string | null;
  spatialPath: string | null;
  x: number | null;
  y: number | null;
  z: number | null;
  propertySets: ExtractedPropertySet[];
}

interface ExtractedPropertySet {
  propertySetName: string;
  sortOrder: number;
  properties: ExtractedProperty[];
}

interface ExtractedProperty {
  propertyName: string;
  propertyType: string | null;
  valueType: string | null;
  valueText: string | null;
  valueNumber: number | null;
  valueBoolean: number | null;
  unitName: string | null;
  sortOrder: number;
}

const MAX_VALUE_TEXT_LENGTH = 65535;
const PROPERTY_SET_EXCLUDE = new Set([
  "expressID",
  "type",
  "GlobalId",
  "OwnerHistory",
  "Name",
  "Description",
  "HasProperties",
  "Quantities",
  "DefinesType",
  "DefinesOccurrence",
  "HasContext",
  "UnitsInContext"
]);
const ALLOWED_PROPERTY_PREFIXES = ["A1_", "A2_", "A3_", "A4_", "A5_", "A6_"];

let ifcApiPromise: Promise<import("web-ifc").IfcAPI> | null = null;

export class IfcMetadataService {
  // 변환된 FRAG 파일과 원본 IFC 파일에서 필요한 메타데이터를 뽑아 TB_IFC_* 테이블에 저장합니다.
  async persistConversionMetadata(input: PersistMetadataInput) {
    const extracted = await this.extractMetadata(input.sourcePath);
    extracted.elements = await this.attachLocalIds(input.fragmentPath, extracted.elements);
    extracted.elements = extracted.elements.filter((element) => element.propertySets.length > 0);
    let connection: PoolConnection | undefined;

    try {
      connection = await dbPool.getConnection();
      await connection.beginTransaction();

      if (!input.attachmentId) {
        throw new AppError(400, "BIM_FILE_ID가 필요합니다.");
      }

      const auditMetadata = await this.getFileAuditMetadata(connection, input.attachmentId);

      await this.deleteExistingModelDetails(connection, input.attachmentId);

      const result = await connection.query<AffectedRowsLike>(
        `UPDATE BIM_CM016D_TB SET
          MODEL_GUID = ?,
          IFC_PROJECT_NM = ?,
          IFC_SCHEMA_NM = ?,
          IFC_CNVR_MG = ?,
          IFC_CNVR_FILE_PATH = ?,
          IFC_CNVR_FILE_NM = ?,
          FRST_REGISTER_ID = ?,
          FRST_REGIST_DT = ?,
          LAST_UPDUSR_ID = ?,
          LAST_UPDT_DT = ?
        WHERE BIM_FILE_ID = ?`,
        [
          extracted.modelGuid,
          extracted.projectName,
          extracted.schemaName,
          input.fragmentSize,
          input.fragmentRelativePath ? path.dirname(input.fragmentRelativePath) : null,
          input.fragmentFileName,
          auditMetadata.lastUpdusrId,
          auditMetadata.lastUpdtDt,
          auditMetadata.lastUpdusrId,
          auditMetadata.lastUpdtDt,
          input.attachmentId
        ]
      );

      if (Number(result.affectedRows) === 0) {
        throw new AppError(404, `BIM 모델 정보를 찾을 수 없습니다. BIM_FILE_ID=${input.attachmentId}`);
      }

      if (extracted.elements.length === 0) {
        await connection.commit();
        return null;
      }

      await this.insertElements(
        connection,
        input.attachmentId,
        extracted.elements,
        auditMetadata
      );

      await connection.commit();
      return null;
    } catch (error) {
      await connection?.rollback().catch(() => undefined);
      throw new AppError(500, `IFC 메타데이터 저장에 실패했습니다: ${this.getMessage(error)}`);
    } finally {
      connection?.release();
    }
  }

  private async getFileAuditMetadata(connection: PoolConnection, attachmentId: string) {
    const rows = await connection.query<FileAuditMetadata[]>(
      `SELECT
         LAST_UPDUSR_ID AS lastUpdusrId,
         LAST_UPDT_DT AS lastUpdtDt
       FROM BIM_CM010D_TB
       WHERE BIM_FILE_ID = ?`,
      [attachmentId]
    );

    const metadata = rows[0];
    if (!metadata?.lastUpdusrId || !metadata.lastUpdtDt) {
      throw new AppError(404, `BIM 파일 정보를 찾을 수 없습니다. BIM_FILE_ID=${attachmentId}`);
    }

    return metadata;
  }

  // web-ifc로 IFC 모델을 열고 프로젝트 정보, 공간 구조, 요소 속성을 추출합니다.
  private async extractMetadata(sourcePath: string): Promise<ExtractedModelMetadata> {
    const api = await this.getIfcApi();
    const bytes = new Uint8Array(await fs.readFile(sourcePath));
    const modelId = api.OpenModel(bytes);

    if (modelId < 0) {
      throw new AppError(500, "IFC 파일을 열지 못했습니다.");
    }

    try {
      const projectIds = api.GetLineIDsWithType(modelId, WebIFC.IFCPROJECT);
      const project =
        projectIds.size() > 0 ? api.GetLine(modelId, projectIds.get(0), false, false) : null;
      const spatialMap = await this.buildSpatialMap(api, modelId);
      const elements = await this.extractElements(api, modelId, spatialMap);

      return {
        modelGuid: this.unwrapString(project?.GlobalId),
        projectName: this.unwrapString(project?.Name),
        schemaName: api.GetModelSchema(modelId) ?? null,
        fileSize: bytes.byteLength,
        elements
      };
    } finally {
      api.CloseModel(modelId);
    }
  }

  // 모델의 모든 IfcElement 계열 객체를 순회하며 기본 정보와 속성 세트를 수집합니다.
  private async extractElements(
    api: import("web-ifc").IfcAPI,
    modelId: number,
    spatialMap: Map<number, { levelName: string | null; spatialPath: string | null }>
  ) {
    const types = api.GetAllTypesOfModel(modelId).filter((typeInfo) => api.IsIfcElement(typeInfo.typeID));
    const elements: ExtractedElement[] = [];

    for (const typeInfo of types) {
      const ids = api.GetLineIDsWithType(modelId, typeInfo.typeID);

      for (let index = 0; index < ids.size(); index += 1) {
        const expressId = ids.get(index);
        const line = api.GetLine(modelId, expressId, false, false);
        const psets = this.getPropertySetsForElement(api, modelId, expressId);
        const spatial = spatialMap.get(expressId);
        const propertySets = this.extractPropertySets(api, psets);

        const position = this.extractPosition(line.ObjectPlacement);

        elements.push({
          expressId,
          localId: null,
          globalId: this.unwrapString(line.GlobalId),
          ifcClass: typeInfo.typeName,
          name: this.unwrapString(line.Name),
          description: this.unwrapString(line.Description),
          objectType: this.unwrapString(line.ObjectType),
          predefinedType: this.unwrapString(line.PredefinedType),
          tag: this.unwrapString(line.Tag),
          levelName: spatial?.levelName ?? null,
          spatialPath: spatial?.spatialPath ?? null,
          x: position?.x ?? null,
          y: position?.y ?? null,
          z: position?.z ?? null,
          propertySets
        });
      }
    }

    return elements;
  }

  // 요소에 직접 연결된 Pset과 타입 객체를 통해 상속된 Pset을 함께 찾아옵니다.
  private getPropertySetsForElement(
    api: import("web-ifc").IfcAPI,
    modelId: number,
    expressId: number
  ) {
    const line = api.GetLine(modelId, expressId, false, true, "IsDefinedBy");
    const relations = Array.isArray(line.IsDefinedBy)
      ? line.IsDefinedBy
      : line.IsDefinedBy
        ? [line.IsDefinedBy]
        : [];
    const propertySets: Array<Record<string, unknown>> = [];
    const seen = new Set<number>();

    for (const relationRef of relations) {
      const relationId =
        relationRef && typeof relationRef === "object" && "value" in relationRef
          ? Number((relationRef as { value: number }).value)
          : null;
      if (!relationId) {
        continue;
      }

      const relationType = api.GetLineType(modelId, relationId);

      if (relationType === WebIFC.IFCRELDEFINESBYPROPERTIES) {
        const relation = api.GetLine(modelId, relationId, false, false);
        const propertySetId = relation.RelatingPropertyDefinition?.value;
        if (typeof propertySetId !== "number" || seen.has(propertySetId)) {
          continue;
        }

        const propertySet = api.GetLine(modelId, propertySetId, true, false);
        propertySets.push(propertySet);
        seen.add(propertySetId);
        continue;
      }

      if (relationType === WebIFC.IFCRELDEFINESBYTYPE) {
        const relation = api.GetLine(modelId, relationId, false, false);
        const typeId = relation.RelatingType?.value;
        if (typeof typeId !== "number") {
          continue;
        }

        const typeObject = api.GetLine(modelId, typeId, false, false);
        const typePropertyRefs = Array.isArray(typeObject.HasPropertySets)
          ? typeObject.HasPropertySets
          : [];

        for (const propertyRef of typePropertyRefs) {
          const propertySetId =
            propertyRef && typeof propertyRef === "object" && "value" in propertyRef
              ? Number((propertyRef as { value: number }).value)
              : null;
          if (!propertySetId || seen.has(propertySetId)) {
            continue;
          }

          const propertySet = api.GetLine(modelId, propertySetId, true, false);
          propertySets.push(propertySet);
          seen.add(propertySetId);
        }
      }
    }

    return propertySets;
  }

  // 같은 이름의 property set을 병합하고 비어 있는 세트는 제외합니다.
  private extractPropertySets(
    api: import("web-ifc").IfcAPI,
    propertySets: Array<Record<string, unknown>>
  ) {
    const merged = new Map<string, ExtractedPropertySet>();

    for (const [index, propertySet] of propertySets.entries()) {
      const extracted = this.extractPropertiesFromSet(api, propertySet, index);
      if (extracted.properties.length === 0) {
        continue;
      }

      const existing = merged.get(extracted.propertySetName);
      if (!existing) {
        merged.set(extracted.propertySetName, extracted);
        continue;
      }

      existing.properties = this.deduplicateProperties([
        ...existing.properties,
        ...extracted.properties
      ]).map((property, propertyIndex) => ({
        ...property,
        sortOrder: propertyIndex
      }));
      existing.sortOrder = Math.min(existing.sortOrder, extracted.sortOrder);
    }

    return [...merged.values()].sort((a, b) => a.sortOrder - b.sortOrder);
  }

  // web-ifc가 풀어준 Pset/Qto 객체에서 저장 가능한 속성 목록을 만듭니다.
  private extractPropertiesFromSet(
    api: import("web-ifc").IfcAPI,
    propertySet: Record<string, unknown>,
    propertySetSortOrder: number
  ) {
    const properties: ExtractedProperty[] = [];
    const propertySetName =
      this.unwrapString(propertySet.Name) ?? this.normalizeTypeName(api, propertySet.type, "PSET") ?? "PSET";
    const relationItems = Array.isArray(propertySet.HasProperties)
      ? propertySet.HasProperties
      : Array.isArray(propertySet.Quantities)
        ? propertySet.Quantities
        : [];
    let sortOrder = 0;

    for (const item of relationItems) {
      if (!item || typeof item !== "object") {
        continue;
      }

      const typedItem = item as Record<string, unknown>;
      const propertyName = this.unwrapString(typedItem.Name) ?? `PROPERTY_${sortOrder + 1}`;
      const propertyType = this.normalizeTypeName(api, typedItem.type, null);
      const normalizedValue = this.extractPropertyValue(typedItem);
      if (normalizedValue === null) {
        continue;
      }

      properties.push(
        this.createPropertyRecord(
          propertyName,
          propertyType,
          normalizedValue.value,
          normalizedValue.unitName,
          sortOrder
        )
      );
      sortOrder += 1;
    }

    for (const [key, rawValue] of Object.entries(propertySet)) {
      if (PROPERTY_SET_EXCLUDE.has(key)) {
        continue;
      }

      const normalizedValue = this.normalizeValue(rawValue);
      if (normalizedValue === null) {
        continue;
      }

      properties.push(
        this.createPropertyRecord(
          key,
          this.normalizeTypeName(api, propertySet.type, null),
          normalizedValue,
          null,
          sortOrder
        )
      );
      sortOrder += 1;
    }

    return {
      propertySetName: propertySetName.slice(0, 255),
      sortOrder: propertySetSortOrder,
      properties: this.filterAllowedProperties(this.deduplicateProperties(properties))
    };
  }

  // 설정에 따라 A1_~A6_ 접두어 속성만 남기거나 전체 속성을 유지합니다.
  private filterAllowedProperties(properties: ExtractedProperty[]) {
    if (!config.isExcludeInfo) {
      return properties;
    }

    return properties.filter((property) =>
      ALLOWED_PROPERTY_PREFIXES.some((prefix) => property.propertyName.startsWith(prefix))
    );
  }

  // 동일한 이름과 값을 가진 속성이 중복 저장되지 않도록 제거합니다.
  private deduplicateProperties(properties: ExtractedProperty[]) {
    const unique = new Map<string, ExtractedProperty>();

    for (const property of properties) {
      const key = `${property.propertyName}|${property.valueText ?? ""}|${property.valueNumber ?? ""}|${property.valueBoolean ?? ""}`;
      if (!unique.has(key)) {
        unique.set(key, property);
      }
    }

    return [...unique.values()];
  }

  // IFC 속성 타입별 대표 값 필드를 찾아 일반 값과 단위명으로 정리합니다.
  private extractPropertyValue(property: Record<string, unknown>) {
    if ("NominalValue" in property) {
      return {
        value: this.normalizeValue(property.NominalValue),
        unitName: this.unwrapString(property.Unit)
      };
    }

    if ("EnumerationValues" in property) {
      return {
        value: this.normalizeValue(property.EnumerationValues),
        unitName: this.unwrapString(property.Unit)
      };
    }

    if ("ListValues" in property) {
      return {
        value: this.normalizeValue(property.ListValues),
        unitName: this.unwrapString(property.Unit)
      };
    }

    for (const [key, rawValue] of Object.entries(property)) {
      if (
        key === "Name" ||
        key === "Description" ||
        key === "Unit" ||
        key === "Formula" ||
        key === "type" ||
        key === "expressID"
      ) {
        continue;
      }

      if (key.endsWith("Value") || key.endsWith("Values")) {
        return {
          value: this.normalizeValue(rawValue),
          unitName: this.unwrapString(property.Unit)
        };
      }
    }

    for (const [key, rawValue] of Object.entries(property)) {
      if (PROPERTY_SET_EXCLUDE.has(key)) {
        continue;
      }

      const normalized = this.normalizeValue(rawValue);
      if (normalized !== null) {
        return {
          value: normalized,
          unitName: this.unwrapString(property.Unit)
        };
      }
    }

    return null;
  }

  // DB 컬럼 길이와 타입 컬럼에 맞게 속성 한 건을 표준 형태로 만듭니다.
  private createPropertyRecord(
    propertyName: string,
    propertyType: string | null,
    rawValue: string | number | boolean | null,
    unitName: string | null,
    sortOrder: number
  ): ExtractedProperty {
    const valueType = this.getValueType(rawValue);
    return {
      propertyName: propertyName.slice(0, 255),
      propertyType: propertyType?.slice(0, 100) ?? null,
      valueType,
      valueText: this.toValueText(rawValue),
      valueNumber: typeof rawValue === "number" ? rawValue : null,
      valueBoolean: typeof rawValue === "boolean" ? Number(rawValue) : null,
      unitName: unitName?.slice(0, 100) ?? null,
      sortOrder
    };
  }

  // JS 값 타입을 DB에 저장할 값 타입 문자열로 변환합니다.
  private getValueType(value: string | number | boolean | null) {
    if (typeof value === "string") {
      return "STRING";
    }
    if (typeof value === "number") {
      return "NUMBER";
    }
    if (typeof value === "boolean") {
      return "BOOLEAN";
    }
    return null;
  }

  // 검색/표시용 문자열 컬럼에 들어갈 값을 길이 제한에 맞춰 만듭니다.
  private toValueText(value: string | number | boolean | null) {
    if (value === null) {
      return null;
    }

    return String(value).slice(0, MAX_VALUE_TEXT_LENGTH);
  }

  // web-ifc의 래퍼 객체, 배열, 좌표 객체 등을 문자열/숫자/불리언 값으로 평탄화합니다.
  private normalizeValue(value: unknown): string | number | boolean | null {
    if (value === null || value === undefined) {
      return null;
    }

    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return value;
    }

    if (Array.isArray(value)) {
      const items = value
        .map((item) => this.normalizeValue(item))
        .filter((item): item is string | number | boolean => item !== null);

      if (items.length === 0) {
        return null;
      }

      return items.join(", ");
    }

    if (typeof value === "object") {
      const record = value as Record<string, unknown>;

      if ("value" in record) {
        return this.normalizeValue(record.value);
      }

      if ("x" in record && "y" in record && "z" in record) {
        const x = this.normalizeValue(record.x);
        const y = this.normalizeValue(record.y);
        const z = this.normalizeValue(record.z);
        return [x, y, z].filter((item) => item !== null).join(", ");
      }

      const flattened = Object.entries(record)
        .filter(([key]) => key !== "type" && key !== "name" && key !== "label")
        .map(([, item]) => this.normalizeValue(item))
        .filter((item): item is string | number | boolean => item !== null);

      if (flattened.length === 0) {
        return null;
      }

      return flattened.join(", ");
    }

    return null;
  }

  // normalizeValue 결과를 문자열로 통일합니다.
  private unwrapString(value: unknown) {
    const normalized = this.normalizeValue(value);
    return normalized === null ? null : String(normalized);
  }

  // IFC type 값을 사람이 읽을 수 있는 문자열로 바꾸고 없으면 fallback을 사용합니다.
  private normalizeTypeName(
    api: import("web-ifc").IfcAPI,
    value: unknown,
    fallback: string | null
  ) {
    if (typeof value === "number") {
      const typeName = api.GetNameFromTypeCode(value);
      return typeName || fallback;
    }

    const normalized = this.unwrapString(value);
    return normalized ?? fallback;
  }

  // ObjectPlacement의 상대 배치 좌표에서 x/y/z 값을 추출합니다.
  private extractPosition(objectPlacement: unknown) {
    if (!objectPlacement || typeof objectPlacement !== "object") {
      return null;
    }

    const placementRel = (objectPlacement as Record<string, unknown>).RelativePlacement;
    if (!placementRel || typeof placementRel !== "object") {
      return null;
    }

    const location = (placementRel as Record<string, unknown>).Location;
    if (!location || typeof location !== "object") {
      return null;
    }

    const coordinates = (location as Record<string, unknown>).Coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 3) {
      return null;
    }

    const x = Number(this.normalizeValue(coordinates[0]));
    const y = Number(this.normalizeValue(coordinates[1]));
    const z = Number(this.normalizeValue(coordinates[2]));

    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      return null;
    }

    return { x, y, z };
  }

  // IFC 공간 트리를 순회해 각 expressID가 어느 층/공간 경로에 속하는지 매핑합니다.
  private async buildSpatialMap(api: import("web-ifc").IfcAPI, modelId: number) {
    const spatialMap = new Map<number, { levelName: string | null; spatialPath: string | null }>();
    const spatialTree = await api.properties.getSpatialStructure(modelId, true);

    const visit = (
      node: Record<string, unknown>,
      pathParts: string[],
      currentLevelName: string | null
    ) => {
      const nodeName = this.unwrapString(node.Name) ?? this.unwrapString(node.type) ?? "UNKNOWN";
      const nextPathParts = [...pathParts, nodeName];
      const nextLevelName = node.type === "IFCBUILDINGSTOREY" ? nodeName : currentLevelName;

      if (typeof node.expressID === "number") {
        spatialMap.set(node.expressID, {
          levelName: nextLevelName,
          spatialPath: nextPathParts.join("/")
        });
      }

      for (const key of ["children", "IsDecomposedBy", "ContainsElements"]) {
        const children = node[key];
        if (!Array.isArray(children)) {
          continue;
        }

        for (const child of children) {
          if (child && typeof child === "object") {
            visit(child as Record<string, unknown>, nextPathParts, nextLevelName);
          }
        }
      }
    };

    visit(spatialTree as unknown as Record<string, unknown>, [], null);
    return spatialMap;
  }

  // 요소, property set, property를 순서대로 bulk insert하고 생성된 ID를 서로 연결합니다.
  private async insertElements(
    connection: PoolConnection,
    attachmentId: string,
    elements: ExtractedElement[],
    auditMetadata: FileAuditMetadata
  ) {
    if (elements.length === 0) {
      return;
    }

    const chunkSize = 200;

    for (let start = 0; start < elements.length; start += chunkSize) {
      const chunk = elements.slice(start, start + chunkSize);
      await connection.batch(
        `INSERT INTO BIM_CM017D_TB (
          BIM_FILE_ID,
          OBJ_ID,
          IFC_EXPRESS_ID,
          IFC_CLASS,
          OBJ_NM,
          OBJ_DESC,
          OBJ_TYPE,
          OBJ_PREDEFINED_TYPE,
          OBJ_TAG,
          OBJ_LEVEL_NM,
          OBJ_SPATIAL_PATH,
          OBJ_X,
          OBJ_Y,
          OBJ_Z,
          FRST_REGISTER_ID,
          FRST_REGIST_DT,
          LAST_UPDUSR_ID,
          LAST_UPDT_DT
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        chunk.map((element) => [
          attachmentId,
          element.globalId ?? String(element.expressId),
          element.expressId,
          element.ifcClass,
          element.name,
          element.description,
          element.objectType,
          element.predefinedType,
          element.tag,
          element.levelName,
          element.spatialPath,
          element.x,
          element.y,
          element.z,
          auditMetadata.lastUpdusrId,
          auditMetadata.lastUpdtDt,
          auditMetadata.lastUpdusrId,
          auditMetadata.lastUpdtDt
        ])
      );
    }

    const insertedElements = await connection.query<Array<{ objId: string; expressId: number }>>(
      `SELECT OBJ_ID AS objId, IFC_EXPRESS_ID AS expressId
       FROM BIM_CM017D_TB
       WHERE BIM_FILE_ID = ?`,
      [attachmentId]
    );

    const elementIdByExpressId = new Map<number, string>();
    for (const row of insertedElements) {
      elementIdByExpressId.set(Number(row.expressId), row.objId);
    }

    const propertySetRows: MetadataValue[][] = [];

    for (const element of elements) {
      const elementId = elementIdByExpressId.get(element.expressId);
      if (!elementId) {
        continue;
      }

      for (const propertySet of element.propertySets) {
        propertySetRows.push([
          attachmentId,
          elementId,
          element.expressId,
          propertySet.sortOrder,
          propertySet.propertySetName,
          propertySet.sortOrder,
          auditMetadata.lastUpdusrId,
          auditMetadata.lastUpdtDt,
          auditMetadata.lastUpdusrId,
          auditMetadata.lastUpdtDt
        ]);
      }
    }

    for (let start = 0; start < propertySetRows.length; start += chunkSize) {
      const chunk = propertySetRows.slice(start, start + chunkSize);
      await connection.batch(
        `INSERT INTO BIM_CM018D_TB (
          BIM_FILE_ID,
          OBJ_ID,
          IFC_EXPRESS_ID,
          PROPERTY_SN,
          PROPERTY_NM,
          ORDR,
          FRST_REGISTER_ID,
          FRST_REGIST_DT,
          LAST_UPDUSR_ID,
          LAST_UPDT_DT
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        chunk
      );
    }

    const insertedPropertySets = await connection.query<
      Array<{ propertySn: number; objId: string; expressId: number; propertyName: string }>
    >(
      `SELECT
         PROPERTY_SN AS propertySn,
         OBJ_ID AS objId,
         IFC_EXPRESS_ID AS expressId,
         PROPERTY_NM AS propertyName
       FROM BIM_CM018D_TB
       WHERE BIM_FILE_ID = ?`,
      [attachmentId]
    );

    const propertySetIdByKey = new Map<string, number>();
    for (const row of insertedPropertySets) {
      propertySetIdByKey.set(
        `${row.objId}|${Number(row.expressId)}|${row.propertyName}`,
        Number(row.propertySn)
      );
    }

    const propertyRows: MetadataValue[][] = [];

    for (const element of elements) {
      const elementId = elementIdByExpressId.get(element.expressId);
      if (!elementId) {
        continue;
      }

      for (const propertySet of element.propertySets) {
        const propertySetId = propertySetIdByKey.get(
          `${elementId}|${element.expressId}|${propertySet.propertySetName}`
        );
        if (!propertySetId) {
          continue;
        }

        for (const property of propertySet.properties) {
          propertyRows.push([
            attachmentId,
            elementId,
            element.expressId,
            propertySetId,
            property.sortOrder,
            property.propertyName,
            property.propertyType ?? property.valueType,
            property.valueText,
            property.unitName,
            property.sortOrder,
            auditMetadata.lastUpdusrId,
            auditMetadata.lastUpdtDt,
            auditMetadata.lastUpdusrId,
            auditMetadata.lastUpdtDt
          ]);
        }
      }
    }

    for (let start = 0; start < propertyRows.length; start += chunkSize) {
      const chunk = propertyRows.slice(start, start + chunkSize);
      await connection.batch(
        `INSERT INTO BIM_CM019D_TB (
          BIM_FILE_ID,
          OBJ_ID,
          IFC_EXPRESS_ID,
          PROPERTY_SN,
          PROPERTY_DETAIL_SN,
          PROPERTY_DETAIL_NM,
          PROPERTY_DETAIL_TYPE,
          PROPERTY_DETAIL_VALUE,
          PROPERTY_DETAIL_UNIT_NM,
          ORDR,
          FRST_REGISTER_ID,
          FRST_REGIST_DT,
          LAST_UPDUSR_ID,
          LAST_UPDT_DT
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        chunk
      );
    }
  }

  // 같은 첨부파일을 다시 변환할 때 이전 IFC 상세 메타데이터를 먼저 제거합니다.
  private async deleteExistingModelDetails(
    connection: PoolConnection,
    attachmentId: string
  ) {
    const metadataTables = [
      "BIM_CM019D_TB",
      "BIM_CM018D_TB",
      "BIM_CM017D_TB"
    ];

    for (const tableName of metadataTables) {
      await connection.query(
        `DELETE FROM ${tableName}
         WHERE BIM_FILE_ID = ?`,
        [attachmentId]
      );
    }
  }

  // web-ifc 초기화 비용을 줄이기 위해 IfcAPI 인스턴스를 프로세스 안에서 재사용합니다.
  private async getIfcApi() {
    if (!ifcApiPromise) {
      ifcApiPromise = this.initIfcApi();
    }

    return ifcApiPromise;
  }

  // web-ifc WASM 경로를 지정하고 IfcAPI를 초기화합니다.
  private async initIfcApi() {
    const api = new WebIFC.IfcAPI();
    const wasmPath = config.webIfcPath.endsWith(path.sep)
      ? config.webIfcPath
      : `${config.webIfcPath}${path.sep}`;
    api.SetWasmPath(wasmPath, true);
    await api.Init();
    return api;
  }

  // FRAG 모델에서 globalId에 대응하는 localId를 찾아 IFC 요소 메타데이터에 보강합니다.
  private async attachLocalIds(fragmentPath: string, elements: ExtractedElement[]) {
    if (elements.length === 0) {
      return elements;
    }

    const elementsWithGuid = elements.filter((element) => element.globalId);
    if (elementsWithGuid.length === 0) {
      return elements;
    }

    const fragmentBuffer = new Uint8Array(await fs.readFile(fragmentPath));
    const fragmentModel = new SingleThreadedFragmentsModel(
      `metadata-${Date.now()}`,
      fragmentBuffer,
      false
    );

    try {
      const guids = elementsWithGuid.map((element) => element.globalId as string);
      const localIds = fragmentModel.getLocalIdsByGuids(guids);
      const localIdByGlobalId = new Map<string, number>();

      for (let index = 0; index < guids.length; index += 1) {
        const localId = localIds[index];
        if (localId === null || localId === undefined) {
          continue;
        }
        localIdByGlobalId.set(guids[index], localId);
      }

      return elements.map((element) => ({
        ...element,
        localId: element.globalId ? (localIdByGlobalId.get(element.globalId) ?? null) : null
      }));
    } finally {
      fragmentModel.dispose();
    }
  }

  // unknown 타입 오류에서 운영 로그에 남길 메시지를 안전하게 꺼냅니다.
  private getMessage(error: unknown) {
    if (error instanceof Error) {
      return error.message;
    }

    return "알 수 없는 오류";
  }
}
