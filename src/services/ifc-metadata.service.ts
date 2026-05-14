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

interface InsertResultLike {
  insertId: number | bigint | string;
}

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
  async persistConversionMetadata(input: PersistMetadataInput) {
    const extracted = await this.extractMetadata(input.sourcePath);
    extracted.elements = await this.attachLocalIds(input.fragmentPath, extracted.elements);
    extracted.elements = extracted.elements.filter((element) => element.propertySets.length > 0);
    let connection: PoolConnection | undefined;

    try {
      connection = await dbPool.getConnection();
      await connection.beginTransaction();

      await this.deleteExistingModel(connection, input.attachmentId ?? null, input.sourcePath);

      if (extracted.elements.length === 0) {
        await connection.commit();
        return null;
      }

      const insertModelResult = await connection.query<InsertResultLike>(
        `INSERT INTO TB_IFC_MODEL (
          ATCHMNFL_SN,
          FRAGMENT_SIZE,
          MODEL_GUID,
          PROJECT_NAME,
          SCHEMA_NAME
        ) VALUES (?, ?, ?, ?, ?)`,
        [
          input.attachmentId ?? null,
          input.fragmentSize,
          extracted.modelGuid,
          extracted.projectName,
          extracted.schemaName
        ]
      );

      const modelId = Number(insertModelResult.insertId);
      await this.insertElements(connection, modelId, extracted.elements);
      await connection.commit();
      return modelId;
    } catch (error) {
      await connection?.rollback().catch(() => undefined);
      throw new AppError(500, `IFC 메타데이터 저장에 실패했습니다: ${this.getMessage(error)}`);
    } finally {
      connection?.release();
    }
  }

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
        const propertySets = this.extractPropertySets(psets);

        const position = this.extractPosition(line.ObjectPlacement);

        elements.push({
          expressId,
          localId: null,
          globalId: this.unwrapString(line.GlobalId),
          ifcClass: this.normalizeTypeName(line.type, typeInfo.typeName) ?? typeInfo.typeName,
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

  private extractPropertySets(propertySets: Array<Record<string, unknown>>) {
    const merged = new Map<string, ExtractedPropertySet>();

    for (const [index, propertySet] of propertySets.entries()) {
      const extracted = this.extractPropertiesFromSet(propertySet, index);
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

  private extractPropertiesFromSet(propertySet: Record<string, unknown>, propertySetSortOrder: number) {
    const properties: ExtractedProperty[] = [];
    const propertySetName =
      this.unwrapString(propertySet.Name) ?? this.normalizeTypeName(propertySet.type, "PSET") ?? "PSET";
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
      const propertyType = this.normalizeTypeName(typedItem.type, null);
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
          this.normalizeTypeName(propertySet.type, null),
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

  private filterAllowedProperties(properties: ExtractedProperty[]) {
    if (!config.isExcludeInfo) {
      return properties;
    }

    return properties.filter((property) =>
      ALLOWED_PROPERTY_PREFIXES.some((prefix) => property.propertyName.startsWith(prefix))
    );
  }

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

  private toValueText(value: string | number | boolean | null) {
    if (value === null) {
      return null;
    }

    return String(value).slice(0, MAX_VALUE_TEXT_LENGTH);
  }

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

  private unwrapString(value: unknown) {
    const normalized = this.normalizeValue(value);
    return normalized === null ? null : String(normalized);
  }

  private normalizeTypeName(value: unknown, fallback: string | null) {
    const normalized = this.unwrapString(value);
    return normalized ?? fallback;
  }

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

  private async insertElements(
    connection: PoolConnection,
    modelId: number,
    elements: ExtractedElement[]
  ) {
    if (elements.length === 0) {
      return;
    }

    const chunkSize = 200;

    for (let start = 0; start < elements.length; start += chunkSize) {
      const chunk = elements.slice(start, start + chunkSize);
      await connection.batch(
        `INSERT INTO TB_IFC_ELEMENT (
          MODEL_ID,
          EXPRESS_ID,
          LOCAL_ID,
          GLOBAL_ID,
          IFC_CLASS,
          NAME,
          DESCRIPTION,
          OBJECT_TYPE,
          PREDEFINED_TYPE,
          TAG,
          LEVEL_NAME,
          SPATIAL_PATH,
          X,
          Y,
          Z
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        chunk.map((element) => [
          modelId,
          element.expressId,
          element.localId,
          element.globalId,
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
          element.z
        ])
      );
    }

    const insertedElements = await connection.query<Array<{ ID: number; EXPRESS_ID: number }>>(
      `SELECT ID, EXPRESS_ID
       FROM TB_IFC_ELEMENT
       WHERE MODEL_ID = ?`,
      [modelId]
    );

    const elementIdByExpressId = new Map<number, number>();
    for (const row of insertedElements) {
      elementIdByExpressId.set(Number(row.EXPRESS_ID), Number(row.ID));
    }

    const propertySetRows: Array<Array<string | number | null>> = [];

    for (const element of elements) {
      const elementId = elementIdByExpressId.get(element.expressId);
      if (!elementId) {
        continue;
      }

      for (const propertySet of element.propertySets) {
        propertySetRows.push([
          modelId,
          elementId,
          propertySet.propertySetName,
          propertySet.sortOrder
        ]);
      }
    }

    for (let start = 0; start < propertySetRows.length; start += chunkSize) {
      const chunk = propertySetRows.slice(start, start + chunkSize);
      await connection.batch(
        `INSERT INTO TB_IFC_PROPERTY_SET (
          MODEL_ID,
          ELEMENT_ID,
          PROPERTY_SET_NAME,
          SORT_ORDER
        ) VALUES (?, ?, ?, ?)`,
        chunk
      );
    }

    const insertedPropertySets = await connection.query<
      Array<{ ID: number; ELEMENT_ID: number; PROPERTY_SET_NAME: string }>
    >(
      `SELECT ID, ELEMENT_ID, PROPERTY_SET_NAME
       FROM TB_IFC_PROPERTY_SET
       WHERE MODEL_ID = ?`,
      [modelId]
    );

    const propertySetIdByKey = new Map<string, number>();
    for (const row of insertedPropertySets) {
      propertySetIdByKey.set(
        `${Number(row.ELEMENT_ID)}|${row.PROPERTY_SET_NAME}`,
        Number(row.ID)
      );
    }

    const propertyRows: Array<Array<string | number | null>> = [];

    for (const element of elements) {
      const elementId = elementIdByExpressId.get(element.expressId);
      if (!elementId) {
        continue;
      }

      for (const propertySet of element.propertySets) {
        const propertySetId = propertySetIdByKey.get(`${elementId}|${propertySet.propertySetName}`);
        if (!propertySetId) {
          continue;
        }

        for (const property of propertySet.properties) {
          propertyRows.push([
            modelId,
            elementId,
            propertySetId,
            property.propertyName,
            property.propertyType,
            property.valueType,
            property.valueText,
            property.valueNumber,
            property.valueBoolean,
            property.unitName,
            property.sortOrder
          ]);
        }
      }
    }

    for (let start = 0; start < propertyRows.length; start += chunkSize) {
      const chunk = propertyRows.slice(start, start + chunkSize);
      await connection.batch(
        `INSERT INTO TB_IFC_PROPERTY (
          MODEL_ID,
          ELEMENT_ID,
          PROPERTY_SET_ID,
          PROPERTY_NAME,
          PROPERTY_TYPE,
          VALUE_TYPE,
          VALUE_TEXT,
          VALUE_NUMBER,
          VALUE_BOOLEAN,
          UNIT_NAME,
          SORT_ORDER
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        chunk
      );
    }
  }

  private async deleteExistingModel(
    connection: PoolConnection,
    attachmentId: string | null,
    sourcePath: string
  ) {
    if (attachmentId) {
      await connection.query(
        `DELETE FROM TB_IFC_MODEL
         WHERE ATCHMNFL_SN = ?`,
        [attachmentId]
      );
      return;
    }
  }

  private async getIfcApi() {
    if (!ifcApiPromise) {
      ifcApiPromise = this.initIfcApi();
    }

    return ifcApiPromise;
  }

  private async initIfcApi() {
    const api = new WebIFC.IfcAPI();
    const wasmPath = config.webIfcPath.endsWith(path.sep)
      ? config.webIfcPath
      : `${config.webIfcPath}${path.sep}`;
    api.SetWasmPath(wasmPath, true);
    await api.Init();
    return api;
  }

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

  private getMessage(error: unknown) {
    if (error instanceof Error) {
      return error.message;
    }

    return "알 수 없는 오류";
  }
}
