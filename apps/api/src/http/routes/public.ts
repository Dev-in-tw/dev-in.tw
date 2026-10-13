import { createReport } from "../../modules/moderation/reports.ts";
import { checkAvailability } from "../../modules/naming/availability.ts";
import { listPresets } from "../../modules/presets/service.ts";
import { getMeta, getStats, getStatus, listDirectory } from "../../modules/public/service.ts";
import { define, type Registry } from "../define.ts";
import { RULES } from "../middleware/rate-limit.ts";

export function publicRoutes(reg: Registry): void {
  define(reg, "getMeta", ({ c }) => getMeta(c.get("deps")));
  define(reg, "getStats", ({ c }) => getStats(c.get("deps")));
  define(reg, "getStatus", ({ c }) => getStatus(c.get("deps")));
  define(reg, "listDirectory", ({ c, query }) => listDirectory(c.get("deps"), query));
  define(reg, "listPresets", async () => ({ items: listPresets() }));
  define(
    reg,
    "checkAvailability",
    ({ c, params, user }) => {
      const deps = c.get("deps");
      return checkAvailability(deps.db, deps.config, params.name, user, deps.clock.now());
    },
    { rateLimits: [RULES.availability] },
  );
  define(
    reg,
    "createReport",
    ({ c, body, user, actor }) =>
      createReport(c.get("deps"), body, { userId: user?.id ?? null }, actor),
    { rateLimits: [RULES.report] },
  );
}
