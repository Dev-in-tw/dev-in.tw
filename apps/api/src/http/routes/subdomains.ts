import { normalizeLabel } from "@dit/dns";
import { listSubdomainActivity } from "../../modules/identity/me.ts";
import { applyPreset, planPresetFor } from "../../modules/presets/service.ts";
import { getPropagation } from "../../modules/propagation/service.ts";
import { prenormalizePresetBody, prenormalizeRecordBody } from "../../modules/records/normalize.ts";
import {
  createRecord,
  deleteRecord,
  listRecords,
  replaceRecord,
  retryRecordSync,
} from "../../modules/records/service.ts";
import {
  createSubdomain,
  getSubdomain,
  listSubdomains,
  releaseSubdomain,
  updateSubdomain,
} from "../../modules/subdomains/service.ts";
import { createTransfer, listTransfers, resolveTransfer } from "../../modules/transfers/service.ts";
import { define, type Registry } from "../define.ts";
import { RECORD_WRITE_RULES, RULES } from "../middleware/rate-limit.ts";

export function subdomainRoutes(reg: Registry): void {
  define(reg, "listSubdomains", async ({ c, user }) => ({
    items: await listSubdomains(c.get("deps"), user),
  }));
  define(
    reg,
    "createSubdomain",
    ({ c, user, body, actor }) => createSubdomain(c.get("deps"), user, body, actor),
    {
      rateLimits: [RULES.createSubdomain],
      normalizeBody: (raw) =>
        raw && typeof raw === "object" && typeof (raw as { name?: unknown }).name === "string"
          ? { ...raw, name: normalizeLabel((raw as { name: string }).name) }
          : raw,
    },
  );
  define(reg, "getSubdomain", ({ c, user, params }) =>
    getSubdomain(c.get("deps"), user, params.name),
  );
  define(reg, "updateSubdomain", ({ c, user, params, body, actor }) =>
    updateSubdomain(c.get("deps"), user, params.name, body, actor),
  );
  define(reg, "releaseSubdomain", ({ c, user, params, body, actor }) =>
    releaseSubdomain(c.get("deps"), user, params.name, body.confirm, actor),
  );
  define(reg, "listSubdomainActivity", ({ c, user, params, query }) =>
    listSubdomainActivity(c.get("deps"), user, params.name, query),
  );
  define(
    reg,
    "getPropagation",
    ({ c, user, params, query }) => getPropagation(c.get("deps"), user, params.name, query),
    {
      rateLimits: [RULES.propagation],
    },
  );

  define(reg, "listRecords", ({ c, user, params }) =>
    listRecords(c.get("deps"), user, params.name),
  );
  define(
    reg,
    "createRecord",
    ({ c, user, params, body, actor }) =>
      createRecord(c.get("deps"), user, params.name, body, actor),
    { rateLimits: RECORD_WRITE_RULES, normalizeBody: prenormalizeRecordBody },
  );
  define(
    reg,
    "replaceRecord",
    ({ c, user, params, body, ifMatch, actor }) =>
      replaceRecord(c.get("deps"), user, params.name, params.recordId, body, ifMatch, actor),
    { rateLimits: RECORD_WRITE_RULES, normalizeBody: prenormalizeRecordBody },
  );
  define(
    reg,
    "deleteRecord",
    ({ c, user, params, ifMatch, actor }) =>
      deleteRecord(c.get("deps"), user, params.name, params.recordId, ifMatch, actor),
    { rateLimits: RECORD_WRITE_RULES },
  );
  define(
    reg,
    "retryRecordSync",
    ({ c, user, params }) => retryRecordSync(c.get("deps"), user, params.name, params.recordId),
    { rateLimits: RECORD_WRITE_RULES },
  );

  define(
    reg,
    "planPreset",
    ({ c, user, params, body }) =>
      planPresetFor(c.get("deps"), user, params.name, params.presetId, body),
    { normalizeBody: prenormalizePresetBody },
  );
  define(
    reg,
    "applyPreset",
    ({ c, user, params, body, actor }) =>
      applyPreset(c.get("deps"), user, params.name, params.presetId, body, actor),
    { rateLimits: [RULES.presetApply], normalizeBody: prenormalizePresetBody },
  );

  define(
    reg,
    "createTransfer",
    ({ c, user, params, body, actor }) =>
      createTransfer(c.get("deps"), user, params.name, body, actor),
    { rateLimits: [RULES.transfer] },
  );
  define(reg, "listTransfers", ({ c, user }) => listTransfers(c.get("deps"), user));
  define(reg, "acceptTransfer", ({ c, user, params, actor }) =>
    resolveTransfer(c.get("deps"), user, params.transferId, "accept", actor),
  );
  define(reg, "declineTransfer", ({ c, user, params, actor }) =>
    resolveTransfer(c.get("deps"), user, params.transferId, "decline", actor),
  );
  define(reg, "cancelTransfer", ({ c, user, params, actor }) =>
    resolveTransfer(c.get("deps"), user, params.transferId, "cancel", actor),
  );
}
