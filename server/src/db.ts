import mysql from "mysql2/promise";
import { config } from "./config";

/** Runtime pool — connects as the least-privilege app account, never as root. */
export const pool = mysql.createPool({
  host: config.DB_HOST,
  port: config.DB_PORT,
  database: config.DB_NAME,
  user: config.DB_USER,
  password: config.DB_PASSWORD,
  ssl: config.DB_SSL ? { rejectUnauthorized: true } : undefined,
  connectionLimit: 10,
  charset: "utf8mb4",
  timezone: "local", // process TZ is the factory's (config.TZ)
  dateStrings: true,
  supportBigNumbers: true,
  // Never allow several statements in one query — closes off a whole class of injection.
  multipleStatements: false,
});

/** A single connection (pooled or not) — what a transaction runs on. */
export type Conn = mysql.Connection;
export type Queryable = mysql.Pool | mysql.Connection;

/**
 * Maintenance scripts (demo load, snapshot restore, renames) need rights the app
 * account deliberately lacks. They connect with the admin account from .env when
 * it is present; on a hardened server it is removed after setup, and must be put
 * back temporarily for such maintenance.
 */
export async function maintenanceConnection(): Promise<mysql.Connection> {
  const user = process.env.DB_ADMIN_USER;
  return mysql.createConnection({
    host: config.DB_HOST,
    port: config.DB_PORT,
    database: config.DB_NAME,
    user: user || config.DB_USER,
    password: user ? (process.env.DB_ADMIN_PASSWORD ?? "") : config.DB_PASSWORD,
    ssl: config.DB_SSL ? { rejectUnauthorized: true } : undefined,
    charset: "utf8mb4",
    timezone: "local",
    dateStrings: true,
    multipleStatements: false,
  });
}
