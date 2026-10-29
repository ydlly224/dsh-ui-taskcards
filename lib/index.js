/**
 * dsh-ui-taskcards — host half.
 *
 * Registers the capabilities the browser half (`./client.js`) consumes:
 *
 * 1. the agent tool `taskcard_notify` — the agent creates one 【待办任务】 card
 *    and presets the session that receives the task when the user presses
 *    「执行」 in the panel;
 * 2. the agent tool `taskcard_delete` — the agent asks the panel to remove a
 *    card again, addressed either by card id (cards this tool created, keyed
 *    `notify:<id>`) or by `(sessionId, content)` (titles captured from a
 *    session's todo list);
 * 3. the session projection `taskcards` — a per-session ring of the freshest
 *    notices plus the freshest deletion requests, read by the panel as
 *    `projectionValues.taskcards`.
 *
 * Both tools are main-agent only (`assertMainAgent`), and `delegationDepth` is
 * the *only* thing that decides: a session with `delegationDepth === 0` (or a
 * header that omits the field, which means top level) may call them, a session
 * with `delegationDepth >= 1` is refused, because the panel is a delivery
 * surface for finished work and a subagent must report its conclusion to the
 * main agent instead of filling the panel itself. A **forked main session**
 * counts as a main agent: a fork keeps `delegationDepth: 0` and merely records
 * its origin in `parentSession`, so `parentSession` says nothing about
 * delegation and must not gate these tools.
 *
 * Shared wire contract (keep in sync with ./client.js):
 *   projection key   "taskcards"
 *   projection state { notices: [], deletions: [] } | null      (stateVersion 2)
 *   rings            notices 20, deletions 50 (freshest kept)
 *   normalization    card titles compare after the client's `normText`
 *                    (case/punctuation/whitespace folded)
 *   session records  "plugin:ui-taskcards/notify", data = one notice
 *                    { id, target, content, createdAt }
 *                    (the pre-0.4 type "taskcards/notify" is still folded)
 *                    "plugin:ui-taskcards/delete", data = exactly one of
 *                    { kind: "id", id } | { kind: "content", sessionId, content }
 *                    (a `kind: "id"` record always carries the *complete* card
 *                    id: a unique prefix the caller passed is completed against
 *                    this session's own notices first — see `resolveDeleteId` —
 *                    because the client matches the literal key `notify:<id>`)
 *                    (only written when the calling session's own log shows the
 *                    card announced after its last deletion, or the caller passes
 *                    force; see `STATUS` — cards themselves live in the browser's
 *                    localStorage, which the host cannot query)
 *   tools            taskcard_notify({ target, content }) -> { ok, id, target }
 *                    taskcard_delete({ id } | { content }, force?)
 *                      -> { ok, kind, id? | content?, status }
 *                      status   deleted | already_deleted | forced |
 *                               not_found | submitted
 *
 * No npm *dependencies* on purpose: this plugin ships without `node_modules`, so
 * every schema below is a plain JSON-schema object and the projection
 * registry's schema slots — which are only ever used through `.parse` — get a
 * pass-through stand-in instead of a schemastery/zod schema. The single import,
 * the host's `appendPluginRecord`, is a guarded, optional peer (see below).
 */

/** Cordis plugin name. */
export const name = "ui-taskcards";

/** Required host services: tool registration and the session projection registry. */
export const inject = ["tools", "sessionProjections"];

/**
 * Stand-in for the projection registry's `stateSchema`/`viewSchema` slots.
 * `@deepseek-ai/dsh-session-projection` only calls `.parse(value)` on them (fold,
 * snapshot read, change feed), so identity is exactly the behavior a plain-JSON
 * state needs — and it keeps the host half dependency-free.
 */
const passthrough = { parse: (value) => value };

/** Projection key the client reads from `projectionValues.taskcards`. */
const PROJECTION_KEY = "taskcards";
/**
 * Session event carrying one whole notice (the log's whole-value event rule).
 *
 * Written as a *plugin record*: an event committed through
 * `appendPluginRecord()`, which stamps `ignorable: true` on the envelope and
 * names the type under this package's own `plugin:` namespace. A bare
 * `session.append("taskcards/notify", ...)` produced a type outside the
 * harness's `KNOWN_SESSION_EVENT_TYPES` with no ignorable marker, so the
 * persistence read path rejected every session log that used this tool after a
 * host restart ("contains event type ... unknown ... not marked ignorable").
 */
const NOTICE_EVENT = "plugin:ui-taskcards/notify";
/** Pre-0.4 event type: history written by older builds must keep folding. */
const LEGACY_EVENT = "taskcards/notify";
/** Every event type that folds into one notice. */
const NOTICE_EVENTS = new Set([NOTICE_EVENT, LEGACY_EVENT]);
/** Ring size: the panel only needs the freshest cards. */
const MAX_NOTICES = 20;
/**
 * Session event carrying one deletion request for a card this plugin created.
 *
 * A plugin record like {@link NOTICE_EVENT}, so it commits through the same
 * guarded path with the same failure policy. `data` carries exactly one of two
 * addresses:
 *
 *   { kind: "id", id }                        -> drop diffKey `notify:<id>`
 *   { kind: "content", sessionId, content }    -> drop diffKey
 *                                                `<sessionId>:<normText(content)>`
 *
 * The client applies each entry to both the live and the archived list and
 * dedupes by entry fingerprint, so replaying a log never removes a card twice.
 */
const DELETE_EVENT = "plugin:ui-taskcards/delete";
/** Ring size for deletion requests: enough history for a panel that missed a fold. */
const MAX_DELETIONS = 50;
/**
 * Session event carrying a whole todo list (`{ todos: TodoItem[] }`).
 *
 * It is the only *existence* evidence the host has for the `content` address of
 * {@link DELETE_EVENT}: a card captured from this session's todo list was
 * necessarily announced by one of these snapshots, so a title that never appears
 * in any of them never became a card here.
 */
const TODO_EVENT = "todo/write";

/**
 * Outcome statuses of `taskcard_delete`.
 *
 * The cards live in the browser's localStorage, so the host cannot query them.
 * It *can* read the calling session's own event log ({@link inspectCardHistory}),
 * which is enough to tell "this session announced such a card" from "this
 * session has already deleted it" — and therefore to refuse a deletion that
 * cannot hit anything instead of silently reporting success.
 */
const STATUS = Object.freeze({
  /** The newest announcement of the card is newer than any deletion, so this call wrote it. */
  DELETED: "deleted",
  /**
   * A deletion record is newer than the newest announcement: nothing was written,
   * so replayed calls are harmless.
   */
  ALREADY_DELETED: "already_deleted",
  /** The log shows no such card but the caller passed `force`: the record was written anyway. */
  FORCED: "forced",
  /** The log shows no such card and `force` was absent: nothing was written. */
  NOT_FOUND: "not_found",
  /** The log could not be read, so existence is unknown: the record was written (pre-0.4 behavior). */
  SUBMITTED: "submitted"
});

/**
 * Host commit path for plugin records, resolved once at load.
 *
 * `@deepseek-ai/dsh-session` is a host peer rather than a dependency (the plugin
 * ships without `node_modules`), so the import is guarded: a host that cannot
 * resolve it leaves this `null` and `taskcard_notify` reports the missing
 * capability instead of writing an unreadable session log. From this plugin's
 * directory the specifier resolves through the harness install to the very
 * module instance the host itself loaded — `appendPluginRecord` reaches a
 * private method of the `Session` class, so a second copy of the package would
 * not accept the live session objects.
 */
let appendPluginRecord = null;
try {
  ({ appendPluginRecord } = await import("@deepseek-ai/dsh-session"));
  if (typeof appendPluginRecord !== "function") appendPluginRecord = null;
} catch {
  appendPluginRecord = null;
}

/** UUID v4 with a crypto.randomUUID fallback for older Node runtimes. */
function newId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = Math.floor(Math.random() * 16);
    const v = ch === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Normalize a card title exactly the way the browser half does (`normText` in
 * ./client.js): lower-case, every run of whitespace *or* Unicode punctuation
 * collapsed to one space, both ends trimmed.
 *
 * Both halves must apply the *same* rule, because they decide about the same
 * card: the client keys a captured todo card by
 * `<sessionId>:<normText(content)>` and compares an incoming deletion record with
 * that very key. A stricter host rule would answer `not_found` for a card the
 * client would happily remove ("Deploy X" vs "deploy x", "部署：镜像" vs
 * "部署 镜像"), which is exactly the false negative this helper exists to remove;
 * a looser rule would write records that match nothing while reporting
 * `deleted`.
 *
 * `\p{P}` is a Unicode property escape, so the `u` flag is mandatory — without it
 * the pattern is a syntax error on older Node and a different (ASCII-only) class
 * elsewhere. The host tests pin the agreement with ./client.js.
 *
 * @param value - anything; `null`/`undefined` normalize to the empty string.
 * @returns the normalized text.
 */
function normText(value) {
  return String(value == null ? "" : value)
    .toLowerCase()
    .replace(/[\s\p{P}]+/gu, " ")
    .trim();
}

/** Model-facing argument schema for `taskcard_notify`. */
const parameters = {
  type: "object",
  additionalProperties: false,
  properties: {
    target: { type: "string" },
    content: { type: "string" }
  },
  required: ["target", "content"]
};

/** Canonical tool result schema. */
const resultSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { type: "boolean" },
    id: { type: "string" },
    target: { type: "string" }
  },
  required: ["ok", "id", "target"]
};

/**
 * Model-facing argument schema for `taskcard_delete`.
 *
 * Neither address is `required`: the contract is "exactly one of them", which
 * plain JSON Schema cannot state without `oneOf`, so `readDeleteArguments`
 * enforces the exclusivity and the non-emptiness at call time. `force` is the
 * escape hatch for a `not_found` verdict the caller knows to be wrong (the card
 * came from another session, or from a build whose history predates this log).
 */
const deleteParameters = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string" },
    content: { type: "string" },
    force: { type: "boolean" }
  }
};

/**
 * Canonical result schema for `taskcard_delete`.
 *
 * `status` is required and mirrors {@link STATUS}: it says whether a deletion
 * record was written and, when it was not, why — `ok` alone cannot express
 * "handled, but there was nothing to delete".
 */
const deleteResultSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { type: "boolean" },
    kind: { type: "string" },
    id: { type: "string" },
    content: { type: "string" },
    status: { type: "string", enum: Object.values(STATUS) }
  },
  required: ["ok", "kind", "status"]
};

/**
 * Validate the model-supplied arguments. A raw `tools.register()` definition
 * does not get the implicit parameter validation `defineTool` installs, so the
 * tool enforces its own declared schema here. Whitespace-padded values are
 * trimmed: `target` is matched against session titles/id prefixes and `content`
 * becomes the card title, so surrounding whitespace only breaks matching.
 *
 * @param args - parsed call arguments, however malformed.
 * @returns the normalized `{ target, content }`.
 * @throws when either field is missing or not a non-empty string.
 */
function readArguments(args) {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("taskcard_notify expects an object argument { target, content }");
  }
  const target = typeof args.target === "string" ? args.target.trim().slice(0, 200) : "";
  const content = typeof args.content === "string" ? args.content.trim().slice(0, 4000) : "";
  if (!target) {
    throw new Error("taskcard_notify.target must be a non-empty string: the target session title or a session-id prefix");
  }
  if (!content) {
    throw new Error("taskcard_notify.content must be a non-empty string: the task the card dispatches");
  }
  return { target, content };
}

/**
 * Length ceilings for the two deletion addresses. They bound the committed
 * record, and they *reject* rather than truncate: the client matches an address
 * against a card key, so a silently shortened value would match nothing while
 * the tool still reported success. 4000 is the cap the notice path already
 * applies to card titles; ids are generated, so 200 is generous.
 */
const MAX_DELETE_ID = 200;
const MAX_DELETE_CONTENT = 4000;

/**
 * Validate the model-supplied `taskcard_delete` arguments: exactly one non-empty
 * address, with both fields trimmed first (the panel compares normalized text,
 * so surrounding whitespace only breaks matching).
 *
 * @param args - parsed call arguments, however malformed.
 * @returns `{ kind: "id", id, force }` or `{ kind: "content", content, force }`.
 * @throws when neither address or both addresses are supplied, one is too long,
 *   or the content address normalizes to the empty string — such a title could
 *   never match a card, so the call is refused instead of answered `not_found`.
 */
function readDeleteArguments(args) {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("taskcard_delete 需要对象参数：{ id } 或 { content }（二选一）");
  }
  const id = typeof args.id === "string" ? args.id.trim() : "";
  const content = typeof args.content === "string" ? args.content.trim() : "";
  if (id && content) {
    throw new Error(
      "taskcard_delete 只能二选一：请只传 id（按卡片 id 删除）或 content（按卡片标题内容删除），不要同时传两者"
    );
  }
  if (!id && !content) {
    throw new Error(
      "taskcard_delete 需要恰好一个非空参数：id（非空字符串，卡片 id）或 content（非空字符串，卡片标题内容）；两者都为空时无法确定删除目标"
    );
  }
  if (id.length > MAX_DELETE_ID) {
    throw new Error(`taskcard_delete.id 过长（${id.length} > ${MAX_DELETE_ID}）：id 是 taskcard_notify 返回的卡片 id，请直接使用该返回值`);
  }
  if (content.length > MAX_DELETE_CONTENT) {
    throw new Error(`taskcard_delete.content 过长（${content.length} > ${MAX_DELETE_CONTENT}），无法作为卡片标题精确匹配；请在【待办任务】面板手动删除这张卡片`);
  }
  // A punctuation-only title survives the `trim()` above but normalizes to the
  // empty string. The client keys a captured todo card by
  // `<sessionId>:<normText(content)>` and ignores a deletion entry whose
  // normalized text is empty, while this host would answer `not_found`/`forced`
  // — two halves disagreeing about whether anything was deleted. Refusing here,
  // before the existence decision and before any record is written, keeps the
  // one outcome the caller can act on: nothing was (or can be) deleted, so pass
  // a real title or the card id. Pure whitespace never reaches this check: the
  // non-empty test above already refuses it, with the same effect (throw, no
  // record, no status).
  if (content && normText(content) === "") {
    throw new Error(
      "taskcard_delete content 归一化后为空（纯空白/标点），无法定位待办卡片；请改用 id 模式或提供可识别的标题内容"
    );
  }
  // Only a literal `true` forces: `force` bypasses the not_found guard, so a
  // sloppy truthy value ("true", 1) must not be able to disable that check.
  const force = args.force === true;
  return id ? { kind: "id", id, force } : { kind: "content", content, force };
}

/**
 * Read the calling session's own events, or `null` when that is impossible.
 *
 * `ownEvents()` is the fork-safe read — it starts after the fork-inherited
 * prefix, so a session that merely inherited an ancestor's cards must not treat
 * them as its own. Every unreadable case (the accessor missing on a stub
 * session, a throw from a host build that dropped the deprecated method, a
 * non-array result) answers `null` = "unknown", never "empty": an empty log
 * would turn every deletion into `not_found` and make the tool useless.
 *
 * @param session - the session that owns the tool call.
 * @returns the own-event array, or `null` when existence cannot be judged.
 */
function readOwnEventLog(session) {
  try {
    if (session === null || typeof session !== "object") return null;
    const read = session.ownEvents;
    if (typeof read !== "function") return null;
    const events = read.call(session);
    return Array.isArray(events) ? events : null;
  } catch {
    return null;
  }
}

/**
 * Shortest id fragment that may be completed as a prefix (see
 * {@link resolveDeleteId}).
 *
 * A shorter fragment is never used as a prefix — it still addresses a card when
 * it is *exactly* a known id. Four hexadecimal characters already cover a
 * 1-in-65 536 slice of a uuid, so a shorter one would turn a typo into a
 * confident hit on the wrong card, and a deletion record is not recoverable.
 */
const MIN_ID_PREFIX = 4;

/**
 * Complete a card id the caller supplied as a unique prefix.
 *
 * The panel keys every card this plugin created by `notify:<full id>` (see
 * ./client.js), so a deletion record carrying a *truncated* id matches nothing:
 * the card stays in the panel while the tool answers `deleted`. Agents routinely
 * pass the first eight characters of the uuid, which is exactly that failure, so
 * the id address is completed against this session's own log **before** any
 * verdict — every later comparison (`latestCreate`, `latestDelete`,
 * `planDeletion`) and the committed record then speak about the same complete id.
 *
 * Rules, in order:
 *
 * 1. An unreadable log completes nothing and returns the fragment unchanged: there
 *    is no evidence to complete it with, so the call keeps the pre-0.4
 *    `submitted` path, which writes whatever the caller passed.
 * 2. A fragment that *is* a known id is used verbatim (the exact-match rule; ids
 *    are hexadecimal and compared byte-exactly, so no case folding here).
 * 3. A fragment shorter than {@link MIN_ID_PREFIX} stops here for the same
 *    verbatim use — see that constant.
 * 4. Otherwise every id this session's log knows is a candidate when it starts
 *    with the fragment. A candidate that merely *abbreviates* another candidate is
 *    not a rival card but the same one, and is folded away: the pre-fix build
 *    wrote the truncated id into its deletion records, and counting such a record
 *    as a second candidate would resurrect the very ambiguity — announced as
 *    `8f3bf8a1-…`, once "deleted" as `8f3bf8a1` — that this function exists to
 *    repair. Exactly one candidate → that complete id; two or more → throw, because
 *    deleting an arbitrary one of them is worse than asking for more characters;
 *    none → the fragment is returned unchanged, so the verdict stays `not_found`
 *    (or `forced`) and a forced record keeps the caller's id verbatim, which is
 *    the "the caller said so explicitly" semantics `force` is for.
 *
 * Candidates come from the notice events *and* from the ids existing deletion
 * records carry: the second source lets a fragment address an id this session
 * already recorded (typically a `forced` deletion of a card created elsewhere),
 * which otherwise only ever answered `not_found`.
 *
 * @param session - the session that owns the tool call.
 * @param id - the trimmed, non-empty id address the caller passed.
 * @returns the complete id to use from here on, or `id` itself when nothing
 *   matched it (the caller's own value is then authoritative).
 * @throws when the fragment matches more than one card id.
 */
function resolveDeleteId(session, id) {
  const events = readOwnEventLog(session);
  if (events === null) return id;
  /** Ids announced by a notice ({@link NOTICE_EVENT} / {@link LEGACY_EVENT}). */
  const noticed = [];
  /** Ids a deletion record already carries ({@link DELETE_EVENT}, `kind: "id"`). */
  const recorded = [];
  for (const event of events) {
    if (event === null || typeof event !== "object") continue;
    const data = event.data;
    if (data === null || typeof data !== "object") continue;
    if (NOTICE_EVENTS.has(event.type)) {
      if (typeof data.id === "string" && data.id !== "") noticed.push(data.id);
      continue;
    }
    if (event.type === DELETE_EVENT && data.kind === "id" && typeof data.id === "string" && data.id !== "") {
      recorded.push(data.id);
    }
  }
  if (noticed.includes(id)) return id;
  if (id.length < MIN_ID_PREFIX) return id;
  const matching = [...new Set([...noticed, ...recorded])].filter((known) => known.startsWith(id));
  const candidates = matching.filter((candidate) => !matching.some(
    (other) => other !== candidate && other.startsWith(candidate)
  ));
  if (candidates.length === 0) return id;
  if (candidates.length === 1) return candidates[0];
  const shown = candidates.slice(0, 3).map((candidate) => `「${candidate}」`).join("、");
  throw new Error(
    `taskcard_delete.id 前缀「${id}」不唯一：本会话日志中有 ${candidates.length} 张卡片以它开头` +
    `（前 ${Math.min(3, candidates.length)} 个：${shown}${candidates.length > 3 ? " 等" : ""}）；` +
    "请传入更长的 id 前缀，或直接使用 taskcard_notify 返回的完整 id"
  );
}

/**
 * Look the addressed card up in the calling session's own event log, as a pair
 * of sequence numbers rather than two booleans.
 *
 * `latestCreate` is the seq of the newest event that *announced* the addressed
 * card and `latestDelete` the seq of the newest record that *deleted* it; `-1`
 * stands for "this log never did that". The card counts as `deleted` only while
 * the newest deletion is **later** than the newest announcement
 * (`latestDelete > latestCreate`). Comparing sequence numbers on purpose: the
 * older "a deletion record exists" rule could never be escaped, so a card that
 * was deleted and then announced again — a fresh `taskcard_notify` id, or a
 * later `todo/write` snapshot listing the title once more — answered
 * `already_deleted` forever and the rebuilt card could not be removed.
 *
 * Evidence per address:
 * * `kind: "id"` — announcement: a notice ({@link NOTICE_EVENT} or the legacy
 *   {@link LEGACY_EVENT}) carrying this id; deletion: `{ kind: "id", id }`.
 * * `kind: "content"` — announcement: a {@link TODO_EVENT} snapshot listing a
 *   todo whose `content` normalizes to the target; deletion:
 *   `{ kind: "content", sessionId, content }` for *this* session whose content
 *   normalizes to the same text. The session id is part of the address because
 *   the client keys a captured todo card by `<sessionId>:<normText(content)>`,
 *   so the same title in another session is no evidence here.
 *
 * Text is compared with {@link normText} — the client's own rule — in both the
 * existence and the deletion check, so a case/punctuation/whitespace variant of
 * a real title is neither answered `not_found` nor deleted from the wrong card.
 *
 * @param session - the session that owns the tool call.
 * @param address - the validated address (without `force`).
 * @param sessionId - this session's id; only consulted for the content address.
 * @returns `{ known, exists, deleted, latestCreate, latestDelete }`;
 *   `known: false` means the log is unreadable and neither seq was computed.
 */
function inspectCardHistory(session, address, sessionId) {
  const events = readOwnEventLog(session);
  if (events === null) {
    return { known: false, exists: false, deleted: false, latestCreate: -1, latestDelete: -1 };
  }
  const byId = address.kind === "id";
  const target = byId ? address.id : normText(address.content);
  // `seq` is the log's own order. A log whose events carry no numeric seq (a stub
  // session) falls back to array order instead — one scale for the whole scan, so
  // the two seqs stay comparable.
  const sequenced = events.every((event) => event !== null
    && typeof event === "object"
    && Number.isFinite(event.seq));
  let latestCreate = -1;
  let latestDelete = -1;
  events.forEach((event, index) => {
    if (event === null || typeof event !== "object") return;
    const data = event.data;
    if (data === null || typeof data !== "object") return;
    const seq = sequenced ? event.seq : index;
    if (event.type === DELETE_EVENT) {
      if (byId) {
        if (data.kind === "id" && data.id === address.id) latestDelete = Math.max(latestDelete, seq);
      } else if (data.kind === "content" && data.sessionId === sessionId && normText(data.content) === target) {
        latestDelete = Math.max(latestDelete, seq);
      }
      return;
    }
    if (byId) {
      if (NOTICE_EVENTS.has(event.type) && data.id === address.id) latestCreate = Math.max(latestCreate, seq);
      return;
    }
    if (event.type !== TODO_EVENT || !Array.isArray(data.todos)) return;
    for (const todo of data.todos) {
      if (todo === null || typeof todo !== "object" || typeof todo.content !== "string") continue;
      if (normText(todo.content) !== target) continue;
      latestCreate = Math.max(latestCreate, seq);
      return;
    }
  });
  return {
    known: true,
    exists: latestCreate >= 0,
    deleted: latestDelete > latestCreate,
    latestCreate,
    latestDelete
  };
}

/**
 * Turn the log evidence into the call's outcome.
 *
 * Precedence: unreadable → `submitted` (pre-0.4 behavior, the only case that may
 * write blind); a deletion newer than the newest announcement → `already_deleted`
 * (a card is never removed twice, so replaying a call is safe, while a card
 * announced *after* its deletion counts as alive again and is deletable once
 * more); announced → `deleted`; otherwise `force` decides between `forced` and
 * `not_found`.
 *
 * @param history - the evidence from {@link inspectCardHistory}.
 * @param force - whether the caller overrode the not_found guard.
 * @returns `{ status, write }` — `write` says whether to commit a deletion record.
 */
function planDeletion(history, force) {
  if (!history.known) return { status: STATUS.SUBMITTED, write: true };
  if (history.deleted) return { status: STATUS.ALREADY_DELETED, write: false };
  if (history.exists) return { status: STATUS.DELETED, write: true };
  return force ? { status: STATUS.FORCED, write: true } : { status: STATUS.NOT_FOUND, write: false };
}

/**
 * Read this session's id for the content address.
 *
 * Both the existence check and the committed record need it: the client keys a
 * captured todo card by `<sessionId>:<normText(content)>`, so a record without
 * the owning session id could delete another session's identically titled card.
 *
 * @param session - the session that owns the tool call.
 * @returns the non-empty session id.
 * @throws when the session header carries no usable id.
 */
function requireSessionId(session) {
  const sessionId = session?.header?.id;
  if (typeof sessionId !== "string" || sessionId === "") {
    throw new Error(
      "taskcard_delete 无法读取当前会话 id（exec.agent.session.header.id 不可用）；" +
      "按 content 删除需要会话 id 才能定位卡片归属，请改用 id 删除"
    );
  }
  return sessionId;
}

/**
 * Projection fold: keep the last {@link MAX_NOTICES} notices and the last
 * {@link MAX_DELETIONS} deletion requests of this session.
 *
 * State is `{ notices, deletions }` (stateVersion 2). Pre-0.4 state was either
 * `null` or `{ notices }`; both are still accepted and are promoted in place
 * the first time an event folds — the notice half keeps its exact old semantics,
 * so an old log folds to the same `notices` array as before plus an empty
 * `deletions`. Unrelated events return the incoming state reference unchanged,
 * which is what the registry's `Object.is` change detection relies on.
 *
 * @param state - folded state, `null` before the first notice or deletion.
 * @param event - one committed session event.
 * @returns the next state.
 */
function foldState(state, event) {
  if (event === null || typeof event !== "object") return state;
  const isNotice = NOTICE_EVENTS.has(event.type);
  const isDeletion = event.type === DELETE_EVENT;
  if (!isNotice && !isDeletion) return state;
  const data = event.data;
  if (data === null || typeof data !== "object") return state;
  const previous = state !== null && typeof state === "object" ? state : {};
  const notices = Array.isArray(previous.notices) ? previous.notices : [];
  const deletions = Array.isArray(previous.deletions) ? previous.deletions : [];
  if (isNotice) return { notices: [...notices, data].slice(-MAX_NOTICES), deletions };
  return { notices, deletions: [...deletions, data].slice(-MAX_DELETIONS) };
}

/**
 * Commit one plugin record (a notice or a deletion request) on the owning
 * agent's session.
 *
 * There is deliberately no fallback to `session.append()`: an unmarked custom
 * event type poisons the whole session log for the persistence read path, so a
 * missing host capability must fail the tool call instead of writing data that
 * only becomes unreadable after the next restart. Both tools share this path, so
 * a deletion request can never be written where a notice could not.
 *
 * @param session - the live session of the agent that owns the tool call.
 * @param eventType - {@link NOTICE_EVENT} or {@link DELETE_EVENT}.
 * @param data - one whole record, losslessly JSON-serializable.
 * @param toolName - the calling tool, for the failure message.
 * @throws when `@deepseek-ai/dsh-session` did not resolve, or the commit fails.
 */
function appendRecord(session, eventType, data, toolName) {
  if (appendPluginRecord === null) {
    throw new Error(
      `${toolName} 需要 @deepseek-ai/dsh-session 的 appendPluginRecord，当前未能解析该包；` +
      "不会回退到裸 session.append()，因为未标记 ignorable 的自定义事件类型会让宿主重启后整份会话日志读取失败"
    );
  }
  try {
    appendPluginRecord(session, eventType, data);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${toolName} 写入插件记录 "${eventType}" 失败：${reason}；` +
      "若提示 Receiver must be an instance of class Session，说明传入的 session 不是真实 Session，" +
      "或本插件与宿主解析到了不同副本的 @deepseek-ai/dsh-session",
      { cause: error }
    );
  }
}

/**
 * Main-agent guard for both tools: refuses a *delegated* session, allows a main
 * one.
 *
 * The panel is a delivery surface: a subagent reports its conclusion to the main
 * agent, which decides what becomes a card. `delegationDepth` is persisted in
 * the session header and is `>= 1` exactly for a delegated child (a missing
 * field means top level), so it alone catches a delegated call even when the
 * tool filter of the child preset did not.
 *
 * `parentSession` is deliberately **not** consulted. It marks where a session
 * came from, not how deep it sits: a forked main session — `subagent_fork` on a
 * main-control session — keeps `delegationDepth: 0` and still carries the
 * `parentSession` of the session it was forked from. Gating on it therefore
 * refused exactly the forked main-control sessions these tools exist to serve
 * (observed locally: session-4f599cfd… → parentSession=session-24984d9d…,
 * delegationDepth=0; 6 of 1434 session headers are depth 0 with a parent, all
 * `isSeeded: true` forks), while every real subagent has depth >= 1 (993 of
 * 1434 headers, each with a parent). A missing or `null` field counts as 0 (top
 * level, the rule the rest of the host already uses), and no malformed value can
 * widen access: the host only ever writes a non-negative safe integer, and a
 * numeric string such as `"1"` still compares as > 0 and is refused.
 *
 * @param exec - the tool execution context.
 * @param toolName - the calling tool, for the refusal message.
 * @throws when the calling session is a delegated (subagent) session.
 */
function assertMainAgent(exec, toolName) {
  const header = exec !== null && typeof exec === "object" ? exec.agent?.session?.header : undefined;
  const depth = header?.delegationDepth ?? 0;
  if (depth > 0) {
    throw new Error(
      `${toolName} 仅允许主代理会话调用（delegationDepth=0；fork 出来的主会话同样允许）；` +
      "子代理请把结论/任务回报给主代理，由主代理统一建卡/删卡"
    );
  }
}

/** Model-facing description of `taskcard_notify`. */
const TOOL_DESCRIPTION = [
  "在 DSH 右侧边栏的【待办任务】面板创建一张任务卡片，并预设这张卡片的执行会话：",
  "用户在该卡片上点击「执行」时，content 会作为任务内容投递到 target 指定的会话。",
  "target 支持两种写法：目标会话的标题，或目标会话 id 的前缀（足够唯一即可）。",
  "content 是任务内容，同时用作卡片的标题与派发文本；请写清目标、范围与验收标准。",
  "每调用一次创建一张卡片，卡片在面板中标记为来自 agent（source=agent-notify）。",
  "仅主代理会话（delegationDepth=0）可调用：fork 出来的主会话同样允许（fork 只记录 parentSession，delegationDepth 仍为 0），",
  "子代理（delegationDepth>=1）调用会被拒绝，请把结论/任务回报给主代理，由主代理统一建卡。"
].join("");

/** Model-facing description of `taskcard_delete`. */
const DELETE_TOOL_DESCRIPTION = [
  "删除【待办任务】面板里的一张卡片；参数二选一（必须恰好一个）：",
  "id：删除 taskcard_notify 建出的那张卡片（卡片 id 即建卡工具返回的 id；id 支持唯一前缀：",
  "本会话日志里恰好命中一张卡片时自动补全为完整 id，命中多张则报错需写更长的前缀或完整 id）；",
  "content：删除当前会话待办列表里标题与该内容一致的卡片（按会话 + 归一化文本匹配：大小写/标点/空白差异不影响命中）。",
  "调用前会先查本会话的事件日志判断这张卡片是否存在：最近一次建卡/待办记录存在即写入删除记录（status=deleted）；",
  "若最近一条删除记录晚于最近一次建卡/待办记录，则不重复写入（status=already_deleted）；",
  "删掉之后又被重新建出（再次 notify 出该 id，或新的 todo/write 再次列出该标题）的卡片，可以再次删除并写入新的删除记录；",
  "日志里查不到（id 打错、或卡片由别的会话创建）时默认不写入并返回 status=not_found，",
  "确认卡片确实存在可传 force=true 强制提交（status=forced）。",
  "只在需要撤回或纠正上一张卡时使用：卡片不可编辑，撤回后再用 taskcard_notify 重建。",
  "仅主代理会话（delegationDepth=0）可调用：fork 出来的主会话同样允许（fork 只记录 parentSession，delegationDepth 仍为 0），",
  "子代理（delegationDepth>=1）调用会被拒绝，请把删除需求回报给主代理，由主代理统一删卡。"
].join("");

/** One-line subject of a deletion result, for the render sentence. */
function deleteAddressLabel(value) {
  return value.kind === "id"
    ? `待办卡片 ${value.id}`
    : `本会话中标题与「${value.content}」一致的待办卡片`;
}

/**
 * One Chinese sentence describing what the call did, keyed by {@link STATUS}.
 *
 * Every branch names its `status` and says whether a deletion record was written,
 * because the model reads this text back: "already_deleted" and "not_found" are
 * *successful* refusals of a redundant write, and saying so plainly is what stops
 * a retry loop over a card that is gone or was never here.
 *
 * @param value - the tool result.
 * @returns the rendered text.
 */
function deleteRenderText(value) {
  const label = deleteAddressLabel(value);
  switch (value.status) {
    case STATUS.DELETED:
      return `已删除${label}（status=deleted）：本条删除记录晚于该卡片最近一次建卡/待办记录，已写入本会话日志，【待办任务】面板收到后会移除这张卡片（含已归档的同一条）。`;
    case STATUS.ALREADY_DELETED:
      return `未重复写入：${label} 最近一条删除记录晚于最近一次建卡/待办记录（status=already_deleted），本会话日志里已覆盖这张卡片，面板状态保持不变；若该卡片之后又被重新建出，再次删除即可写入新的删除记录。`;
    case STATUS.FORCED:
      return `已按 force 强制写入删除记录（status=forced）：本会话日志里查不到${label}，面板收到该记录后会尝试移除匹配卡片，无匹配则无变化。`;
    case STATUS.NOT_FOUND:
      return `未写入删除记录：本会话日志里不存在${label}（status=not_found），可能是 id 写错或该卡片由其他会话创建；确认它确实存在时可传 force=true 强制提交。`;
    case STATUS.SUBMITTED:
      return `已写入删除记录但无法确认是否存在（status=submitted）：当前会话的事件日志不可读，存在性无从判定，已按旧行为提交，由面板决定是否命中${label}。`;
    default:
      return `已提交删除请求（status=${String(value.status)}）：${label}。`;
  }
}

/**
 * Register the projection and the tools on the host plugin context.
 *
 * @param ctx - Cordis plugin context carrying `tools` and `sessionProjections`.
 */
export function apply(ctx) {
  ctx.sessionProjections.register({
    key: PROJECTION_KEY,
    stateSchema: passthrough,
    init: () => null,
    apply: foldState,
    wire: {
      viewSchema: passthrough,
      view: (state) => state
    },
    // 2: `state` gained `deletions`, so a cached v1 state must be refolded.
    stateVersion: 2
  });

  ctx.tools.register({
    name: "taskcard_notify",
    description: TOOL_DESCRIPTION,
    parameters,
    output: {
      schema: resultSchema,
      render: (_args, value) => [{
        type: "text",
        text: `已创建待办卡片 ${value.id} → 目标会话「${value.target}」；用户在【待办任务】面板点击「执行」即投递任务内容。`
      }]
    },
    async execute(args, exec) {
      assertMainAgent(exec, "taskcard_notify");
      if (!exec.agent) throw new Error("taskcard_notify requires an owning agent session");
      const { target, content } = readArguments(args);
      const id = newId();
      appendRecord(
        exec.agent.session,
        NOTICE_EVENT,
        { id, target, content, createdAt: new Date().toISOString() },
        "taskcard_notify"
      );
      return { ok: true, id, target };
    }
  });

  ctx.tools.register({
    name: "taskcard_delete",
    description: DELETE_TOOL_DESCRIPTION,
    parameters: deleteParameters,
    output: {
      schema: deleteResultSchema,
      render: (_args, value) => [{
        type: "text",
        text: deleteRenderText(value)
      }]
    },
    async execute(args, exec) {
      assertMainAgent(exec, "taskcard_delete");
      if (!exec.agent) throw new Error("taskcard_delete requires an owning agent session");
      const session = exec.agent.session;
      const { force, ...parsed } = readDeleteArguments(args);
      // Complete a truncated id *before* the verdict: the panel matches a card by
      // its full id (`notify:<id>`), so a record written from a prefix removes
      // nothing while the tool would still answer `deleted`. A fragment that
      // matches no card id stays verbatim, so the not_found/forced pair keeps
      // describing exactly what the caller asked for.
      const address = parsed.kind === "id"
        ? { ...parsed, id: resolveDeleteId(session, parsed.id) }
        : parsed;
      // Resolve the session id first for the content address: it is required for
      // the committed record (the client keys a captured todo card by
      // `<sessionId>:<normText(content)>`) *and* for the existence check, so a
      // header without an id must fail here rather than fall through as "unknown".
      const sessionId = address.kind === "content" ? requireSessionId(session) : undefined;
      const plan = planDeletion(inspectCardHistory(session, address, sessionId), force);
      if (plan.write) {
        appendRecord(
          session,
          DELETE_EVENT,
          address.kind === "id"
            ? { kind: "id", id: address.id }
            : { kind: "content", sessionId, content: address.content },
          "taskcard_delete"
        );
      }
      const fields = address.kind === "id"
        ? { kind: "id", id: address.id }
        : { kind: "content", content: address.content };
      return { ok: plan.status !== STATUS.NOT_FOUND, ...fields, status: plan.status };
    }
  });
}
