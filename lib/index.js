/**
 * dsh-ui-taskcards — host half.
 *
 * Registers the two capabilities the browser half (`./client.js`) consumes:
 *
 * 1. the agent tool `taskcard_notify` — the agent creates one 【待办任务】 card
 *    and presets the session that receives the task when the user presses
 *    「执行」 in the panel;
 * 2. the session projection `taskcards` — a per-session ring of the freshest
 *    notices, read by the panel as `projectionValues.taskcards`.
 *
 * Shared wire contract (keep in sync with ./client.js):
 *   projection key   "taskcards"
 *   projection state { notices: [{ id, target, content, createdAt }] } | null
 *   session record   "plugin:ui-taskcards/notify", data = one notice
 *                    (the pre-0.4 type "taskcards/notify" is still folded)
 *   tool             taskcard_notify({ target, content }) -> { ok, id, target }
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
 * Projection fold: keep the last {@link MAX_NOTICES} notices of this session.
 * Unrelated events return the incoming state reference unchanged, which is what
 * the registry's `Object.is` change detection relies on.
 *
 * @param state - folded state, `null` before the first notice.
 * @param event - one committed session event.
 * @returns the next state.
 */
function foldNotice(state, event) {
  if (event === null || typeof event !== "object") return state;
  if (!NOTICE_EVENTS.has(event.type)) return state;
  const data = event.data;
  if (data === null || typeof data !== "object") return state;
  const previous = state !== null && typeof state === "object" && Array.isArray(state.notices) ? state.notices : [];
  return { notices: [...previous, data].slice(-MAX_NOTICES) };
}

/**
 * Commit one notice as a plugin record on the owning agent's session.
 *
 * There is deliberately no fallback to `session.append()`: an unmarked custom
 * event type poisons the whole session log for the persistence read path, so a
 * missing host capability must fail the tool call instead of writing data that
 * only becomes unreadable after the next restart.
 *
 * @param session - the live session of the agent that owns the tool call.
 * @param data - one whole notice, losslessly JSON-serializable.
 * @throws when `@deepseek-ai/dsh-session` did not resolve, or the commit fails.
 */
function appendNotice(session, data) {
  if (appendPluginRecord === null) {
    throw new Error(
      "taskcard_notify 需要 @deepseek-ai/dsh-session 的 appendPluginRecord，当前未能解析该包；" +
      "不会回退到裸 session.append()，因为未标记 ignorable 的自定义事件类型会让宿主重启后整份会话日志读取失败"
    );
  }
  try {
    appendPluginRecord(session, NOTICE_EVENT, data);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `taskcard_notify 写入插件记录 "${NOTICE_EVENT}" 失败：${reason}；` +
      "若提示 Receiver must be an instance of class Session，说明传入的 session 不是真实 Session，" +
      "或本插件与宿主解析到了不同副本的 @deepseek-ai/dsh-session",
      { cause: error }
    );
  }
}

/** Model-facing description of `taskcard_notify`. */
const TOOL_DESCRIPTION = [
  "在 DSH 右侧边栏的【待办任务】面板创建一张任务卡片，并预设这张卡片的执行会话：",
  "用户在该卡片上点击「执行」时，content 会作为任务内容投递到 target 指定的会话。",
  "target 支持两种写法：目标会话的标题，或目标会话 id 的前缀（足够唯一即可）。",
  "content 是任务内容，同时用作卡片的标题与派发文本；请写清目标、范围与验收标准。",
  "每调用一次创建一张卡片，卡片在面板中标记为来自 agent（source=agent-notify）。"
].join("");

/**
 * Register the projection and the tool on the host plugin context.
 *
 * @param ctx - Cordis plugin context carrying `tools` and `sessionProjections`.
 */
export function apply(ctx) {
  ctx.sessionProjections.register({
    key: PROJECTION_KEY,
    stateSchema: passthrough,
    init: () => null,
    apply: foldNotice,
    wire: {
      viewSchema: passthrough,
      view: (state) => state
    },
    stateVersion: 1
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
      if (!exec.agent) throw new Error("taskcard_notify requires an owning agent session");
      const { target, content } = readArguments(args);
      const id = newId();
      appendNotice(exec.agent.session, {
        id,
        target,
        content,
        createdAt: new Date().toISOString()
      });
      return { ok: true, id, target };
    }
  });
}
