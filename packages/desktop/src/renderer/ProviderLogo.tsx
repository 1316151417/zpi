import { Package } from "lucide-react";
import { getProviderPreset } from "zpi-ai";
import deepseek from "./assets/providers/deepseek.png";
import mimo from "./assets/providers/mimo.png";
import minimax from "./assets/providers/minimax.png";
import zhipu from "./assets/providers/zhipu.svg";

const icons = { deepseek, minimax, mimo, zhipu };
export function ProviderLogo({ preset, size = 24 }: { preset?: string; size?: number }) {
  const family = preset ? getProviderPreset(preset)?.family : undefined;
  return family ? (
    <img className="provider-logo" src={icons[family]} width={size} height={size} alt="" />
  ) : (
    <Package size={size} />
  );
}
