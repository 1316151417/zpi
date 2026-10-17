import { createHash } from "node:crypto";
import type { LookupAddress } from "node:dns";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import type { ClientRequest, IncomingHttpHeaders, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import { PassThrough } from "node:stream";
import sharp from "sharp";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSourceIcons } from "../src/main/web-source-icons.ts";

const URL = "https://icons.example.com/icon.png";
const PUBLIC = { address: "93.184.215.14", family: 4 };
const MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
let png: Buffer;
beforeAll(async () => {
  png = await sharp({ create: { width: 8, height: 4, channels: 4, background: "red" } })
    .png()
    .toBuffer();
});
beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

type Reply = {
  status?: number;
  type?: string;
  headers?: IncomingHttpHeaders;
  chunks?: Buffer[];
  hang?: "headers" | "body";
  error?: boolean;
};
function harness(reply: Reply = {}, addresses: LookupAddress[] = [PUBLIC]) {
  const requests: Array<{ options: RequestOptions; destroy: ReturnType<typeof vi.fn> }> = [];
  const lookup = vi.fn(async (_hostname: string) => addresses);
  const decode = vi.fn(async (_body: Buffer, _signal: AbortSignal) => png);
  const request = vi.fn((options: RequestOptions, callback: (response: IncomingMessage) => void) => {
    const req = new EventEmitter();
    const response = new PassThrough() as unknown as IncomingMessage;
    response.statusCode = reply.status ?? 200;
    response.headers = { "content-type": reply.type ?? "image/png", ...reply.headers };
    const destroy = vi.fn(() => {
      response.destroy();
      return req;
    });
    Object.assign(req, {
      destroy,
      end: () => {
        void Promise.resolve().then(() => {
          if (reply.error) return void req.emit("error", new Error("Private transport detail"));
          if (reply.hang === "headers") return;
          callback(response);
          if (reply.hang === "body" || response.destroyed) return;
          for (const chunk of reply.chunks ?? [png]) (response as unknown as PassThrough).write(chunk);
          (response as unknown as PassThrough).end();
        });
      },
    });
    requests.push({ options, destroy });
    return req as unknown as ClientRequest;
  });
  const dependencies = { lookup, request, decode };
  return { ...dependencies, requests, icons: new WebSourceIcons(dependencies) };
}

async function flush() {
  await vi.advanceTimersByTimeAsync(0);
}

describe("source icon URL and DNS isolation", () => {
  it.each([
    "http://icons.example.com/icon.png",
    "file:///tmp/icon.png",
    "data:image/png;base64,aGVsbG8=",
    "javascript:alert(1)",
    "https://user:password@example.com/icon.png",
    "https://user@example.com/icon.png",
    "https://example.com:8443/icon.png",
    "https://localhost/icon.png",
    "https://a.localhost/icon.png",
    "https://a.internal/icon.png",
    "https://home.arpa/icon.png",
    "https://127.0.0.1/icon.png",
    "https://2130706433/icon.png",
    "https://0x7f000001/icon.png",
    "https://10.1.2.3/icon.png",
    "https://169.254.169.254/icon.png",
    "https://100.64.0.1/icon.png",
    "https://192.0.2.1/icon.png",
    "https://[::1]/icon.png",
    "https://[::ffff:127.0.0.1]/icon.png",
    "https://[::ffff:93.184.215.14]/icon.png",
    "https://[fd00::1]/icon.png",
    "https://[2001:db8::1]/icon.png",
    "https://[2002:0808:0808::1]/icon.png",
  ])("rejects unsafe URL without DNS or HTTP: %s", async (url) => {
    const h = harness();
    expect(await h.icons.load(url)).toBeUndefined();
    expect(h.lookup).not.toHaveBeenCalled();
    expect(h.request).not.toHaveBeenCalled();
  });

  it.each([
    [],
    [{ address: "127.0.0.1", family: 4 }],
    [{ address: "10.0.0.1", family: 4 }],
    [{ address: "172.16.0.1", family: 4 }],
    [{ address: "192.168.1.1", family: 4 }],
    [{ address: "169.254.169.254", family: 4 }],
    [{ address: "198.18.0.1", family: 4 }],
    [{ address: "::ffff:93.184.215.14", family: 6 }],
    [{ address: "fe80::1", family: 6 }],
    [{ address: "2001:db8::1", family: 6 }],
    [{ address: "invalid", family: 4 }],
    [{ address: "93.184.215.14", family: 6 }],
    [PUBLIC, { address: "10.0.0.1", family: 4 }],
    [PUBLIC, { address: "::1", family: 6 }],
  ])("rejects empty, malformed, non-global, and mixed DNS results: %j", async (...addresses) => {
    // Each table row is an array of addresses, spread by Vitest's table runner.
    const h = harness({}, addresses);
    expect(await h.icons.load(URL)).toBeUndefined();
    expect(h.request).not.toHaveBeenCalled();
    expect(h.decode).not.toHaveBeenCalled();
  });

  it("pins the validated address even if subsequent DNS changes, preserving HTTPS hostname", async () => {
    const h = harness();
    h.lookup.mockResolvedValueOnce([PUBLIC]).mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    await h.icons.load(`${URL}?v=1#fragment`);
    const options = h.requests[0].options;
    expect(options).toMatchObject({
      protocol: "https:",
      hostname: "icons.example.com",
      port: 443,
      path: "/icon.png?v=1",
      family: 4,
      rejectUnauthorized: true,
      agent: false,
    });
    const callback = vi.fn();
    options.lookup?.("icons.example.com", { all: false }, callback);
    expect(callback).toHaveBeenCalledWith(null, PUBLIC.address, 4);
    const all = vi.fn();
    options.lookup?.("icons.example.com", { all: true }, all);
    expect(all).toHaveBeenCalledWith(null, [PUBLIC]);
    expect(h.lookup).toHaveBeenCalledTimes(1);
  });

  it.each(["https://93.184.215.14/icon.png", "https://[2606:4700:4700::1111]/icon.png"])(
    "allows public literals without a second DNS resolution: %s",
    async (url) => {
      const h = harness();
      expect(await h.icons.load(url)).toMatch(/^data:image\/png;base64,/);
      expect(h.lookup).not.toHaveBeenCalled();
      expect(h.request).toHaveBeenCalledTimes(1);
    },
  );

  it("sends only image headers, no credentials/referrer/cookies, and does not use the ambient agent", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://user:secret@127.0.0.1:8000");
    vi.stubEnv("NODE_USE_ENV_PROXY", "1");
    const h = harness({ headers: { "set-cookie": ["secret=never-send"] } });
    await h.icons.load(URL);
    await h.icons.load(`${URL}?different`);
    for (const { options } of h.requests) {
      expect(options.agent).toBe(false);
      expect(options.headers).toEqual({
        Accept: "image/png,image/jpeg,image/gif,image/webp,image/x-icon,image/vnd.microsoft.icon",
        "Accept-Encoding": "identity",
      });
      expect(options).not.toHaveProperty("auth");
      expect(options).not.toHaveProperty("proxyEnv");
    }
  });
});

describe("source icon body and decode isolation", () => {
  it.each([301, 302, 303, 307, 308, 401, 404, 500])("never follows status %i", async (status) => {
    const h = harness({ status, headers: { location: "https://127.0.0.1/secret" } });
    expect(await h.icons.load(URL)).toBeUndefined();
    expect(h.request).toHaveBeenCalledTimes(1);
    expect(h.requests[0].destroy).toHaveBeenCalled();
    expect(h.decode).not.toHaveBeenCalled();
  });

  it.each([
    { type: "image/svg+xml", chunks: [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')] },
    { type: "text/html", chunks: [Buffer.from("<script>alert(1)</script>")] },
    { type: "image/png", chunks: [Buffer.from("<html>not an image</html>")] },
    { type: "binary/octet-stream", chunks: [Buffer.from('<svg onload="alert(1)"/>')] },
    { type: "image/pnetvue", chunks: [Buffer.from("not an image")] },
    { chunks: [MAGIC], headers: { "content-encoding": "gzip" } },
    { chunks: [MAGIC], headers: { "content-length": "262145" } },
    { chunks: [MAGIC], headers: { "content-length": "invalid" } },
    { chunks: [MAGIC, Buffer.alloc(256 * 1024)] },
    { chunks: [] },
  ])("rejects unsupported bytes, compressed, oversized or empty content: %j", async (reply) => {
    const h = harness(reply);
    expect(await h.icons.load(URL)).toBeUndefined();
    expect(h.decode).not.toHaveBeenCalled();
  });

  it.each([
    { type: "image/png; charset=binary", chunks: [MAGIC] },
    { type: "binary/octet-stream", chunks: [MAGIC] },
    { type: "application/octet-stream", chunks: [MAGIC] },
    { type: "image/pnetvue", chunks: [MAGIC] },
    { type: "image/jpeg", chunks: [MAGIC] },
    { type: "image/jpeg", chunks: [Buffer.from([255, 216, 255, 224])] },
    { type: "image/gif", chunks: [Buffer.from("GIF89a")] },
    { type: "image/webp", chunks: [Buffer.from("RIFF1234WEBP")] },
  ])("recognizes supported image bytes independently of unreliable response MIME: %j", async (reply) => {
    const h = harness(reply);
    expect(await h.icons.load(URL)).toBe(`data:image/png;base64,${png.toString("base64")}`);
    expect(h.decode).toHaveBeenCalledTimes(1);
  });

  it("contains DNS, transport and decode failures without logging URLs or errors", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = harness({ error: true });
    expect(await h.icons.load(URL)).toBeUndefined();
    h.lookup.mockRejectedValueOnce(new Error("private DNS detail"));
    expect(await h.icons.load(`${URL}?dns`)).toBeUndefined();
    const d = harness();
    d.decode.mockRejectedValue(new Error("private decoder detail"));
    expect(await d.icons.load(URL)).toBeUndefined();
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("uses the real bounded decoder to produce a 32px PNG without input metadata", async () => {
    const h = harness();
    const icons = new WebSourceIcons({ lookup: h.lookup, request: h.request });
    const result = await icons.load(URL);
    expect(result).toMatch(/^data:image\/png;base64,/);
    const metadata = await sharp(Buffer.from(result?.split(",")[1] ?? "", "base64")).metadata();
    expect(metadata).toMatchObject({ format: "png", width: 32, height: 32 });
    expect(metadata.exif).toBeUndefined();
  });

  const realSources = JSON.parse(
    readFileSync(new globalThis.URL("./fixtures/web-source-icons/sources.json", import.meta.url), "utf8"),
  ) as Array<{ file: string; url: string; contentType: string; bytes: number; sha256: string }>;
  it.each(realSources)(
    "renders actual DeepSeek CDN response $file ($contentType) through mock transport and real decode",
    async ({ file, url, contentType, bytes, sha256 }) => {
      const body = readFileSync(new globalThis.URL(`./fixtures/web-source-icons/${file}`, import.meta.url));
      expect(body.length).toBe(bytes);
      expect(createHash("sha256").update(body).digest("hex")).toBe(sha256);
      const h = harness({ type: contentType, chunks: [body] });
      const icons = new WebSourceIcons({ lookup: h.lookup, request: h.request });
      const result = await icons.load(url);
      expect(h.lookup).toHaveBeenCalledExactlyOnceWith("cdn.deepseek.com");
      expect(h.request).toHaveBeenCalledTimes(1);
      expect(result).toMatch(/^data:image\/png;base64,/);
      const output = Buffer.from(result?.split(",")[1] ?? "", "base64");
      expect(output.length).toBeLessThanOrEqual(16 * 1024);
      const metadata = await sharp(output).metadata();
      expect(metadata).toMatchObject({ format: "png", width: 32, height: 32 });
      expect(metadata.exif).toBeUndefined();
      expect(metadata.icc).toBeUndefined();
      const { data, info } = await sharp(output).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      expect(info.channels).toBe(4);
      expect(data.some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
    },
  );

  it("rejects corrupted images and images exceeding the one-megapixel decode limit", async () => {
    const large = await sharp({ create: { width: 1025, height: 1025, channels: 3, background: "red" } })
      .png()
      .toBuffer();
    for (const body of [Buffer.concat([MAGIC, Buffer.alloc(16)]), large]) {
      const h = harness({ chunks: [body] });
      const icons = new WebSourceIcons({ lookup: h.lookup, request: h.request });
      expect(await icons.load(URL)).toBeUndefined();
    }
  });
});

describe("source icon resource bounds", () => {
  it.each(["dns", "headers", "body", "decode"])(
    "enforces the five-second deadline during %s",
    async (stage) => {
      const h = harness(stage === "headers" || stage === "body" ? { hang: stage } : {});
      if (stage === "dns") h.lookup.mockImplementation(() => new Promise(() => {}));
      if (stage === "decode") h.decode.mockImplementation(() => new Promise(() => {}));
      const result = h.icons.load(URL);
      await flush();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await result).toBeUndefined();
      if (stage === "headers" || stage === "body") expect(h.requests[0].destroy).toHaveBeenCalled();
    },
  );

  it("cancels the last waiter, destroys transport, and does not cache user cancellation", async () => {
    const h = harness({ hang: "body" });
    const controller = new AbortController();
    const result = h.icons.load(URL, controller.signal);
    await flush();
    controller.abort();
    expect(await result).toBeUndefined();
    expect(h.requests[0].destroy).toHaveBeenCalled();
    const second = h.icons.load(URL);
    await flush();
    expect(h.request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5_000);
    await second;
  });

  it("shares in-flight work while allowing one waiter to cancel independently", async () => {
    const h = harness();
    let complete: (value: Buffer) => void = () => {};
    h.decode.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const controller = new AbortController();
    const one = h.icons.load(URL, controller.signal);
    const two = h.icons.load(URL);
    await flush();
    controller.abort();
    expect(await one).toBeUndefined();
    expect(h.requests[0].options.signal?.aborted).toBe(false);
    complete(png);
    expect(await two).toMatch(/^data:image\/png;base64,/);
    expect(h.request).toHaveBeenCalledTimes(1);
  });

  it("rejects already cancelled requests without starting work", async () => {
    const h = harness();
    expect(await h.icons.load(URL, AbortSignal.abort())).toBeUndefined();
    expect(h.lookup).not.toHaveBeenCalled();
  });

  it("caches successes, deduplicates fragment variants, and expires failure entries after one minute", async () => {
    const h = harness();
    const [one, two] = await Promise.all([h.icons.load(URL), h.icons.load(`${URL}#fragment`)]);
    expect(one).toBe(two);
    expect(await h.icons.load(URL)).toBe(one);
    expect(h.request).toHaveBeenCalledTimes(1);
    const failure = harness({ status: 404 });
    await failure.icons.load(URL);
    await failure.icons.load(URL);
    expect(failure.request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_001);
    await failure.icons.load(URL);
    expect(failure.request).toHaveBeenCalledTimes(2);
  });

  it("bounds the cache to 128 entries including failures", async () => {
    const h = harness({ status: 404 });
    for (let index = 0; index < 129; index++) await h.icons.load(`${URL}?${index}`);
    expect(h.request).toHaveBeenCalledTimes(129);
    await h.icons.load(`${URL}?128`);
    expect(h.request).toHaveBeenCalledTimes(129);
    await h.icons.load(`${URL}?0`);
    expect(h.request).toHaveBeenCalledTimes(130);
  });

  it("allows four active jobs and at most fifty queued, all with bounded deadlines", async () => {
    const h = harness({ hang: "headers" });
    const pending = Array.from({ length: 54 }, (_, index) => h.icons.load(`${URL}?${index}`));
    await flush();
    expect(h.request).toHaveBeenCalledTimes(4);
    expect(h.lookup).toHaveBeenCalledTimes(4);
    expect(await h.icons.load(`${URL}?overflow`)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await Promise.all(pending)).toEqual(Array(54).fill(undefined));
    expect(h.request).toHaveBeenCalledTimes(4);
    expect(h.lookup).toHaveBeenCalledTimes(4);
  });

  it("never opens a socket for DNS that resolves after the deadline", async () => {
    const h = harness();
    let resolve: (value: LookupAddress[]) => void = () => {};
    h.lookup.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = h.icons.load(URL);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await pending).toBeUndefined();
    resolve([PUBLIC]);
    await flush();
    expect(h.request).not.toHaveBeenCalled();
  });

  it("checks the absolute deadline even when its timer callback has not run yet", async () => {
    const h = harness();
    let resolve: (value: LookupAddress[]) => void = () => {};
    h.lookup.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    let now = 0;
    const icons = new WebSourceIcons({
      lookup: h.lookup,
      request: h.request,
      decode: h.decode,
      now: () => now,
    });
    const pending = icons.load(URL);
    now = 5_001;
    resolve([PUBLIC]);
    expect(await pending).toBeUndefined();
    expect(h.request).not.toHaveBeenCalled();
  });

  it("releases concurrency after oversized responses so queued work can continue", async () => {
    const h = harness({ chunks: [MAGIC, Buffer.alloc(256 * 1024)] });
    const pending = Array.from({ length: 5 }, (_, index) => h.icons.load(`${URL}?${index}`));
    expect(await Promise.all(pending)).toEqual(Array(5).fill(undefined));
    expect(h.request).toHaveBeenCalledTimes(5);
    expect(h.decode).not.toHaveBeenCalled();
    for (const req of h.requests) expect(req.destroy).toHaveBeenCalled();
  });

  it("bounds decoded output well below the renderer's data-URL limit", async () => {
    const h = harness();
    h.decode.mockResolvedValue(Buffer.concat([MAGIC, Buffer.alloc(16 * 1024)]));
    expect(await h.icons.load(URL)).toBeUndefined();
  });

  it("cancels queued work without consuming a transport slot", async () => {
    const h = harness({ hang: "headers" });
    const pending = Array.from({ length: 4 }, (_, index) => h.icons.load(`${URL}?${index}`));
    const controller = new AbortController();
    const queued = h.icons.load(`${URL}?queued`, controller.signal);
    controller.abort();
    expect(await queued).toBeUndefined();
    await vi.advanceTimersByTimeAsync(5_000);
    await Promise.all(pending);
    expect(h.request).toHaveBeenCalledTimes(4);
  });

  it("starts queued work as active jobs finish", async () => {
    const h = harness();
    const complete: Array<(value: Buffer) => void> = [];
    h.decode.mockImplementation(() => new Promise((resolve) => complete.push(resolve)));
    const pending = Array.from({ length: 5 }, (_, index) => h.icons.load(`${URL}?${index}`));
    await flush();
    expect(complete).toHaveLength(4);
    complete[0](png);
    await flush();
    expect(h.request).toHaveBeenCalledTimes(5);
    expect(complete).toHaveLength(5);
    for (const resolve of complete) resolve(png);
    expect((await Promise.all(pending)).every(Boolean)).toBe(true);
  });
});
