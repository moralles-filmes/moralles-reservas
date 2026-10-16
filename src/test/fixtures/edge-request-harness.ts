/**
 * Test-only execution of complete, trusted repository Edge modules. This VM is
 * deterministic isolation, NOT a sandbox for untrusted code. Compilation here
 * proves neither Deno compatibility nor SQL/JWT authority nor line coverage.
 */
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, Script } from "node:vm";
import { webcrypto } from "node:crypto";
import ts from "typescript";

const SOURCE_ROOT = realpathSync(fileURLToPath(new URL("../../../supabase/functions/", import.meta.url)));
const REMOTE = {
  serve: "https://deno.land/std@0.168.0/http/server.ts",
  supabase: "https://esm.sh/@supabase/supabase-js@2",
  anthropic: "https://esm.sh/@anthropic-ai/sdk@0.27.3",
} as const;
export type EdgeName = "send-confirmation" | "send-cancellation" | "send-manual-message" | "notify-waitlist-ready" | "process-notification-outbox"
  | "process-reservation-reminders" | "process-satisfaction-surveys"
  | "process-waitlist-entered" | "process-waitlist-feedback"
  | "process-voucher-triggers" | "webhook-whatsapp"
  | "send-scheduled-whatsapp" | "send-whatsapp" | "process-whatsapp-automations" | "resend-notification" | "manage-whatsapp-templates";
const ENDPOINTS: readonly EdgeName[] = ["send-confirmation", "send-cancellation", "send-manual-message", "notify-waitlist-ready", "process-notification-outbox",
  "process-reservation-reminders", "process-satisfaction-surveys", "process-waitlist-entered",
  "process-waitlist-feedback", "process-voucher-triggers", "webhook-whatsapp",
  "send-scheduled-whatsapp", "send-whatsapp", "process-whatsapp-automations", "resend-notification", "manage-whatsapp-templates"];
type Handler = (request: Request) => Response | Promise<Response>;
type Transport = { from?: EdgeName; method: string; url: string; respond: (request: Request) => Response | Promise<Response> };
export interface EdgeRequestHarnessOptions {
  /** Explicit synthetic values only; never inherits process.env. */
  env: Readonly<Record<string, string>>;
  createClient: (url: string, key: string, options?: unknown) => unknown;
  anthropicConstructor?: (options: unknown) => void;
  anthropicMessagesCreate?: (input: unknown, options?: unknown) => Promise<unknown>;
  transport?: readonly Transport[];
  internalHops?: readonly { from: EdgeName; to: EdgeName }[];
  /** Optional leaf transport fault after the declared real handler has executed. */
  afterInternalResponse?: (from: EdgeName, to: EdgeName, response: Response) => Response | Promise<Response>;
  now?: number;
}

/** Canonical path-segment containment, including symlinks and Windows casing. */
export function resolveEdgeModule(specifier: string, importer?: string): string {
  if (importer && !specifier.startsWith("./") && !specifier.startsWith("../")) {
    throw new Error("Unsupported runtime import (only relative paths or the three fixed remote ports)");
  }
  const candidate = path.resolve(importer ? path.dirname(importer) : SOURCE_ROOT, specifier);
  const check = (target: string) => {
    const relative = path.relative(SOURCE_ROOT, target);
    if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("Edge module escapes canonical source root");
    }
  };
  check(candidate);
  const canonical = realpathSync(candidate);
  check(canonical);
  if (path.extname(canonical) !== ".ts") throw new Error("Edge module must be a TypeScript source file");
  return canonical;
}

/** AST preflight only; it never executes caller-provided source. */
export function validateEdgeSource(source: string, filename = "edge.ts"): void {
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const visit = (node: ts.Node, functionDepth: number) => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      throw new Error("Unsupported dynamic import");
    }
    if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
      throw new Error("Unsupported import.meta");
    }
    if (functionDepth === 0 && (ts.isAwaitExpression(node)
      || (ts.isForOfStatement(node) && node.awaitModifier))) throw new Error("Unsupported top-level await");
    const depth = functionDepth + (ts.isFunctionLike(node) ? 1 : 0);
    ts.forEachChild(node, (child) => visit(child, depth));
  };
  visit(ast, 0);
}

export function createEdgeRequestHarness(options: EdgeRequestHarnessOptions) {
  const env = Object.freeze({ ...options.env });
  const routes = [...(options.transport ?? [])];
  const hops = [...(options.internalHops ?? [])];
  const unexpected: string[] = [];
  const envNames = new Set<string>();
  const manifest = new Set<string>();
  const logs: string[] = [];
  const internalRequests: { from: EdgeName; to: EdgeName; request: Request }[] = [];
  const endpoints = new Map<EdgeName, { handler: Handler; modules: Map<string, { exports: unknown }> }>();
  const timers = new Map<number, { at: number; callback: () => void }>();
  const backgrounds: { settled: Promise<void>; pending: boolean; error?: unknown }[] = [];
  const pendingAbort = new Set<() => void>();
  let now = options.now ?? Date.UTC(2026, 9, 4, 12);
  let timerId = 0;
  let disposed = false;
  const live = () => { if (disposed) throw new Error("Edge harness disposed"); };
  const deny = (kind: string): never => {
    unexpected.push(kind);
    throw new Error(`Unexpected fixture I/O: ${kind}`);
  };
  const redact = (value: unknown) => {
    let line = String(value);
    for (const value of Object.values(env)) if (value) line = line.split(value).join("[synthetic env]");
    return line.replace(/https?:\/\/[^\s"']+/g, "[url]");
  };
  // Preserve Date(), explicit undefined and all constructor overloads; only
  // the implicit current time is controlled by this fixture.
  const ClockDate = new Proxy(Date, {
    construct: (target, args, newTarget) => Reflect.construct(target, args.length ? args : [now], newTarget),
    apply: () => new Date(now).toString(),
    get: (target, key, receiver) => key === "now" ? () => now : Reflect.get(target, key, receiver),
  });
  function captureBackground(promise: Promise<unknown>) {
    live();
    const record: { settled: Promise<void>; pending: boolean; error?: unknown } = { settled: Promise.resolve(), pending: true };
    // Register rejection handling immediately, even when drain happens later.
    record.settled = Promise.resolve(promise).then(() => { record.pending = false; }, (error) => { record.pending = false; record.error = error; });
    backgrounds.push(record);
  }
  function withAbort(request: Request, work: () => Promise<Response>): Promise<Response> {
    return new Promise((resolve, reject) => {
      let finished = false;
      const cleanup = () => { request.signal.removeEventListener("abort", abort); pendingAbort.delete(abort); };
      const finish = (action: () => void) => { if (!finished) { finished = true; cleanup(); action(); } };
      const abort = () => finish(() => reject(new DOMException("Fixture transport aborted", "AbortError")));
      pendingAbort.add(abort);
      request.signal.addEventListener("abort", abort, { once: true });
      if (request.signal.aborted) { abort(); return; }
      Promise.resolve().then(() => {
        if (request.signal.aborted) throw new DOMException("Fixture transport aborted", "AbortError");
        return work();
      }).then((response) => finish(() => resolve(response)),
        (error) => finish(() => reject(error)));
    });
  }
  async function fetchFor(from: EdgeName, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    live();
    const request = new Request(input, init);
    return withAbort(request, async () => {
      const hop = hops.find((hop) => hop.from === from && request.method === "POST"
        && request.url === `${env.SUPABASE_URL}/functions/v1/${hop.to}`);
      if (hop) {
        internalRequests.push({ from, to: hop.to, request: request.clone() });
        const response = await invoke(hop.to, request);
        return options.afterInternalResponse ? options.afterInternalResponse(from, hop.to, response) : response;
      }
      const url = new URL(request.url);
      const internalBase = new URL(`${env.SUPABASE_URL}/functions/v1/`);
      // External scripts cannot impersonate an undeclared internal endpoint,
      // nor accept its wrong method/query/path through a canned good result.
      if (url.origin === internalBase.origin && url.pathname.startsWith(internalBase.pathname)) return deny("internal_hop");
      const route = routes.find((route) => (route.from === undefined || route.from === from) && route.method === request.method && route.url === request.url);
      if (!route) return deny("external_fetch");
      return route.respond(request);
    });
  }
  function load(name: EdgeName): void {
    live();
    if (!ENDPOINTS.includes(name)) throw new Error("Unknown Edge endpoint");
    if (endpoints.has(name)) return;
    let handler: Handler | undefined;
    const register = (callback: Handler) => {
      if (handler || typeof callback !== "function") throw new Error("Expected exactly one serve registration");
      handler = callback;
    };
    const modules = new Map<string, { exports: unknown }>();
    const context = createContext({
      Request, Response, Headers, URL, URLSearchParams, TextEncoder, TextDecoder,
      AbortController, AbortSignal, DOMException, Error, TypeError, RangeError,
      ArrayBuffer, Uint8Array, crypto: webcrypto, Date: ClockDate,
      structuredClone, atob, btoa,
      Deno: Object.freeze({ ...(name === "manage-whatsapp-templates" ? { serve: register } : {}), env: Object.freeze({ get: (key: string) => {
        envNames.add(key); return Object.prototype.hasOwnProperty.call(env, key) ? env[key] : undefined;
      } }) }),
      EdgeRuntime: Object.freeze({ waitUntil: captureBackground }),
      console: Object.freeze(Object.fromEntries(["log", "warn", "error", "info", "debug"].map((level) => [level,
        (...args: unknown[]) => logs.push(args.map(redact).join(" "))]))),
      fetch: (input: RequestInfo | URL, init?: RequestInit) => fetchFor(name, input, init),
      setTimeout: (callback: (...args: unknown[]) => void, delay = 0, ...args: unknown[]) => {
        live(); const id = ++timerId;
        timers.set(id, { at: now + Math.max(0, Number(delay)), callback: () => callback(...args) }); return id;
      },
      clearTimeout: (id: number) => timers.delete(id),
    });
    const remote = (specifier: string): unknown => {
      manifest.add(specifier);
      if (specifier === REMOTE.serve) return { serve: register };
      if (specifier === REMOTE.supabase) return { createClient: options.createClient };
      if (specifier === REMOTE.anthropic) return { __esModule: true, default: class Anthropic {
        constructor(config: unknown) { options.anthropicConstructor?.(config); }
        messages = { create: (input: unknown, requestOptions?: unknown) => options.anthropicMessagesCreate
          ? options.anthropicMessagesCreate(input, requestOptions) : deny("anthropic_messages_create") };
      } };
      return deny("runtime_import");
    };
    const execute = (filename: string): unknown => {
      const cached = modules.get(filename);
      if (cached) return cached.exports;
      const source = readFileSync(filename, "utf8");
      validateEdgeSource(source, filename);
      const compiled = ts.transpileModule(source, { fileName: filename, reportDiagnostics: true,
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
          esModuleInterop: true, sourceMap: true, inlineSources: true } });
      if (compiled.diagnostics?.some((item) => item.category === ts.DiagnosticCategory.Error)) {
        throw new Error(`Edge compilation failed: ${path.relative(SOURCE_ROOT, filename)}`);
      }
      const module = { exports: {} as unknown };
      modules.set(filename, module);
      manifest.add(`${name}:${path.relative(SOURCE_ROOT, filename).split(path.sep).join("/")}`);
      const requireLocal = (specifier: string) => {
        if (Object.values(REMOTE).some((url) => url === specifier)) return remote(specifier);
        if (!specifier.startsWith("./") && !specifier.startsWith("../")) return deny("runtime_import");
        return execute(resolveEdgeModule(specifier, filename));
      };
      const wrapper = new Script(`(function(exports, require, module) {\n${compiled.outputText}\n})`, { filename });
      wrapper.runInContext(context)(module.exports, requireLocal, module);
      return module.exports;
    };
    execute(resolveEdgeModule(`${name}/index.ts`));
    if (!handler) throw new Error("Expected exactly one std serve registration");
    endpoints.set(name, { handler, modules });
  }
  async function invoke(name: EdgeName, request: Request): Promise<Response> {
    load(name);
    const response = await endpoints.get(name)!.handler(request);
    if (!(response instanceof Response)) throw new Error("Edge handler did not return an actual Response");
    return response;
  }
  return {
    load,
    request: invoke,
    // Approved test-only observer control: identical collector to waitUntil.
    // It does not invoke or replace any repository handler decision.
    captureBackground,
    envNames, manifest, logs, internalRequests,
    get pendingBackground() { return backgrounds.filter((record) => record.pending).length; },
    get pendingTimers() { return timers.size; },
    get now() { return now; },
    async advanceTime(milliseconds: number, iterationLimit = 100) {
      live();
      if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new Error("Invalid clock advance");
      const target = now + milliseconds;
      let iterations = 0;
      while (true) {
        const due = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        if (++iterations > iterationLimit) throw new Error("Controlled timer iteration bound exceeded");
        now = due[1].at; timers.delete(due[0]); due[1].callback();
        // Let awaited callbacks schedule their next timer before advancing again.
        for (let i = 0; i < 20; i++) await Promise.resolve();
      }
      now = target;
    },
    async drainBackground(timeoutMs = 1000) {
      live();
      let timeout: ReturnType<typeof setTimeout>;
      const bound = new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Background drain bound exceeded; release I/O barriers or advance timers explicitly")), timeoutMs); });
      try {
        await Promise.race([ (async () => {
          let index = 0;
          while (index < backgrounds.length) {
            const batch = backgrounds.slice(index); index = backgrounds.length;
            await Promise.all(batch.map((record) => record.settled));
            const failed = batch.find((record) => Object.prototype.hasOwnProperty.call(record, "error"));
            if (failed) throw failed.error;
          }
        })(), bound ]);
      } finally { clearTimeout(timeout!); }
    },
    assertNoUnexpectedIo() { if (unexpected.length) throw new Error(`Unexpected fixture I/O recorded: ${unexpected.join(", ")}`); },
    dispose() {
      if (disposed) return;
      disposed = true; timers.clear();
      for (const abort of [...pendingAbort]) abort();
      endpoints.clear();
    },
  };
}
