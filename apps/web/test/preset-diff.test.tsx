// @vitest-environment jsdom
import { responses } from "@dit/contract/fixtures";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PresetDiff } from "../components/subdomain/presets.tsx";

describe("preset diff preview", () => {
  it("lists deletions then creations like a git diff", () => {
    const { container } = render(<PresetDiff plan={responses.planPreset} />);
    const lines = [...container.querySelectorAll("[data-diff]")];
    expect(lines.map((l) => l.getAttribute("data-diff"))).toEqual([
      "delete",
      "delete",
      "delete",
      "delete",
      "create",
    ]);
    expect(lines[4]).toHaveTextContent("+新增@CNAMEalice.github.io");
    expect(lines[0]).toHaveTextContent("-刪除@A185.199.108.153");
    expect(screen.getByRole("region", { name: "變更預覽" })).toBeInTheDocument();
  });

  it("staggers lines by 30ms", () => {
    const { container } = render(<PresetDiff plan={responses.planPreset} />);
    const delays = [...container.querySelectorAll<HTMLElement>("[data-diff]")].map(
      (l) => l.style.animationDelay,
    );
    expect(delays).toEqual(["0ms", "30ms", "60ms", "90ms", "120ms"]);
  });
});
