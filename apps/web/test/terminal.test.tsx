// @vitest-environment jsdom
import { availability } from "@dit/contract/fixtures";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaimTerminal } from "../components/claim/terminal.tsx";

function setup(onSubmit = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ClaimTerminal onSubmit={onSubmit} />
    </QueryClientProvider>,
  );
  return { onSubmit };
}

beforeEach(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  window.matchMedia ??= ((q: string) => ({
    matches: q.includes("reduce"),
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const name = decodeURIComponent(String(url).split("/").pop() ?? "");
      const body =
        name === "bob"
          ? availability.taken
          : { ...availability.available, name, fqdn: `${name}.dev-in.tw` };
      return new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
      });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

describe("claim terminal", () => {
  it("debounces, checks availability and announces only the final result", async () => {
    const user = userEvent.setup();
    setup();
    await user.type(screen.getByLabelText("想要的子網域名稱"), "alice");
    const live = screen.getByTestId("availability-live");
    expect(live).toHaveTextContent("");
    await waitFor(() => expect(live).toHaveTextContent("alice.dev-in.tw：可以申請"));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe("/api/v1/availability/alice");
  });

  it("offers suggestions and Tab-completes the first one", async () => {
    const user = userEvent.setup();
    setup();
    const input = screen.getByLabelText("想要的子網域名稱");
    await user.type(input, "bob");
    await waitFor(() =>
      expect(screen.getByTestId("availability-live")).toHaveTextContent("已被使用"),
    );
    expect(screen.getByRole("button", { name: "bob-dev" })).toBeInTheDocument();
    await user.keyboard("{Tab}");
    expect(input).toHaveValue("bob-dev");
  });

  it("submits the normalized name on Enter", async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();
    await user.type(screen.getByLabelText("想要的子網域名稱"), "  My_Site {Enter}");
    expect(onSubmit).toHaveBeenCalledWith("my-site");
  });
});
