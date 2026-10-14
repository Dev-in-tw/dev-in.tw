// @vitest-environment jsdom
import type { Me } from "@dit/contract";
import { responses } from "@dit/contract/fixtures";
import { CURRENT_LEGAL_VERSIONS } from "@dit/contract/legal";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConsentGate } from "../components/app/consent-gate.tsx";
import { MeProvider } from "../lib/me.tsx";

const router = { push: vi.fn(), refresh: vi.fn(), replace: vi.fn() };
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/dashboard",
}));

function renderGate(me: Me) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MeProvider me={me}>
        <ConsentGate />
      </MeProvider>
    </QueryClientProvider>,
  );
}

describe("consent gate", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("stays hidden while the user's consent is current", () => {
    renderGate(responses.getMe);
    expect(screen.queryByTestId("consent-gate")).not.toBeInTheDocument();
  });

  it("asks for consent after the documents change and records the current versions", async () => {
    const user = userEvent.setup();
    const stale: Me = {
      ...responses.getMe,
      consent: {
        termsVersion: "1.0",
        privacyVersion: "1.0",
        acceptedAt: "2026-10-01T08:00:00.000Z",
      },
      consentRequired: true,
    };
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith("/me/consent")
        ? new Response(
            JSON.stringify({ ...CURRENT_LEGAL_VERSIONS, acceptedAt: "2026-10-14T08:00:00.000Z" }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          )
        : new Response(JSON.stringify({ ...stale, consentRequired: false }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
    );
    renderGate(stale);
    const dialog = await screen.findByTestId("consent-gate");
    expect(dialog).toHaveTextContent("服務條款與隱私權政策已更新");
    expect(dialog).toHaveTextContent("隱私權政策 v1.0");
    expect(dialog).toHaveTextContent(`v${CURRENT_LEGAL_VERSIONS.privacyVersion}`);
    expect(screen.queryByRole("button", { name: "關閉" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "我已閱讀並同意" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/me/consent");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual(CURRENT_LEGAL_VERSIONS);
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  });

  it("explains first-time consent when the user never agreed", () => {
    renderGate({ ...responses.getMe, consent: null, consentRequired: true });
    expect(screen.getByTestId("consent-gate")).toHaveTextContent("請先閱讀並同意服務條款");
  });
});
