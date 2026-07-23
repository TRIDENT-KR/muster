import { describe, expect, it } from "vitest";
import {
  composeFragments,
  extractManagedBlock,
  managedBlockHash,
  sha256,
  upsertManagedBlock,
} from "../src/compose.js";

describe("composeFragments", () => {
  it("composes fragments in filename order", () => {
    const out = composeFragments([
      { name: "10-typescript", content: "TS rules" },
      { name: "00-org", content: "Org rules" },
    ]);
    expect(out).toBe("Org rules\n\nTS rules");
  });

  it("drops empty fragments and normalizes CRLF", () => {
    const out = composeFragments([
      { name: "00-a", content: "line1\r\nline2\r\n" },
      { name: "01-b", content: "   \n" },
    ]);
    expect(out).toBe("line1\nline2");
  });
});

describe("upsertManagedBlock", () => {
  it("creates a fresh file from the block", () => {
    const out = upsertManagedBlock(null, "Hello");
    expect(out).toContain("<!-- muster:begin -->");
    expect(out).toContain("Hello");
    expect(out.endsWith("<!-- muster:end -->\n")).toBe(true);
  });

  it("preserves existing local content below the managed block on adoption", () => {
    const out = upsertManagedBlock("# My repo notes\n\nDo not lose this.", "Org rules");
    const begin = out.indexOf("<!-- muster:begin -->");
    const local = out.indexOf("# My repo notes");
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(local).toBeGreaterThan(begin);
    expect(out).toContain("Do not lose this.");
  });

  it("replaces an existing block idempotently, leaving local content intact", () => {
    const v1 = upsertManagedBlock("# Local", "Org rules v1");
    const v2 = upsertManagedBlock(v1, "Org rules v2");
    const v2again = upsertManagedBlock(v2, "Org rules v2");
    expect(v2).toBe(v2again);
    expect(v2).toContain("Org rules v2");
    expect(v2).not.toContain("Org rules v1");
    expect(v2).toContain("# Local");
  });
});

describe("managed block hashing", () => {
  it("extracted block hash matches the rendered hash", () => {
    const file = upsertManagedBlock("# Local", "Body");
    const block = extractManagedBlock(file);
    expect(block).not.toBeNull();
    expect(sha256(block as string)).toBe(managedBlockHash("Body"));
  });

  it("returns null when no block exists", () => {
    expect(extractManagedBlock("just text")).toBeNull();
  });
});
