// Control UI tests cover chat session continuity across reloads, reconnects, and list refreshes.
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
  type MockGatewayControls,
  type MockGatewayRequest,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

const MAIN = "agent:main:main";
const LINE_GROUP = "agent:main:line:group:test-group";
const OTHER_LINE_GROUP = "agent:main:line:group:other-group";
// Methods that bind the chat pane to a transcript; any of them for main means
// the operator's view left the selected session.
const TRANSCRIPT_BINDING_METHODS = new Set([
  "chat.history",
  "chat.startup",
  "sessions.messages.subscribe",
]);

let browser: Browser;
let server: ControlUiE2eServer;
const openContexts = new Set<BrowserContext>();

function sessionRow(key: string, label: string, updatedAt: number, kind = "direct") {
  return {
    contextTokens: null,
    displayName: label,
    hasActiveRun: false,
    key,
    kind,
    label,
    model: "gpt-5.5",
    modelProvider: "openai",
    status: "done",
    totalTokens: 0,
    updatedAt,
  };
}

function sessionsList(rows: unknown[]) {
  return {
    count: rows.length,
    defaults: { contextTokens: null, model: "gpt-5.5", modelProvider: "openai" },
    path: "",
    sessions: rows,
    ts: Date.now(),
  };
}

const ALL_SESSIONS = sessionsList([
  sessionRow(LINE_GROUP, "LINE group", Date.now(), "group"),
  sessionRow(OTHER_LINE_GROUP, "Other LINE group", Date.now() - 1, "group"),
  sessionRow(MAIN, "Main", Date.now() - 2),
]);

function requestSessionKey(request: MockGatewayRequest): string | undefined {
  const params = (request.params ?? {}) as { sessionKey?: unknown; key?: unknown };
  const key = params.sessionKey ?? params.key;
  return typeof key === "string" ? key : undefined;
}

/** Every transcript binding the page made for `sessionKey`, in request order. */
async function transcriptBindings(
  gateway: MockGatewayControls,
  sessionKey: string,
): Promise<string[]> {
  return (await gateway.getRequests())
    .filter((request) => TRANSCRIPT_BINDING_METHODS.has(request.method))
    .filter((request) => requestSessionKey(request) === sessionKey)
    .map((request) => request.method);
}

async function routeSession(page: Page): Promise<string | null> {
  return new URL(page.url()).searchParams.get("session");
}

async function newPage(): Promise<Page> {
  const context = await browser.newContext({
    locale: "en-US",
    serviceWorkers: "block",
    viewport: { height: 900, width: 1280 },
  });
  openContexts.add(context);
  return context.newPage();
}

async function installGateway(page: Page): Promise<MockGatewayControls> {
  return installMockGateway(page, {
    historyMessages: [{ content: "earlier in the group", role: "user", timestamp: Date.now() }],
    methodResponses: { "sessions.list": ALL_SESSIONS, "sessions.patch": {} },
    models: [
      { available: true, id: "gpt-5.5", name: "GPT-5.5", provider: "openai" },
      { available: true, id: "gpt-6-luna", name: "GPT-6 Luna", provider: "openai" },
    ],
    // The gateway's configured main session, as a production hello advertises it.
    sessionKey: MAIN,
  });
}

async function waitForBinding(gateway: MockGatewayControls, method: string, sessionKey: string) {
  await expect
    .poll(async () => (await transcriptBindings(gateway, sessionKey)).includes(method), {
      timeout: 10_000,
    })
    .toBe(true);
}

async function openSession(page: Page, gateway: MockGatewayControls, sessionKey: string) {
  await page.goto(`${server.baseUrl}chat?session=${encodeURIComponent(sessionKey)}`);
  await waitForBinding(gateway, "chat.startup", sessionKey);
}

async function sendMessage(page: Page, gateway: MockGatewayControls, text: string) {
  const sendsBefore = (await gateway.getRequests("chat.send")).length;
  const composer = page.locator(".agent-chat__composer-combobox textarea");
  await composer.fill(text);
  await composer.press("Enter");
  await expect
    .poll(async () => (await gateway.getRequests("chat.send")).length, { timeout: 10_000 })
    .toBeGreaterThan(sendsBefore);
  const send = (await gateway.getRequests("chat.send")).at(-1);
  return send ? requestSessionKey(send) : undefined;
}

async function expectBoundToLineGroup(page: Page, gateway: MockGatewayControls, text: string) {
  expect(await routeSession(page)).toBe(LINE_GROUP);
  expect(await sendMessage(page, gateway, text)).toBe(LINE_GROUP);
  expect(await transcriptBindings(gateway, MAIN)).toEqual([]);
}

/** Lets a burst of UI work settle so a late session switch cannot hide behind the assertion. */
async function settle(page: Page) {
  await page.waitForTimeout(400);
}

describeControlUiE2e("Control UI chat session continuity E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(
        `Playwright Chromium is not installed or cannot start at ${chromiumExecutablePath}.`,
      );
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterEach(async () => {
    await Promise.all([...openContexts].map((context) => context.close().catch(() => {})));
    openContexts.clear();
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("a cold route mount binds only the selected LINE group, never the main session", async () => {
    const page = await newPage();
    const gateway = await installGateway(page);

    // The router renders the chat page before its route data resolves; that
    // window must not fall back to the gateway's main session.
    await openSession(page, gateway, LINE_GROUP);
    await settle(page);

    expect(await transcriptBindings(gateway, MAIN)).toEqual([]);
    expect(await transcriptBindings(gateway, LINE_GROUP)).toContain("sessions.messages.subscribe");
    await expectBoundToLineGroup(page, gateway, "still the group");
  });

  it("a page reload (deploy) keeps the selected LINE group", async () => {
    const page = await newPage();
    const gateway = await installGateway(page);
    await openSession(page, gateway, LINE_GROUP);

    // The mock gateway re-installs per document, so requests below are the
    // reloaded page's own.
    await page.reload();
    await waitForBinding(gateway, "chat.startup", LINE_GROUP);
    await settle(page);

    await expectBoundToLineGroup(page, gateway, "after the deploy reload");
  });

  it("a websocket reconnect keeps the selected LINE group", async () => {
    const page = await newPage();
    const gateway = await installGateway(page);
    await openSession(page, gateway, LINE_GROUP);
    const connectsBefore = (await gateway.getRequests("connect")).length;

    await gateway.closeLatest(1012, "service restart");
    await expect
      .poll(async () => (await gateway.getRequests("connect")).length, { timeout: 10_000 })
      .toBeGreaterThan(connectsBefore);
    await expect
      .poll(
        async () =>
          (await transcriptBindings(gateway, LINE_GROUP)).filter(
            (method) => method === "chat.startup",
          ).length,
        { timeout: 10_000 },
      )
      .toBe(2);
    await settle(page);

    await expectBoundToLineGroup(page, gateway, "after the reconnect");
  });

  it("a sessions.list refresh keeps the selected LINE group", async () => {
    const page = await newPage();
    const gateway = await installGateway(page);
    await openSession(page, gateway, LINE_GROUP);
    const listsBefore = (await gateway.getRequests("sessions.list")).length;

    await gateway.emitGatewayEvent("sessions.changed", { reason: "patch", sessionKey: MAIN });
    await expect
      .poll(async () => (await gateway.getRequests("sessions.list")).length, { timeout: 10_000 })
      .toBeGreaterThan(listsBefore);
    await settle(page);

    await expectBoundToLineGroup(page, gateway, "after the list refresh");
  });

  it("a list that temporarily omits the LINE group row does not force main", async () => {
    const page = await newPage();
    const gateway = await installGateway(page);
    await openSession(page, gateway, LINE_GROUP);
    await gateway.setMethodResponse(
      "sessions.list",
      sessionsList([sessionRow(MAIN, "Main", Date.now())]),
    );
    const listsBefore = (await gateway.getRequests("sessions.list")).length;

    await gateway.emitGatewayEvent("sessions.changed", { reason: "patch", sessionKey: MAIN });
    await expect
      .poll(async () => (await gateway.getRequests("sessions.list")).length, { timeout: 10_000 })
      .toBeGreaterThan(listsBefore);
    await settle(page);

    await expectBoundToLineGroup(page, gateway, "row missing from the list");
  });

  it("a model picker sessions.patch keeps the active LINE group", async () => {
    const page = await newPage();
    const gateway = await installGateway(page);
    await openSession(page, gateway, LINE_GROUP);

    const composer = page.locator(".agent-chat__input");
    await composer.locator('[data-chat-model-select="true"]').click();
    await composer.locator('[data-chat-model-option="openai/gpt-6-luna"]').click();
    await expect
      .poll(
        async () =>
          (await gateway.getRequests("sessions.patch")).map((request) => ({
            key: requestSessionKey(request),
            model: (request.params as { model?: unknown }).model,
          })),
        { timeout: 10_000 },
      )
      .toContainEqual({ key: LINE_GROUP, model: "openai/gpt-6-luna" });
    await settle(page);

    await expectBoundToLineGroup(page, gateway, "after picking a model");
  });

  it("chat.history reloads stay bound to the selected LINE group", async () => {
    const page = await newPage();
    const gateway = await installGateway(page);
    await openSession(page, gateway, LINE_GROUP);
    const historyBefore = (await gateway.getRequests("chat.history")).length;

    // A transcript change on the selected session makes the pane reload history.
    await gateway.emitGatewayEvent("session.message", {
      message: { content: "new group message", role: "user", timestamp: Date.now() },
      sessionKey: LINE_GROUP,
    });
    await expect
      .poll(async () => (await gateway.getRequests("chat.history")).length, { timeout: 10_000 })
      .toBeGreaterThan(historyBefore);
    await settle(page);

    const historyKeys = (await gateway.getRequests("chat.history")).map(requestSessionKey);
    expect(new Set(historyKeys)).toEqual(new Set([LINE_GROUP]));
    await expectBoundToLineGroup(page, gateway, "after the history reload");
  });

  it("an explicit session switch still moves the chat to the chosen session", async () => {
    const page = await newPage();
    const gateway = await installGateway(page);
    await openSession(page, gateway, LINE_GROUP);

    const mainRow = page
      .locator(".sidebar-recent-sessions__list .sidebar-recent-session")
      .filter({ hasText: "Main" });
    await mainRow.locator("a").first().click();
    await expect.poll(() => routeSession(page), { timeout: 10_000 }).toBe(MAIN);
    await waitForBinding(gateway, "chat.history", MAIN);

    expect(await sendMessage(page, gateway, "chosen on purpose")).toBe(MAIN);
  });

  it("a deleted LINE group still falls back to the main session", async () => {
    const page = await newPage();
    const gateway = await installGateway(page);
    await openSession(page, gateway, LINE_GROUP);

    await gateway.emitGatewayEvent("sessions.changed", {
      reason: "delete",
      sessionKey: LINE_GROUP,
    });
    await expect.poll(() => routeSession(page), { timeout: 10_000 }).toBe(MAIN);
    await waitForBinding(gateway, "chat.history", MAIN);
  });

  it("an empty route key is no opinion: no subscription or history side effect", async () => {
    const page = await newPage();
    const gateway = await installGateway(page);
    await openSession(page, gateway, LINE_GROUP);
    const requestsBefore = (await gateway.getRequests()).length;

    // The container passes "" while its route data is unresolved.
    await page.locator("openclaw-chat-pane").evaluate((pane) => {
      (pane as HTMLElement & { sessionKey: string }).sessionKey = "";
    });
    await settle(page);

    const sideEffects = (await gateway.getRequests())
      .slice(requestsBefore)
      .filter((request) => TRANSCRIPT_BINDING_METHODS.has(request.method))
      .map((request) => `${request.method} ${requestSessionKey(request)}`);
    expect(sideEffects).toEqual([]);
    await expectBoundToLineGroup(page, gateway, "after an empty key");
  });

  it("a real replacement key after an empty one still switches normally", async () => {
    const page = await newPage();
    const gateway = await installGateway(page);
    await openSession(page, gateway, LINE_GROUP);

    const pane = page.locator("openclaw-chat-pane");
    await pane.evaluate((element) => {
      (element as HTMLElement & { sessionKey: string }).sessionKey = "";
    });
    await pane.evaluate((element, sessionKey) => {
      (element as HTMLElement & { sessionKey: string }).sessionKey = sessionKey;
    }, OTHER_LINE_GROUP);
    await waitForBinding(gateway, "chat.history", OTHER_LINE_GROUP);
    await waitForBinding(gateway, "sessions.messages.subscribe", OTHER_LINE_GROUP);

    expect(await transcriptBindings(gateway, MAIN)).toEqual([]);
    expect(await sendMessage(page, gateway, "in the other group")).toBe(OTHER_LINE_GROUP);
  });

  it("leaves the tokenized dashboard link on its existing main-session behavior", async () => {
    const page = await newPage();
    const gateway = await installGateway(page);
    await openSession(page, gateway, LINE_GROUP);

    // Unchanged product behavior: a token link without ?session= opens main.
    await page.goto(`${server.baseUrl}#token=dashboard-token`);
    await waitForBinding(gateway, "chat.startup", MAIN);

    expect(await sendMessage(page, gateway, "from the dashboard link")).toBe(MAIN);
  });
});
