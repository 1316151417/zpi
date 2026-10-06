import { getProviderPreset } from "ZPI-ai";
import { Package } from "lucide-react";
import openai from "./assets/providers/chatgpt.png";
import deepseek from "./assets/providers/deepseek.png";
import mimo from "./assets/providers/mimo.png";
import minimax from "./assets/providers/minimax.png";
import zhipu from "./assets/providers/zhipu.svg";

const icons = { openai, deepseek, minimax, mimo, zhipu };
export function ProviderLogo({ preset, size = 24 }: { preset?: string; size?: number }) {
  const family = preset ? getProviderPreset(preset)?.family : undefined;
  if (!family) return <Package size={size} />;
  const image = <img className="provider-logo" src={icons[family]} width={size} height={size} alt="" />;
  return family === "openai" ? (
    <span className="provider-logo-chatgpt" style={{ width: size, height: size }}>
      {image}
    </span>
  ) : (
    image
  );
}
