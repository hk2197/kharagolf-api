/**
 * Task #2036 — Cover the survey template picker with an automated browser
 * test. The template CRUD endpoints already have a thorough vitest suite in
 * post-event-survey-templates.test.ts, but the dialog-side wiring in
 * SendSurveyDialog (the picker, the inline "Save as template" form, and the
 * role-gated delete button) had no UI coverage. These tests pin down:
 *
 *   1. An org_admin can save the dialog's current questions as a template,
 *      and re-opening the dialog and picking that template from the picker
 *      restores those exact questions (round-trip).
 *   2. A tournament_director sees the picker (and can load templates) but
 *      does NOT see the "Save as template" toggle or the delete button —
 *      even after a template is selected.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { SendSurveyDialog } from "../tournament-detail";

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status < 400,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);
}

interface StoredTemplate {
  id: number;
  name: string;
  questions: Array<{ id: string; prompt: string; type: "rating" | "boolean" | "text" }>;
  createdAt: string;
  updatedAt: string;
}

let templates: StoredTemplate[];
let nextTemplateId: number;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  templates = [];
  nextTemplateId = 100;

  // jsdom does not implement Pointer Capture; Radix Select calls these on
  // pointer-down to decide whether to open. Without these stubs, the
  // user-event click on a SelectTrigger throws and the dropdown never
  // opens, blocking the "pick from picker" interaction.
  if (!(Element.prototype as unknown as { hasPointerCapture?: unknown }).hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!(Element.prototype as unknown as { releasePointerCapture?: unknown }).releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => {};
  }
  if (!(Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }

  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();

    // Existing-survey query — keep it null so the dialog falls back to the
    // built-in defaults and isn't pre-filled from a previous send.
    if (url.includes("/survey/responses")) {
      return jsonResponse({
        survey: null,
        totalResponses: 0,
        eligiblePlayers: 0,
        aggregates: [],
      });
    }

    // Template list / create / delete endpoints.
    const listMatch = url.match(/\/api\/organizations\/\d+\/survey-templates(?:\?.*)?$/);
    const itemMatch = url.match(/\/api\/organizations\/\d+\/survey-templates\/(\d+)$/);

    if (listMatch && method === "GET") {
      return jsonResponse({ templates });
    }
    if (listMatch && method === "POST") {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      const now = new Date().toISOString();
      const existing = templates.find(t => t.name === body.name);
      let template: StoredTemplate;
      if (existing) {
        existing.questions = body.questions;
        existing.updatedAt = now;
        template = existing;
      } else {
        template = {
          id: nextTemplateId++,
          name: body.name,
          questions: body.questions,
          createdAt: now,
          updatedAt: now,
        };
        templates.push(template);
      }
      return jsonResponse({ template });
    }
    if (itemMatch && method === "DELETE") {
      const id = Number(itemMatch[1]);
      templates = templates.filter(t => t.id !== id);
      return jsonResponse({ ok: true });
    }

    return jsonResponse({}, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderDialog(props: {
  open: boolean;
  userRole?: string;
  onOpenChange?: (v: boolean) => void;
}) {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchInterval: false, staleTime: 0, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <SendSurveyDialog
        open={props.open}
        onOpenChange={props.onOpenChange ?? (() => {})}
        orgId={1}
        tournamentId={42}
        onSent={() => {}}
        userRole={props.userRole}
      />
    </QueryClientProvider>,
  );
}

describe("SendSurveyDialog templates — org_admin round-trip", () => {
  it("saves the current questions as a template and reloads them via the picker after reopening", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const { rerender } = renderDialog({ open: true, userRole: "org_admin", onOpenChange });

    // Wait for the defaults to render.
    const firstPrompt = (await screen.findByTestId(
      "input-question-prompt-0",
    )) as HTMLInputElement;
    expect(firstPrompt.value).toBe("Overall experience");

    // Edit the prompts to the content we want to round-trip.
    await user.clear(firstPrompt);
    await user.type(firstPrompt, "How was the food?");

    const secondPrompt = screen.getByTestId(
      "input-question-prompt-1",
    ) as HTMLInputElement;
    await user.clear(secondPrompt);
    await user.type(secondPrompt, "Would you play again?");

    // Drop the third default question — the round-trip should reflect just
    // these two saved questions.
    await user.click(screen.getByTestId("button-remove-question-2"));
    await waitFor(() => {
      expect(screen.queryByTestId("input-question-prompt-2")).toBeNull();
    });

    // Open the inline "Save as template" form, name it, and confirm.
    await user.click(screen.getByTestId("button-toggle-save-template"));
    const nameInput = (await screen.findByTestId(
      "input-save-template-name",
    )) as HTMLInputElement;
    await user.type(nameInput, "Standard post-round survey");
    await user.click(screen.getByTestId("button-confirm-save-template"));

    // Verify the POST hit the templates endpoint with the right payload.
    await waitFor(() => {
      expect(templates).toHaveLength(1);
    });
    expect(templates[0].name).toBe("Standard post-round survey");
    expect(templates[0].questions.map(q => q.prompt)).toEqual([
      "How was the food?",
      "Would you play again?",
    ]);
    const postCalls = fetchMock.mock.calls.filter(([url, init]) => {
      const u = typeof url === "string" ? url : url.toString();
      return u.endsWith("/survey-templates") && (init as RequestInit | undefined)?.method === "POST";
    });
    expect(postCalls).toHaveLength(1);

    // Simulate "reopen": close, then open again. The dialog's reset effect
    // fires on open and pulls fresh templates from the server.
    rerender(
      <QueryClientProvider client={new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      })}>
        <SendSurveyDialog
          open={false}
          onOpenChange={onOpenChange}
          orgId={1}
          tournamentId={42}
          onSent={() => {}}
          userRole="org_admin"
        />
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(screen.queryByTestId("dialog-send-survey")).toBeNull();
    });

    rerender(
      <QueryClientProvider client={new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      })}>
        <SendSurveyDialog
          open={true}
          onOpenChange={onOpenChange}
          orgId={1}
          tournamentId={42}
          onSent={() => {}}
          userRole="org_admin"
        />
      </QueryClientProvider>,
    );

    // After reopening, the dialog falls back to the three built-in defaults
    // because /survey/responses returns survey: null.
    const reopenedFirst = (await screen.findByTestId(
      "input-question-prompt-0",
    )) as HTMLInputElement;
    await waitFor(() => {
      expect(reopenedFirst.value).toBe("Overall experience");
    });
    expect(
      (screen.getByTestId("input-question-prompt-2") as HTMLInputElement).value,
    ).toBe("Any comments?");

    // Wait for the templates list refresh so the saved template shows up
    // in the picker. The trigger is disabled while the list is loading or
    // while it's empty, so wait for it to become enabled.
    const trigger = await screen.findByTestId("select-survey-template");
    await waitFor(() => {
      expect(trigger).not.toBeDisabled();
    });

    // Open the picker and pick the saved template.
    await user.click(trigger);
    const option = await screen.findByRole("option", {
      name: /Standard post-round survey/,
    });
    await user.click(option);

    // The questions list should now reflect the saved template's questions.
    await waitFor(() => {
      const p0 = screen.getByTestId("input-question-prompt-0") as HTMLInputElement;
      if (p0.value !== "How was the food?") throw new Error("not yet loaded");
    });
    expect(
      (screen.getByTestId("input-question-prompt-0") as HTMLInputElement).value,
    ).toBe("How was the food?");
    expect(
      (screen.getByTestId("input-question-prompt-1") as HTMLInputElement).value,
    ).toBe("Would you play again?");
    // Only two questions in the saved template — the third default must be gone.
    expect(screen.queryByTestId("input-question-prompt-2")).toBeNull();

    // The picker trigger now displays the chosen template's name.
    expect(within(trigger).getByText(/Standard post-round survey/)).toBeInTheDocument();
  });
});

describe("SendSurveyDialog templates — tournament_director affordances", () => {
  it("shows the picker but hides the save and delete buttons", async () => {
    // Pre-seed a template so the picker is enabled and the director can
    // select it — exercising the "delete after selection" code path.
    templates = [
      {
        id: 200,
        name: "Director-loadable template",
        questions: [
          { id: "q1", prompt: "How was the venue?", type: "rating" },
          { id: "q2", prompt: "Would you recommend us?", type: "boolean" },
        ],
        createdAt: "2026-04-01T00:00:00.000Z",
        updatedAt: "2026-04-01T00:00:00.000Z",
      },
    ];

    const user = userEvent.setup();
    renderDialog({ open: true, userRole: "tournament_director" });

    // The picker (and its panel) must render for tournament directors.
    await screen.findByTestId("survey-templates-panel");
    const trigger = await screen.findByTestId("select-survey-template");

    // The "Save as template" toggle button is org_admin/super_admin only.
    expect(screen.queryByTestId("button-toggle-save-template")).toBeNull();
    expect(screen.queryByTestId("save-template-row")).toBeNull();

    // Wait for the templates fetch to finish so the trigger becomes enabled.
    await waitFor(() => {
      expect(trigger).not.toBeDisabled();
    });

    // Pick the seeded template so a selection exists — the delete button
    // would appear here for an org_admin, but must stay hidden for a director.
    await user.click(trigger);
    const option = await screen.findByRole("option", {
      name: /Director-loadable template/,
    });
    await user.click(option);

    // Loading the template still works for a director.
    await waitFor(() => {
      const p0 = screen.getByTestId("input-question-prompt-0") as HTMLInputElement;
      if (p0.value !== "How was the venue?") throw new Error("template not loaded yet");
    });

    // The delete button must NOT render even after a template is selected.
    expect(screen.queryByTestId("button-delete-survey-template")).toBeNull();
  });
});
