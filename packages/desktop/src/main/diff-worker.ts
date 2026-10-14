import { parentPort, workerData } from "node:worker_threads";
import { createTwoFilesPatch } from "diff";

const { path, created, before, after } = workerData as {
  path: string;
  created: boolean;
  before: string;
  after: string;
};
// Keep the existing diff semantics and budget, but isolate its synchronous work from Electron.
parentPort?.postMessage(
  createTwoFilesPatch(created ? "/dev/null" : path, path, before, after, "", "", {
    context: 3,
    timeout: 1000,
  }),
);
