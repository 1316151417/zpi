import * as Menu from "@radix-ui/react-dropdown-menu";
import { Copy } from "lucide-react";
import type { Result } from "../shared/bridge.ts";
import { report } from "./store.ts";
import { unwrap } from "./unwrap.ts";

export function DirectoryMenuItems({
  getPath,
  Item = Menu.Item,
  className = "menu-item",
}: {
  getPath: () => Promise<string>;
  Item?: typeof Menu.Item;
  className?: string;
}) {
  const run = (action: (path: string) => Promise<Result<void>>) =>
    void getPath().then(action).then(unwrap).catch(report);
  return (
    <>
      <Item className={className} onSelect={() => run(window.zpi.openDirectory)}>
        <img
          src={new URL("./file-actions/finder.png", document.baseURI).href}
          width={16}
          height={16}
          alt=""
        />
        Finder
      </Item>
      <Item className={className} onSelect={() => run(window.zpi.copyText)}>
        <Copy size={14} />
        复制路径
      </Item>
    </>
  );
}
