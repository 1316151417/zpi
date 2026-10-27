import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { readActiveGeneration } from "../../packages/desktop/src/main/storage-generation.ts";
import { runCleanup } from "../helpers/cleanup.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { expect, test } from "../helpers/test.ts";

test("ChatGPT OAuth settings hide API keys, accept callbacks, auto-discover and cancel or disconnect", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-chatgpt-ui-"));
  let app: Awaited<ReturnType<typeof launchDesktop>>;
  try {
    app = await launchDesktop({ dir, url: "" });
    const keys = await generateKeyPair("RS256", { extractable: true });
    const jwk = { ...(await exportJWK(keys.publicKey)), kid: "test", alg: "RS256" };
    await app.evaluate(({ net, shell }, publicKey) => {
      const state = { url: "", idToken: "", models: 0, revokes: 0 };
      Object.assign(globalThis, { oauthTest: state });
      shell.openExternal = async (url) => {
        state.url = url;
      };
      const original = net.fetch.bind(net);
      net.fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.endsWith("jwks.json")) return Response.json({ keys: [publicKey] });
        if (url.endsWith("/token"))
          return Response.json({
            access_token: "ui-private-access",
            refresh_token: "ui-private-refresh",
            expires_in: 3600,
            id_token: state.idToken,
            scope: "openid chatgpt.tokens.use.direct",
          });
        if (url === "https://api.openai.com/v1/models") {
          state.models++;
          return Response.json({
            models: [
              {
                slug: "account-model",
                display_name: "Account Model",
                visibility: "list",
                context_window: 1000000,
                max_output_tokens: 128000,
                input_modalities: ["text", "image"],
                supported_reasoning_levels: [
                  { effort: "none" },
                  { effort: "low" },
                  { effort: "high" },
                  { effort: "xhigh" },
                ],
              },
              { slug: "hidden-model", visibility: "hide" },
            ],
          });
        }
        if (url.endsWith("/revoke")) {
          state.revokes++;
          return new Response(null, { status: 200 });
        }
        return original(input, init);
      };
    }, jwk);
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "模型", exact: true }).click();
    const chatgptTemplate = page
      .locator(".provider-template-grid")
      .getByRole("button", { name: "OpenAI（ChatGPT）", exact: true });
    const icon = await chatgptTemplate.locator(".provider-logo-chatgpt").boundingBox();
    const label = await chatgptTemplate.locator(".provider-template-label").boundingBox();
    expect(icon).not.toBeNull();
    expect(label).not.toBeNull();
    expect(icon?.width).toBe(32);
    expect((label?.x ?? 0) - (icon?.x ?? 0) - (icon?.width ?? 0)).toBeCloseTo(12);
    await page.screenshot({ path: "test-results/chatgpt-provider-picker-light.png" });
    await chatgptTemplate.click();
    await expect(page.getByLabel("API key", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Base URL", { exact: true })).toHaveCount(0);
    const apiFormat = page.getByRole("combobox", { name: "API 格式", exact: true });
    await expect(apiFormat).toContainText("OpenAI Responses");
    await expect(apiFormat).toBeDisabled();
    await expect(page.getByRole("button", { name: "保存提供商", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Continue with ChatGPT", exact: true }).click();
    await expect(page.getByRole("button", { name: "取消登录", exact: true })).toBeVisible();
    const authorize = new URL(
      await app.evaluate(() => (globalThis as unknown as { oauthTest: { url: string } }).oauthTest.url),
    );
    expect(authorize.searchParams.get("client_id")).toBe("dynamic_agent_client");
    expect(authorize.searchParams.get("agent_name_hint")).toBe("ZPI");
    const idToken = await new SignJWT({
      nonce: authorize.searchParams.get("nonce"),
      email: "test@example.com",
    })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuer("https://auth.openai.com")
      .setAudience("oaiapp_ui")
      .setSubject("test-user")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(keys.privateKey);
    await app.evaluate((_electron, token) => {
      (globalThis as unknown as { oauthTest: { idToken: string } }).oauthTest.idToken = token;
    }, idToken);
    const callback = new URL(authorize.searchParams.get("redirect_uri") ?? "");
    callback.search = new URLSearchParams({
      code: "test-code",
      state: "wrong",
      client_id: "oaiapp_ui",
    }).toString();
    await page.getByLabel("ChatGPT 回调地址", { exact: true }).fill(callback.href);
    await page.getByRole("button", { name: "提交回调地址", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("输入内容无效，请检查后重试。");
    callback.searchParams.set("state", authorize.searchParams.get("state") ?? "");
    await page.getByLabel("ChatGPT 回调地址", { exact: true }).fill(callback.href);
    await page.getByRole("button", { name: "提交回调地址", exact: true }).click();
    await expect(page.getByRole("button", { name: "退出登录", exact: true })).toBeVisible();
    const loginButtons = await page.locator(".chatgpt-actions > button").evaluateAll((buttons) =>
      buttons.map((button) => {
        const css = getComputedStyle(button);
        return {
          height: button.getBoundingClientRect().height,
          width: button.getBoundingClientRect().width,
          fontSize: css.fontSize,
          padding: css.padding,
          lineHeight: css.lineHeight,
        };
      }),
    );
    expect(loginButtons).toHaveLength(2);
    expect(loginButtons[0]).toEqual(loginButtons[1]);
    await expect(page.locator(".provider-model-row")).toHaveCount(5);
    expect(
      await page
        .locator(".provider-model-row")
        .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-model-id"))),
    ).toEqual(["gpt-6.1-terra", "gpt-6.1-sol", "gpt-6-luna", "gpt-6-astra", "account-model"]);
    await expect(page.locator('[data-model-id="gpt-6.1-terra"]')).toContainText("GPT-6.1 Terra");
    await expect(page.locator('[data-model-id="gpt-6.1-sol"]')).toContainText("GPT-6.1 Sol");
    await expect(page.locator(".provider-model-row").filter({ hasText: "待验证" })).toHaveCount(0);
    await expect(page.locator(".chatgpt-connection")).toContainText("test@example.com");
    await expect(page.getByLabel("API key", { exact: true })).toHaveCount(0);
    const generation = readActiveGeneration(dir);
    if (!generation) throw new Error("Missing active storage generation");
    const database = new DatabaseSync(join(generation.directory, "state.sqlite"), { readOnly: true });
    try {
      const settings = database.prepare("SELECT data FROM app_settings WHERE key = ?").get("app");
      expect(settings?.data).toEqual(expect.any(String));
      expect(settings?.data).not.toContain("ui-private-");
    } finally {
      database.close();
    }
    const publicCredentials = await page.evaluate(async () => {
      const settings = await window.zpi.getSettings();
      if (!settings.ok) throw new Error(settings.error.message);
      return window.zpi.getProviderCredentials(settings.value.providers[0].id);
    });
    expect(publicCredentials).toEqual({ ok: true, value: { apiKey: "" } });
    await page.screenshot({ path: "test-results/chatgpt-model-settings-light.png" });
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.screenshot({ path: "test-results/chatgpt-model-settings-dark.png", animations: "disabled" });
    await page.getByRole("button", { name: "编辑模型 account-model", exact: true }).click();
    await page.getByText("高级配置", { exact: true }).click();
    await expect(page.getByLabel("输出上限字段", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await page.getByRole("button", { name: "获取模型", exact: true }).click();
    await expect(page.locator(".run-notice")).toContainText("账号可用性待验证");
    await page.getByRole("button", { name: "保存提供商", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page.getByRole("button", { name: "重新登录", exact: true }).click();
    await expect(page.getByRole("button", { name: "取消登录", exact: true })).toBeVisible();
    const returning = new URL(
      await app.evaluate(() => (globalThis as unknown as { oauthTest: { url: string } }).oauthTest.url),
    );
    expect(returning.searchParams.get("client_id")).toBe("oaiapp_ui");
    await page.getByRole("button", { name: "取消登录", exact: true }).click();
    await expect(page.getByRole("button", { name: "退出登录", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "退出登录", exact: true }).click();
    await expect(page.getByRole("button", { name: "Continue with ChatGPT", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "获取模型", exact: true })).toBeDisabled();
    expect(
      await app.evaluate(
        () => (globalThis as unknown as { oauthTest: { models: number; revokes: number } }).oauthTest,
      ),
    ).toMatchObject({ models: 2, revokes: 1 });
  } finally {
    await runCleanup([() => rm(dir, { recursive: true, force: true }), () => app?.close()]);
  }
});
