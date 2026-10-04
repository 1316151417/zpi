import {
  closestCenter,
  DndContext,
  KeyboardSensor,
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
type Bindings = Pick<ReturnType<typeof useSortable>, "attributes" | "setNodeRef" | "isDragging"> & {
  style: CSSProperties;
  listeners: ReturnType<typeof useSortable>["listeners"];
};
function Row<T extends { id: string }>({
  item,
  disabled,
  renderItem,
}: {
  item: T;
  disabled: boolean;
  renderItem(item: T, bindings: Bindings): ReactNode;
}) {
  const { attributes, listeners, setNodeRef, isDragging, transform, transition } = useSortable({
    id: item.id,
    disabled,
  });
  return renderItem(item, {
    attributes,
    setNodeRef,
    isDragging,
    style: { transform: CSS.Transform.toString(transform), transition },
    listeners: {
      ...listeners,
      onKeyDown: (event: KeyboardEvent) => {
        if (!interactive(event.target)) listeners?.onKeyDown?.(event);
      },
    },
  });
}
export function SortableList<T extends { id: string }>({
  items,
  disabled = false,
  onReorder,
  renderItem,
}: {
  items: T[];
  disabled?: boolean;
  onReorder(items: T[]): void;
  renderItem(item: T, bindings: Bindings): ReactNode;
}) {
  const sensors = useSensors(
    useSensor(RowPointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={({ active, over }) => {
        if (!over || active.id === over.id) return;
        const from = items.findIndex((item) => item.id === active.id);
        const to = items.findIndex((item) => item.id === over.id);
        if (from >= 0 && to >= 0) onReorder(arrayMove(items, from, to));
      }}
    >
      <SortableContext items={items.map((item) => item.id)} strategy={verticalListSortingStrategy}>
        {items.map((item) => (
          <Row key={item.id} item={item} disabled={disabled} renderItem={renderItem} />
        ))}
      </SortableContext>
    </DndContext>
  );
}
