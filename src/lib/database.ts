import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import { config } from "../config";

const databasePath = path.resolve(process.cwd(), config.betterAuthDatabasePath);
fs.mkdirSync(path.dirname(databasePath), { recursive: true });

export const database = new Database(databasePath);
