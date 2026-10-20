// Adapted from ZCode project-sidebar/PurposeSections and WorkspacePurposeSection (Apache-2.0), 3c5b2276.
import type { Modifier } from "@dnd-kit/core";
import { ChevronDown, ChevronRight } from "lucide-react";
import { type ReactNode, useState } from "react";
import { SortableList } from "zpi-ui";

const verticalAxis: Modifier[] = [({ transform }) => ({ ...transform, x: 0 })];
const storageKey = "zpi.sidebarSectionOrder";
const defaultOrder = ["projects", "tasks"] as const;
type SectionId = (typeof defaultOrder)[number];
interface Section {
  title: string;
  open: boolean;
  onToggle(): void;
  action: ReactNode;
  children: ReactNode;
}

function readOrder(): SectionId[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    if (Array.isArray(value) && value.length === 2 && defaultOrder.every((id) => value.includes(id)))
      return value;
  } catch {
    // Restricted storage must not prevent using the sidebar.
  }
  return [...defaultOrder];
}

export function SidebarSections({ projects, tasks }: { projects: Section; tasks: Section }) {
  const [order, setOrder] = useState(readOrder);
  const sections = { projects, tasks };
  return (
    <div className="sidebar-purpose-sections">
      <SortableList
        items={order.map((id) => ({ id, ...sections[id] }))}
        handleOnly
        activationDistance={6}
        modifiers={verticalAxis}
        onReorder={(items) => {
          const next = items.map((item) => item.id);
          setOrder(next);
          try {
            localStorage.setItem(storageKey, JSON.stringify(next));
          } catch {
            // Keep the reordered sections usable when storage is unavailable.
          }
        }}
        renderItem={(
          section,
          { setNodeRef, setActivatorNodeRef, style, attributes, listeners, isDragging, dropPosition },
        ) => (
          <section
            ref={setNodeRef}
            className="sidebar-purpose-section"
            aria-label={section.title}
            data-sidebar-section={section.id}
            style={{
              ...style,
              zIndex: dropPosition ? 20 : isDragging ? 10 : undefined,
              opacity: isDragging ? 0.85 : 1,
            }}
          >
            {dropPosition && (
              <div
                className={`project-drop-indicator ${dropPosition}`}
                data-testid="purpose-section-drop-indicator"
                data-drop-position={dropPosition}
                aria-hidden="true"
              >
                <span />
              </div>
            )}
            <div className="sidebar-heading">
              <button
                ref={setActivatorNodeRef}
                {...attributes}
                {...listeners}
                type="button"
                className="section-toggle"
                aria-description={`移动${section.title}分区`}
                data-purpose-section-drag-trigger={section.id}
                aria-label={`${section.open ? "收起" : "展开"}${section.title}列表`}
                aria-expanded={section.open}
                onClick={section.onToggle}
              >
                <span>{section.title}</span>
                {section.open ? (
                  <ChevronDown size={14} aria-hidden="true" />
                ) : (
                  <ChevronRight size={14} aria-hidden="true" />
                )}
              </button>
              <div className="sidebar-heading-actions">{section.action}</div>
            </div>
            {section.children}
          </section>
        )}
      />
    </div>
  );
}
