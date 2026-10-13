import { describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.ts";

describe("GET /api/healthz", () => {
  it("returns ok", async () => {
    const res = await createApp().request("/api/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("does not serve routes outside /api", async () => {
    const res = await createApp().request("/healthz");
    expect(res.status).toBe(404);
  });
});
