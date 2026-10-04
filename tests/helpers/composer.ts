import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
export async function create(page: Page) {
  await page.locator(".sidebar-global").getByRole("button", { name: "新对话", exact: true }).click();
  await expect(page.getByLabel("消息", { exact: true })).toBeVisible();
}
export async function select(page: Page, id: string) {
  await page.locator(`.recent-sessions .session-row[data-session-id="${id}"] .session-name`).click();
}
export async function clipboardText(page: Page, cut = false) {
  return page.getByLabel("消息", { exact: true }).evaluate((el, cut) => {
    const data = new DataTransfer();
    el.dispatchEvent(
      new ClipboardEvent(cut ? "cut" : "copy", { clipboardData: data, bubbles: true, cancelable: true }),
    );
    return data.getData("text/plain");
  }, cut);
}
