/**
 * What a module is: one client tool (their Apps Script page + sheet) served by our backend from the one database.
 * See docs/03-adding-a-module.md for how to add one.
 */
import type { Request, Response, Router } from "express";
import type { Connection } from "mysql2/promise";

/** one call from the page (google.script.run.<fn>(…args)) */
export interface Call {
  req: Request;
  res: Response;
  /** the first argument when it is text — modules use it as the page's session token */
  token: string;
}

export interface Migration {
  version: number;
  name: string;
  statements: string[];
  /** data step run after the statements, on the admin connection */
  run?: (conn: Connection) => Promise<void>;
}

export interface Grant {
  table: string;
  privileges: string;
}

export interface Patch {
  find: string;
  replace: string;
  /** why the client's page had to change here (listed in the module's MODULE.md too) */
  why: string;
}

export interface Job {
  name: string;
  /** run every N minutes … */
  everyMinutes?: number;
  /** … or once a day at this local time, "HH:MM" */
  at?: string;
  run: () => Promise<string>;
}

export interface ModuleDef {
  /** short id: the page is /<id>, calls go to /api/<id>/call/<fn>, tables are named <id>_… */
  id: string;
  title: string;
  page: {
    /** the client's Index.html, path from the project root — served as it is */
    file: string;
    /** values for the page's <?= name ?> scriptlets (Apps Script's doGet template variables) */
    vars?: (req: Request) => Record<string, string>;
    /** the only changes made to the client's page; each must match exactly once */
    patches?: Patch[];
    /** extra Content-Security-Policy sources, e.g. { "img-src": ["https://drive.google.com"] } */
    csp?: Record<string, string[]>;
  };
  /** the server functions the page calls, by the same names as in Code.gs */
  functions: Record<string, (c: Call, ...args: never[]) => unknown>;
  /** login-type functions: limited to a few tries per address and first argument */
  guarded?: string[];
  /** extra endpoints under /api/<id> (files, images) */
  routes?: Router;
  /** largest call body, e.g. "16mb" when the page uploads photos (default 1mb) */
  bodyLimit?: string;
  jobs?: Job[];
  /** what the app's database account may do on this module's tables (and shared tables it writes) */
  grants: Grant[];
  /** this module's migrations; versions are global (see server/src/schema.ts) */
  migrations?: Migration[];
}
