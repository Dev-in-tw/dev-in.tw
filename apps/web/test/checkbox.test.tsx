// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Checkbox } from "../components/ui/field.tsx";

describe("Checkbox", () => {
  it("keeps the checked fill and the checkmark, so a ticked box shows as ticked", () => {
    render(<Checkbox aria-label="同意" />);
    const box = screen.getByRole("checkbox", { name: "同意" });
    expect(box.classList.contains("checked:bg-magpie")).toBe(true);
    expect(box.classList.contains("checked:checkmark")).toBe(true);
    // 每個 class 的方括號都要成對：任意值裡有空白就會被拆開，Tailwind 產生不出規則
    for (const name of box.classList) {
      expect(name.split("[").length, name).toBe(name.split("]").length);
    }
  });
});
