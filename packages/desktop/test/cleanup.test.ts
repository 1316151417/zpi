import { access } from "node:fs/promises";
import { beforeEach, expect, it, vi } from "vitest";
import { type CleanupAction, runCleanup } from "../../../tests/helpers/cleanup.ts";

const resources = vi.hoisted(() => ({
  hostClose: vi.fn(async () => {}),
  serverClose: vi.fn(async () => {}),
  initError: new Error("initialization failed"),
  dir: "",
}));
vi.mock("../src/main/session-host.ts", () => ({
  SessionHost: class {
    constructor(dir: string) {
      resources.dir = dir;
    }
    async init() {
      throw resources.initError;
    }
    close = resources.hostClose;
  },
}));
vi.mock("../../../tests/fake-server.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../tests/fake-server.ts")>()),
  fakeServer: async () => ({ url: "http://127.0.0.1:1", close: resources.serverClose }),
}));

import { cleanup as contextCleanup, fixture } from "./helpers/context-fixture.ts";
import { cleanup as sessionCleanup, setup } from "./helpers/session-fixture.ts";

beforeEach(() => {
  vi.clearAllMocks();
});

it("attempts all cleanup actions in reverse acquisition order and reports every failure", async () => {
  const order: string[] = [];
  const hostError = new Error("host close failed"),
    serverError = new Error("server close failed");
  const actions: CleanupAction[] = [
    () => order.push("directory"),
    () => {
      order.push("server");
      throw serverError;
    },
    async () => {
      order.push("host");
      throw hostError;
    },
  ];
  await expect(runCleanup(actions)).rejects.toMatchObject({ errors: [hostError, serverError] });
  expect(order).toEqual(["host", "server", "directory"]);
  expect(actions).toEqual([]);
  await runCleanup(actions);
  expect(order).toHaveLength(3);
});

it.each([
  ["context", fixture, contextCleanup],
  ["session", setup, sessionCleanup],
] as const)(
  "%s fixture releases partially initialized hosts, servers, and directories",
  async (_, create, cleanup) => {
    resources.hostClose.mockRejectedValueOnce(new Error("host close failed"));
    await expect(create()).rejects.toBe(resources.initError);
    const dir = resources.dir;
    await expect(runCleanup(cleanup)).rejects.toBeInstanceOf(AggregateError);
    expect(resources.hostClose).toHaveBeenCalledOnce();
    expect(resources.serverClose).toHaveBeenCalledOnce();
    await expect(access(dir)).rejects.toMatchObject({ code: "ENOENT" });
    expect(cleanup).toHaveLength(0);
  },
);

it("cleans previously acquired resources when desktop launch fails", async () => {
  const cleanup: CleanupAction[] = [];
  const removeDirectory = vi.fn(),
    closeServer = vi.fn();
  const launchError = new Error("launch failed");
  const launch = vi.fn(async () => {
    throw launchError;
  });
  const acquire = async () => {
    cleanup.push(removeDirectory);
    try {
      cleanup.push(closeServer);
      await launch();
    } finally {
      await runCleanup(cleanup);
    }
  };
  await expect(acquire()).rejects.toBe(launchError);
  expect(closeServer).toHaveBeenCalledOnce();
  expect(removeDirectory).toHaveBeenCalledOnce();
});
