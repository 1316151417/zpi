import { defineTool, query } from "@zpi-dev/agent-sdk";
import { Type } from "typebox";

const lookupOrder = defineTool({
  name: "lookup_order",
  description: "查询演示订单的状态",
  parameters: Type.Object({ orderId: Type.String() }),
  execute({ orderId }) {
    return { orderId, status: "已发货" };
  },
});

for await (const message of query({
  prompt: "请调用 lookup_order 查询订单 42 的状态。",
  options: {
    model: "deepseek",
    persistSession: false,
    tools: [lookupOrder.name],
    zpi: { customTools: [lookupOrder] },
  },
})) {
  if (message.type === "result") {
    if (message.subtype !== "success") throw new Error(message.errors.join("\n"));
    console.log(message.result);
  }
}
