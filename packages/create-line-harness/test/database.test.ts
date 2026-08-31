import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertLegacyCredentialSqlAllowed,
  assertLegacySetupBundleAllowed,
  classifyDatabaseSchema,
  type DatabaseSchema,
} from "../src/steps/database.js";

describe("database schema guard", () => {
  it("keeps a generic schema on the legacy path", () => {
    expect(
      classifyDatabaseSchema('[{"results":[{"name":"line_accounts"}]}]'),
    ).toBe("legacy");
  });

  it.each(["tenants", "tenant_line_accounts", "pharmacy_line_credentials"])(
    "detects the central pharmacy schema from %s",
    (table) => {
      expect(
        classifyDatabaseSchema(`[{"results":[{"name":"${table}"}]}]`),
      ).toBe("pharmacy-multitenant");
    },
  );

  it("fails closed when the schema probe output is not valid D1 JSON", () => {
    expect(() => classifyDatabaseSchema("not-json")).toThrow(
      "D1 schema probe returned invalid JSON",
    );
  });

  it("allows direct credential SQL only for the legacy schema", () => {
    const schemas: DatabaseSchema[] = ["legacy"];
    for (const schema of schemas) {
      expect(() => assertLegacyCredentialSqlAllowed(schema)).not.toThrow();
    }
  });

  it("rejects direct credential SQL for the central pharmacy schema", () => {
    expect(() => assertLegacyCredentialSqlAllowed("pharmacy-multitenant")).toThrow(
      "central pharmacy provisioning",
    );
  });

  it("rejects a central pharmacy bundle before standalone setup can mutate Cloudflare", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "line-harness-setup-"));
    mkdirSync(join(repoDir, "packages", "db"), { recursive: true });
    writeFileSync(
      join(repoDir, "packages", "db", "bootstrap-meta.json"),
      JSON.stringify({
        schemaMode: "pharmacy-multitenant",
        includedMigrations: ["001_v033_baseline.sql"],
        migrationCount: 1,
      }),
    );

    expect(() => assertLegacySetupBundleAllowed(repoDir)).toThrow(
      "tenant:setup",
    );
  });

  it("keeps a generic bundle on the standalone setup path", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "line-harness-setup-"));
    mkdirSync(join(repoDir, "packages", "db"), { recursive: true });
    writeFileSync(
      join(repoDir, "packages", "db", "bootstrap-meta.json"),
      JSON.stringify({ includedMigrations: ["001_round2.sql"], migrationCount: 1 }),
    );

    expect(() => assertLegacySetupBundleAllowed(repoDir)).not.toThrow();
  });
});
