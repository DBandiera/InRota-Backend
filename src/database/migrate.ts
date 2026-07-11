import "dotenv/config";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";
import { createDatabase } from "./client.js";

const config = loadConfig();
const database = createDatabase(config.DATABASE_URL);
const schemaPath = fileURLToPath(new URL("./schema.sql", import.meta.url));
const sql = await readFile(schemaPath, "utf8");

try {
  await database.query(sql);
  console.info("Banco de dados atualizado.");
} finally {
  await database.end();
}
