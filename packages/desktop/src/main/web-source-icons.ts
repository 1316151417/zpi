import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import type { ClientRequest, IncomingMessage } from "node:http";
import { type RequestOptions, request } from "node:https";
import { isIP } from "node:net";
import { publicWebUrl } from "./web-client.ts";
import { decodeIconImage, iconImageFormat } from "./web-icon-image.ts";

const MAX_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 16 * 1024;
const DEADLINE_MS = 5_000;
const CACHE_SIZE = 128;
const MAX_ACTIVE = 4;
const MAX_QUEUED = 50;

type Dependencies = {
  lookup?: (hostname: string) => Promise<LookupAddress[]>;
  request?: (options: RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;
  decode?: (body: Buffer, signal: AbortSignal) => Promise<Buffer>;
  now?: () => number;
};
type Job = {
  url: URL;
  controller: AbortController;
  promise: Promise<string | undefined>;
  resolve: (value: string | undefined) => void;
  timer: ReturnType<typeof setTimeout>;
  deadline: number;
  waiters: number;
  started: boolean;
  done: boolean;
  cancelled: boolean;
};

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("Icon unavailable"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

/** Main-process only. Callers must authorize the DeepSeek source record before passing its site_icon. */
export class WebSourceIcons {
  private readonly dependencies: Required<Dependencies>;
  private readonly cache = new Map<string, { value: string | undefined; expires: number }>();
  private readonly pending = new Map<string, Job>();
  private readonly queue: Job[] = [];
  private active = 0;

  constructor(dependencies: Dependencies = {}) {
    this.dependencies = {
      lookup: (hostname) => lookup(hostname, { all: true, verbatim: true }),
      request,
      decode: decodeIconImage,
      now: Date.now,
      ...dependencies,
    };
  }

  load(iconUrl: string, signal?: AbortSignal): Promise<string | undefined> {
    if (signal?.aborted || !publicWebUrl(iconUrl)) return Promise.resolve(undefined);
    const url = new URL(iconUrl);
    if (url.protocol !== "https:" || (url.port && url.port !== "443")) return Promise.resolve(undefined);
    url.hash = "";
    const key = url.href;
    const cached = this.cache.get(key);
    if (cached && cached.expires > this.dependencies.now()) return Promise.resolve(cached.value);
    this.cache.delete(key);
    let job = this.pending.get(key);
    if (!job) {
      if (this.active >= MAX_ACTIVE && this.queue.length >= MAX_QUEUED) return Promise.resolve(undefined);
      let resolve: Job["resolve"] = () => {};
      const promise = new Promise<string | undefined>((done) => {
        resolve = done;
      });
      const controller = new AbortController();
      job = {
        url,
        controller,
        promise,
        resolve,
        timer: setTimeout(() => controller.abort(), DEADLINE_MS),
        deadline: this.dependencies.now() + DEADLINE_MS,
        waiters: 0,
        started: false,
        done: false,
        cancelled: false,
      };
      this.pending.set(key, job);
      this.queue.push(job);
      const queued = job;
      controller.signal.addEventListener("abort", () => this.finish(queued, undefined), { once: true });
      this.drain();
    }
    const shared = job;
    shared.waiters++;
    const result = signal ? abortable(shared.promise, signal).catch(() => undefined) : shared.promise;
    return result.finally(() => {
      shared.waiters--;
      // One caller cannot cancel another caller's shared work.
      if (!shared.done && shared.waiters === 0) {
        shared.cancelled = true;
        shared.controller.abort();
      }
    });
  }

  private drain() {
    while (this.active < MAX_ACTIVE && this.queue.length) {
      const job = this.queue.shift();
      if (!job || job.done) continue;
      if (this.dependencies.now() >= job.deadline) {
        job.controller.abort();
        continue;
      }
      job.started = true;
      this.active++;
      void abortable(
        this.fetchIcon(job.url, job.controller.signal, job.deadline),
        job.controller.signal,
      ).then(
        (value) => this.finish(job, value),
        () => this.finish(job, undefined),
      );
    }
  }

  private finish(job: Job, value: string | undefined) {
    if (job.done) return;
    job.done = true;
    clearTimeout(job.timer);
    this.pending.delete(job.url.href);
    if (job.started) this.active--;
    else {
      const index = this.queue.indexOf(job);
      if (index !== -1) this.queue.splice(index, 1);
    }
    if (!job.cancelled) {
      this.cache.set(job.url.href, {
        value,
        expires: this.dependencies.now() + (value ? 60 * 60_000 : 60_000),
      });
      while (this.cache.size > CACHE_SIZE) {
        const oldest = this.cache.keys().next().value;
        if (oldest !== undefined) this.cache.delete(oldest);
      }
    }
    job.resolve(value);
    this.drain();
  }

  private async fetchIcon(url: URL, signal: AbortSignal, deadline: number): Promise<string | undefined> {
    if (signal.aborted || this.dependencies.now() >= deadline) return undefined;
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const family = isIP(hostname);
    const addresses = family
      ? [{ address: hostname, family }]
      : await abortable(this.dependencies.lookup(hostname), signal);
    if (
      signal.aborted ||
      this.dependencies.now() >= deadline ||
      !addresses.length ||
      addresses.length > 64 ||
      addresses.some(
        ({ address, family }) =>
          ![4, 6].includes(family) ||
          isIP(address) !== family ||
          !publicWebUrl(`https://${family === 6 ? `[${address}]` : address}/`),
      )
    )
      return undefined;
    const pinned = addresses[0];
    const body = await this.download(url, pinned, signal);
    if (signal.aborted || this.dependencies.now() >= deadline) return undefined;
    const png = await abortable(this.dependencies.decode(body, signal), signal);
    if (
      signal.aborted ||
      this.dependencies.now() >= deadline ||
      png.length > MAX_OUTPUT_BYTES ||
      iconImageFormat(png) !== "png"
    )
      return undefined;
    return `data:image/png;base64,${png.toString("base64")}`;
  }

  private download(url: URL, pinned: LookupAddress, signal: AbortSignal): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      let req: ClientRequest | undefined;
      let response: IncomingMessage | undefined;
      let settled = false;
      const finish = (body?: Buffer) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        if (body) resolve(body);
        else {
          response?.destroy();
          req?.destroy();
          reject(new Error("Icon unavailable"));
        }
      };
      const abort = () => finish();
      if (signal.aborted) return finish();
      signal.addEventListener("abort", abort, { once: true });
      try {
        req = this.dependencies.request(
          {
            protocol: "https:",
            hostname: url.hostname.replace(/^\[|\]$/g, ""),
            port: 443,
            path: url.pathname + url.search,
            method: "GET",
            // Fresh non-proxy agent: no pooled sockets, ambient cookies, credentials or env proxy.
            agent: false,
            rejectUnauthorized: true,
            family: pinned.family,
            lookup: (_hostname, options, callback) => {
              if (options.all) callback(null, [pinned]);
              else callback(null, pinned.address, pinned.family);
            },
            headers: {
              Accept: "image/png,image/jpeg,image/gif,image/webp,image/x-icon,image/vnd.microsoft.icon",
              "Accept-Encoding": "identity",
            },
            signal,
          },
          (res) => {
            response = res;
            res.on("error", abort);
            res.on("aborted", abort);
            if (settled) return void res.destroy();
            const length = res.headers["content-length"];
            if (
              res.statusCode !== 200 ||
              (res.headers["content-encoding"] && res.headers["content-encoding"] !== "identity") ||
              (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES))
            )
              return finish();
            const buffer = Buffer.alloc(MAX_BYTES);
            let bytes = 0;
            res.on("data", (chunk: Buffer) => {
              if (settled) return;
              if (bytes + chunk.length > MAX_BYTES) return finish();
              chunk.copy(buffer, bytes);
              bytes += chunk.length;
            });
            res.on("end", () => {
              if (settled) return;
              const body = buffer.subarray(0, bytes);
              // DeepSeek's CDN serves valid PNG/ICO as binary/octet-stream or image/pnetvue.
              // Identify the bytes, then fully decode and re-encode them; never pass raw content to UI.
              finish(iconImageFormat(body) ? body : undefined);
            });
          },
        );
        req.on("error", abort);
        if (settled) req.destroy();
        else req.end();
      } catch {
        finish();
      }
    });
  }
}
