import { ChevronRight } from "lucide-react";
import { createContext, type ReactNode, useContext, useLayoutEffect } from "react";
import { createPortal } from "react-dom";

const Navigation = createContext<{
  container: HTMLElement | null;
  onDetailChange(detail: boolean): void;
} | null>(null);

export function SettingsBreadcrumbProvider({
  container,
  onDetailChange,
  children,
}: {
  container: HTMLElement | null;
  onDetailChange(detail: boolean): void;
  children?: ReactNode;
}) {
  return <Navigation.Provider value={{ container, onDetailChange }}>{children}</Navigation.Provider>;
}

/** Project the existing page's navigation into the shared settings titlebar. */
export function SettingsBreadcrumb({
  section,
  current,
  disabled,
  onBack,
}: {
  section: string;
  current: string;
  disabled?: boolean;
  onBack(): void;
}) {
  const navigation = useContext(Navigation);
  const report = navigation?.onDetailChange;
  useLayoutEffect(() => {
    report?.(true);
    return () => report?.(false);
  }, [report]);
  if (!navigation?.container) return null;
  return createPortal(
    <nav className="settings-breadcrumb" aria-label={`${section}导航`}>
      <ol>
        <li>
          <button type="button" aria-label={`返回${section}列表`} disabled={disabled} onClick={onBack}>
            {section}
          </button>
        </li>
        <li>
          <ChevronRight size={14} aria-hidden="true" />
          <span aria-current="page" title={current}>
            {current}
          </span>
        </li>
      </ol>
    </nav>,
    navigation.container,
  );
}
