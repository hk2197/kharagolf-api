// Unit tests for ObjectStorageService.deleteObjectByPath outcome mapping
// (Task #616). These cover the lightweight branches that don't require a
// configured GCS bucket: empty/missing inputs and data-URLs both map to
// "skipped" so the account-erasure cron never crashes when DB rows hold
// degenerate path values left over from earlier app versions.
import { describe, it, expect } from "vitest";
import { ObjectStorageService } from "../lib/objectStorage.js";

describe("ObjectStorageService.deleteObjectByPath outcome mapping", () => {
  const svc = new ObjectStorageService();

  it("returns 'skipped' for null/empty/whitespace paths", async () => {
    expect(await svc.deleteObjectByPath(null)).toBe("skipped");
    expect(await svc.deleteObjectByPath(undefined)).toBe("skipped");
    expect(await svc.deleteObjectByPath("")).toBe("skipped");
    expect(await svc.deleteObjectByPath("   ")).toBe("skipped");
  });

  it("returns 'skipped' for inline data URLs", async () => {
    expect(
      await svc.deleteObjectByPath("data:image/png;base64,iVBORw0KGgo="),
    ).toBe("skipped");
  });

  it("returns 'skipped' when the value is not a string", async () => {
    // The cron passes Set members through directly; defend against the
    // (impossible-but-cheap-to-check) case where a non-string sneaks in.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await svc.deleteObjectByPath(123 as any)).toBe("skipped");
  });
});
