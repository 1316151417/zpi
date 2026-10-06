import * as Menu from "@radix-ui/react-dropdown-menu";
import { Copy } from "lucide-react";
import type { Result } from "../shared/bridge.ts";
import { report, unwrap } from "./store.ts";

export function DirectoryMenuItems({
  getPath,
  className = "menu-item",
}: {
  getPath: () => Promise<string>;
  className?: string;
}) {
  const run = (action: (path: string) => Promise<Result<void>>) =>
    void getPath().then(action).then(unwrap).catch(report);
  return (
    <>
      <Menu.Item className={className} onSelect={() => run(window.ZPI.openDirectory)}>
        <img
          src={new URL("./file-actions/finder.png", document.baseURI).href}
          width={16}
          height={16}
          alt=""
        />
        Finder
      </Menu.Item>
      <Menu.Item className={className} onSelect={() => run(window.ZPI.copyText)}>
        <Copy size={14} />
        复制路径
      </Menu.Item>
    </>
  );
}
