import { Type } from "typebox";
import { expect, expectTypeOf, test } from "vitest";
import { defineTool, type Options } from "../src/index.ts";

test("infers parameters, forwards native execution context and wraps text", async () => {
  const controller = new AbortController();
  const tool = defineTool({
    name: "lookup_order",
    description: "Look up an order",
    parameters: Type.Object({ orderId: Type.String(), limit: Type.Optional(Type.Integer()) }),
    execute({ orderId, limit }, { signal, toolCallId }) {
      expectTypeOf(orderId).toEqualTypeOf<string>();
      expectTypeOf(limit).toEqualTypeOf<number | undefined>();
      expectTypeOf(signal).toEqualTypeOf<AbortSignal | undefined>();
      expect(signal).toBe(controller.signal);
      expect(toolCallId).toBe("call-1");
      return `Order ${orderId}`;
    },
  });
  const options: Options = { zpi: { customTools: [tool] } };
  expect(options.zpi?.customTools?.[0]).toBe(tool);
  expect(tool.label).toBe("lookup_order");
  await expect(
    tool.execute("call-1", { orderId: "42" }, controller.signal, undefined, undefined as never),
  ).resolves.toEqual({ content: [{ type: "text", text: "Order 42" }], details: undefined });
});

test("wraps JSON objects from async services and preserves native tool options", async () => {
  interface Order {
    orderId: string;
    items: { sku: string }[];
  }
  const order: Order = { orderId: "42", items: [{ sku: "item-1" }] };
  const tool = defineTool({
    name: "lookup_order",
    label: "Order lookup",
    description: "Look up an order",
    metadata: { readOnly: true },
    parameters: Type.Object({ orderId: Type.String() }),
    async execute({ orderId }, { signal }) {
      expectTypeOf(orderId).toEqualTypeOf<string>();
      expect(orderId).toBe(order.orderId);
      expect(signal).toBeUndefined();
      return order;
    },
  });
  expect(tool.label).toBe("Order lookup");
  expect(tool.metadata).toEqual({ readOnly: true });
  await expect(
    tool.execute("call-2", { orderId: "42" }, undefined, undefined, undefined as never),
  ).resolves.toEqual({ content: [{ type: "text", text: JSON.stringify(order) }], details: undefined });
});

test("leaves callback errors to the existing tool runner", async () => {
  const error = new Error("Order service unavailable");
  const tool = defineTool({
    name: "lookup_order",
    description: "Look up an order",
    parameters: Type.Object({}),
    async execute() {
      throw error;
    },
  });
  await expect(tool.execute("call-3", {}, undefined, undefined, undefined as never)).rejects.toBe(error);
});
