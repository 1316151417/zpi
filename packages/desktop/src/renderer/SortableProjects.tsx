// Adapted from ZCode project-sidebar/{SortableProjects,ProjectNode} (Apache-2.0), 3c5b2276.
import type { ReactNode } from "react";
import { type SortableBindings, SortableList } from "zpi-ui";
import type { ProjectRecord } from "../shared/bridge.ts";

type Bindings = Pick<SortableBindings, "attributes" | "listeners" | "setActivatorNodeRef">;
export function SortableProjects({
  projects,
  renderProject,
  onReorder,
}: {
  projects: ProjectRecord[];
  renderProject(project: ProjectRecord, bindings: Bindings): ReactNode;
  onReorder(projects: ProjectRecord[]): void;
}) {
  return (
    <SortableList
      items={projects}
      handleOnly
      activationDistance={6}
      onReorder={onReorder}
      renderItem={(project, { setNodeRef, style, isDragging, dropPosition, ...bindings }) => (
        <section
          ref={setNodeRef}
          className="project"
          data-project-id={project.id}
          style={{ ...style, position: "relative", zIndex: dropPosition ? 20 : isDragging ? 10 : undefined }}
        >
          {dropPosition && (
            <div
              className={`project-drop-indicator ${dropPosition}`}
              data-testid="project-drop-indicator"
              data-drop-position={dropPosition}
              aria-hidden="true"
            >
              <span />
            </div>
          )}
          {renderProject(project, bindings)}
        </section>
      )}
    />
  );
}
