import { describe, expect, it, vi } from "vitest";

const { wranglerMock } = vi.hoisted(() => ({
  wranglerMock: vi.fn(),
}));

vi.mock("../src/lib/wrangler.js", () => ({
  wrangler: wranglerMock,
  WranglerError: class extends Error {
    stderr = "";
  },
}));

import { detectDatabaseSchema } from "../src/steps/database.js";

describe("detectDatabaseSchema", () => {
  it("uses a read-only D1 schema probe and detects pharmacy tables", async () => {
    wranglerMock.mockResolvedValue(
      '[{"results":[{"name":"pharmacy_line_credentials"}]}]',
    );

    await expect(detectDatabaseSchema("db")).resolves.toBe(
      "pharmacy-multitenant",
    );
    expect(wranglerMock).toHaveBeenCalledWith([
      "d1",
      "execute",
      "db",
      "--remote",
      "--json",
      "--command",
      expect.stringContaining("sqlite_master"),
    ]);
  });

  it("keeps a schema without pharmacy markers on the legacy path", async () => {
    wranglerMock.mockResolvedValue('[{"results":[]}]');

    await expect(detectDatabaseSchema("db")).resolves.toBe("legacy");
  });
});
