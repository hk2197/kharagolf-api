/**
 * Task #661 — UI test for the custom-domain admin form
 * (admin.tsx → "Custom Domain" section).
 *
 * Covers the saveCustomDomain handler end-to-end:
 *   - An org admin types a hostname, clicks "Save Domain", and the page
 *     PATCHes /api/organizations/:orgId/marketing-site/custom-domain with
 *     the entered value.
 *   - The server's normalised value (e.g. lowercased) is reflected back
 *     into the input, and a success toast is shown.
 *   - The "Clear Domain" button (visible only when a domain exists) sends
 *     `null` and triggers the same success toast.
 *   - When the server returns 409 (collision), the destructive error toast
 *     surfaces the server's user-readable error verbatim and the local
 *     input value is preserved so the admin can edit and retry.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// useGetMe → trusted org admin in org 42.
vi.mock("@workspace/api-client-react", () => ({
  useGetMe: () => ({
    data: { id: 1, organizationId: 42, role: "org_admin" },
  }),
}));

const toastMock = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastMock }),
}));

import SettingsPage from "../admin";

interface Org {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  logoUrl: string | null;
  primaryColor: string | null;
  customDomain: string | null;
  subscriptionTier: string;
  isActive: boolean;
  contactEmail: string | null;
  contactPhone: string | null;
  address: string | null;
  website: string | null;
  defaultLanguage: string | null;
}

let currentOrg: Org;
let saveCalls: Array<{ method: string; url: string; body: unknown }>;
let saveResponse: { status: number; body: { error?: string; customDomain?: string | null } };

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status < 400,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);
}

function makeOrg(overrides: Partial<Org> = {}): Org {
  return {
    id: 42,
    name: "Pine Valley",
    slug: "pinevalley",
    description: null,
    logoUrl: null,
    primaryColor: "#1e4d2b",
    customDomain: null,
    subscriptionTier: "enterprise",
    isActive: true,
    contactEmail: null,
    contactPhone: null,
    address: null,
    website: null,
    defaultLanguage: "en",
    ...overrides,
  };
}

beforeEach(() => {
  toastMock.mockReset();
  currentOrg = makeOrg();
  saveCalls = [];
  saveResponse = { status: 200, body: { customDomain: "golf.pinevalley.com" } };

  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();

      if (url.endsWith("/api/organizations/42") && method === "GET") {
        return jsonResponse(currentOrg);
      }

      if (url.endsWith("/api/organizations/42/marketing-site/custom-domain")
          && method === "PATCH") {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        saveCalls.push({ method, url, body });
        if (saveResponse.status >= 400) {
          return jsonResponse(saveResponse.body, saveResponse.status);
        }
        // Mirror the server: normalise + persist.
        currentOrg = { ...currentOrg, customDomain: saveResponse.body.customDomain ?? null };
        return jsonResponse(saveResponse.body, 200);
      }

      // Cert-status query and any other side queries: degrade gracefully.
      return jsonResponse({}, 404);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function gotoDomainSection() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchInterval: false, staleTime: 0 },
      mutations: { retry: false },
    },
  });
  render(
    <QueryClientProvider client={qc}>
      <SettingsPage />
    </QueryClientProvider>,
  );
  // Wait for the org fetch to resolve so the section nav renders.
  const navBtn = await screen.findByRole("button", { name: /custom domain/i });
  fireEvent.click(navBtn);
  // Confirm the Save button (inside the Domain card) is now mounted.
  await screen.findByRole("button", { name: /save domain/i });
}

describe("admin.tsx — custom-domain form (Task #661)", () => {
  it("PATCHes the custom-domain endpoint with the entered value and reflects the server's normalised response", async () => {
    saveResponse = { status: 200, body: { customDomain: "golf.pinevalley.com" } };
    await gotoDomainSection();

    const input = screen.getByPlaceholderText("golf.yourclub.com") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "GOLF.PineValley.com" } });
    expect(input.value).toBe("GOLF.PineValley.com");

    fireEvent.click(screen.getByRole("button", { name: /save domain/i }));

    await waitFor(() => expect(saveCalls.length).toBe(1));
    expect(saveCalls[0]).toMatchObject({
      method: "PATCH",
      url: expect.stringContaining("/api/organizations/42/marketing-site/custom-domain"),
      body: { customDomain: "GOLF.PineValley.com" },
    });

    // Server normalisation is reflected back into the input.
    await waitFor(() => {
      expect((screen.getByPlaceholderText("golf.yourclub.com") as HTMLInputElement).value)
        .toBe("golf.pinevalley.com");
    });

    // Success toast.
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({
        title: expect.stringMatching(/custom domain saved/i),
      }));
    });
  });

  it("clears the domain when 'Clear Domain' is clicked (sends null)", async () => {
    // Start with a domain already saved so the Clear button is rendered.
    currentOrg = makeOrg({ customDomain: "golf.pinevalley.com" });
    saveResponse = { status: 200, body: { customDomain: null } };
    await gotoDomainSection();

    const clearBtn = await screen.findByRole("button", { name: /clear domain/i });
    fireEvent.click(clearBtn);

    await waitFor(() => expect(saveCalls.length).toBe(1));
    expect(saveCalls[0].body).toEqual({ customDomain: null });

    await waitFor(() => {
      expect((screen.getByPlaceholderText("golf.yourclub.com") as HTMLInputElement).value).toBe("");
    });

    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({
        title: expect.stringMatching(/custom domain saved/i),
      }));
    });
  });

  it("surfaces the server's user-readable error verbatim on 409 and preserves the input", async () => {
    saveResponse = {
      status: 409,
      body: { error: "That domain is already assigned to another club." },
    };
    await gotoDomainSection();

    const input = screen.getByPlaceholderText("golf.yourclub.com") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "taken.example.com" } });

    fireEvent.click(screen.getByRole("button", { name: /save domain/i }));

    await waitFor(() => expect(saveCalls.length).toBe(1));

    // Destructive toast surfaces the server's exact wording.
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({
        title: "That domain is already assigned to another club.",
        variant: "destructive",
      }));
    });

    // Input value is preserved so the admin can edit and retry without retyping.
    expect((screen.getByPlaceholderText("golf.yourclub.com") as HTMLInputElement).value)
      .toBe("taken.example.com");
  });
});
