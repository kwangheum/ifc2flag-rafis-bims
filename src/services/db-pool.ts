import { config } from "../config.js";

type QueryParams = Array<string | number | Date | null>;

export interface QueryResult {
  affectedRows: number;
}

export interface DbConnection {
  query<T>(sql: string, params?: QueryParams): Promise<T>;
  batch(sql: string, rows: QueryParams[]): Promise<void>;
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(): Promise<void>;
}

interface OraclePool {
  getConnection(): Promise<OracleConnection>;
  connectionsOpen: number;
  connectionsInUse: number;
}

interface OracleDbModule {
  createPool(options: {
    user: string;
    password: string;
    connectString: string;
    poolMin: number;
    poolMax: number;
    poolIncrement: number;
  }): Promise<OraclePool>;
}

interface OracleConnection {
  execute<T>(sql: string, binds?: QueryParams, options?: Record<string, unknown>): Promise<{
    rows?: T;
    rowsAffected?: number;
  }>;
  executeMany(sql: string, binds: QueryParams[], options?: Record<string, unknown>): Promise<unknown>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  close(): Promise<void>;
}

interface OdbcPool {
  connect(): Promise<OdbcConnection>;
}

interface OdbcModule {
  pool(options: {
    connectionString: string;
    initialSize: number;
    maxSize: number;
  }): Promise<OdbcPool>;
}

interface OdbcConnection {
  query(sql: string, params?: QueryParams): Promise<unknown>;
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  close(): Promise<void>;
}

interface OdbcQueryResult {
  count?: number;
  rowsAffected?: number;
}

class OracleDbConnection implements DbConnection {
  constructor(private readonly connection: OracleConnection) {}

  async query<T>(sql: string, params: QueryParams = []) {
    const result = await this.connection.execute<T>(
      toOracleSql(sql),
      params,
      { outFormat: 4002 }
    );

    if (isSelect(sql)) {
      return (result.rows ?? []) as T;
    }

    return { affectedRows: result.rowsAffected ?? 0 } as T;
  }

  async batch(sql: string, rows: QueryParams[]) {
    if (rows.length === 0) {
      return;
    }

    await this.connection.executeMany(toOracleSql(sql), rows, { autoCommit: false });
  }

  async beginTransaction() {
    return;
  }

  async commit() {
    await this.connection.commit();
  }

  async rollback() {
    await this.connection.rollback();
  }

  async release() {
    await this.connection.close();
  }
}

class TiberoDbConnection implements DbConnection {
  constructor(private readonly connection: OdbcConnection) {}

  async query<T>(sql: string, params: QueryParams = []) {
    const result = await this.connection.query(sql, params);

    if (isSelect(sql)) {
      return result as T;
    }

    const affectedRows = getOdbcAffectedRows(result);
    return { affectedRows } as T;
  }

  async batch(sql: string, rows: QueryParams[]) {
    for (const row of rows) {
      await this.connection.query(sql, row);
    }
  }

  async beginTransaction() {
    await this.connection.beginTransaction();
  }

  async commit() {
    await this.connection.commit();
  }

  async rollback() {
    await this.connection.rollback();
  }

  async release() {
    await this.connection.close();
  }
}

class DatabasePool {
  private oraclePoolPromise: Promise<OraclePool> | null = null;
  private tiberoPoolPromise: Promise<OdbcPool> | null = null;
  private activeConnectionCount = 0;

  async getConnection(): Promise<DbConnection> {
    this.activeConnectionCount += 1;

    try {
      if (config.db.vendor === "oracle") {
        const pool = await this.getOraclePool();
        return new TrackedDbConnection(new OracleDbConnection(await pool.getConnection()), this);
      }

      const pool = await this.getTiberoPool();
      return new TrackedDbConnection(new TiberoDbConnection(await pool.connect()), this);
    } catch (error) {
      this.activeConnectionCount -= 1;
      throw error;
    }
  }

  activeConnections() {
    return this.activeConnectionCount;
  }

  idleConnections() {
    return Math.max(this.totalConnections() - this.activeConnectionCount, 0);
  }

  totalConnections() {
    return this.oraclePoolPromise ? 10 : this.activeConnectionCount;
  }

  taskQueueSize() {
    return 0;
  }

  releaseConnection() {
    this.activeConnectionCount = Math.max(this.activeConnectionCount - 1, 0);
  }

  private async getOraclePool() {
    this.oraclePoolPromise ??= this.createOraclePool();
    return this.oraclePoolPromise;
  }

  private async createOraclePool(): Promise<OraclePool> {
    const oracledbModule = await import("oracledb");
    const oracledb = getModuleDefault<OracleDbModule>(oracledbModule);
    return oracledb.createPool({
      user: config.db.user,
      password: config.db.password,
      connectString: config.db.connectString,
      poolMin: 0,
      poolMax: 10,
      poolIncrement: 1
    }) as Promise<OraclePool>;
  }

  private async getTiberoPool() {
    this.tiberoPoolPromise ??= this.createTiberoPool();
    return this.tiberoPoolPromise;
  }

  private async createTiberoPool(): Promise<OdbcPool> {
    const odbcModule = await import("odbc");
    const odbc = getModuleDefault<OdbcModule>(odbcModule);
    return odbc.pool({
      connectionString: config.db.connectString,
      initialSize: 0,
      maxSize: 10
    }) as Promise<OdbcPool>;
  }
}

class TrackedDbConnection implements DbConnection {
  private released = false;

  constructor(
    private readonly connection: DbConnection,
    private readonly pool: DatabasePool
  ) {}

  query<T>(sql: string, params?: QueryParams) {
    return this.connection.query<T>(sql, params);
  }

  batch(sql: string, rows: QueryParams[]) {
    return this.connection.batch(sql, rows);
  }

  beginTransaction() {
    return this.connection.beginTransaction();
  }

  commit() {
    return this.connection.commit();
  }

  rollback() {
    return this.connection.rollback();
  }

  async release() {
    if (this.released) {
      return;
    }

    this.released = true;
    try {
      await this.connection.release();
    } finally {
      this.pool.releaseConnection();
    }
  }
}

function isSelect(sql: string) {
  return sql.trimStart().toUpperCase().startsWith("SELECT");
}

function toOracleSql(sql: string) {
  let index = 0;
  return sql.replace(/\?/g, () => `:${++index}`);
}

function getOdbcAffectedRows(result: unknown) {
  if (result && typeof result === "object") {
    const queryResult = result as OdbcQueryResult;
    return queryResult.count ?? queryResult.rowsAffected ?? 0;
  }

  return 0;
}

function getModuleDefault<T>(module: unknown) {
  if (module && typeof module === "object" && "default" in module) {
    return (module as { default: T }).default;
  }

  return module as T;
}

export const dbPool = new DatabasePool();
