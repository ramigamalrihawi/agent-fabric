import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FabricDb, MIGRATIONS, SCHEMA_VERSION } from "../src/db.js";

describe("schema contract", () => {
  it("local ADR-0012 mentions every runtime table when local decisions are present", () => {
    const adrPath = join(process.cwd(), "decisions", "0012-schema-summary.md");
    if (!existsSync(adrPath)) return;

    const db = new FabricDb(":memory:");
    try {
      const rows = db.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as { name: string }[];
      const adr = readFileSync(adrPath, "utf8");

      for (const row of rows) {
        expect(adr, `ADR-0012 should mention table ${row.name}`).toContain(`CREATE TABLE ${row.name}`);
      }
    } finally {
      db.close();
    }
  });

  it("numbered migration metadata reaches the current schema version", () => {
    expect(MIGRATIONS.map((migration) => migration.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(MIGRATIONS.at(-1)?.version).toBe(SCHEMA_VERSION);
  });
});
