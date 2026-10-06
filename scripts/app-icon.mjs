import { mkdir } from "node:fs/promises";
import sharp from "sharp";

export async function buildAppIcon() {
  await mkdir("packages/desktop/dist", { recursive: true });
  // Keep the artwork inside an 824px square on a 1024px transparent macOS icon canvas.
  const background = { r: 0, g: 0, b: 0, alpha: 0 };
  await sharp("icon.png")
    .resize(824, 824, { fit: "contain", background })
    .extend({ top: 100, bottom: 100, left: 100, right: 100, background })
    .png()
    .toFile("packages/desktop/dist/icon-mac.png");
}
