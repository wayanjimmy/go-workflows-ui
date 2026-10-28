import { test, expect } from "@playwright/test";

test("timeline axis, event inspection, sorting and attention filter", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await page
    .getByRole("link", { name: "demo:retry/summary", exact: true })
    .click();
  await expect(
    page.getByRole("img", { name: /Workflow lifetime/ }),
  ).toBeVisible();
  await expect(page.getByLabel("Elapsed time axis")).toContainText("0 ms");
  const first = page.getByRole("button", {
    name: /Inspect Activity Summarize, attempt 1/,
  });
  await first.focus();
  await page.keyboard.press("Enter");
  const inspector = page.getByRole("region", {
    name: "Timeline event details",
  });
  await expect(inspector).toContainText("temporary upstream failure");
  await expect(inspector).toContainText("ActivityFailed");
  await expect(first).toHaveAttribute("aria-expanded", "true");
  await page.screenshot({
    path: testInfo.outputPath("timeline-inspected.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Show failed and pending only" })
    .click();
  await expect(
    page.getByRole("button", { name: /Inspect Activity Summarize/ }),
  ).toHaveCount(1);
  await expect(page.getByRole("button", { name: /Inspect Timer/ })).toHaveCount(
    0,
  );
  await page.screenshot({
    path: testInfo.outputPath("timeline-filtered.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Show all events" }).click();
  await page.getByRole("button", { name: "Newest first" }).click();
  await expect(
    page.getByRole("button", { name: /Inspect / }).first(),
  ).toHaveAccessibleName(/attempt 2/);
  await page.screenshot({
    path: testInfo.outputPath("timeline-newest.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: testInfo.outputPath("timeline-mobile.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("link", { name: "All executions" }).click();
  await page.getByRole("link", { name: "demo:waiting", exact: true }).click();
  await expect(
    page.getByRole("img", { name: /Workflow lifetime: Running/ }),
  ).toBeVisible();
  await expect(
    page.getByText("No activity, timer, child workflow, or signal events yet."),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("timeline-running.png"),
    fullPage: true,
  });
});

test("start-time presets and exact ID copying", async ({
  page,
  context,
  request,
}, testInfo) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  const row = page.getByRole("row").filter({
    has: page.getByRole("link", { name: "demo:retry/summary", exact: true }),
  });
  const { executions } = await (await request.get("/api/executions")).json();
  const ref = executions.find(
    (item) => item.instance.instance_id === "demo:retry/summary",
  );
  await row
    .getByRole("button", { name: "Copy workflow ID", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(ref.instance.instance_id);
  await row
    .getByRole("button", { name: "Copy execution ID", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(ref.instance.execution_id);
  await page
    .getByRole("combobox", { name: "Started within" })
    .selectOption("hour");
  await expect(
    page.getByRole("table", { name: "Workflow executions" }).getByRole("row"),
  ).toHaveCount(7);
  await page
    .getByRole("combobox", { name: "Started within" })
    .selectOption("today");
  await expect(
    page.getByRole("table", { name: "Workflow executions" }).getByRole("row"),
  ).toHaveCount(7);
  await page.screenshot({
    path: testInfo.outputPath("time-filter.png"),
    fullPage: true,
  });
  await row
    .getByRole("link", { name: "demo:retry/summary", exact: true })
    .click();
  for (const [label, value] of [
    ["workflow", ref.instance.instance_id],
    ["execution", ref.instance.execution_id],
  ]) {
    await page
      .getByRole("button", { name: `Copy ${label} ID`, exact: true })
      .click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(value);
  }
  await page.screenshot({
    path: testInfo.outputPath("copy-ids.png"),
    fullPage: true,
  });
});

test("timezone selection updates dates, preserves durations and survives reload", async ({
  browser,
  request,
}, testInfo) => {
  const context = await browser.newContext({ timezoneId: "Asia/Jakarta" });
  const page = await context.newPage();
  try {
    const { executions } = await (await request.get("/api/executions")).json();
    const ref = executions.find(
      (item) => item.instance.instance_id === "demo:retry/summary",
    );
    const query = new URLSearchParams({
      instance: ref.instance.instance_id,
      execution: ref.instance.execution_id,
    });
    const before = await (await request.get(`/api/execution?${query}`)).json();
    const utc = new Date(before.created_at).toISOString().slice(11, 19);
    const jakarta = new Date(Date.parse(before.created_at) + 7 * 3600000)
      .toISOString()
      .slice(11, 19);
    await page.goto(`/#execution?${query}`);
    const picker = page.getByRole("combobox", { name: "Timezone" });
    const started = page.getByText("Started", { exact: true }).locator("..");
    await expect(picker).toHaveValue("local");
    await expect(started).toContainText(jakarta);
    const durations = await page.locator(".duration").allTextContents();
    await picker.selectOption("UTC");
    await expect(started).toContainText(utc);
    await expect(started).toContainText("UTC");
    await page.screenshot({
      path: testInfo.outputPath("timezone-utc.png"),
      fullPage: true,
    });
    await page.reload();
    await expect(picker).toHaveValue("UTC");
    await expect(started).toContainText(utc);
    await picker.selectOption("Asia/Jakarta");
    await expect(started).toContainText(jakarta);
    expect(await page.locator(".duration").allTextContents()).toEqual(
      durations,
    );
    await page.getByRole("tab", { name: "Relationships" }).click();
    await expect(
      page.getByRole("region", { name: "Selected workflow" }),
    ).toContainText(jakarta);
    await page.getByRole("tab", { name: "Event history" }).click();
    await expect(
      page.getByRole("button", { name: /WorkflowExecutionStarted/ }),
    ).toContainText(jakarta);
    await page.screenshot({
      path: testInfo.outputPath("timezone-jakarta.png"),
      fullPage: true,
    });
    await page.getByRole("link", { name: "All executions" }).click();
    const row = page.getByRole("row").filter({
      has: page.getByRole("link", {
        name: "demo:retry/summary",
        exact: true,
      }),
    });
    await expect(row).toContainText(jakarta);
    await expect(picker).toHaveValue("Asia/Jakarta");
    const after = await (await request.get(`/api/execution?${query}`)).json();
    expect(after).toEqual(before);
  } finally {
    await context.close();
  }
});

test("SQLite executions, retry timeline, payloads, relationships and navigation", async ({
  page,
}, testInfo) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.cspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      window.cspViolations.push(event.violatedDirective);
    });
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Executions", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("table", { name: "Workflow executions" }).getByRole("row"),
  ).toHaveCount(7);
  await page.getByRole("textbox", { name: "Filter this page" }).fill("retry/");
  await expect(
    page.getByRole("table", { name: "Workflow executions" }).getByRole("row"),
  ).toHaveCount(2);
  await page
    .getByRole("textbox", { name: "Filter this page" })
    .fill("no-such-workflow");
  await expect(page.getByText("No executions match this page.")).toBeVisible();
  await page.getByRole("textbox", { name: "Filter this page" }).fill("");
  await page.evaluate(() => document.fonts.ready);
  expect(
    await page.evaluate(() => document.fonts.check('13px "Inter Variable"')),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("executions.png"),
    fullPage: true,
  });
  await page
    .getByRole("link", { name: "demo:retry/summary", exact: true })
    .click();
  await expect(page.getByTestId("execution-status")).toHaveText("Succeeded");
  await expect(
    page.getByRole("heading", { name: "Timeline", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Attempt 1", { exact: true })).toBeVisible();
  await expect(page.getByText("Attempt 2", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("img", { name: /Includes queue time/ }),
  ).toBeVisible();
  await expect(page.locator('.timeline-row[data-kind="Activity"]')).toHaveCount(
    2,
  );
  await page.screenshot({
    path: testInfo.outputPath("retry-timeline.png"),
    fullPage: true,
  });
  await page.getByRole("tab", { name: "Event history" }).click();
  await page.getByRole("tab", { name: "Event history" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Payloads" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("payloads")).toBeVisible();
  await page.getByRole("tab", { name: "Event history" }).click();
  await expect(
    page.getByRole("button", { name: /ActivityFailed/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: /ActivityFailed/ }).click();
  await expect(
    page.getByText("temporary upstream failure", { exact: false }).first(),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("event-history.png"),
    fullPage: true,
  });
  await page.getByRole("tab", { name: "Payloads" }).click();
  await expect(page.getByTestId("payloads")).toContainText("<script>");
  expect(await page.evaluate(() => window.injected)).toBeUndefined();
  await page.screenshot({
    path: testInfo.outputPath("payloads.png"),
    fullPage: true,
  });
  await page.reload();
  await expect(page.getByTestId("execution-status")).toHaveText("Succeeded");
  await page.getByRole("link", { name: "All executions" }).click();
  await page.getByRole("link", { name: "demo:failed", exact: true }).click();
  await expect(page.getByTestId("execution-status")).toHaveText("Failed");
  await page.getByRole("link", { name: "All executions" }).click();
  await page.getByRole("link", { name: "demo:canceled", exact: true }).click();
  await expect(page.getByTestId("execution-status")).toHaveText("Canceled");
  await page.getByRole("link", { name: "All executions" }).click();
  await page.getByRole("link", { name: "demo:parent", exact: true }).click();
  await page.getByRole("tab", { name: "Relationships" }).click();
  const family = page.getByRole("region", { name: "Workflow family" });
  await expect(
    family.getByRole("button", { name: "Select demo:parent", exact: true }),
  ).toHaveAttribute("aria-current", "true");
  await expect(
    family.getByRole("button", { name: "Select demo:child", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("relationships-default.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Collapse all" }).click();
  await expect(
    family.getByRole("button", { name: "Select demo:child", exact: true }),
  ).toBeHidden();
  await page.screenshot({
    path: testInfo.outputPath("relationships-collapsed.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Expand all" }).click();
  await family
    .getByRole("button", { name: "Select demo:child", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await expect(
    family.getByRole("button", { name: "Select demo:child", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    family.getByRole("button", { name: "Select demo:parent", exact: true }),
  ).toHaveAttribute("aria-current", "true");
  await expect(
    page.getByRole("region", { name: "Selected workflow" }),
  ).toContainText("ChildSummary");
  await expect(
    page
      .getByRole("region", { name: "Selected workflow" })
      .getByText("Finished", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("table", { name: "Related executions" }),
  ).toContainText("Parent");
  await expect(
    page.getByRole("link", { name: "demo:child", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("relationships.png"),
    fullPage: true,
  });
  await page.getByRole("link", { name: "demo:child", exact: true }).click();
  await expect(page.getByTestId("execution-status")).toHaveText("Succeeded");
  // TimerFired.timestamp is creation time upstream, not when it became eligible.
  // The real demo waits 100ms, so showing 0ms would misrepresent persisted data.
  await expect(
    page.locator('.timeline-row[data-kind="Timer"] .duration'),
  ).not.toHaveText("0 ms");
  await page.getByRole("tab", { name: "Relationships" }).click();
  await expect(
    family.getByRole("button", { name: "Select demo:child", exact: true }),
  ).toHaveAttribute("aria-current", "true");
  await expect(
    family.getByRole("button", { name: "Select demo:parent", exact: true }),
  ).not.toHaveAttribute("aria-current", "true");
  await expect(
    page
      .getByRole("region", { name: "Selected workflow" })
      .getByText("Succeeded", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("relationships-child.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: testInfo.outputPath("relationships-mobile.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("tab", { name: "Timeline" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: testInfo.outputPath("mobile-detail.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("link", { name: "All executions" }).click();
  await page.getByRole("link", { name: "demo:waiting", exact: true }).click();
  await page.getByRole("tab", { name: "Relationships" }).click();
  await expect(
    page.getByText("No parent or child workflows", { exact: true }),
  ).toBeVisible();
  await expect(
    family.getByRole("button", { name: "Select demo:waiting", exact: true }),
  ).toHaveAttribute("aria-current", "true");
  await page.screenshot({
    path: testInfo.outputPath("relationships-empty.png"),
    fullPage: true,
  });
  expect(await page.evaluate(() => window.cspViolations)).toEqual([]);
  expect(errors).toEqual([]);
});

test("missing execution and read-only boundary", async ({
  page,
  request,
}, testInfo) => {
  await page.goto("/#execution?instance=missing&execution=missing");
  await expect(page.getByRole("alert")).toContainText("Execution not found");
  await page.screenshot({
    path: testInfo.outputPath("not-found.png"),
    fullPage: true,
  });
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const response = await request.fetch(
      "/api/execution?instance=demo:waiting",
      { method },
    );
    expect(response.status()).toBe(405);
  }
});

test("existing summarize data loads without writes", async ({
  page,
  request,
}) => {
  test.skip(
    !process.env.DASHBOARD_LIVE_URL,
    "Optional read-only viewer over a summarize SQLite snapshot",
  );
  const base = process.env.DASHBOARD_LIVE_URL;
  const response = await request.get(`${base}/api/executions?limit=1`);
  expect(response.ok()).toBe(true);
  const { executions } = await response.json();
  expect(executions.length).toBeGreaterThan(0);
  const { instance_id, execution_id } = executions[0].instance;
  await page.goto(
    `${base}/#execution?${new URLSearchParams({ instance: instance_id, execution: execution_id })}`,
  );
  await expect(page.getByTestId("execution-status")).not.toBeEmpty();
  await page.getByRole("tab", { name: "Event history" }).click();
  await expect(
    page.getByRole("button", { name: /WorkflowExecutionStarted/ }),
  ).toBeVisible();
});
