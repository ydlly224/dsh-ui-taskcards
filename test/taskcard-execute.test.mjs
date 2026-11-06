/**
 * Tests for the v0.7.0 host HTTP execute API (POST /api/collab/taskcard-execute).
 *
 * Zero dependencies: node:test + node:assert/strict only. The fake ctx mirrors
 * the exact surfaces lib/index.js touches — tools.register,
 * sessionProjections.register, ctx.inject(["connection"], cb) and (optionally)
 * ctx.reflect.get for service probing. Every test calls apply() on a fresh
 * fake context, and each registration creates its own rate/idempotency state,
 * so no test can leak quota or cached responses into another.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { apply, inject, name } from "../lib/index.js";

const EXECUTE_PATH = "/api/collab/taskcard-execute";

/** Build a fake host plugin context plus everything apply registered on it. */
function makeCtx({ services = {}, withInject = true, withReflect = true } = {}) {
  const captured = {
    tools: [],
    projections: [],
    webServer: [],
    routes: [],
    injectedDeps: null
  };
  const connection = {
    fetch: {
      register(route) {
        captured.routes.push(route);
        return () => {}; // disposer — the plugin keeps but never invokes it
      }
    }
  };
  const ctx = {
    tools: { register(definition) { captured.tools.push(definition); } },
    sessionProjections: { register(definition) { captured.projections.push(definition); } },
    webServer: { register(definition) { captured.webServer.push(definition); } }
  };
  if (withInject) {
    ctx.inject = (deps, callback) => {
      captured.injectedDeps = deps;
      callback({ connection });
    };
  }
  if (withReflect) {
    ctx.reflect = { get: (serviceName) => services[serviceName] ?? null };
  }
  return { ctx, captured, connection };
}

/**
 * A real global Request, so request.json() rejects on malformed JSON exactly
 * like the host's buffered body does.
 */
function makeRequest(payload, { raw } = {}) {
  const text = raw !== undefined ? raw : JSON.stringify(payload);
  return new Request("http://127.0.0.1:3080" + EXECUTE_PATH, { method: "POST", body: text });
}

/** Fake sessionController recording every prompt/create call. */
function makeSessionController({ prompt, create } = {}) {
  const calls = { prompt: [], create: [] };
  return {
    calls,
    prompt: prompt ?? (async (request, signal) => {
      calls.prompt.push({ request, signal });
      return { accepted: true };
    }),
    create: create ?? (async (request) => {
      calls.create.push(request);
      return { sessionId: "session-new-" + (calls.create.length) };
    })
  };
}

/** POST once against the route captured from the latest apply(). */
async function post(captured, payload, options) {
  const route = captured.routes.at(-1);
  assert.ok(route, "execute route registered");
  const response = await route.fetch(makeRequest(payload, options));
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* body stays null for non-JSON */ }
  return { response, text, body };
}

const happyServices = () => ({ sessionController: makeSessionController() });

// --- 1. route registration -------------------------------------------------

test("apply 注册 execute 路由：path/methods/requestBody/fetch 正确，inject 依赖为 ['connection']", () => {
  const { ctx, captured } = makeCtx({ services: { sessionController: makeSessionController() } });
  apply(ctx);
  assert.equal(captured.routes.length, 1, "exactly one connection route");
  const route = captured.routes[0];
  assert.equal(route.path, EXECUTE_PATH);
  assert.deepEqual(route.methods, ["POST"]);
  assert.equal(route.requestBody, "buffered");
  assert.equal(typeof route.fetch, "function");
  assert.deepEqual(captured.injectedDeps, ["connection"]);
});

test("不注册 webServer 路由（API 面唯一，只走 connection.fetch.register）", () => {
  const { ctx, captured } = makeCtx({ services: { sessionController: makeSessionController() } });
  apply(ctx);
  assert.equal(captured.webServer.length, 0);
  assert.equal(captured.routes.length, 1);
});

test("connection 不可用时静默降级：无路由、不抛、工具/投影照常注册", () => {
  const { ctx, captured } = makeCtx({ withInject: false, withReflect: false });
  assert.doesNotThrow(() => apply(ctx));
  assert.equal(captured.routes.length, 0);
  assert.equal(captured.tools.length, 2);
  assert.equal(captured.projections.length, 1);
});

// --- 2. content validation --------------------------------------------------

test("content 非字符串（数字）→ 400 content-invalid，不触达 prompt", async () => {
  const sc = makeSessionController();
  const { ctx, captured } = makeCtx({ services: { sessionController: sc } });
  apply(ctx);
  const { response, body } = await post(captured, { content: 42, sessionId: "s1" });
  assert.equal(response.status, 400);
  assert.deepEqual(body, { ok: false, reason: "content-invalid" });
  assert.equal(sc.calls.prompt.length, 0);
});

test("content 空字符串 → 400 content-invalid", async () => {
  const { ctx, captured } = makeCtx({ services: { sessionController: makeSessionController() } });
  apply(ctx);
  const { response, body } = await post(captured, { content: "", sessionId: "s1" });
  assert.equal(response.status, 400);
  assert.equal(body.reason, "content-invalid");
});

test("content 纯空白 → 400 content-invalid", async () => {
  const { ctx, captured } = makeCtx({ services: { sessionController: makeSessionController() } });
  apply(ctx);
  const { response, body } = await post(captured, { content: "   \n\t ", sessionId: "s1" });
  assert.equal(response.status, 400);
  assert.equal(body.reason, "content-invalid");
});

test("content 20001 字 → 400 content-invalid；20000 字 → 200 且按原文投递", async () => {
  const sc = makeSessionController();
  const { ctx, captured } = makeCtx({ services: { sessionController: sc } });
  apply(ctx);
  const over = await post(captured, { content: "x".repeat(20001), sessionId: "s1" });
  assert.equal(over.response.status, 400);
  assert.equal(over.body.reason, "content-invalid");

  const exact = "y".repeat(20000);
  const ok = await post(captured, { content: exact, sessionId: "s1" });
  assert.equal(ok.response.status, 200);
  assert.equal(ok.body.ok, true);
  assert.equal(sc.calls.prompt.length, 1);
  assert.equal(sc.calls.prompt[0].request.content[0].text, exact);
});

// --- 3. target resolution ---------------------------------------------------

test("sessionId 与 workspaceId 都缺 → 400 target-unresolved，不触达 prompt", async () => {
  const sc = makeSessionController();
  const { ctx, captured } = makeCtx({ services: { sessionController: sc } });
  apply(ctx);
  const { response, body } = await post(captured, { content: "hi" });
  assert.equal(response.status, 400);
  assert.equal(body.reason, "target-unresolved");
  assert.equal(sc.calls.prompt.length, 0);
  assert.equal(sc.calls.create.length, 0);
});

test("sessionId 不存在（prompt 抛 session/not-found）→ 404 session-not-found", async () => {
  const sc = makeSessionController({
    prompt: async () => {
      const error = new Error("no such session");
      error.code = "session/not-found";
      throw error;
    }
  });
  const { ctx, captured } = makeCtx({ services: { sessionController: sc } });
  apply(ctx);
  const { response, body } = await post(captured, { content: "task", sessionId: "session-gone" });
  assert.equal(response.status, 404);
  assert.equal(body.reason, "session-not-found");
});

test("workspaceId 不在注册表（registry.list 无该 id）→ 404 workspace-not-found 且不 create", async () => {
  const sc = makeSessionController();
  const registry = { list: async () => [{ id: "ws-other" }] };
  const { ctx, captured } = makeCtx({
    services: { sessionController: sc, workspaceRegistry: registry }
  });
  apply(ctx);
  const { response, body } = await post(captured, { content: "task", workspaceId: "ws-1" });
  assert.equal(response.status, 404);
  assert.equal(body.reason, "workspace-not-found");
  assert.equal(sc.calls.create.length, 0);
});

// --- 4. workspace create path ----------------------------------------------

test("workspaceId 路径全链路：create({workspaceId}) 一次 → 新 sessionId → prompt 一次 → 200 回显", async () => {
  const sc = makeSessionController({
    create: async (request) => {
      sc.calls.create.push(request);
      return { sessionId: "session-fresh-1" };
    }
  });
  const registry = { list: async () => [{ id: "ws-1" }, { id: "ws-2" }] };
  const { ctx, captured } = makeCtx({
    services: { sessionController: sc, workspaceRegistry: registry }
  });
  apply(ctx);
  const { response, body } = await post(captured, { content: "任务", workspaceId: "ws-1" });
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.sessionId, "session-fresh-1");
  assert.equal(body.workspaceId, "ws-1");
  assert.deepEqual(sc.calls.create, [{ workspaceId: "ws-1" }]);
  assert.equal(sc.calls.prompt.length, 1);
  assert.equal(sc.calls.prompt[0].request.sessionId, "session-fresh-1");
  assert.equal(sc.calls.prompt[0].request.mode, "queue");
  assert.deepEqual(sc.calls.prompt[0].request.content, [{ type: "text", text: "任务" }]);
  assert.ok(sc.calls.prompt[0].signal instanceof AbortSignal, "prompt 第二参是 AbortSignal");
});

test("create 抛 workspace/not-found → 404；create 其它错误 → 502 create-failed 且不泄露 message", async () => {
  const notFound = makeSessionController({
    create: async () => {
      const error = new Error("ws missing");
      error.code = "workspace/not-found";
      throw error;
    }
  });
  const firstCtx = makeCtx({ services: { sessionController: notFound } });
  apply(firstCtx.ctx);
  const first = await post(firstCtx.captured, { content: "t", workspaceId: "ws-x" });
  assert.equal(first.response.status, 404);
  assert.equal(first.body.reason, "workspace-not-found");

  const boom = makeSessionController({
    create: async () => { throw new Error("secret-create-internals"); }
  });
  const second = makeCtx({ services: { sessionController: boom } });
  apply(second.ctx);
  const res = await post(second.captured, { content: "t", workspaceId: "ws-x" });
  assert.equal(res.response.status, 502);
  assert.equal(res.body.reason, "create-failed");
  assert.ok(!res.text.includes("secret-create-internals"), "不回显内部错误信息");
});

// --- 5. idempotency ---------------------------------------------------------

test("幂等：同 requestId 两次 → prompt 只调 1 次，两次都 200 且 body 相同", async () => {
  const sc = makeSessionController();
  const { ctx, captured } = makeCtx({ services: { sessionController: sc } });
  apply(ctx);
  const first = await post(captured, { content: "任务A", sessionId: "s1", requestId: "rid-1" });
  const second = await post(captured, { content: "任务A", sessionId: "s1", requestId: "rid-1" });
  assert.equal(first.response.status, 200);
  assert.equal(second.response.status, 200);
  assert.deepEqual(second.body, first.body);
  assert.equal(second.body.requestId, "rid-1");
  assert.equal(sc.calls.prompt.length, 1, "重复 requestId 不重复投递");
  assert.equal(sc.calls.prompt[0].request.requestId, "rid-1", "requestId 透传给 prompt");
});

test("不同 requestId → 各自投递（prompt 2 次）", async () => {
  const sc = makeSessionController();
  const { ctx, captured } = makeCtx({ services: { sessionController: sc } });
  apply(ctx);
  await post(captured, { content: "a", sessionId: "s1", requestId: "rid-a" });
  await post(captured, { content: "b", sessionId: "s1", requestId: "rid-b" });
  assert.equal(sc.calls.prompt.length, 2);
});

test("requestId 缺省 → 响应携带宿主生成的 requestId（UUID 形态）", async () => {
  const { ctx, captured } = makeCtx({ services: happyServices() });
  apply(ctx);
  const { response, body } = await post(captured, { content: "a", sessionId: "s1" });
  assert.equal(response.status, 200);
  assert.equal(typeof body.requestId, "string");
  assert.match(body.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

// --- 6. rate limiting -------------------------------------------------------

test("限流：31 次不同 requestId → 前 30 次 200，第 31 次 429 rate-limited", async () => {
  const sc = makeSessionController();
  const { ctx, captured } = makeCtx({ services: { sessionController: sc } });
  apply(ctx);
  for (let i = 1; i <= 30; i += 1) {
    const { response } = await post(captured, { content: "c" + i, sessionId: "s1", requestId: "r" + i });
    assert.equal(response.status, 200, "第 " + i + " 次应成功");
  }
  const over = await post(captured, { content: "c31", sessionId: "s1", requestId: "r31" });
  assert.equal(over.response.status, 429);
  assert.equal(over.body.reason, "rate-limited");
  assert.equal(sc.calls.prompt.length, 30, "429 的请求不触达 prompt");
});

test("幂等重放不占额度：30 次打满后重放命中缓存返回 200，新 requestId 才 429", async () => {
  const sc = makeSessionController();
  const { ctx, captured } = makeCtx({ services: { sessionController: sc } });
  apply(ctx);
  const first = await post(captured, { content: "c1", sessionId: "s1", requestId: "r1" });
  for (let i = 2; i <= 30; i += 1) {
    await post(captured, { content: "c" + i, sessionId: "s1", requestId: "r" + i });
  }
  const replay = await post(captured, { content: "c1", sessionId: "s1", requestId: "r1" });
  assert.equal(replay.response.status, 200, "缓存命中先于限流");
  assert.deepEqual(replay.body, first.body);
  assert.equal(sc.calls.prompt.length, 30, "重放不触发新的投递");
  const fresh = await post(captured, { content: "cx", sessionId: "s1", requestId: "rx" });
  assert.equal(fresh.response.status, 429);
});

// --- 7. error mapping + no leak ---------------------------------------------

test("prompt 抛普通 Error('secret internals') → 502 dispatch-failed，响应不含 'secret'", async () => {
  const sc = makeSessionController({
    prompt: async () => { throw new Error("secret internals"); }
  });
  const { ctx, captured } = makeCtx({ services: { sessionController: sc } });
  apply(ctx);
  const { response, text, body } = await post(captured, { content: "t", sessionId: "s1" });
  assert.equal(response.status, 502);
  assert.deepEqual(body, { ok: false, reason: "dispatch-failed" });
  assert.ok(!text.includes("secret"), "不泄露内部信息");
});

test("prompt 抛 session/agent-busy → 409 session-busy", async () => {
  const sc = makeSessionController({
    prompt: async () => {
      const error = new Error("busy");
      error.code = "session/agent-busy";
      throw error;
    }
  });
  const { ctx, captured } = makeCtx({ services: { sessionController: sc } });
  apply(ctx);
  const { response, body } = await post(captured, { content: "t", sessionId: "s1" });
  assert.equal(response.status, 409);
  assert.equal(body.reason, "session-busy");
});

test("prompt 抛 session/writer-held → 409 session-busy", async () => {
  const sc = makeSessionController({
    prompt: async () => {
      const error = new Error("held");
      error.code = "session/writer-held";
      throw error;
    }
  });
  const { ctx, captured } = makeCtx({ services: { sessionController: sc } });
  apply(ctx);
  const { response, body } = await post(captured, { content: "t", sessionId: "s1" });
  assert.equal(response.status, 409);
  assert.equal(body.reason, "session-busy");
});

test("prompt 返回 { accepted: false } → 502 dispatch-failed", async () => {
  const sc = makeSessionController({ prompt: async () => ({ accepted: false }) });
  const { ctx, captured } = makeCtx({ services: { sessionController: sc } });
  apply(ctx);
  const { response, body } = await post(captured, { content: "t", sessionId: "s1" });
  assert.equal(response.status, 502);
  assert.equal(body.reason, "dispatch-failed");
});

test("sessionController 服务完全缺失（sessionId 路径）→ 502 dispatch-failed", async () => {
  const { ctx, captured } = makeCtx({ services: {} });
  apply(ctx);
  const { response, body } = await post(captured, { content: "t", sessionId: "s1" });
  assert.equal(response.status, 502);
  assert.equal(body.reason, "dispatch-failed");
});

// --- 8. request-body + field validation --------------------------------------

test("请求体坏 JSON → 400 body-invalid", async () => {
  const { ctx, captured } = makeCtx({ services: happyServices() });
  apply(ctx);
  const { response, body } = await post(captured, null, { raw: "{not json" });
  assert.equal(response.status, 400);
  assert.equal(body.reason, "body-invalid");
});

test("请求体是数组/字符串（非对象）→ 400 body-invalid", async () => {
  const { ctx, captured } = makeCtx({ services: happyServices() });
  apply(ctx);
  const arr = await post(captured, null, { raw: "[1,2]" });
  assert.equal(arr.response.status, 400);
  assert.equal(arr.body.reason, "body-invalid");
  const str = await post(captured, null, { raw: '"a string"' });
  assert.equal(str.response.status, 400);
  assert.equal(str.body.reason, "body-invalid");
});

test("requestId 非法（201 字 / 非字符串）→ 400 request-id-invalid", async () => {
  const { ctx, captured } = makeCtx({ services: happyServices() });
  apply(ctx);
  const long = await post(captured, { content: "t", sessionId: "s1", requestId: "r".repeat(201) });
  assert.equal(long.response.status, 400);
  assert.equal(long.body.reason, "request-id-invalid");
  const nonString = await post(captured, { content: "t", sessionId: "s1", requestId: 42 });
  assert.equal(nonString.response.status, 400);
  assert.equal(nonString.body.reason, "request-id-invalid");
});

test("sessionId/workspaceId 非法（纯空白 / 超 200 字 / 数字）→ 400 target-invalid", async () => {
  const { ctx, captured } = makeCtx({ services: happyServices() });
  apply(ctx);
  const blank = await post(captured, { content: "t", sessionId: "   " });
  assert.equal(blank.response.status, 400);
  assert.equal(blank.body.reason, "target-invalid");
  const tooLong = await post(captured, { content: "t", sessionId: "s".repeat(201) });
  assert.equal(tooLong.response.status, 400);
  assert.equal(tooLong.body.reason, "target-invalid");
  const numeric = await post(captured, { content: "t", workspaceId: 7 });
  assert.equal(numeric.response.status, 400);
  assert.equal(numeric.body.reason, "target-invalid");
});

// --- 9. response shape --------------------------------------------------------

test("响应头：content-type application/json; charset=utf-8，cache-control no-store", async () => {
  const { ctx, captured } = makeCtx({ services: happyServices() });
  apply(ctx);
  const { response } = await post(captured, { content: "t", sessionId: "s1" });
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "no-store");
});

// --- 10. backward compatibility ----------------------------------------------

test("向后兼容：最小 ctx（无 inject/reflect）apply 不抛，工具与投影注册不变，模块 exports 未变", () => {
  const { ctx, captured } = makeCtx({ withInject: false, withReflect: false });
  assert.doesNotThrow(() => apply(ctx));
  assert.deepEqual(captured.tools.map((tool) => tool.name), ["taskcard_notify", "taskcard_delete"]);
  assert.equal(captured.projections[0].key, "taskcards");
  assert.equal(captured.routes.length, 0);
  assert.equal(name, "ui-taskcards");
  assert.deepEqual(inject, ["tools", "sessionProjections"]);
});

test("严格代理 ctx（未声明属性读取抛错）下：注册与投递照常，服务经 reflect.get 探测", async () => {
  const sc = makeSessionController();
  const base = makeCtx({ services: { sessionController: sc } });
  const declared = new Set(["tools", "sessionProjections", "inject", "reflect"]);
  const strictCtx = new Proxy(base.ctx, {
    get(target, property, receiver) {
      if (declared.has(property)) return Reflect.get(target, property, receiver);
      throw new Error("strict proxy: property not injected: " + String(property));
    }
  });
  apply(strictCtx);
  assert.equal(base.captured.routes.length, 1);
  const { response, body } = await post(base.captured, { content: "t", sessionId: "s1" });
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(sc.calls.prompt.length, 1);
});

test("agents.get 探测被调用且抛错不影响投递（prompt 才是权威错误源）", async () => {
  const sc = makeSessionController();
  const probed = [];
  const agents = {
    get(id) {
      probed.push(id);
      throw new Error("agents lookup blew up");
    }
  };
  const { ctx, captured } = makeCtx({
    services: { sessionController: sc, agents }
  });
  apply(ctx);
  const { response } = await post(captured, { content: "t", sessionId: "s1" });
  assert.equal(response.status, 200, "探测失败不拦截投递");
  assert.deepEqual(probed, ["s1"]);
  assert.equal(sc.calls.prompt.length, 1);
});
