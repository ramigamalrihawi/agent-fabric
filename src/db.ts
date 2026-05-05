import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

export const SCHEMA_VERSION = 14;

// Migration metadata. The SQL bodies live next to this file under
// `migrations/<version>-<name>.sql`. Adding a new migration means dropping a
// new SQL file in that directory and appending an entry here.
//
// Naming convention: files match `^(\d{4})-([a-z0-9-]+)\.sql$`. The numeric
// prefix is the schema version; the name is informational.
export const MIGRATIONS: readonly { version: number; name: string }[] = [
  { version: 1, name: "init" },
  { version: 2, name: "session-expiry" },
  { version: 3, name: "tool-coverage" },
  { version: 4, name: "notification-self-test" },
  { version: 5, name: "bi-temporal-memory" },
  { version: 6, name: "plan-chains" },
  { version: 7, name: "llm-preflight" },
  { version: 8, name: "approval-requests" },
  { version: 9, name: "worker-tasks" },
  { version: 10, name: "route-outcomes" },
  { version: 11, name: "context-packages" },
  { version: 12, name: "policy-aliases" },
  { version: 13, name: "project-queues" },
  { version: 14, name: "project-task-context-requirements" }
];

const MIGRATIONS_DIR = (() => {
  // Compiled output: dist/db.js → dist/migrations/
  // Source via tsx: src/db.ts → src/migrations/
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "migrations");
})();

export class FabricDb {
  readonly db: DatabaseSync;
  readonly path: string;

  constructor(path: string) {
    this.path = path;
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
    this.secureDatabaseFiles();
  }

  close(): void {
    this.secureDatabaseFiles();
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const result = fn();
      this.db.exec("COMMIT;");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  schemaVersion(): number {
    const row = this.db.prepare("SELECT MAX(version) AS version FROM _schema_versions").get() as { version: number | null };
    return row.version ?? 0;
  }

  // Migration runner. Each migration:
  //   1. Runs in its own transaction — partial migrations are impossible.
  //   2. Splits the SQL file into individual statements.
  //   3. For each statement: if it's `ALTER TABLE ... ADD COLUMN ...` and the
  //      column already exists, skip just that statement (SQLite has no
  //      `IF NOT EXISTS` for ADD COLUMN). All other statements use
  //      `CREATE ... IF NOT EXISTS` and run unconditionally.
  //   4. On success, append the version row and commit.
  //
  // This means a partial-state DB (column present but a sibling table missing,
  // or any other interrupted state) self-repairs cleanly on next startup.
  private migrate(): void {
    this.db.exec(SCHEMA_VERSION_BOOTSTRAP);
    const existing = this.schemaVersion();
    const migrations = loadMigrationFiles();

    for (const migration of migrations) {
      if (migration.version <= existing) continue;
      this.db.exec("BEGIN IMMEDIATE;");
      try {
        for (const statement of splitStatements(migration.sql)) {
          if (this.statementShouldBeSkipped(statement)) continue;
          this.db.exec(statement);
        }
        this.db
          .prepare("INSERT OR REPLACE INTO _schema_versions(version, name) VALUES (?, ?)")
          .run(migration.version, migration.name);
        this.db.exec("COMMIT;");
      } catch (error) {
        this.db.exec("ROLLBACK;");
        throw error;
      }
    }
  }

  private statementShouldBeSkipped(statement: string): boolean {
    const match = ALTER_ADD_COLUMN.exec(statement);
    if (!match) return false;
    const [, table, column] = match;
    return columnExists(this.db, table, column);
  }

  private secureDatabaseFiles(): void {
    if (this.path === ":memory:") return;
    for (const suffix of ["", "-wal", "-shm"]) {
      const file = `${this.path}${suffix}`;
      if (existsSync(file)) {
        chmodSync(file, 0o600);
      }
    }
  }
}

const SCHEMA_VERSION_BOOTSTRAP = `
CREATE TABLE IF NOT EXISTS _schema_versions (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`;

const ALTER_ADD_COLUMN = /^\s*ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)/i;

type LoadedMigration = { version: number; name: string; sql: string };

function loadMigrationFiles(): LoadedMigration[] {
  const filenamePattern = /^(\d{4})-([a-z0-9-]+)\.sql$/;
  const files = readdirSync(MIGRATIONS_DIR);
  const loaded: LoadedMigration[] = [];

  for (const filename of files) {
    const match = filenamePattern.exec(filename);
    if (!match) continue;
    const version = Number(match[1]);
    const name = match[2];
    const declared = MIGRATIONS.find((entry) => entry.version === version);
    if (!declared) {
      throw new Error(`migration ${filename} on disk has no entry in MIGRATIONS metadata`);
    }
    if (declared.name !== name) {
      throw new Error(`migration ${filename} on disk does not match MIGRATIONS metadata name "${declared.name}"`);
    }
    const sql = readFileSync(join(MIGRATIONS_DIR, filename), "utf8");
    loaded.push({ version, name, sql });
  }

  for (const entry of MIGRATIONS) {
    if (!loaded.some((migration) => migration.version === entry.version)) {
      throw new Error(`MIGRATIONS metadata references version ${entry.version} but no SQL file was found`);
    }
  }

  loaded.sort((a, b) => a.version - b.version);
  return loaded;
}

// Split a SQL file into individual statements. Strips line and block comments
// first; relies on the fact that our migration SQL contains no string literals
// with embedded semicolons (controlled inputs).
function splitStatements(sql: string): string[] {
  const stripped = sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
  return stripped
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
    .map((statement) => `${statement};`);
}

function columnExists(db: DatabaseSync, table: string, column: string): boolean {
  const tableRow = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { name: string } | undefined;
  if (!tableRow) return false;
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return columns.some((entry) => entry.name === column);
}
