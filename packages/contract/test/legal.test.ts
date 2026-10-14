import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { responses } from "../src/fixtures.ts";
import {
  ConsentContext,
  CURRENT_LEGAL_VERSIONS,
  isCurrentConsent,
  LEGAL_DOCUMENTS,
  LegalVersion,
  Me,
  UserDataExport,
} from "../src/index.ts";

describe("legal documents", () => {
  it("every document has a parseable version and an ISO effective date", () => {
    for (const doc of Object.values(LEGAL_DOCUMENTS)) {
      expect(LegalVersion.safeParse(doc.version).success).toBe(true);
      expect(doc.effective).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("current versions come from the documents", () => {
    expect(CURRENT_LEGAL_VERSIONS).toEqual({
      termsVersion: LEGAL_DOCUMENTS.terms.version,
      privacyVersion: LEGAL_DOCUMENTS.privacy.version,
    });
  });

  it("isCurrentConsent requires both versions to match", () => {
    expect(isCurrentConsent(CURRENT_LEGAL_VERSIONS)).toBe(true);
    expect(isCurrentConsent(null)).toBe(false);
    expect(isCurrentConsent(undefined)).toBe(false);
    expect(isCurrentConsent({ ...CURRENT_LEGAL_VERSIONS, privacyVersion: "0.9" })).toBe(false);
    expect(isCurrentConsent({ ...CURRENT_LEGAL_VERSIONS, termsVersion: "0.9" })).toBe(false);
  });

  it("the legal module stays free of zod so client bundles can import it", () => {
    const source = readFileSync(new URL("../src/legal.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/from\s+["']zod["']/);
    expect(source).not.toMatch(/import\s/);
  });

  it("is exported as the @dit/contract/legal subpath", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      exports: Record<string, string>;
    };
    expect(pkg.exports["./legal"]).toBe("./src/legal.ts");
  });
});

describe("consent and data export schemas", () => {
  it("Me stays backward compatible: the consent fields are optional", () => {
    const { consent: _c, consentRequired: _r, ...legacy } = responses.getMe;
    expect(Me.safeParse(legacy).success).toBe(true);
  });

  it("covers every consent context", () => {
    expect(ConsentContext.options.sort()).toEqual(["login", "prompt", "subdomain_create"]);
  });

  it("the data export never carries secrets or other people's emails", () => {
    const parsed = UserDataExport.parse(responses.exportMyData);
    const text = JSON.stringify(parsed);
    expect(text).not.toMatch(/token|secret|hash/i);
    for (const t of parsed.transfers) expect(Object.keys(t)).not.toContain("email");
  });
});
