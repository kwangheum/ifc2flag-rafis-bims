import * as mariadb from "mariadb";
import { config } from "../config.js";

export const dbPool = mariadb.createPool({
  host: config.db.host,
  port: config.db.port,
  database: config.db.database,
  user: config.db.user,
  password: config.db.password,
  connectionLimit: 10,
  minimumIdle: 0,
  acquireTimeout: 10000,
  idleTimeout: 60,
  leakDetectionTimeout: 30000
});
