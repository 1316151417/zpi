import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  type Modifier,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { CSSProperties, KeyboardEvent, PointerEvent, ReactNode } from "react";

function interactive(target: EventTarget | null) {
  const control =
    target instanceof Element
      ? target.closest(
          "button, input, textarea, select, a, [contenteditable]:not([contenteditable=false]), [role=dialog]",
        )
      : null;
  return control !== null && !control.hasAttribute("data-sortable-select");
}
class RowPointerSensor extends PointerSensor {
  static activators = [
    {
      eventName: "onPointerDown" as const,
      handler: ({ nativeEvent }: PointerEvent) => !interactive(nativeEvent.target),
    },
  ];
}
type Bindings = Pick<
  ReturnType<typeof useSortable>,
  "attributes" | "setNodeRef" | "setActivatorNodeRef" | "isDragging"
> & {
  style: CSSProperties;
  listeners: ReturnType<typeof useSortable>["listeners"];
};
function Row<T extends { id: string }>({
  item,
  disabled,
  handleOnly,
  renderItem,
}: {
  item: T;
  disabled: boolean;
  handleOnly: boolean;
  renderItem(item: T, bindings: Bindings): ReactNode;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging, transform, transition } =
    useSortable({
      id: item.id,
      disabled,
    });
  return renderItem(item, {
    attributes,
    setNodeRef,
    setActivatorNodeRef,
    isDragging,
    style: {
      transform: CSS.Transform.toString(
        handleOnly && transform ? { ...transform, scaleX: 1, scaleY: 1 } : transform,
      ),
      transition,
    },
    listeners: {
      ...listeners,
      onKeyDown: (event: KeyboardEvent) => {
        if (handleOnly || !interactive(event.target)) listeners?.onKeyDown?.(event);
      },
    },
  });
}
const restrictVerticalDragWithinContainer: Modifier = ({
  transform,
  draggingNodeRect,
  activeNodeRect,
  containerNodeRect,
  windowRect,
}) => {
  const nodeRect = draggingNodeRect ?? activeNodeRect;
  const boundaryRect = containerNodeRect ?? windowRect;
  return {
    ...transform,
    x: 0,
    y:
      nodeRect && boundaryRect
        ? Math.min(
            Math.max(transform.y, boundaryRect.top - nodeRect.top),
            boundaryRect.bottom - nodeRect.bottom,
          )
        : transform.y,
  };
};
export function SortableList<T extends { id: string }>({
  items,
  disabled = false,
  handleOnly = false,
  constrainVertical = false,
  onReorder,
  renderItem,
}: {
  items: T[];
  disabled?: boolean;
  handleOnly?: boolean;
  constrainVertical?: boolean;
  onReorder(items: T[]): void;
  renderItem(item: T, bindings: Bindings): ReactNode;
}) {
  const sensors = useSensors(
    useSensor(handleOnly ? PointerSensor : RowPointerSensor, {
      activationConstraint: { distance: handleOnly ? 8 : 6 },
    }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={constrainVertical ? [restrictVerticalDragWithinContainer] : undefined}
      onDragEnd={({ active, over }) => {
        if (!over || active.id === over.id) return;
        const from = items.findIndex((item) => item.id === active.id);
        const to = items.findIndex((item) => item.id === over.id);
        if (from >= 0 && to >= 0) onReorder(arrayMove(items, from, to));
      }}
    >
      <SortableContext items={items.map((item) => item.id)} strategy={verticalListSortingStrategy}>
        {items.map((item) => (
          <Row
            key={item.id}
            item={item}
            disabled={disabled}
            handleOnly={handleOnly}
            renderItem={renderItem}
          />
        ))}
      </SortableContext>
    </DndContext>
  );
}
