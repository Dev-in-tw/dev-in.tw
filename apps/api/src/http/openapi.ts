import { type Endpoint, ERROR_STATUS, endpoints, Problem } from "@dit/contract";
import { z } from "zod";
import { toHonoPath } from "./define.ts";

type JsonSchema = Record<string, unknown>;

const toSchema = (schema: z.ZodType, io: "input" | "output"): JsonSchema => {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, {
    io,
    unrepresentable: "any",
  }) as JsonSchema;
  return rest;
};

function parametersOf(ep: Endpoint) {
  const out: JsonSchema[] = [];
  const add = (schema: z.ZodObject | undefined, location: "path" | "query") => {
    if (!schema) return;
    const json = toSchema(schema, "input") as {
      properties?: Record<string, JsonSchema>;
      required?: string[];
    };
    for (const [name, prop] of Object.entries(json.properties ?? {})) {
      out.push({
        name,
        in: location,
        required: location === "path" || (json.required ?? []).includes(name),
        schema: prop,
      });
    }
  };
  add(ep.params, "path");
  add(ep.query, "query");
  for (const header of ep.headers ?? []) {
    out.push({ name: header, in: "header", required: false, schema: { type: "string" } });
  }
  return out;
}

/** 由合約的 endpoint map 產生 OpenAPI 3.1（路徑集合與 endpoint map 完全相同） */
export function buildOpenApi(opts: { serverUrl: string; version: string }) {
  const problem = toSchema(Problem, "output");
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [name, ep] of Object.entries(endpoints) as [string, Endpoint][]) {
    const path = `/api${toHonoPath(ep.path).replace(/:(\w+)/g, "{$1}")}`;
    const responses: Record<string, unknown> = {};
    if (ep.response) {
      responses[String(ep.status)] = {
        description: "OK",
        content: { "application/json": { schema: toSchema(ep.response, "output") } },
      };
    } else if (name === "events") {
      responses[String(ep.status)] = {
        description: "Server-Sent Events（ServerEvent）",
        content: { "text/event-stream": {} },
      };
    } else {
      responses[String(ep.status)] = {
        description: ep.status === 302 || ep.status === 303 ? "Redirect" : "No content",
      };
    }
    const statuses = new Set<number>(ep.errors.map((code) => ERROR_STATUS[code]));
    statuses.add(500);
    for (const status of [...statuses].sort()) {
      const codes = ep.errors.filter((code) => ERROR_STATUS[code] === status);
      responses[String(status)] = {
        description: codes.length ? codes.join(" | ") : "INTERNAL",
        content: {
          "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } },
        },
      };
    }
    paths[path] ??= {};
    paths[path][ep.method.toLowerCase()] = {
      operationId: name,
      tags: [ep.path.split("/")[1] ?? "misc"],
      ...(ep.auth !== "public" ? { security: [{ session: [] }] } : {}),
      "x-auth": ep.auth,
      parameters: parametersOf(ep),
      ...(ep.body
        ? {
            requestBody: {
              required: true,
              content: { "application/json": { schema: toSchema(ep.body, "input") } },
            },
          }
        : {}),
      responses,
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Dev-in.tw API",
      version: opts.version,
      description:
        "Dev-in.tw（Lazco Labs）API。所有寫入請求需同源（Origin 與 Sec-Fetch-Site 檢查），錯誤格式為 RFC 9457 problem+json。",
      license: { name: "AGPL-3.0-only", identifier: "AGPL-3.0-only" },
    },
    servers: [{ url: opts.serverUrl }],
    paths,
    components: {
      schemas: { Problem: problem },
      securitySchemes: { session: { type: "apiKey", in: "cookie", name: "__Host-dit_session" } },
    },
  };
}
