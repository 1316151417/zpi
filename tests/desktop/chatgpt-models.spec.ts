import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { launchDesktop } from "../helpers/desktop.ts";

test("ChatGPT OAuth settings hide API keys, accept callbacks, auto-discover and cancel or disconnect", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-chatgpt-ui-"));
  const app = await launchDesktop({ dir, url: "" });
  try {
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
    await page
      .locator(".provider-template-grid")
      .getByRole("button", { name: "OpenAI（ChatGPT）", exact: true })
      .click();
    await expect(page.getByLabel("API key", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Base URL", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("API 格式", { exact: true })).toHaveValue(
      "OpenAI Responses · ChatGPT 套餐授权",
    );
    await expect(page.getByRole("button", { name: "保存提供商", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Continue with ChatGPT", exact: true }).click();
    await expect(page.getByRole("button", { name: "取消登录", exact: true })).toBeVisible();
    const authorize = new URL(
      await app.evaluate(() => (globalThis as unknown as { oauthTest: { url: string } }).oauthTest.url),
    );
    expect(authorize.searchParams.get("client_id")).toBe("dynamic_agent_client");
    expect(authorize.searchParams.get("agent_name_hint")).toBe("zpi");
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
    await expect(page.getByRole("alert")).toContainText("state");
    callback.searchParams.set("state", authorize.searchParams.get("state") ?? "");
    await page.getByLabel("ChatGPT 回调地址", { exact: true }).fill(callback.href);
    await page.getByRole("button", { name: "提交回调地址", exact: true }).click();
    await expect(page.getByRole("button", { name: "退出登录", exact: true })).toBeVisible();
    await expect(page.locator(".provider-model-row")).toHaveCount(4);
    await expect(page.locator('[data-model-id="gpt-6.1-sol"]')).toContainText("GPT-6.1 Sol");
    await expect(page.locator('[data-model-id="gpt-6.1-sol"]')).toContainText("待验证");
    await expect(page.locator(".chatgpt-connection")).toContainText("test@example.com");
    await expect(page.getByLabel("API key", { exact: true })).toHaveCount(0);
    expect(await readFile(join(dir, "settings.json"), "utf8")).not.toContain("ui-private-");
    const publicCredentials = await page.evaluate(async () => {
      const settings = await window.zpi.getSettings();
      if (!settings.ok) throw new Error(settings.error.message);
      return window.zpi.getProviderCredentials(settings.value.providers[0].id);
    });
    expect(publicCredentials).toEqual({ ok: true, value: { apiKey: "" } });
    await page.screenshot({ path: "test-results/chatgpt-model-settings-light.png" });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.screenshot({ path: "test-results/chatgpt-model-settings-dark.png" });
    await page.getByRole("button", { name: "编辑模型 account-model", exact: true }).click();
    await page.getByText("高级配置", { exact: true }).click();
    await expect(page.getByLabel("输出上限字段", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await page.getByRole("button", { name: "获取模型", exact: true }).click();
    await expect(page.locator(".run-notice")).toContainText("账号可用性待验证");
    await page.getByRole("button", { name: "保存提供商", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page.getByRole("button", { name: "重新登录 ChatGPT", exact: true }).click();
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
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
