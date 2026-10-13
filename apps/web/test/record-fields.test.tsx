// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { RecordFields } from "../components/records/record-fields.tsx";
import { emptyDraft, type RecordDraft } from "../lib/records.ts";

function Harness({ initial = emptyDraft("A") }: { initial?: RecordDraft }) {
  const [draft, setDraft] = useState(initial);
  return (
    <RecordFields
      draft={draft}
      onChange={setDraft}
      errors={{}}
      idPrefix="t"
      sub="alice"
      allowedTypes={["A", "AAAA", "CNAME", "TXT", "MX", "SRV", "CAA"]}
      layout="stack"
    />
  );
}

describe("DNS editor fields", () => {
  it("switches fields when the record type changes", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.getByLabelText(/位址/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/優先序/)).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("類型"), "MX");
    expect(screen.getByLabelText(/優先序/)).toBeInTheDocument();
    expect(screen.getByLabelText(/郵件主機/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/位址/)).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("類型"), "SRV");
    for (const label of [/優先序/, /權重/, /埠號/, /目標/])
      expect(screen.getByLabelText(label)).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("類型"), "CAA");
    for (const label of [/旗標/, /標籤/, /值/])
      expect(screen.getByLabelText(label)).toBeInTheDocument();
  });

  it("previews the FQDN as the name is typed and sets domain-friendly input attributes", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const name = screen.getByLabelText("名稱");
    await user.clear(name);
    await user.type(name, "blog");
    expect(screen.getByText("→ blog.alice.dev-in.tw")).toBeInTheDocument();
    expect(name).toHaveAttribute("autocapitalize", "none");
    expect(name).toHaveAttribute("spellcheck", "false");
    expect(screen.getByLabelText(/位址/)).toHaveAttribute("inputmode", "decimal");
  });

  it("links errors to their fields with aria-describedby", () => {
    render(
      <RecordFields
        draft={emptyDraft("A")}
        onChange={() => {}}
        errors={{ address: "必須是公網位址" }}
        idPrefix="e"
        sub="alice"
        allowedTypes={["A"]}
      />,
    );
    const input = screen.getByLabelText(/位址/);
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("必須是公網位址");
  });
});
