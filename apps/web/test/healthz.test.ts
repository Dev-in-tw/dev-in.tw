import { describe, expect, it } from "vitest";
import { GET } from "../app/healthz/route.ts";

describe("GET /healthz", () => {
  it("returns ok", async () => {
    const res = GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
