/**
 * Tests for the DSH 0.2.2-rc.5 migration of `taskcard_delete`'s existence read.
 *
 * Background: `Session#ownEvents()` / `eventAt()` / `snapshotEvents()` are
 * `deprecated` in rc.5 ("Existing logic may remain unmigrated for now, but new
 * calls are prohibited"), and the supported channel is the asynchronous
 * `ctx.sessionQuery`. `lib/index.js` therefore reads `sessionQuery.readSession()`
 * first and falls back to the deprecated `ownEvents()` only when that channel is
 * missing, throws, or busts its 750ms budget.
 *
 * What is faked and what is real:
 * - `ctx` is a hand-written fake (the plugin's own `apply` contract: tools +
 *   sessionProjections + optional reflect + optional logger).
 * - `sessionQuery` is a fake engine: `readSession` answers the exact
 *   `{ session, inheritedEventCount, events }` snapshot the host returns, built
 *   from a real Session's `snapshotEvents()`, so the plugin's own-range cut is
 *   exercised against faithful data.
 * - the `session` is a **real** rc.5 `Session` (detached, via `Session.create`)
 *   whenever the write path runs: `appendPluginRecord` only accepts a genuine
 *   `Session` receiver, so a fake one could not prove `deleted`/`forced`/
 *   `submitted` end-to-end. Where the host package is unavailable the
 *   write-path tests skip; the read-only ones keep running on stub sessions.
 * - the deprecated reader is instrumented, never trusted: tests that assert the
 *   new channel did the work replace `session.ownEvents` with a spy (or with
 *   `undefined` to simulate a host build that dropped it).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { apply } from "../lib/index.js";

/** Host session package, probed exactly like lib/index.js probes it. */
let host = null;
try {
  host = await import("@deepseek-ai/dsh-session");
} catch {
  host = null;
}
/** Real detached Sessions (needed by every path that writes a deletion record). */
const HAS_HOST_SESSION = host !== null
  && typeof host.Session === "function"
  && typeof host.appendPluginRecord === "function";

const NOTIFY_EVENT = "plugin:ui-taskcards/notify";
const DELETE_EVENT = "plugin:ui-taskcards/delete";
const TODO_EVENT = "todo/write";

// --- harness ---------------------------------------------------------------

/**
 * Fake plugin context. `sessionQuery` is reachable either directly on ctx (the
 * non-strict path) or only through `ctx.reflect.get` (the strict-proxy path the
 * plugin actually sees in the host) — tests cover both probe channels.
 */
function makeCtx({ sessionQuery, probe = "reflect", logger = true } = {}) {
  const captured = { tools: [], projections: [], logs: [] };
  const ctx = {
    tools: { register(definition) { captured.tools.push(definition); } },
    sessionProjections: { register(definition) { captured.projections.push(definition); } }
  };
  if (probe === "direct") {
    if (sessionQuery !== undefined) ctx.sessionQuery = sessionQuery;
  } else {
    ctx.reflect = { get: (serviceName) => (serviceName === "sessionQuery" ? sessionQuery ?? null : null) };
  }
  if (logger) {
    ctx.logger = {
      debug: (message) => captured.logs.push(message),
      warning: (message) => captured.logs.push(message)
    };
  }
  apply(ctx);
  return { ctx, captured };
}

/** The registered `taskcard_delete` definition. */
function deleteTool(captured) {
  const tool = captured.tools.find((definition) => definition.name === "taskcard_delete");
  assert.ok(tool, "taskcard_delete registered by apply()");
  return tool;
}

/** Invoke one tool the way the host does: `execute(args, exec)`. */
async function callDelete(captured, session, args) {
  return deleteTool(captured).execute(args, { agent: { session } });
}

/** Real detached Session seeded with plugin records (the host's own write path). */
function realSession(id) {
  assert.ok(HAS_HOST_SESSION, "host @deepseek-ai/dsh-session available");
  return host.Session.create(id);
}

/** Append one plugin record to a real Session. */
function seedNotice(session, noticeData) {
  host.appendPluginRecord(session, NOTIFY_EVENT, noticeData);
}

/** A fake `sessionQuery` engine shaped like the host's `SessionQueryEngine`. */
function makeQuery(handler) {
  const calls = { readSession: [], inspectSession: [] };
  const engine = {
    calls,
    readSession(sessionId) {
      calls.readSession.push(sessionId);
      return handler(sessionId);
    },
    inspectSession(sessionId, read) {
      calls.inspectSession.push(sessionId);
      return Promise.resolve(read(null));
    }
  };
  return engine;
}

/** The exact snapshot the host's `readSession` answers for a real Session. */
function snapshotOf(session) {
  return {
    session: structuredClone(session.header),
    inheritedEventCount: session.inheritedEventCount,
    events: session.snapshotEvents().map((event) => structuredClone(event))
  };
}

/** Wrap a real `ownEvents` in a call counter (the deprecated fallback's evidence). */
function spyOwnEvents(session) {
  const calls = { count: 0 };
  const real = session.ownEvents.bind(session);
  Object.defineProperty(session, "ownEvents", {
    configurable: true,
    value: () => {
      calls.count += 1;
      return real();
    }
  });
  return calls;
}

/** A stub session: exactly the surface the plugin reads, no host Session. */
function stubSession(id, events) {
  return {
    header: { id, delegationDepth: 0 },
    ownEvents: () => events
  };
}

const notice = (id) => ({
  id,
  target: "target-session",
  content: "部署 v1",
  createdAt: "2026-11-20T00:00:00.000Z"
});
const noticeEvent = (id, seq) => ({ type: NOTIFY_EVENT, seq, data: notice(id) });
const deleteEvent = (id, seq) => ({ type: DELETE_EVENT, seq, data: { kind: "id", id } });

// --- (a) async session-query channel first ---------------------------------

test("a1: sessionQuery 可用时走新通道：readSession 被调用、ownEvents 未被调用，status=deleted", async (t) => {
  if (!HAS_HOST_SESSION) return t.skip("host @deepseek-ai/dsh-session unavailable");
  const session = realSession("session-a1");
  const cardId = "8f3bf8a1-1111-4aaa-8bbb-0123456789ab";
  seedNotice(session, notice(cardId));
  // The deprecated reader must not be reached on the happy path: replace it with
  // a tripwire that fails the test if the plugin still calls it.
  let ownEventsCalls = 0;
  Object.defineProperty(session, "ownEvents", {
    configurable: true,
    value: () => {
      ownEventsCalls += 1;
      throw new Error("deprecated ownEvents() must not be called when sessionQuery answers");
    }
  });
  const query = makeQuery(async () => snapshotOf(session));
  const { captured } = makeCtx({ sessionQuery: query });

  const result = await callDelete(captured, session, { id: cardId });

  assert.deepEqual(query.calls.readSession, ["session-a1"], "async channel addressed the calling session");
  assert.equal(query.calls.inspectSession.length, 0, "inspectSession is not the migration path");
  assert.equal(ownEventsCalls, 0, "deprecated ownEvents() never called");
  assert.equal(result.status, "deleted");
  assert.equal(result.ok, true);
  assert.equal(result.kind, "id");
  // The record really landed in the log, with the complete id.
  const written = session.snapshotEvents().filter((event) => event.type === DELETE_EVENT);
  assert.equal(written.length, 1);
  assert.deepEqual(written[0].data, { kind: "id", id: cardId });
  // The full-log read is the part that scales with history, so it is timed.
  assert.ok(
    captured.logs.some((line) => /sessionQuery\.readSession session-a1: 1 own \/ 1 total events in \d+ms/.test(line)),
    "read cost recorded: " + JSON.stringify(captured.logs)
  );
});

test("a2: 新通道也负责 id 前缀补全（写入完整 id），且 sessionQuery 可从 ctx 直读", async (t) => {
  if (!HAS_HOST_SESSION) return t.skip("host @deepseek-ai/dsh-session unavailable");
  const session = realSession("session-a2");
  const fullId = "8f3bf8a1-2222-4aaa-8bbb-0123456789ab";
  seedNotice(session, notice(fullId));
  const query = makeQuery(async () => snapshotOf(session));
  // probe: "direct" exercises ctx.sessionQuery (the non-reflect branch).
  const { captured } = makeCtx({ sessionQuery: query, probe: "direct" });

  const result = await callDelete(captured, session, { id: "8f3bf8a1" });

  assert.deepEqual(query.calls.readSession, ["session-a2"]);
  assert.equal(result.status, "deleted");
  assert.equal(result.id, fullId, "prefix completed to the full card id before the verdict");
  const written = session.snapshotEvents().filter((event) => event.type === DELETE_EVENT);
  assert.deepEqual(written[0].data, { kind: "id", id: fullId });
});

test("a3: 新通道下 already_deleted / not_found 的判定不变", async (t) => {
  if (!HAS_HOST_SESSION) return t.skip("host @deepseek-ai/dsh-session unavailable");
  const session = realSession("session-a3");
  const cardId = "8f3bf8a1-3333-4aaa-8bbb-0123456789ab";
  seedNotice(session, notice(cardId));
  const query = makeQuery(async () => snapshotOf(session));
  const { captured } = makeCtx({ sessionQuery: query });

  const first = await callDelete(captured, session, { id: cardId });
  assert.equal(first.status, "deleted");
  const second = await callDelete(captured, session, { id: cardId });
  assert.equal(second.status, "already_deleted", "replay is a no-op");
  const missing = await callDelete(captured, session, { id: "ffffffff-0000-4000-8000-000000000000" });
  assert.equal(missing.status, "not_found");
  assert.equal(missing.ok, false);
  assert.equal(query.calls.readSession.length, 3, "every call took the async channel");
});

// --- (b) sessionQuery throws -> deprecated fallback ------------------------

test("b1: sessionQuery 抛错 → 回退 ownEvents，status=deleted（仍写入正确记录）", async (t) => {
  if (!HAS_HOST_SESSION) return t.skip("host @deepseek-ai/dsh-session unavailable");
  const session = realSession("session-b1");
  const cardId = "8f3bf8a1-4444-4aaa-8bbb-0123456789ab";
  seedNotice(session, notice(cardId));
  const ownEvents = spyOwnEvents(session);
  const query = makeQuery(async () => { throw new Error("E_SESSION_NOT_FOUND simulated"); });
  const { captured } = makeCtx({ sessionQuery: query });

  const result = await callDelete(captured, session, { id: cardId });

  assert.deepEqual(query.calls.readSession, ["session-b1"], "async channel was attempted");
  assert.equal(ownEvents.count, 1, "deprecated fallback read the log exactly once");
  assert.equal(result.status, "deleted");
  const written = session.snapshotEvents().filter((event) => event.type === DELETE_EVENT);
  assert.equal(written.length, 1);
  assert.ok(
    captured.logs.some((line) => line.includes("sessionQuery unavailable for session-b1")),
    "degradation is recorded: " + JSON.stringify(captured.logs)
  );
});

test("b2: 回退路径下 already_deleted（真实 Session：先 notify 再 delete）", async (t) => {
  if (!HAS_HOST_SESSION) return t.skip("host @deepseek-ai/dsh-session unavailable");
  const session = realSession("session-b2");
  const cardId = "8f3bf8a1-5555-4aaa-8bbb-0123456789ab";
  seedNotice(session, notice(cardId));
  host.appendPluginRecord(session, DELETE_EVENT, { kind: "id", id: cardId });
  const ownEvents = spyOwnEvents(session);
  const query = makeQuery(async () => { throw new Error("boom"); });
  const { captured } = makeCtx({ sessionQuery: query });

  const result = await callDelete(captured, session, { id: cardId });

  assert.equal(ownEvents.count, 1, "fallback read happened");
  assert.equal(result.status, "already_deleted");
  assert.equal(result.ok, true);
});

test("b3: 回退路径下 not_found / already_deleted 不变，content 地址照常归一化", async () => {
  // Stub session: both outcomes are write-free, so no host Session is needed.
  const legacyDelete = { type: DELETE_EVENT, data: { kind: "content", sessionId: "session-b3", content: "deploy mirror" } };
  const todo = { type: TODO_EVENT, data: { todos: [{ content: "Deploy: Mirror", status: "pending" }] } };
  const session = stubSession("session-b3", [todo, legacyDelete]);
  const query = makeQuery(async () => { throw new Error("down"); });
  const { captured } = makeCtx({ sessionQuery: query });

  // Announcement (todo) is older than the deletion record -> already deleted,
  // despite the case/punctuation difference (normText folding).
  const already = await callDelete(captured, session, { content: "deploy mirror" });
  assert.equal(already.status, "already_deleted");
  assert.equal(already.ok, true);

  const absent = await callDelete(captured, session, { content: "完全不存在" });
  assert.equal(absent.status, "not_found");
  assert.equal(absent.ok, false);
  assert.equal(query.calls.readSession.length, 2, "both calls attempted the async channel first");
});

// --- (c) neither channel answers -> never throws ---------------------------

test("c1: 两通道都不可用 → status=submitted（未知），不抛；force 也无法把未知变成 forced", async (t) => {
  if (!HAS_HOST_SESSION) return t.skip("host @deepseek-ai/dsh-session unavailable");
  const session = realSession("session-c1");
  const cardId = "8f3bf8a1-6666-4aaa-8bbb-0123456789ab";
  seedNotice(session, notice(cardId));
  // Simulate the note's endgame: a host build that dropped the deprecated reader.
  Object.defineProperty(session, "ownEvents", { configurable: true, value: undefined });
  const query = makeQuery(async () => { throw new Error("no persistence"); });
  const { captured } = makeCtx({ sessionQuery: query });

  const result = await callDelete(captured, session, { id: cardId });
  assert.equal(result.status, "submitted", "unknown existence keeps the documented pre-0.4 outcome");
  assert.equal(result.ok, true);
  // The blind write still landed: submitted means "written, existence unknown".
  assert.equal(session.snapshotEvents().filter((event) => event.type === DELETE_EVENT).length, 1);

  const forced = await callDelete(captured, session, { id: "ffffffff-0000-4000-8000-000000000000", force: true });
  assert.equal(forced.status, "submitted", "force cannot upgrade an unknown log to forced");
});

test("c2: sessionQuery 完全缺失（没有 reflect、也没有 sessionQuery）→ 回退 ownEvents，不抛", async (t) => {
  if (!HAS_HOST_SESSION) return t.skip("host @deepseek-ai/dsh-session unavailable");
  const session = realSession("session-c2");
  seedNotice(session, notice("8f3bf8a1-7777-4aaa-8bbb-0123456789ab"));
  const registered = [];
  const ctx = {
    tools: { register(definition) { registered.push(definition); } },
    sessionProjections: { register() {} }
  };
  apply(ctx);
  const tool = registered.find((definition) => definition.name === "taskcard_delete");
  const result = await tool.execute({ id: "8f3bf8a1" }, { agent: { session } });
  assert.equal(result.status, "deleted", "the fallback still completes ids and finds the card");
  assert.equal(result.id, "8f3bf8a1-7777-4aaa-8bbb-0123456789ab");
});

test("c3: sessionQuery 形状不对（readSession 非函数 / 返回非快照）→ 回退 ownEvents，不抛", async (t) => {
  if (!HAS_HOST_SESSION) return t.skip("host @deepseek-ai/dsh-session unavailable");
  // One fresh session per shape: each call writes a record, so a shared session
  // would answer already_deleted from the second iteration on.
  const shapes = [
    { label: "readSession 非函数", sessionQuery: { readSession: "nope" } },
    { label: "readSession 返回 null", sessionQuery: makeQuery(async () => null) },
    { label: "快照缺 events", sessionQuery: makeQuery(async () => ({ session: { id: "session-c3" } })) },
    { label: "events 非数组", sessionQuery: makeQuery(async () => ({ events: "not-an-array", inheritedEventCount: 0 })) },
    { label: "readSession 返回数字", sessionQuery: makeQuery(async () => 42) }
  ];
  let index = 0;
  for (const shape of shapes) {
    index += 1;
    const cardId = "8f3bf8a1-8888-4aaa-8bbb-012345678" + String(index).padStart(3, "0");
    const session = realSession("session-c3-" + index);
    seedNotice(session, notice(cardId));
    const { captured } = makeCtx({ sessionQuery: shape.sessionQuery });
    const result = await callDelete(captured, session, { id: cardId });
    assert.equal(result.status, "deleted", shape.label + " degrades to the fallback");
    assert.equal(result.id, cardId, shape.label + ": still the addressed card");
  }
});

test("c4: 可读但本会话为空区间 → not_found（force=true → forced），不是 submitted", async (t) => {
  if (!HAS_HOST_SESSION) return t.skip("host @deepseek-ai/dsh-session unavailable");
  const session = realSession("session-c4");
  const query = makeQuery(async () => snapshotOf(session));
  const { captured } = makeCtx({ sessionQuery: query });

  const missing = await callDelete(captured, session, { id: "deadbeef-0000-4000-8000-000000000001" });
  assert.equal(missing.status, "not_found", "a readable empty own log proves absence");
  assert.equal(missing.ok, false);

  const forced = await callDelete(captured, session, { id: "deadbeef-0000-4000-8000-000000000002", force: true });
  assert.equal(forced.status, "forced", "force writes despite absence");
  assert.equal(forced.ok, true);
});

// --- (d) fork safety ------------------------------------------------------

/** Real seeded fork: parent's own events become the child's inherited prefix. */
function realFork(childId, parent) {
  return host.Session.create(
    childId,
    parent.ownEvents(),
    { ...parent.header, id: childId, isSeeded: true, parentSession: parent.header.id },
    parent.seq
  );
}

test("d1: fork 安全（新通道）：继承前缀里的卡片不算本会话 announce → not_found", async (t) => {
  if (!HAS_HOST_SESSION) return t.skip("host @deepseek-ai/dsh-session unavailable");
  const parent = realSession("session-parent-1");
  const inheritedId = "8f3bf8a1-9999-4aaa-8bbb-0123456789ab";
  seedNotice(parent, notice(inheritedId));
  const fork = realFork("session-fork-1", parent);
  assert.equal(fork.inheritedEventCount, 1, "fork really carries an inherited prefix");

  // The async channel answers the complete raw log (inherited prefix included),
  // exactly like the host: the plugin must cut it at inheritedEventCount.
  const query = makeQuery(async () => snapshotOf(fork));
  const { captured } = makeCtx({ sessionQuery: query });

  const result = await callDelete(captured, fork, { id: inheritedId });
  assert.equal(result.status, "not_found", "an inherited card is not this session's announcement");
  assert.equal(result.ok, false);
  assert.equal(query.calls.readSession.length, 1, "the verdict came from the async channel");
});

test("d2: fork 安全（回退路径）：真实 ownEvents 同样不含继承前缀", async (t) => {
  if (!HAS_HOST_SESSION) return t.skip("host @deepseek-ai/dsh-session unavailable");
  const parent = realSession("session-parent-2");
  const inheritedId = "8f3bf8a1-aaaa-4aaa-8bbb-0123456789ab";
  seedNotice(parent, notice(inheritedId));
  const fork = realFork("session-fork-2", parent);
  const ownEvents = spyOwnEvents(fork);
  const { captured } = makeCtx({ sessionQuery: makeQuery(async () => { throw new Error("down"); }) });

  const result = await callDelete(captured, fork, { id: inheritedId });
  assert.equal(ownEvents.count, 1, "deprecated fallback used");
  assert.equal(result.status, "not_found", "fork-safety holds on the fallback path too");
});

test("d3: fork 安全：本会话自己 announce 的卡片仍可删除 → deleted", async (t) => {
  if (!HAS_HOST_SESSION) return t.skip("host @deepseek-ai/dsh-session unavailable");
  const parent = realSession("session-parent-3");
  seedNotice(parent, notice("8f3bf8a1-bbbb-4aaa-8bbb-0123456789ab"));
  const fork = realFork("session-fork-3", parent);
  const ownId = "8f3bf8a1-cccc-4aaa-8bbb-0123456789ab";
  seedNotice(fork, notice(ownId));
  const query = makeQuery(async () => snapshotOf(fork));
  const { captured } = makeCtx({ sessionQuery: query });

  const result = await callDelete(captured, fork, { id: ownId });
  assert.equal(result.status, "deleted", "own announcements stay visible after the inherited cut");
  assert.equal(query.calls.readSession.length, 1);
});

test("d4: fork 安全（桩）：inheritedEventCount 之内的通知不参与判定", async () => {
  // Same rule, fake session: the complete log carries one inherited notice.
  const inheritedId = "8f3bf8a1-eeee-4aaa-8bbb-0123456789ab";
  const all = [noticeEvent(inheritedId, 0)];
  const session = {
    header: { id: "session-d4", delegationDepth: 0 },
    inheritedEventCount: 1,
    ownEvents: () => []
  };
  const query = makeQuery(async () => ({
    session: { id: "session-d4" },
    inheritedEventCount: 1,
    events: all
  }));
  const { captured } = makeCtx({ sessionQuery: query });

  const missing = await callDelete(captured, session, { id: inheritedId });
  assert.equal(missing.status, "not_found");
  assert.equal(missing.ok, false);
});

// --- budget (750ms) -------------------------------------------------------

test("e1: sessionQuery 挂住不返回 → 750ms 预算内回退 ownEvents，不抛", async (t) => {
  if (!HAS_HOST_SESSION) return t.skip("host @deepseek-ai/dsh-session unavailable");
  const cardId = "8f3bf8a1-dddd-4aaa-8bbb-0123456789ab";
  const session = realSession("session-e1");
  seedNotice(session, notice(cardId));
  const query = makeQuery(() => new Promise(() => {})); // never settles
  const { captured } = makeCtx({ sessionQuery: query });

  const startedAt = Date.now();
  const result = await callDelete(captured, session, { id: cardId });
  const elapsed = Date.now() - startedAt;

  assert.equal(result.status, "deleted", "fallback answered after the budget expired");
  assert.equal(query.calls.readSession.length, 1);
  // The budget is short on purpose (a full-log read on a ~17k-event session must
  // not delay the instant ownEvents() fallback): ~750ms, with slack for a
  // loaded runner, and far below the old 3s ceiling.
  assert.ok(elapsed >= 700, "waited for the 750ms budget, got " + elapsed + "ms");
  assert.ok(elapsed < 2000, "did not hang past the budget, got " + elapsed + "ms");
});

// --- zero behavior change outside the read --------------------------------

test("f1: 注册面与 notify 行为不变（2 工具 + 1 投影；notify 照常写记录）", async (t) => {
  if (!HAS_HOST_SESSION) return t.skip("host @deepseek-ai/dsh-session unavailable");
  const session = realSession("session-f1");
  const { captured } = makeCtx({ sessionQuery: makeQuery(async () => snapshotOf(session)) });

  assert.deepEqual(captured.tools.map((tool) => tool.name), ["taskcard_notify", "taskcard_delete"]);
  assert.equal(captured.projections.length, 1);
  assert.equal(captured.projections[0].key, "taskcards");
  assert.deepEqual(deleteTool(captured).parameters.properties.id, { type: "string" }, "工具 schema 未变");

  const notify = captured.tools.find((tool) => tool.name === "taskcard_notify");
  const created = await notify.execute({ target: "some-session", content: "部署 v1" }, { agent: { session } });
  assert.equal(created.ok, true);
  assert.equal(typeof created.id, "string");
  const notices = session.snapshotEvents().filter((event) => event.type === NOTIFY_EVENT);
  assert.equal(notices.length, 1, "notify still writes exactly one record");
});
