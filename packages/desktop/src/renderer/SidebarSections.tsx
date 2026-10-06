import { SortableList } from "ZPI-ui";
import { ChevronDown, ChevronRight, GripVertical } from "lucide-react";
import { type ReactNode, useState } from "react";

const storageKey = "ZPI.sidebarSectionOrder";
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
        constrainVertical
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
          { setNodeRef, setActivatorNodeRef, style, attributes, listeners, isDragging },
        ) => (
          <section
            ref={setNodeRef}
            className="sidebar-purpose-section"
            aria-label={section.title}
            data-sidebar-section={section.id}
            style={{ ...style, zIndex: isDragging ? 10 : undefined, opacity: isDragging ? 0.85 : 1 }}
          >
            <div className="sidebar-heading">
              <button
                type="button"
                className="section-toggle"
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
              <div className="sidebar-heading-actions">
                <button
                  ref={setActivatorNodeRef}
                  type="button"
                  className="section-drag-handle"
                  aria-label={`移动${section.title}分区`}
                  {...attributes}
                  {...listeners}
                >
                  <GripVertical size={14} aria-hidden="true" />
                </button>
                {section.action}
              </div>
            </div>
            {section.children}
          </section>
        )}
      />
    </div>
  );
}
