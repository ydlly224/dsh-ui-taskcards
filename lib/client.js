window.__ModuleLoader__.load({
	id: "dsh-ui-taskcards",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");
		const { jsx: __jsx, jsxs: __jsxs, Fragment } = require("react/jsx-runtime");
		// createElement-style wrappers: children land in props.
		// (the raw jsx/jsxs 3rd argument is the React KEY, not children)
		const h = (type, props, children) => __jsx(type, children === undefined ? props : Object.assign({}, props, { children }));
		const hs = (type, props, children) => __jsxs(type, children === undefined ? props : Object.assign({}, props, { children }));

		//#region constants
		const { useState, useEffect, useMemo, useRef, useCallback, useSyncExternalStore } = react;

		/** Locale namespace owned by this plugin. */
		const NS = "taskcards";
		/** Services this plugin's apply() touches (uiWorkspace accessed defensively). */
		const inject = ["slots", "locale", "sessions", "uiWorkspace"];

		const STORAGE_KEY = "dsh.taskcards.v1";
		/** Right-sidebar tab type identity (registry id + kind). */
		const TAB_TYPE_ID = "dsh-ui-taskcards";
		const TAB_KIND = "taskcards";
		const CARDS_LIMIT = 500;
		const ARCHIVED_LIMIT = 1000;
		/** Bounded ring of session-notice ids already materialised as cards. Must hold
		 *  comfortably more than CARDS_LIMIT + ARCHIVED_LIMIT of history: a seen-id that
		 *  aged out of this window while the notice stayed in the host projection would
		 *  make the effect rebuild its card every pass (slice -> expire -> rebuild loop). */
		const NOTICE_SEEN_LIMIT = 5000;
		const HISTORY_SHOW = 50;
		const HEARTBEAT_MS = 30_000;
		const HEARTBEAT_BURST = 3;
		const INTERACTION_RECOVERY_MS = 10_000;
		const PROMPT_TIMEOUT_MS = 60_000;
		const FUZZY_THRESHOLD = 0.8;
		/** Per-session todo baselines kept for diffing: every session syncs now, not just the
		 *  main-view one, so the cache must hold more than a handful. */
		const TODOS_CACHE_LIMIT = 64;

		const STATUSES = ["pending", "queued", "running", "done", "failed", "cancelled", "stale"];
		const TERMINAL = new Set(["done", "failed", "cancelled", "stale"]);
		const SOURCES = new Set(["agent-todo", "agent-notify", "composer-pinned", "panel-input", "import"]);
		//#endregion

		//#region utils
		function uuid() {
			try {
				if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
			} catch (_) { /* fall through */ }
			return "tc-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
		}

		function nowIso() {
			return new Date().toISOString();
		}

		function normText(s) {
			return String(s == null ? "" : s).toLowerCase().replace(/[\s\p{P}]+/gu, " ").trim();
		}

		/** Card diffKey -> the deletion fingerprint that addresses it (single source of
		 *  truth, byte-identical to the consumer in the deletion projection effect).
		 *  notify cards ("notify:<id>") map to id fingerprints; captured todo cards
		 *  ("<sessionId>:<norm>") map to content fingerprints. Returns "" for any other
		 *  shape (panel-input cards carry no diffKey). */
		function deletionFingerprintFor(diffKey) {
			if (typeof diffKey !== "string" || !diffKey) return "";
			if (diffKey.startsWith("notify:")) return "id\u001f" + diffKey.slice("notify:".length);
			const sep = diffKey.indexOf(":");
			if (sep > 0 && sep < diffKey.length - 1) {
				return "content\u001f" + diffKey.slice(0, sep) + "\u001f" + diffKey.slice(sep + 1);
			}
			return "";
		}

		function diceSimilar(a, b) {
			const x = normText(a);
			const y = normText(b);
			if (!x && !y) return 1;
			if (!x || !y) return 0;
			if (x === y) return 1;
			if (x.length < 2 || y.length < 2) return x === y ? 1 : 0;
			const grams = new Map();
			for (let i = 0; i < x.length - 1; i++) {
				const g = x.slice(i, i + 2);
				grams.set(g, (grams.get(g) || 0) + 1);
			}
			let hits = 0;
			for (let i = 0; i < y.length - 1; i++) {
				const g = y.slice(i, i + 2);
				const n = grams.get(g) || 0;
				if (n > 0) { grams.set(g, n - 1); hits++; }
			}
			return (2 * hits) / (x.length - 1 + y.length - 1);
		}

		function clamp(v, lo, hi) {
			return Math.min(hi, Math.max(lo, v));
		}

		function asRecord(v) {
			return v != null && typeof v === "object" && !Array.isArray(v) ? v : null;
		}

		function extractWorkspaces(state) {
			const rec = asRecord(state);
			const list = Array.isArray(state) ? state
				: rec != null && Array.isArray(rec.items) ? rec.items
					: rec != null && Array.isArray(rec.workspaces) ? rec.workspaces
						: rec != null && Array.isArray(rec.rows) ? rec.rows : [];
			const out = [];
			for (const row of list) {
				const r = asRecord(row);
				if (r == null || typeof r.workspaceId !== "string") continue;
				out.push({
					workspaceId: r.workspaceId,
					title: typeof r.title === "string" ? r.title : r.workspaceId,
					path: typeof r.path === "string" ? r.path : "",
					sessionIds: Array.isArray(r.sessionIds) ? r.sessionIds.filter((x) => typeof x === "string") : [],
				});
			}
			return out;
		}
		//#endregion

		//#region store
		function coerceCard(raw, i) {
			const r = asRecord(raw);
			if (r == null) return null;
			const title = typeof r.title === "string" ? r.title : "";
			if (!title.trim()) return null;
			const status = STATUSES.includes(r.status) ? r.status : "pending";
			const source = SOURCES.has(r.source) ? r.source : "import";
			const card = {
				id: typeof r.id === "string" && r.id ? r.id : uuid(),
				title,
				prompt: typeof r.prompt === "string" && r.prompt ? r.prompt : title,
				status,
				order: Number.isFinite(r.order) ? r.order : i + 1,
				source,
				inSeqRun: r.inSeqRun === undefined ? true : !!r.inSeqRun,
				immediate: !!r.immediate,
				createdAt: typeof r.createdAt === "string" ? r.createdAt : nowIso(),
				updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : nowIso(),
			};
			if (typeof r.sessionId === "string" && r.sessionId) card.sessionId = r.sessionId;
			if (typeof r.workspaceId === "string" && r.workspaceId) card.workspaceId = r.workspaceId;
			if (typeof r.diffKey === "string" && r.diffKey) card.diffKey = r.diffKey;
			// 建卡来源会话（谁建立的任务卡）：旧卡无此字段时保持缺省，渲染层按来源兜底
			if (typeof r.createdBy === "string" && r.createdBy) card.createdBy = r.createdBy;
			if (r.schedule != null && asRecord(r.schedule) != null && typeof r.schedule.at === "string") {
				card.schedule = { kind: "once", at: r.schedule.at };
			} else if (r.schedule === null) {
				card.schedule = null;
			}
			if (asRecord(r.lastDispatch) != null && typeof r.lastDispatch.requestId === "string") {
				const outcome = r.lastDispatch.outcome === "accepted" || r.lastDispatch.outcome === "error" || r.lastDispatch.outcome === "pending" ? r.lastDispatch.outcome : "pending";
				card.lastDispatch = { requestId: r.lastDispatch.requestId, at: typeof r.lastDispatch.at === "string" ? r.lastDispatch.at : nowIso(), outcome };
			}
			return card;
		}

		function defaultState() {
			return {
				version: 1,
				cards: [],
				archived: [],
				seqMode: false,
				seqIsolatedSessions: false,
				badCards: 0,
				ui: { historyOpen: false, openAfterDispatch: false },
				noticeSeen: [],
				deletionSeen: [],
			};
		}

		function coerceState(raw) {
			const r = asRecord(raw);
			if (r == null) return defaultState();
			const st = defaultState();
			// 顺序执行开关不持久化：每次载入默认关闭，避免上次开启后长期自动派发
			st.seqMode = false;
			st.seqIsolatedSessions = !!r.seqIsolatedSessions;
			st.badCards = Number.isFinite(r.badCards) ? r.badCards : 0;
			// session-notice ids already materialised as cards (bounded; survives reload)
			st.noticeSeen = Array.isArray(r.noticeSeen) ? r.noticeSeen.filter((x) => typeof x === "string").slice(-NOTICE_SEEN_LIMIT) : [];
			// session-deletion entry fingerprints already applied (bounded; survives reload).
			// Pre-0.4 stores have no deletionSeen: an absent value coerces to an empty list.
			st.deletionSeen = Array.isArray(r.deletionSeen) ? r.deletionSeen.filter((x) => typeof x === "string").slice(-50) : [];
			const ui = asRecord(r.ui);
			if (ui != null) {
				st.ui.historyOpen = !!ui.historyOpen;
				st.ui.openAfterDispatch = !!ui.openAfterDispatch;
			}
			const rawCards = Array.isArray(r.cards) ? r.cards : [];
			const rawArchived = Array.isArray(r.archived) ? r.archived : [];
			const good = [];
			let bad = 0;
			rawCards.forEach((c, i) => { const x = coerceCard(c, i); if (x) good.push(x); else bad++; });
			const goodArch = [];
			rawArchived.forEach((c, i) => { const x = coerceCard(c, i); if (x) goodArch.push(x); else bad++; });
			st.cards = good.slice(0, CARDS_LIMIT);
			st.archived = goodArch.slice(-ARCHIVED_LIMIT);
			// Upgrade hardening: every notify card already present (live or archived) proves
			// its notice id was materialised in an older store, even if its noticeSeen entry
			// aged out of the old 50-id window. Fold such ids back in so an upgrade needs no
			// manual DevTools cleanup and the projection effect cannot rebuild old cards.
			// Existing order is preserved; newly discovered ids append in live-then-archived
			// card order. When nothing is missing the array keeps its exact reference.
			{
				const seenSet = new Set(Array.isArray(st.noticeSeen) ? st.noticeSeen : []);
				const merged = Array.isArray(st.noticeSeen) ? st.noticeSeen.slice() : [];
				let added = 0;
				for (const coll of [st.cards, st.archived]) {
					for (const c of coll) {
						const dk = c && c.diffKey;
						if (typeof dk !== "string" || !dk.startsWith("notify:")) continue;
						const id = dk.slice("notify:".length);
						if (!id || seenSet.has(id)) continue;
						seenSet.add(id);
						merged.push(id);
						added++;
					}
				}
				if (added > 0) st.noticeSeen = merged.slice(-NOTICE_SEEN_LIMIT);
			}
			// quarantine corrupt entries as visible cancelled shells (design §5)
			for (let k = 0; k < bad && k < 50; k++) {
				st.archived.push({
					id: uuid(),
					title: "(corrupt card #" + (k + 1) + ")",
					prompt: "(corrupt card)",
					status: "cancelled",
					order: 0,
					source: "import",
					inSeqRun: false,
					immediate: false,
					createdAt: nowIso(),
					updatedAt: nowIso(),
				});
			}
			st.badCards += bad;
			return st;
		}

		function readStore() {
			try {
				const raw = localStorage.getItem(STORAGE_KEY);
				if (!raw) return defaultState();
				return coerceState(JSON.parse(raw));
			} catch (_) {
				return defaultState();
			}
		}

		const store = {
			state: readStore(),
			listeners: new Set(),
			saveTimer: null,
			emit() {
				for (const fn of this.listeners) {
					try { fn(); } catch (_) { /* listener errors must not break the store */ }
				}
			},
			mutate(fn) {
				const next = fn(this.state);
				if (next !== this.state) {
					this.state = next;
					this.scheduleSave();
					this.emit();
				}
			},
			scheduleSave() {
				if (this.saveTimer != null) return;
				this.saveTimer = setTimeout(() => {
					this.saveTimer = null;
					this.save();
				}, 0);
			},
			save() {
				try {
					// 存储层不保留 seqMode：写入时强制 false（开关仅在本次页面载入内有效）
					localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...this.state, seqMode: false }));
					return true;
				} catch (_) {
					return false;
				}
			},
			subscribe(fn) {
				this.listeners.add(fn);
				return () => this.listeners.delete(fn);
			},
			getSnapshot() {
				return this.state;
			},
		};

		function sweepTerminal() {
			store.mutate((st) => {
				const terminal = st.cards.filter((c) => TERMINAL.has(c.status));
				if (terminal.length === 0) return st;
				const live = st.cards.filter((c) => !TERMINAL.has(c.status));
				const archived = [...st.archived, ...terminal].slice(-ARCHIVED_LIMIT);
				return { ...st, cards: live, archived };
			});
		}

		function useStore() {
			return useSyncExternalStore(
				useCallback((fn) => store.subscribe(fn), []),
				useCallback(() => store.getSnapshot(), []),
			);
		}
		//#endregion

		//#region card-ops
		function nextOrder(cards) {
			return cards.reduce((m, c) => Math.max(m, c.order), 0) + 1;
		}

		function addCard(partial) {
			let created = null;
			store.mutate((st) => {
				if (st.cards.length >= CARDS_LIMIT) return st;
				const base = {
					id: uuid(),
					title: partial.title,
					prompt: partial.prompt || partial.title,
					status: "pending",
					order: nextOrder(st.cards),
					source: partial.source || "panel-input",
					inSeqRun: partial.inSeqRun === undefined ? true : !!partial.inSeqRun,
					immediate: !!partial.immediate,
					createdAt: nowIso(),
					updatedAt: nowIso(),
				};
				if (partial.sessionId) base.sessionId = partial.sessionId;
				if (partial.workspaceId) base.workspaceId = partial.workspaceId;
				if (partial.diffKey) base.diffKey = partial.diffKey;
				// 建卡来源会话 id：仅接受非空字符串，缺省时省略（旧数据/取不到均兼容）
				if (typeof partial.createdBy === "string" && partial.createdBy) base.createdBy = partial.createdBy;
				if (partial.schedule) base.schedule = partial.schedule;
				created = base;
				// A freshly materialised addressed card (notify cards) answers deletion
				// events again: evict its fingerprint in this same mutation so a delete that
				// arrives after a rebuild is not skipped as “already seen”. No match -> no rewrite.
				let next = { ...st, cards: [...st.cards, base] };
				const fingerprint = base.diffKey ? deletionFingerprintFor(base.diffKey) : "";
				if (fingerprint) {
					const prevSeen = Array.isArray(st.deletionSeen) ? st.deletionSeen : [];
					if (prevSeen.length > 0 && prevSeen.indexOf(fingerprint) !== -1) {
						next = { ...next, deletionSeen: prevSeen.filter((x) => x !== fingerprint) };
					}
				}
				return next;
			});
			sweepTerminal();
			return created;
		}

		function updateCard(id, patch) {
			store.mutate((st) => ({
				...st,
				cards: st.cards.map((c) => (c.id === id ? { ...c, ...patch, updatedAt: nowIso() } : c)),
			}));
			sweepTerminal();
		}

		function findCard(id) {
			return store.state.cards.find((c) => c.id === id) || store.state.archived.find((c) => c.id === id) || null;
		}

		function reorderCards(cardId, targetIndex) {
			store.mutate((st) => {
				const sorted = [...st.cards].sort((a, b) => a.order - b.order);
				const from = sorted.findIndex((c) => c.id === cardId);
				if (from < 0) return st;
				const to = clamp(targetIndex, 0, sorted.length - 1);
				if (from === to) return st;
				const moved = sorted.splice(from, 1)[0];
				sorted.splice(to, 0, moved);
				const cards = sorted.map((c, i) => (c.order !== i + 1 ? { ...c, order: i + 1, updatedAt: nowIso() } : c));
				return { ...st, cards };
			});
		}

		function nudgeOrder(cardId, delta) {
			const sorted = [...store.state.cards].sort((a, b) => a.order - b.order);
			const idx = sorted.findIndex((c) => c.id === cardId);
			if (idx < 0) return;
			reorderCards(cardId, idx + delta);
		}

		function restoreCard(id) {
			store.mutate((st) => {
				const card = st.archived.find((c) => c.id === id);
				if (!card || st.cards.length >= CARDS_LIMIT) return st;
				const revived = { ...card, status: "pending", order: nextOrder(st.cards), updatedAt: nowIso() };
				delete revived.lastDispatch;
				return { ...st, cards: [...st.cards, revived], archived: st.archived.filter((c) => c.id !== id) };
			});
		}

		function purgeCard(id) {
			store.mutate((st) => ({ ...st, archived: st.archived.filter((c) => c.id !== id) }));
		}

		function deleteCard(id) {
			store.mutate((st) => ({ ...st, cards: st.cards.filter((c) => c.id !== id), archived: st.archived.filter((c) => c.id !== id) }));
		}

		/** Delete a live card: drop it from both lists first (an earlier wake could
		 *  otherwise let an idle machine claim the card mid-deletion), then release any
		 *  sequencer machine mid-dispatch on it so the queue advances. Deleting never
		 *  interrupts an already-dispatched session. */
		function deleteCardFlow(cardId) {
			const c = findCard(cardId);
			// remove from the store FIRST: a wake issued before the deletion could let an
			// idle machine claim the very card being deleted (QC round-2 hardening)
			deleteCard(cardId);
			try { sequencer.removeCardRef(cardId); } catch (_) { /* best effort */ }
			pushToast("ok", c && (c.status === "queued" || c.status === "running") ? "toastDeletedLive" : "toastDeleted");
		}
		//#endregion

		//#region env
		const env = {
			ctx: null,
			sessionIds: new Set(),
			sessionTitles: new Map(),
			currentSessionId: null,
			/** sessionId -> cwd, captured from the sessions store; resolves workspaces for
			 *  sessions the workspace store does not list (sub-sessions, brand-new sessions). */
			sessionCwd: new Map(),
			workspaces: [],
			statusBySession: new Map(),
			queueLenBySession: new Map(),
			todosBySession: new Map(),
			/** sessionId -> todo signature already synced status-only (no-creation passes). */
			todosSyncedBySession: new Map(),
			batchSessions: new Map(),
			toasts: [],
			toastListeners: new Set(),
		};

		function pushToast(kind, textKey, detail) {
			const item = { id: uuid(), kind, textKey, detail: detail == null ? "" : String(detail) };
			env.toasts = [...env.toasts.slice(-4), item];
			for (const fn of env.toastListeners) {
				try { fn(); } catch (_) { /* ignore */ }
			}
			setTimeout(() => {
				env.toasts = env.toasts.filter((x) => x.id !== item.id);
				for (const fn of env.toastListeners) {
					try { fn(); } catch (_) { /* ignore */ }
				}
			}, 4200);
		}

		/** Resolve the uiWorkspace service: injected on this ctx, rootCtx fallback. */
		function uiWs() {
			if (env.ctx && env.ctx.uiWorkspace) return env.ctx.uiWorkspace;
			try {
				const rc = env.ctx && env.ctx.sessions && env.ctx.sessions.rootCtx;
				return rc && typeof rc.get === "function" ? rc.get("uiWorkspace") : null;
			} catch (_) {
				return null;
			}
		}

		/** Pick the session the main view currently shows. DSH 0.2.x root-scope
		 *  session stores carry no `current` key, so fall back to the row retained by
		 *  the main view ({"mainView":1} refcount marker). */
		function mainViewSessionOf(state) {
			if (state == null) return undefined;
			if (typeof state.current === "string" && state.current) return state.current;
			const byId = state.byId;
			if (byId == null || typeof byId !== "object") return undefined;
			for (const rowRaw of Object.values(byId)) {
				const row = rowRaw && typeof rowRaw === "object" ? rowRaw : null;
				if (row == null) continue;
				const rb = row.retainedBy && typeof row.retainedBy === "object" ? row.retainedBy : null;
				if (rb != null && Number(rb.mainView) > 0) return row.id;
			}
			return undefined;
		}

		/** Snapshot -> Map<sessionId, todos> for every session whose row carries a todos
		 *  projection. Cached per snapshot identity: handing back a fresh Map on every
		 *  selector call would make the Engine effect re-fire on every re-render. */
		const todosSnapCache = { snap: null, map: null };
		function todosBySessionOf(state) {
			if (state == null) return null;
			if (todosSnapCache.snap === state) return todosSnapCache.map;
			const map = new Map();
			const byId = asRecord(state.byId);
			if (byId != null) {
				for (const [sid, rowRaw] of Object.entries(byId)) {
					if (typeof sid !== "string" || !sid) continue;
					const row = asRecord(rowRaw);
					if (row == null) continue;
					const pv = asRecord(row.projectionValues);
					if (pv == null || pv.todos == null) continue;
					map.set(sid, pv.todos);
				}
			}
			todosSnapCache.snap = state;
			todosSnapCache.map = map;
			return map;
		}

		/** Resolve the workspace owning a session: the workspace store's sessionIds come
		 *  first; sessions it does not list (sub-sessions, brand-new sessions) fall back
		 *  to the session cwd matched against the workspace paths (longest match wins). */
		function workspaceOf(sessionId) {
			if (!sessionId) return null;
			for (const w of env.workspaces) {
				if (w.sessionIds.includes(sessionId)) return w.workspaceId;
			}
			const cwd = env.sessionCwd instanceof Map ? env.sessionCwd.get(sessionId) : undefined;
			if (typeof cwd !== "string" || !cwd) return null;
			let bestId = null;
			let bestLen = -1;
			for (const w of env.workspaces) {
				const raw = typeof w.path === "string" ? w.path : "";
				const root = raw.length > 1 && raw.endsWith("/") ? raw.replace(/\/+$/, "") : raw;
				if (!root) continue;
				if (cwd !== root && !cwd.startsWith(root + "/")) continue;
				if (root.length > bestLen) {
					bestId = w.workspaceId;
					bestLen = root.length;
				}
			}
			return bestId;
		}

		/** Coerce a runtime value into plain text (notice payloads are untrusted JSON). */
		function textOf(value) {
			return typeof value === "string" ? value : value == null ? "" : String(value);
		}

		/** Match one reference inside a given session-id scope, one layer at a time. Titles
		 *  normalise to textOf(title).trim().toLowerCase(). Every layer must leave exactly
		 *  ONE candidate: two or more hits make that layer ambiguous and the next, looser
		 *  layer is tried instead. Layers: T1 title equals want, T2 title starts with want,
		 *  T3 title contains want, T5 id starts with want, T6 id contains want. There is
		 *  deliberately NO "want contains title" layer: a short session title (the session
		 *  merely named after its workspace, e.g. "Centauri") would swallow a composite
		 *  "Centauri-主线" target and bind the card to that unrelated short-titled session.
		 *  Returns null when no layer pins down a single session. */
		function matchSessionRef(want, scopeIds) {
			if (!want || scopeIds == null || typeof scopeIds.has !== "function") return null;
			const lower = want.toLowerCase();
			// [id, normalised title] for the whole scope ("" when the row carries no title);
			// only live sessions count — callers' scopes are already subsets of env.sessionIds
			const scope = [];
			for (const sid of scopeIds) {
				if (!env.sessionIds.has(sid)) continue;
				scope.push([sid, textOf(env.sessionTitles.get(sid)).trim().toLowerCase()]);
			}
			const layers = [
				(e) => e[1] !== "" && e[1] === lower,          // T1 exact title
				(e) => e[1] !== "" && e[1].startsWith(lower),  // T2 title prefix
				(e) => e[1] !== "" && e[1].includes(lower),    // T3 title contains want
				(e) => e[0].startsWith(want),                  // T5 id prefix
				(e) => e[0].includes(want),                    // T6 id contains
			];
			for (const matches of layers) {
				let found = null;
				let hits = 0;
				for (const entry of scope) {
					if (!matches(entry)) continue;
					hits++;
					if (hits > 1) break;   // two or more candidates: ambiguous, degrade
					found = entry[0];
				}
				if (hits === 1) return found;
			}
			return null;
		}

		/** Session ids of one workspace that this window knows about (intersection with
		 *  env.sessionIds). Returns null when the workspace is unknown or holds no live
		 *  session, so callers fall straight through to the global scope. */
		function workspaceSessionSet(workspaceId) {
			if (!workspaceId) return null;
			const w = env.workspaces.find((x) => x.workspaceId === workspaceId);
			if (w == null) return null;
			const out = new Set();
			for (const sid of w.sessionIds) {
				if (env.sessionIds.has(sid)) out.add(sid);
			}
			return out.size > 0 ? out : null;
		}

		/** Separators a notice target may use between a workspace title and a session
		 *  reference ("工作区-会话"): hyphen, underscore, middle dot and whitespace. */
		const REF_SEPARATOR_RE = /[-_\u00b7\s]/;

		/** Strip the separators padding one half of a composite reference: "- Centauri-"
		 *  becomes "Centauri", which is what lets "Centauri - 主线" split cleanly. */
		function trimRefSeparators(text) {
			let a = 0;
			let b = text.length;
			while (a < b && REF_SEPARATOR_RE.test(text.charAt(a))) a++;
			while (b > a && REF_SEPARATOR_RE.test(text.charAt(b - 1))) b--;
			return text.slice(a, b);
		}

		/** Match a workspace by title text, one layer at a time: W1 exact title, W2 title
		 *  prefix, W3 title contains. Like matchSessionRef every layer must leave exactly
		 *  ONE workspace: two or more hits make that layer ambiguous and the next, looser
		 *  layer is tried instead. Returns the workspaceId, or null when no layer pins down
		 *  a single workspace. */
		function matchWorkspaceRef(want) {
			const lower = want.toLowerCase();
			if (!lower) return null;
			const rows = [];
			for (const w of env.workspaces) {
				const title = textOf(w.title).trim().toLowerCase();
				if (title !== "") rows.push([w.workspaceId, title]);
			}
			const layers = [
				(t) => t === lower,          // W1 exact title
				(t) => t.startsWith(lower),  // W2 title prefix
				(t) => t.includes(lower),    // W3 title contains want
			];
			for (const matches of layers) {
				let found = null;
				let hits = 0;
				for (const row of rows) {
					if (!matches(row[1])) continue;
					hits++;
					if (hits > 1) break;   // two or more candidates: ambiguous, degrade
					found = row[0];
				}
				if (hits === 1) return found;
			}
			return null;
		}

		/** Parse a composite "<workspace><separator><session>" reference into its two halves.
		 *  Notices from the host tool carry both halves when the target names a workspace
		 *  ("Centauri-主线"). A split point may only sit ON a separator (the cut excludes that
		 *  character and the halves are trimmed afterwards), never between two ordinary
		 *  characters: an arbitrary cut would let a one-character prefix match through the loose
		 *  W3 contains layer — "s" + "ession-7bb5" would invent a workspace hint for a plain
		 *  session id. Separator-aligned splits are tried longest prefix first, so a workspace
		 *  title that itself contains a separator ("权小赚DSH- Native") is never chopped in
		 *  the middle; padding separators are stripped and pure-separator splits skipped. A
		 *  prefix only counts as a workspace when it pins down exactly ONE existing workspace
		 *  title, which is what keeps a bare session id ("session-7bb5") on the regular path.
		 *  A reference that is itself a workspace name is NOT composite either: it names a
		 *  workspace, not a session, so a dangling separator ("Centauri-") never turns the
		 *  prefix into a session ref.
		 *  Returns null when the reference is not composite, and { workspaceId, suffix } —
		 *  the matched workspace plus the trimmed session half — otherwise. A caller that
		 *  only needs the workspace (the notice card hint) uses the id even when the session
		 *  half resolves to nothing. */
		function compositeWorkspaceOf(want) {
			const ref = textOf(want).trim().replace(/^#/, "").slice(0, 200);
			if (!ref || !REF_SEPARATOR_RE.test(ref)) return null;
			// composite needs a PROPER prefix: a reference that is itself a workspace name
			// (padding separators aside, also when it is only part of a longer workspace title)
			// names no session, so it stays on the regular path exactly like a separator-free
			// workspace title would — a safe null beats a card bound to a guessed session
			const bare = trimRefSeparators(ref);
			if (bare && matchWorkspaceRef(bare) != null) return null;
			for (let cut = ref.length - 1; cut > 0; cut--) {
				// only a separator may be cut away: any other index would slice a word in half
				// and let a stub prefix ("s" of "session-7bb5") hit the loose W3 contains layer
				if (!REF_SEPARATOR_RE.test(ref.charAt(cut))) continue;
				const wsPart = trimRefSeparators(ref.slice(0, cut));
				const suffix = trimRefSeparators(ref.slice(cut));
				if (!wsPart || !suffix) continue;   // separator-only split: keep shrinking
				const workspaceId = matchWorkspaceRef(wsPart);
				if (workspaceId == null) continue;
				return { workspaceId, suffix };
			}
			return null;
		}

		/** Resolve a composite "<workspace><separator><session>" reference (split rules live
		 *  in compositeWorkspaceOf).
		 *  Returns undefined when the reference is not composite (the caller keeps going
		 *  with the regular path), null when a workspace matched but its session did not,
		 *  and the session id otherwise. Once a workspace has matched, the session lookup
		 *  stays inside it: never fall back across workspaces, never retry the workspace
		 *  prefix as a session name — the caller materialises an unbound card instead of
		 *  guessing. */
		function resolveCompositeRef(want) {
			const hit = compositeWorkspaceOf(want);
			if (hit == null) return undefined;
			const scope = workspaceSessionSet(hit.workspaceId);
			return scope == null ? null : matchSessionRef(hit.suffix, scope);
		}

		/** Resolve a session reference from a notice. Composite "<workspace>-<session>"
		 *  targets are parsed first; then titles may repeat across workspaces, so the source
		 *  notice's own workspace wins; only on a miss does the global session list get
		 *  consulted. */
		function resolveSessionRef(ref, preferWorkspaceId) {
			const want = textOf(ref).trim().replace(/^#/, "").slice(0, 200);
			if (!want) return null;
			const composite = resolveCompositeRef(want);
			if (composite !== undefined) return composite;
			if (preferWorkspaceId) {
				const scope = workspaceSessionSet(preferWorkspaceId);
				if (scope != null) {
					const local = matchSessionRef(want, scope);
					if (local != null) return local;
				}
			}
			return matchSessionRef(want, env.sessionIds);
		}
		function workspaceTitle(workspaceId) {
			const w = env.workspaces.find((x) => x.workspaceId === workspaceId);
			return w ? { title: w.title, path: w.path } : null;
		}

		function sessionTitle(sessionId) {
			return env.sessionTitles.get(sessionId) || null;
		}

		function probeQueueLen(sessionId) {
			const n = env.queueLenBySession.get(sessionId);
			return typeof n === "number" ? n : undefined;
		}
		//#endregion

		//#region capture
		/** Bound a sessionId-keyed todo cache (oldest entry first out). */
		function trimTodoCache(cache) {
			while (cache.size > TODOS_CACHE_LIMIT) {
				const oldest = cache.keys().next().value;
				cache.delete(oldest);
			}
		}

		/** Todo status -> card status: a todo being worked on is `running` for its card. */
		function todoCardStatus(todo) {
			const s = todo && todo.status;
			return s === "completed" ? "done" : s === "in_progress" ? "running" : "pending";
		}

		/** Status-only card update used by the todo sync. Returns null when the card must be
		 *  left alone: terminal cards are archived history and are never rewritten, and a
		 *  dispatched card (queued/running) is never walked back down to pending. */
		function syncCardStatus(card, nextStatus, now) {
			if (!nextStatus) return null;
			if (TERMINAL.has(card.status)) return null;
			if (card.status === nextStatus) return null;
			if (nextStatus === "pending" && (card.status === "queued" || card.status === "running")) return null;
			return { ...card, status: nextStatus, updatedAt: now };
		}

		/** Sync one session's todos into cards.
		 *  options.create === false: status-only sync (never creates cards) — used for the
		 *  sessions the drawer is not showing. Such a pass leaves the creation baseline
		 *  untouched, so a later create pass still materialises that session's cards. */
		function captureTodos(sessionId, todos, options) {
			const opts = options || {};
			const mayCreate = opts.create !== false;
			const prevList = env.todosBySession.get(sessionId) || [];
			const todosArray = Array.isArray(todos) ? todos
				: todos && Array.isArray(todos.items) ? todos.items : [];
			const nextList = todosArray;
			const sigOf = (list) => list.map((t) => normText(t && t.content) + "\u0002" + ((t && t.status) || "")).join("\u0001");
			const sigNext = sigOf(nextList);
			// The creation baseline doubles as the "already processed" mark; a status-only pass
			// must not move it, so it keeps its own signature cache to stay idempotent.
			let markApplied;
			if (mayCreate) {
				if (prevList === nextList) return;
				if (sigOf(prevList) === sigNext) {
					env.todosBySession.set(sessionId, nextList);
					trimTodoCache(env.todosBySession);
					return;
				}
				markApplied = () => {
					env.todosBySession.set(sessionId, nextList);
					trimTodoCache(env.todosBySession);
				};
			} else {
				if (env.todosSyncedBySession.get(sessionId) === sigNext) return;
				markApplied = () => {
					env.todosSyncedBySession.set(sessionId, sigNext);
					trimTodoCache(env.todosSyncedBySession);
				};
			}

			const prevNorms = prevList.map((t) => normText(t && t.content));
			const nextNorms = nextList.map((t) => normText(t && t.content));

			const ws = workspaceOf(sessionId) || undefined;
			const keyOf = (norm) => sessionId + ":" + norm;

			const matchedPrev = new Set();
			const matchedNext = new Set();
			const statusUpdates = [];
			const additions = [];
			const removals = [];

			const lcs = Array.from({ length: prevNorms.length + 1 }, () => new Array(nextNorms.length + 1).fill(0));
			for (let i = prevNorms.length - 1; i >= 0; i--) {
				for (let j = nextNorms.length - 1; j >= 0; j--) {
					lcs[i][j] = prevNorms[i] && prevNorms[i] === nextNorms[j]
						? lcs[i + 1][j + 1] + 1
						: Math.max(lcs[i + 1][j], lcs[i][j + 1]);
				}
			}
			let i = 0;
			let j = 0;
			while (i < prevNorms.length && j < nextNorms.length) {
				if (prevNorms[i] && prevNorms[i] === nextNorms[j]) {
					matchedPrev.add(i);
					matchedNext.add(j);
					statusUpdates.push({ index: j, todo: nextList[j] });
					i++;
					j++;
				} else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
					i++;
				} else {
					j++;
				}
			}
			for (let x = 0; x < prevNorms.length; x++) if (!matchedPrev.has(x)) removals.push({ index: x, todo: prevList[x], norm: prevNorms[x] });
			for (let x = 0; x < nextNorms.length; x++) if (!matchedNext.has(x)) additions.push({ index: x, todo: nextList[x], norm: nextNorms[x] });

			const mergedAdditions = [];
			for (const add of additions) {
				let best = null;
				let bestScore = 0;
				for (const rem of removals) {
					if (rem.consumed) continue;
					const score = diceSimilar(rem.norm, add.norm);
					if (score > bestScore) { bestScore = score; best = rem; }
				}
				if (best != null && bestScore >= FUZZY_THRESHOLD) {
					best.consumed = true;
					add.rewordedFrom = best;
				}
				mergedAdditions.push(add);
			}

			store.mutate((st) => {
				let cards = st.cards;
				let changed = false;
				/** Apply a mapping; only a real change rewrites the store, so a sync pass that
				 *  changes nothing neither re-renders nor re-saves. */
				const touch = (fn) => {
					const next = fn(cards);
					if (next === cards) return;
					if (next.length === cards.length && next.every((c, i) => c === cards[i])) return;
					cards = next;
					changed = true;
				};

				for (const m of statusUpdates) {
					const key = keyOf(normText(m.todo && m.todo.content));
					const nextStatus = todoCardStatus(m.todo);
					const now = nowIso();
					touch((cs) => cs.map((c) => {
						if (c.diffKey !== key) return c;
						return syncCardStatus(c, nextStatus, now) || c;
					}));
				}

				// Archived records participate in de-duplication: a completed todo swept into
				// st.archived must never be re-materialised as a live card after a page reload
				// leaves the env.todosBySession creation baseline empty.
				let archived = st.archived;
				let archivedChanged = false;
				/** Fingerprints of cards materialised in this very pass (live or born
				 *  terminal): their deletion records are evicted in this same mutation, so a
				 *  todo rebuilt after a delete answers a fresh deletion event again. */
				const evictedFingerprints = new Set();
				for (const add of mergedAdditions) {
					const key = keyOf(add.norm);
					const content = add.todo && typeof add.todo.content === "string" ? add.todo.content : String(add.norm);
					if (!content.trim()) continue;
					if (add.rewordedFrom != null) {
						const oldKey = keyOf(add.rewordedFrom.norm);
						// archived predecessor: history is never renamed or revived
						if (archived.some((c) => c.diffKey === oldKey)) continue;
						touch((cs) => cs.map((c) => (c.diffKey === oldKey ? { ...c, diffKey: key, title: content, prompt: content, updatedAt: nowIso() } : c)));
					} else if (archived.some((c) => c.diffKey === key)) {
						// same todo already archived (e.g. completed before the baseline was rebuilt):
						// neither re-create nor revive it
						continue;
					} else if (cards.some((c) => c.diffKey === key)) {
						// the card already exists (e.g. env baseline empty after a page reload):
						// never create a duplicate, converge its status with the same rules instead
						const nextStatus = todoCardStatus(add.todo);
						const now = nowIso();
						touch((cs) => cs.map((c) => {
							if (c.diffKey !== key) return c;
							return syncCardStatus(c, nextStatus, now) || c;
						}));
					} else {
						if (!mayCreate) continue;
						if (cards.length >= CARDS_LIMIT) continue;
						const now = nowIso();
						const card = {
							id: uuid(),
							title: content,
							prompt: content,
							status: todoCardStatus(add.todo),
							order: nextOrder(cards),
							source: "agent-todo",
							// 自动捕获的待办卡默认只进清单，不自动加入顺序执行队列（用户可在修改面板显式加入）
							inSeqRun: false,
							immediate: false,
							createdAt: now,
							updatedAt: now,
							diffKey: key,
						};
						if (sessionId) card.sessionId = sessionId;
						// 待办捕获卡（含 born-terminal 直接归档）由其所属会话建立
						if (sessionId) card.createdBy = sessionId;
						if (ws) card.workspaceId = ws;
						const fp = deletionFingerprintFor(key);
						if (fp) evictedFingerprints.add(fp);
						if (TERMINAL.has(card.status)) {
							// born terminal (e.g. todo already completed on first capture): go
							// straight into archived history, same move sweepTerminal performs
							archived = [...archived, card].slice(-ARCHIVED_LIMIT);
							archivedChanged = true;
						} else {
							touch((cs) => [...cs, card]);
						}
					}
				}

				for (const rem of removals) {
					if (rem.consumed) continue;
					const key = keyOf(rem.norm);
					touch((cs) => cs.map((c) => (c.diffKey === key && !TERMINAL.has(c.status) ? { ...c, status: "stale", updatedAt: nowIso() } : c)));
				}

				// Apply fingerprint eviction for cards created in this same pass. Only a
				// real match rewrites deletionSeen (reference-preserving otherwise), and the
				// 50-entry freshest cap is untouched since eviction only shrinks the list.
				let deletionSeen = st.deletionSeen;
				if (evictedFingerprints.size > 0) {
					const prevSeen = Array.isArray(st.deletionSeen) ? st.deletionSeen : [];
					if (prevSeen.some((x) => evictedFingerprints.has(x))) {
						deletionSeen = prevSeen.filter((x) => !evictedFingerprints.has(x));
					}
				}
				const seenChanged = deletionSeen !== st.deletionSeen;
				if (!changed && !archivedChanged && !seenChanged) return st;
				const out = { ...st, cards };
				if (archivedChanged) out.archived = archived;
				if (seenChanged) out.deletionSeen = deletionSeen;
				return out;
			});
			markApplied();
			sweepTerminal();
		}
		//#endregion

		//#region dispatch
		function resolveTarget(card, opts) {
			const options = opts || {};
			if (card.sessionId && env.sessionIds.has(card.sessionId)) {
				const actualWs = workspaceOf(card.sessionId);
				const want = actualWs || undefined;
				if (card.workspaceId !== want) {
					updateCard(card.id, want ? { workspaceId: want } : { workspaceId: undefined });
					if (card.workspaceId && options.source !== "scheduler") pushToast("info", "toastWsHealed");
				}
				return { ok: true, sessionId: card.sessionId, reason: "session" };
			}
			if (!card.sessionId && card.workspaceId && env.workspaces.some((w) => w.workspaceId === card.workspaceId)) {
				const ws = card.workspaceId;
				// batch reuse is a sequencer-batch-only privilege (design §4.5); write back per card
				if (options.source === "sequencer" && !store.state.seqIsolatedSessions && env.batchSessions.has(ws)) {
					const sid = env.batchSessions.get(ws);
					updateCard(card.id, { sessionId: sid });
					return { ok: true, sessionId: sid, reason: "batch-reuse" };
				}
				return { ok: false, sessionId: null, reason: "create", workspaceId: ws };
			}
			if (card.sessionId && options.source !== "scheduler") pushToast("info", "toastSessionGone");
			return { ok: false, sessionId: null, reason: card.sessionId ? "session-dead" : card.workspaceId ? "workspace-dead" : "no-target" };
		}

		async function createSessionIn(workspaceId) {
			const sessions = env.ctx && env.ctx.sessions;
			if (!sessions || typeof sessions.create !== "function") return null;
			try {
				const value = await sessions.create({ workspaceId });
				// the service returns the session id string directly; tolerate wrapper shapes
				const sid = typeof value === "string" ? value
					: value && typeof value.sessionId === "string" ? value.sessionId
						: value && value.session && typeof value.session.id === "string" ? value.session.id
							: null;
				if (sid) {
					env.sessionIds.add(sid);
					if (!store.state.seqIsolatedSessions) env.batchSessions.set(workspaceId, sid);
				}
				return sid;
			} catch (e) {
				return null;
			}
		}

		async function dispatchRun(cardId, opts) {
			const options = opts || {};
			const card = findCard(cardId);
			if (!card) return { skipped: true, reason: "gone" };
			if (TERMINAL.has(card.status)) return { skipped: true, reason: "terminal" };
			if (card.lastDispatch && card.lastDispatch.outcome === "pending") {
				// stale write-ahead recovery: page closed between write-ahead and settle
				const age = Date.now() - Date.parse(card.lastDispatch.at || 0);
				if (Number.isFinite(age) && age <= 2 * PROMPT_TIMEOUT_MS) {
					return { skipped: true, reason: "in-flight" };
				}
			}

			let target = resolveTarget(card, options);
			if (!target.ok && target.reason === "create") {
				const sid = await createSessionIn(target.workspaceId);
				if (sid) {
					updateCard(cardId, { sessionId: sid });
					target = { ok: true, sessionId: sid, reason: "created" };
				}
			}
			if (!target.ok) {
				if (options.source === "scheduler") {
					updateCard(cardId, { schedule: null, status: "failed" });
					pushToast("error", "toastScheduleDead");
				} else {
					pushToast("error", target.reason === "workspace-dead" ? "toastWorkspaceGone" : "toastNoWorkspace");
				}
				return { blocked: true, reason: target.reason };
			}
			const sessionId = target.sessionId;

			// write-ahead (§4.7 step 2) — reuse the original requestId on retries/catch-up
			// so the server can deduplicate (design §4.7, acceptance #9)
			const reuseId = card.lastDispatch && card.lastDispatch.outcome !== "accepted" && typeof card.lastDispatch.requestId === "string"
				? card.lastDispatch.requestId
				: null;
			updateCard(cardId, {
				lastDispatch: { requestId: reuseId || uuid(), at: nowIso(), outcome: "pending" },
			});
			const fresh = findCard(cardId);
			const requestId = fresh && fresh.lastDispatch ? fresh.lastDispatch.requestId : uuid();

			// Real dispatch face: the sessions service exposes session objects with
			// prompt(content, mode, signal, requestId) through its manager (verified live)
			const sessions = env.ctx && env.ctx.sessions;
			const mgr = sessions && sessions.manager;
			if (!mgr || typeof mgr.get !== "function") {
				updateCard(cardId, { lastDispatch: { requestId, at: nowIso(), outcome: "error" } });
				pushToast("error", "toastNoService");
				return { error: true, reason: "service" };
			}
			let sessionObj = null;
			try {
				sessionObj = mgr.get(sessionId);
			} catch (_) {
				sessionObj = null;
			}
			if (!sessionObj || typeof sessionObj.prompt !== "function") {
				updateCard(cardId, { lastDispatch: { requestId, at: nowIso(), outcome: "error" } });
				pushToast("error", "toastNoService");
				return { error: true, reason: "session-object" };
			}

			try {
				const content = [{ type: "text", text: card.prompt || card.title }];
				const admitted = await Promise.race([
					sessionObj.prompt(content, "queue", undefined, requestId),
					new Promise((_, reject) => {
						setTimeout(() => { reject(new Error("prompt admission timeout")); }, PROMPT_TIMEOUT_MS);
					}),
				]);
				if (admitted && admitted.ok === false) {
					const err = admitted.error || {};
					throw new Error(err.code ? (err.code + ": " + (err.message || "")) : "prompt rejected");
				}
				const patch = { status: "queued", lastDispatch: { requestId, at: nowIso(), outcome: "accepted" } };
				if (card.schedule) patch.schedule = null;
				updateCard(cardId, patch);
				try { watcher.tick(); } catch (_) { /* best effort */ }
				if (store.state.ui.openAfterDispatch) {
					const uiw = uiWs();
					if (uiw && typeof uiw.openSession === "function") {
						try { uiw.openSession(sessionId); } catch (_) { /* best effort */ }
					}
				}
				return { ok: true, sessionId, requestId };
			} catch (e) {
				updateCard(cardId, { status: "pending", lastDispatch: { requestId, at: nowIso(), outcome: "error" } });
				pushToast("error", "toastDispatchFailed", e && e.message ? e.message : "");
				return { error: true, reason: "prompt" };
			}
		}
		//#endregion

		//#region scheduler
		const scheduler = {
			timer: null,
			ticking: false,
			start() {
				if (this.timer != null) return;
				this.timer = setInterval(() => { this.tick(); }, HEARTBEAT_MS);
				this.tick();
			},
			stop() {
				if (this.timer != null) {
					clearInterval(this.timer);
					this.timer = null;
				}
			},
			async tick() {
				if (this.ticking) return;
				this.ticking = true;
				try {
					watcher.tick();
					await this.scan();
				} finally {
					this.ticking = false;
				}
			},
			async scan() {
				const now = Date.now();
				const due = store.state.cards.filter((c) => {
					if (c.status !== "pending") return false;
					if (!c.schedule || c.schedule.kind !== "once") return false;
					if (c.lastDispatch && c.lastDispatch.outcome === "pending") return false;
					const at = Date.parse(c.schedule.at);
					return Number.isFinite(at) && at <= now;
				}).sort((a, b) => Date.parse(a.schedule.at) - Date.parse(b.schedule.at));

				let fired = 0;
				for (const card of due) {
					if (fired >= HEARTBEAT_BURST) break;
					fired++;
					if (store.state.seqMode && card.inSeqRun) {
						// hand over to the sequencer via its pump (design §4.4): claim by queued
						// status, then the pump resolves target + dispatches exactly once
						updateCard(card.id, { status: "queued" });
						sequencer.handover.push(card.id);
						sequencer.wake();
					} else {
						await dispatchRun(card.id, { source: "scheduler" });
					}
				}
			},
		};
		//#endregion

		//#region sequencer
		function newMachine(sessionId) {
			return {
				sessionId,
				state: "idle",
				cardId: null,
				interactionTimer: null,
				idleTimer: null,
				graceUntil: 0,
				lastRunning: false,
				idleSince: 0,
				failStreak: 0,
				skipped: new Set(),
			};
		}

		const sequencer = {
			machines: new Map(),
			running: false,
			handover: [],
			pumping: false,
			setEnabled(on) {
				this.running = on;
				store.mutate((st) => ({ ...st, seqMode: on }));
				if (!on) {
					for (const m of this.machines.values()) this.stopMachine(m);
					env.batchSessions.clear();
					this.handover = [];
				} else {
					this.wake();
				}
			},
			stopMachine(m) {
				if (m.interactionTimer != null) {
					clearTimeout(m.interactionTimer);
					m.interactionTimer = null;
				}
				if (m.idleTimer != null) {
					clearTimeout(m.idleTimer);
					m.idleTimer = null;
				}
				m.state = "stopped";
				m.cardId = null;
				m.graceUntil = 0;
				m.skipped = new Set();
			},
			/** A card was deleted: release any machine mid-flight on it and resume the queue. */
			removeCardRef(cardId) {
				for (const m of this.machines.values()) {
					if (m.cardId === cardId) this.stopMachine(m);
				}
				if (this.running) this.wake();
			},
			/** Cross-window storage replacement: stop all in-flight machines without writing the store. */
			/** 跨窗口存储替换：立即停止所有在途状态机，但不写回 store（避免触发存储事件回环）。 */
			halt() {
				this.running = false;
				for (const m of this.machines.values()) this.stopMachine(m);
				this.machines.clear();
				env.batchSessions.clear();
				this.handover = [];
				this.pumping = false;
			},
			cardsFor(m) {
				const cards = store.state.cards;
				return cards.filter((c) => {
					if (c.status !== "pending" || !c.inSeqRun) return false;
					if (m.skipped && m.skipped.has(c.id)) return false;
					if (c.sessionId) return c.sessionId === m.sessionId;
					if (c.workspaceId && env.batchSessions.get(c.workspaceId) === m.sessionId) return true;
					return false;
				}).sort((a, b) => a.order - b.order);
			},
			async advance(m) {
				if (!this.running) return;
				const queue = this.cardsFor(m);
				if (queue.length === 0) {
					m.state = "idle";
					m.cardId = null;
					m.skipped = new Set();
					// batch ends for this machine: drop batch mappings pointing at this session
					// (the map is keyed by workspaceId — delete by value, not by key)
					let anyLeft = false;
					for (const c of store.state.cards) {
						if (c.status === "pending" && c.inSeqRun && !c.sessionId && c.workspaceId && env.batchSessions.get(c.workspaceId) === m.sessionId) anyLeft = true;
					}
					if (!anyLeft) {
						for (const [wsKey, sidVal] of Array.from(env.batchSessions.entries())) {
							if (sidVal === m.sessionId) env.batchSessions.delete(wsKey);
						}
					}
					return;
				}
				const card = queue[0];
				m.cardId = card.id;
				m.state = "dispatching";
				const r = await dispatchRun(card.id, { source: "sequencer" });
				if (!this.running) return;
				if (r && (r.skipped || r.blocked || r.error)) {
					if (m.skipped) m.skipped.add(card.id);
					if (r.blocked) {
						m.failStreak = (m.failStreak || 0) + 1;
						if (m.failStreak >= 3) {
							this.stopMachine(m);
							pushToast("error", "toastSeqStopped");
							return;
						}
					}
					m.state = "idle";
					m.cardId = null;
					const rest = this.cardsFor(m);
					if (rest.length > 0) {
						await this.advance(m);
					} else {
						m.skipped = new Set();
					}
					return;
				}
				if (r && r.ok) {
					m.failStreak = 0;
					m.state = "waiting-running";
				}
			},
			/** Scheduler handover pump (design §4.4): dispatch queued handover cards. */
			async pump() {
				if (this.pumping) return;
				this.pumping = true;
				try {
					while (this.handover.length > 0) {
						const id = this.handover.shift();
						const card = findCard(id);
						if (!card || card.status !== "queued") continue;
						const r = await dispatchRun(id, { source: "sequencer" });
						if (r && r.blocked) {
							// mirror the scheduler expiry closure so the card cannot stick in queued
							updateCard(id, { schedule: null, status: "failed" });
							pushToast("error", "toastScheduleDead");
						}
					}
				} finally {
					this.pumping = false;
				}
			},
			wake() {
				if (!store.state.seqMode) return;
				this.running = true;
				if (this.handover.length > 0) this.pump();
				const wanted = new Set();
				for (const c of store.state.cards) {
					if (c.status !== "pending" || !c.inSeqRun) continue;
					if (c.sessionId && env.sessionIds.has(c.sessionId)) wanted.add(c.sessionId);
				}
				// refresh recovery (design §4.6 last row): adopt in-flight cards, no re-dispatch
				for (const c of store.state.cards) {
					if ((c.status === "queued" || c.status === "running") && c.sessionId
						&& c.lastDispatch && c.lastDispatch.outcome === "accepted") {
						wanted.add(c.sessionId);
					}
				}
				for (const sid of wanted) {
					if (!this.machines.has(sid)) this.machines.set(sid, newMachine(sid));
					const m = this.machines.get(sid);
					if (m.state === "idle" || m.state === "stopped") {
						const adopted = store.state.cards.find((c) => (c.status === "queued" || c.status === "running")
							&& c.sessionId === sid && c.lastDispatch && c.lastDispatch.outcome === "accepted");
						if (adopted) {
							m.state = "waiting-running";
							m.cardId = adopted.id;
							m.skipped = new Set();
						} else {
							m.skipped = new Set();
							this.advance(m);
						}
					}
				}
				for (const [sid, m] of this.machines) {
					if (!wanted.has(sid)) this.stopMachine(m);
				}
			},
			onStatus(sessionId, status) {
				const m = this.machines.get(sessionId);
				if (!m || !this.running) return;
				try {
					this.step(m, status);
				} catch (_) {
					// one machine's error must not starve the others in feedAll
				}
			},
			step(m, status) {
				const sessionId = m.sessionId;
				const running = !!(status && status.running);
				const interaction = status && status.pendingInteraction ? status.pendingInteraction : null;
				const runningEdge = running && !m.lastRunning;
				m.lastRunning = running;

				if (interaction && (m.state === "waiting-running" || m.state === "dispatching")) {
					this.clearTimers(m);
					m.state = "waiting-interaction";
					return;
				}

				if (m.state === "waiting-interaction" && !interaction) {
					m.state = "waiting-running";
					m.graceUntil = Date.now() + INTERACTION_RECOVERY_MS;
					const armedCardId = m.cardId;
					m.interactionTimer = setTimeout(() => {
						m.interactionTimer = null;
						m.graceUntil = 0;
						if (m.state !== "waiting-running" || m.cardId !== armedCardId) return;
						this.finishCard(m);
					}, INTERACTION_RECOVERY_MS);
					return;
				}

				if (m.state === "waiting-running") {
					if (runningEdge) {
						this.clearTimers(m);
						m.graceUntil = 0;
						if (m.cardId) {
							const cur = findCard(m.cardId);
							if (cur && cur.status === "queued") updateCard(m.cardId, { status: "running" });
						}
						return;
					}
					if (!running) {
						const inGrace = m.graceUntil > 0 && Date.now() < m.graceUntil;
						if (inGrace) return;
						const qlen = probeQueueLen(sessionId);
						if (qlen === undefined) {
							if (!m.idleSince) {
								m.idleSince = Date.now();
								const armedCardId = m.cardId;
								m.idleTimer = setTimeout(() => {
									m.idleTimer = null;
									if (m.state !== "waiting-running" || m.cardId !== armedCardId) return;
									if (probeQueueLen(sessionId) !== undefined) return;
									m.idleSince = 0;
									this.finishCard(m);
								}, 3050);
							}
						} else {
							m.idleSince = 0;
							if (m.idleTimer != null) { clearTimeout(m.idleTimer); m.idleTimer = null; }
							if (qlen === 0) this.finishCard(m);
						}
					} else {
						m.idleSince = 0;
					}
				}
			},
			clearTimers(m) {
				if (m.interactionTimer != null) { clearTimeout(m.interactionTimer); m.interactionTimer = null; }
				if (m.idleTimer != null) { clearTimeout(m.idleTimer); m.idleTimer = null; }
			},
			async finishCard(m) {
				this.clearTimers(m);
				m.graceUntil = 0;
				if (m.cardId) {
					const card = findCard(m.cardId);
					if (card && card.status !== "done") updateCard(m.cardId, { status: "done" });
				}
				m.cardId = null;
				m.state = "idle";
				await this.advance(m);
			},
			feedAll(statusBySession) {
				for (const [sid, status] of statusBySession) this.onStatus(sid, status);
			},
		};
		//#endregion


		//#region turn-watch (manual dispatch completion)
		const WATCH_MIN_AGE_MS = 2000;
		const WATCH_FAST_TURN_MS = 15000;
		const WATCH_IDLE_GRACE_MS = 3000;
		const WATCH_GONE_MS = 45000;
		const watcher = {
			// cardId -> { sawRunning, idleSince, idleTimer }
			state: new Map(),
			candidates() {
				const out = [];
				for (const c of store.state.cards) {
					if (c.status !== "queued" && c.status !== "running") continue;
					if (!c.sessionId || !c.lastDispatch || c.lastDispatch.outcome !== "accepted") continue;
					let owned = false;
					for (const m of sequencer.machines.values()) {
						if (m.cardId === c.id) { owned = true; break; }
					}
					if (!owned) out.push(c);
				}
				return out;
			},
			feed(statusBySession) {
				this.evaluate(statusBySession || env.statusBySession || new Map());
			},
			tick() {
				this.evaluate(env.statusBySession || new Map());
			},
			evaluate(statusBySession) {
				const alive = this.candidates();
				const aliveIds = new Set(alive.map((c) => c.id));
				for (const id of Array.from(this.state.keys())) {
					if (aliveIds.has(id)) continue;
					const s = this.state.get(id);
					if (s && s.idleTimer != null) clearTimeout(s.idleTimer);
					this.state.delete(id);
				}
				for (const card of alive) {
					const st = statusBySession.get(card.sessionId);
					const running = !!(st && st.running);
					const age = Date.now() - Date.parse(card.lastDispatch.at || 0);
					if (!(age >= WATCH_MIN_AGE_MS)) continue;
					let s = this.state.get(card.id);
					if (!s) { s = { sawRunning: false, idleSince: 0, idleTimer: null }; this.state.set(card.id, s); }
					if (running) {
						s.sawRunning = true;
						s.idleSince = 0;
						if (s.idleTimer != null) { clearTimeout(s.idleTimer); s.idleTimer = null; }
						if (card.status === "queued") updateCard(card.id, { status: "running" });
						continue;
					}
					if (!env.sessionIds.has(card.sessionId)) {
						// session vanished: give it a grace window, then fail the card
						if (age >= WATCH_GONE_MS) this.finish(card.id);
						continue;
					}
					const qlen = probeQueueLen(card.sessionId);
					if (qlen !== undefined && qlen > 0) {
						if (s.idleTimer != null) { clearTimeout(s.idleTimer); s.idleTimer = null; }
						s.idleSince = 0;
						continue;
					}
					if (qlen === undefined) {
						if (!s.idleSince) {
							s.idleSince = Date.now();
							const armedId = card.id;
							s.idleTimer = setTimeout(() => {
								s.idleTimer = null;
								s.idleSince = 0;
								if (watcher.state.get(armedId) !== s) return;
								const cur = findCard(armedId);
								if (!cur) return;
								const age2 = Date.now() - Date.parse((cur.lastDispatch && cur.lastDispatch.at) || 0);
								if (!s.sawRunning && !(age2 >= WATCH_FAST_TURN_MS)) return;
								watcher.finish(armedId);
							}, WATCH_IDLE_GRACE_MS);
						}
						continue;
					}
					// never observed running: require a full fast-turn window before finishing
					if (!s.sawRunning && age < WATCH_FAST_TURN_MS) continue;
					this.state.delete(card.id);
					this.finish(card.id);
				}
			},
			finish(cardId) {
				const card = findCard(cardId);
				if (!card || (card.status !== "queued" && card.status !== "running")) return;
				updateCard(cardId, { status: "done" });
			},
		};
		//#endregion

		//#region ui-shared
		function classList() {
			return Array.prototype.slice.call(arguments).filter(Boolean).join(" ");
		}

		function fmtWhen(iso) {
			try {
				const d = new Date(iso);
				if (Number.isNaN(d.getTime())) return "";
				return d.toLocaleString();
			} catch (_) {
				return "";
			}
		}

		/** Interpolate {name} placeholders in a dictionary entry (host t() may or may
		 *  not bind params; we interpolate locally so badges render either way). */
		function interpolate(template, params) {
			if (params === undefined || params === null) return template;
			return template.replace(/\{([A-Za-z0-9_]+)\}/g, (whole, key) => (
				Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : whole
			));
		}

		//#endregion

		//#region engine
		/** Live Engine mounts; the heartbeat keeps running while at least one panel is mounted. */
		let engineMounts = 0;
		/** Stable no-op selector hook stand-in (keeps hook call order unconditional). */
		const NO_HOOK = (sel) => (typeof sel === "function" ? sel(undefined) : undefined);

		function Engine(props) {
			const useSessions = props.useSessions || NO_HOOK;
			const useWorkspaces = props.useWorkspaces || NO_HOOK;
			const useSessionStatus = props.useSessionStatus || NO_HOOK;
			const usePanelInfo = props.usePanelInfo || NO_HOOK;

			const ids = useSessions((s) => (s ? s.ids : undefined));
			const byId = useSessions((s) => (s ? s.byId : undefined));
			const current = useSessions((s) => (s ? s.current : undefined));
			// Every session's todos, not just the main view's: a card may belong to a panel
			// session or to another session entirely, and its status must follow that
			// session's todos. The Map is identity-cached per snapshot and captureTodos
			// de-dupes by signature, so the extra passes create no duplicate cards.
			const todosBySession = useSessions(todosBySessionOf);
			// switching the session in the main view re-runs the sync, so the newly current
			// session materialises its own cards right away
			const mainViewSid = useSessions(mainViewSessionOf) || null;
			const wsSnap = useWorkspaces((s) => s);
			const statusSnap = useSessionStatus((s) => s);

			const ctxRef = useRef(null);
			if (ctxRef.current == null && props.ctx) ctxRef.current = props.ctx;
			env.ctx = ctxRef.current;

			useEffect(() => {
				const arr = Array.isArray(ids) ? ids : [];
				env.sessionIds = new Set(arr.filter((x) => typeof x === "string"));
			}, [ids]);
			useEffect(() => {
				const rec = asRecord(byId);
				if (rec == null) return;
				const titles = new Map();
				const queueLens = new Map();
				const cwds = new Map();
				let mainViewSession = null;
				for (const [sid, rowRaw] of Object.entries(rec)) {
					const row = asRecord(rowRaw);
					if (row == null) continue;
					const title = typeof row.title === "string" ? row.title : typeof row.displayTitle === "string" ? row.displayTitle : "";
					if (title) titles.set(sid, title);
					const inputState = asRecord(row.inputState);
					const inbox = asRecord(row.inbox);
					const queueRaw = Array.isArray(inputState && inputState.queue) ? inputState.queue
						: Array.isArray(inbox && inbox.queue) ? inbox.queue
							: Array.isArray(row.queue) ? row.queue : null;
					if (queueRaw != null) queueLens.set(sid, queueRaw.length);
					// session cwd resolves workspaces for sessions the workspace store does
					// not list (sub-sessions, brand-new sessions)
					const pv = asRecord(row.projectionValues);
					const cwd = typeof row.cwd === "string" && row.cwd ? row.cwd
						: pv != null && typeof pv.workingDirectory === "string" ? pv.workingDirectory : "";
					if (cwd) cwds.set(sid, cwd);
					// root-scope store has no state.current: the session retained by the
					// main view IS the current session ({"mainView":1} refcount marker)
					const retainedBy = asRecord(row.retainedBy);
					if (mainViewSession == null && retainedBy && Number(retainedBy.mainView) > 0) mainViewSession = sid;
				}
				env.sessionTitles = titles;
				env.queueLenBySession = queueLens;
				env.sessionCwd = cwds;
				if (mainViewSession != null) env.currentSessionId = mainViewSession;
			}, [byId]);
			useEffect(() => {
				// 0.2.x snapshots have no `current`: never clobber the byId-derived value
				if (typeof current === "string" && current) env.currentSessionId = current;
			}, [current]);
			useEffect(() => {
				env.workspaces = extractWorkspaces(wsSnap);
			}, [wsSnap]);
			// Session-notice projection (host tool taskcard_notify): materialise one card per
			// notice with the target session preset; ids are recorded so reloads never duplicate.
			useEffect(() => {
				const rec = asRecord(byId);
				if (rec == null) return;
				const seen = new Set(Array.isArray(store.state.noticeSeen) ? store.state.noticeSeen : []);
				const pending = [];
				for (const [sourceSid, rowRaw] of Object.entries(rec)) {
					const row = asRecord(rowRaw);
					if (row == null) continue;
					const pv = asRecord(row.projectionValues);
					const bag = pv != null ? asRecord(pv.taskcards) : null;
					const notices = bag != null && Array.isArray(bag.notices) ? bag.notices : null;
					if (notices == null) continue;
					for (const noticeRaw of notices) {
						const notice = asRecord(noticeRaw);
						if (notice == null || typeof notice.id !== "string" || seen.has(notice.id)) continue;
						seen.add(notice.id);
						pending.push({ notice, sourceSid });
					}
				}
				if (pending.length === 0) return;
				store.mutate((st) => ({ ...st, noticeSeen: [...(Array.isArray(st.noticeSeen) ? st.noticeSeen : []), ...pending.map((p) => p.notice.id)].slice(-NOTICE_SEEN_LIMIT) }));
				for (const { notice, sourceSid } of pending) {
					// Replay hardening (belt-and-braces over the seen-id window): a notice id
					// that already exists as a live or archived notify card must never produce
					// a second uuid card. The id above was already recorded into noticeSeen.
					const diffKey = "notify:" + notice.id;
					if (store.state.cards.some((c) => c.diffKey === diffKey)
						|| store.state.archived.some((c) => c.diffKey === diffKey)) continue;
					const content = textOf(notice.content).slice(0, 4000);
					const target = textOf(notice.target).slice(0, 200);
					// same workspace first: session titles may repeat across workspaces
					const resolved = resolveSessionRef(target, workspaceOf(sourceSid));
					if (resolved != null) {
						const created = addCard({
							title: content,
							prompt: content,
							source: "agent-notify",
							sessionId: resolved,
							workspaceId: workspaceOf(resolved) || undefined,
							// 建卡来源 = 投影来源会话（发起通知的会话），而非目标会话
							createdBy: sourceSid,
							inSeqRun: false,
							diffKey,
						});
						if (created) pushToast("ok", "toastNoticeCard");
						else pushToast("error", "limitCards");
					} else {
						// 复合 target 里工作区已唯一命中、会话没解析出来：未绑定卡带上该工作区，
						// 用户可在「修改」里直接选这个工作区的会话，或走「执行时新建会话」。
						// sessionId 仍然留空 —— 宁可让用户选，也不猜一个会话绑上去。
						const wsHint = compositeWorkspaceOf(target);
						const cardDraft = {
							title: "→ " + target + "：" + content,
							prompt: content,
							source: "agent-notify",
							createdBy: sourceSid,
							inSeqRun: false,
							diffKey,
						};
						if (wsHint != null) cardDraft.workspaceId = wsHint.workspaceId;
						const created = addCard(cardDraft);
						if (created) pushToast("error", "toastNoticeTarget", target);
						else pushToast("error", "limitCards");
					}
				}
			}, [byId, wsSnap]);
			// Session-deletion projection (host tool taskcard_delete): every unseen entry
			// removes the addressed card from BOTH the live list and archived history, so a
			// deletion survives reload and the card never resurfaces. Entries are deduped by a
			// stable fingerprint in store.state.deletionSeen (bounded), so replaying the same
			// log never removes a card twice. id entries address notice cards (diffKey
			// "notify:<id>"); content entries address captured todo cards (diffKey
			// "<sessionId>:<normText(content)>").
			useEffect(() => {
				const rec = asRecord(byId);
				if (rec == null) return;
				const seen = new Set(Array.isArray(store.state.deletionSeen) ? store.state.deletionSeen : []);
				const pending = [];
				for (const rowRaw of Object.values(rec)) {
					const row = asRecord(rowRaw);
					if (row == null) continue;
					const pv = asRecord(row.projectionValues);
					const bag = pv != null ? asRecord(pv.taskcards) : null;
					// tolerate all three projection shapes: null (pre-projection),
					// { notices } (stateVersion 1) and { notices, deletions } (version 2)
					const deletions = bag != null && Array.isArray(bag.deletions) ? bag.deletions : null;
					if (deletions == null) continue;
					for (const dRaw of deletions) {
						const d = asRecord(dRaw);
						if (d == null) continue;
						// the unit-separator (\u001f) keeps concatenated fingerprint fields
						// unambiguous without needing to escape their contents
						if (d.kind === "id") {
							if (typeof d.id !== "string" || d.id === "") continue;
							const fingerprint = "id\u001f" + d.id;
							if (seen.has(fingerprint) || pending.some((p) => p.fingerprint === fingerprint)) continue;
							pending.push({ targetKey: "notify:" + d.id, fingerprint });
						} else if (d.kind === "content") {
							if (typeof d.sessionId !== "string" || d.sessionId === "") continue;
							const norm = normText(d.content);
							if (!norm) continue;
							const fingerprint = "content\u001f" + d.sessionId + "\u001f" + norm;
							if (seen.has(fingerprint) || pending.some((p) => p.fingerprint === fingerprint)) continue;
							pending.push({ targetKey: d.sessionId + ":" + norm, fingerprint });
						}
					}
				}
				if (pending.length === 0) return;
				// Resolve hits BEFORE mutating: only a removal that matched a card toasts;
				// an unseen deletion that matches nothing is still recorded, silently.
				let hitCount = 0;
				for (const p of pending) {
					if (store.state.cards.some((c) => c.diffKey === p.targetKey)
						|| store.state.archived.some((c) => c.diffKey === p.targetKey)) {
						p.hit = true;
						hitCount++;
					}
				}
				// One mutate for the whole batch; untouched cards keep their object references.
				// deletionSeen is recorded for every entry, hit or miss, bounded to 50 (freshest).
				store.mutate((st) => {
					const targetKeys = new Set(pending.map((p) => p.targetKey));
					const cards = st.cards.filter((c) => !targetKeys.has(c.diffKey));
					const archived = st.archived.filter((c) => !targetKeys.has(c.diffKey));
					const deletionSeen = [
						...(Array.isArray(st.deletionSeen) ? st.deletionSeen : []),
						...pending.map((p) => p.fingerprint),
					].slice(-50);
					return { ...st, cards, archived, deletionSeen };
				});
				// one toast per actually removed card; misses stay silent (see comment above)
				for (let i = 0; i < hitCount; i++) pushToast("ok", "toastTaskDeleted");
			}, [byId, wsSnap]);
			useEffect(() => {
				const map = todosBySession;
				const currentSid = env.currentSessionId;
				if (map == null || typeof map.forEach !== "function") return;
				map.forEach((todos, sid) => captureTodos(sid, todos, { create: sid === currentSid }));
				// main-view session whose row has no todos projection at all: an emptied list
				// must still age its cards out (pre-0.1.3 kept this single-session pass)
				if (currentSid != null && !map.has(currentSid)) captureTodos(currentSid, [], { create: true });
			}, [todosBySession, mainViewSid, current]);
			useEffect(() => {
				const map = new Map();
				const snap = statusSnap;
				if (snap instanceof Map) {
					for (const [k, v] of snap) map.set(k, v);
				} else if (asRecord(snap) != null) {
					for (const [k, v] of Object.entries(snap)) {
						if (typeof k === "string") map.set(k, v);
					}
				}
				env.statusBySession = map;
				sequencer.feedAll(map);
				watcher.feed(map);
			}, [statusSnap]);
			useEffect(() => {
				engineMounts += 1;
				scheduler.start();
				sequencer.wake();
				return () => {
					engineMounts = Math.max(0, engineMounts - 1);
					if (engineMounts === 0) scheduler.stop();
				};
			}, []);
			useEffect(() => {
				const onStorage = (e) => {
					if (e.key === STORAGE_KEY && e.newValue) {
						try {
							const next = JSON.parse(e.newValue);
							if (JSON.stringify(next) !== JSON.stringify(store.state)) {
								store.state = coerceState(next);
								store.emit();
								// 远端状态覆盖本地后，顺序执行与在途批次立即停止
								sequencer.halt();
							}
						} catch (_) { /* ignore */ }
					}
				};
				window.addEventListener("storage", onStorage);
				return () => window.removeEventListener("storage", onStorage);
			}, []);

			return null;
		}
		//#endregion

		//#region pin-button
		function PinButton(props) {
			const t = typeof props.t === "function" ? props.t : (k) => k;
			const sessionId = typeof props.sessionId === "string" ? props.sessionId : undefined;
			const useSessions = props.useSessions;
			const current = useSessions ? useSessions(mainViewSessionOf) : undefined;
			const sid = sessionId || (typeof current === "string" ? current : undefined) || env.currentSessionId || undefined;
			const [busy, setBusy] = useState(false);

			const onClick = useCallback((e) => {
				e.preventDefault();
				e.stopPropagation();
				if (busy) return;
				let text = "";
				try {
					const root = e.currentTarget && e.currentTarget.closest
						? e.currentTarget.closest('[data-composer-seat],[class*="composer"],form')
						: null;
					const el = root
						? root.querySelector('[contenteditable="true"],textarea')
						: null;
					text = el ? String(el.value != null ? el.value : el.innerText || "") : "";
				} catch (_) {
					text = "";
				}
				text = text.replace(/\u200b/g, "").trim();
				if (!text) {
					pushToast("error", "toastDraftEmpty");
					return;
				}
				setBusy(true);
				try {
					const ws = sid ? workspaceOf(sid) || undefined : undefined;
					const card = addCard({ title: text, prompt: text, source: "composer-pinned", sessionId: sid, workspaceId: ws, createdBy: env.currentSessionId });
					if (card) pushToast("ok", "toastCardAdded");
					else pushToast("error", "limitCards");
				} finally {
					setBusy(false);
				}
			}, [busy, sid]);

			return h("button", {
				type: "button",
				className: "tkc-pin-btn",
				title: t("pinTitle"),
				onClick,
				disabled: busy,
			}, t("pinLabel"));
		}
		//#endregion

		//#region param-panel
		function toLocalInput(iso) {
			try {
				const d = new Date(iso);
				if (Number.isNaN(d.getTime())) return "";
				const pad = (n) => String(n).padStart(2, "0");
				return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
			} catch (_) {
				return "";
			}
		}

		function fromLocalInput(v) {
			try {
				const d = new Date(v);
				if (Number.isNaN(d.getTime())) return null;
				return d.toISOString();
			} catch (_) {
				return null;
			}
		}

		function quickTime(ms) {
			return toLocalInput(new Date(Date.now() + ms).toISOString());
		}

		function tomorrowNine() {
			const d = new Date();
			d.setDate(d.getDate() + 1);
			d.setHours(9, 0, 0, 0);
			return toLocalInput(d.toISOString());
		}

		function ParamPanel(props) {
			const { card, t, onClose } = props;
			const editable = card.status === "pending";
			const [wsId, setWsId] = useState(card.workspaceId || "");
			const [sesId, setSesId] = useState(card.sessionId || "");
			const [when, setWhen] = useState(card.schedule && card.schedule.at ? toLocalInput(card.schedule.at) : "");
			const [inSeq, setInSeq] = useState(card.inSeqRun !== false);

			const wsSessions = useMemo(() => {
				if (!wsId) return [];
				const w = env.workspaces.find((x) => x.workspaceId === wsId);
				return w ? w.sessionIds : [];
			}, [wsId]);

			const save = () => {
				const patch = {};
				if (editable) {
					if (wsId) patch.workspaceId = wsId; else patch.workspaceId = undefined;
					if (sesId) patch.sessionId = sesId; else patch.sessionId = undefined;
					patch.inSeqRun = !!inSeq;
				}
				if (when) {
					if (!wsId && !sesId) {
						pushToast("error", "toastNoWorkspace");
						return;
					}
					if (sesId && !env.sessionIds.has(sesId)) {
						pushToast("error", "toastSessionGone");
						return;
					}
					const iso = fromLocalInput(when);
					if (!iso) {
						pushToast("error", "toastBadTime");
						return;
					}
					patch.schedule = { kind: "once", at: iso };
				} else {
					patch.schedule = null;
				}
				updateCard(card.id, patch);
				onClose(true);
			};

			return hs("div", { className: "tkc-param", role: "dialog", "aria-label": t("paramTitle") }, [
				h("div", { className: "tkc-param-head" }, h("span", {}, t("paramTitle"))),
				hs("label", { className: "tkc-param-row" }, [
					h("span", { className: "tkc-param-label" }, t("paramWorkspace")),
					hs("select", {
						value: wsId,
						disabled: !editable,
						onChange: (e) => { setWsId(e.target.value); setSesId(""); },
					}, [
						h("option", { value: "" }, t("paramNone")),
						...env.workspaces.map((w) => h("option", { key: w.workspaceId, value: w.workspaceId, title: w.path }, w.title)),
					]),
				]),
				hs("label", { className: "tkc-param-row" }, [
					h("span", { className: "tkc-param-label" }, t("paramSession")),
					hs("select", {
						value: sesId,
						disabled: !editable,
						onChange: (e) => setSesId(e.target.value),
					}, [
						h("option", { value: "" }, t("paramSessionNew")),
						...wsSessions.filter((sid) => env.sessionIds.has(sid)).map((sid) => h("option", { key: sid, value: sid }, sessionTitle(sid) || sid.slice(0, 8))),
					]),
				]),
				hs("label", { className: "tkc-param-row" }, [
					h("span", { className: "tkc-param-label" }, t("paramSchedule")),
					h("input", {
						type: "datetime-local",
						value: when,
						onChange: (e) => setWhen(e.target.value),
					}),
				]),
				h("div", { className: "tkc-param-quick" }, [
					h("button", { type: "button", key: "q30", onClick: () => setWhen(quickTime(30 * 60 * 1000)) }, t("paramQuick30m")),
					h("button", { type: "button", key: "q1h", onClick: () => setWhen(quickTime(60 * 60 * 1000)) }, t("paramQuick1h")),
					h("button", { type: "button", key: "t9", onClick: () => setWhen(tomorrowNine()) }, t("paramTomorrow9")),
					h("button", { type: "button", key: "clr", onClick: () => setWhen("") }, t("paramScheduleClear")),
				]),
				hs("label", { className: "tkc-param-row" }, [
					h("span", { className: "tkc-param-label" }, t("paramInSeq")),
					h("input", { type: "checkbox", checked: inSeq, disabled: !editable, onChange: (e) => setInSeq(e.target.checked) }),
				]),
				editable ? null : h("div", { className: "tkc-param-locked" }, t("paramTargetLocked")),
				h("div", { className: "tkc-param-actions" }, [
					h("button", { type: "button", key: "ok", className: "tkc-btn-primary", onClick: save }, t("btnSave")),
					h("button", { type: "button", key: "no", onClick: () => onClose(false) }, t("btnCancel")),
				]),
			]);
		}
		//#endregion

		//#region card-row
		const STATUS_CLASS = {
			pending: "tkc-dot-pending",
			queued: "tkc-dot-queued",
			running: "tkc-dot-running",
			done: "tkc-dot-done",
			failed: "tkc-dot-failed",
			cancelled: "tkc-dot-cancelled",
			stale: "tkc-dot-stale",
		};

		function CardRow(props) {
			const { card, index, t, onModify, onDelete } = props;
			const [editing, setEditing] = useState(false);
			const [title, setTitle] = useState(card.title);
			const [prompt, setPrompt] = useState(card.prompt);
			const [dragOver, setDragOver] = useState(false);
			const [busy, setBusy] = useState(false);

			const ws = card.workspaceId ? workspaceTitle(card.workspaceId) : null;
			const wsGone = card.workspaceId && !ws;
			const ses = card.sessionId ? sessionTitle(card.sessionId) : null;
			// 建卡来源：createdBy 是持久化的建卡会话；旧 agent-todo 卡无该字段时用其
			// 所属 sessionId 兜底；其它来源（通知卡等）缺字段则不显示，避免「未知」噪音。
			let creatorSid = typeof card.createdBy === "string" && card.createdBy
				? card.createdBy
				: (card.source === "agent-todo" && card.sessionId ? card.sessionId : null);
			const creatorTitle = creatorSid ? (sessionTitle(creatorSid) || creatorSid.slice(0, 8)) : null;
			const creatorTip = creatorSid
				? interpolate(t("creatorBadgeTitle"), { id: creatorSid, time: fmtWhen(card.createdAt) })
				: null;

			const openSession = () => {
				if (!card.sessionId) return;
				const uiw = uiWs();
				if (!uiw || typeof uiw.openSession !== "function") {
					pushToast("error", "toastNoService");
					return;
				}
				try { uiw.openSession(card.sessionId); } catch (_) {
					try { uiw.openSession({ sessionId: card.sessionId }); } catch (e) {
						pushToast("error", "toastNoService");
					}
				}
			};

			const run = async () => {
				if (busy) return;
				setBusy(true);
				try {
					await dispatchRun(card.id, { source: "manual" });
				} finally {
					setBusy(false);
				}
			};

			if (editing) {
				return hs("div", { className: "tkc-card tkc-card-editing" }, [
					h("input", {
						key: "t",
						className: "tkc-edit-title",
						value: title,
						onChange: (e) => setTitle(e.target.value),
						placeholder: t("editTitle"),
					}),
					h("textarea", {
						key: "p",
						className: "tkc-edit-prompt",
						value: prompt,
						onChange: (e) => setPrompt(e.target.value),
						placeholder: t("editPrompt"),
						rows: 3,
					}),
					h("div", { className: "tkc-card-actions" }, [
						h("button", {
							type: "button",
							key: "s",
							className: "tkc-btn-primary",
							onClick: () => {
								if (!title.trim()) return;
								updateCard(card.id, { title: title.trim(), prompt: prompt.trim() || title.trim() });
								setEditing(false);
							},
						}, t("btnSave")),
						h("button", {
							type: "button",
							key: "c",
							onClick: () => { setTitle(card.title); setPrompt(card.prompt); setEditing(false); },
						}, t("btnCancel")),
					]),
				]);
			}

			return hs("div", {
				className: classList("tkc-card", dragOver && "tkc-card-dragover"),
				draggable: true,
				onDragStart: (e) => { e.dataTransfer.setData("text/tkc-id", card.id); },
				onDragOver: (e) => { e.preventDefault(); setDragOver(true); },
				onDragLeave: () => setDragOver(false),
				onDrop: (e) => {
					e.preventDefault();
					setDragOver(false);
					const id = e.dataTransfer.getData("text/tkc-id");
					if (id && id !== card.id) reorderCards(id, index);
				},
			}, [
				hs("div", { key: "main", className: "tkc-card-main" }, [
					h("span", { className: classList("tkc-dot", STATUS_CLASS[card.status] || "tkc-dot-pending"), title: t("status." + card.status) }),
					h("span", { className: "tkc-card-title", title: card.prompt }, card.title),
					card.schedule ? h("span", { className: "tkc-when", title: card.schedule.at }, "⏰ " + fmtWhen(card.schedule.at)) : null,
				]),
				hs("div", { key: "badges", className: "tkc-card-badges" }, [
					wsGone
						? h("span", { key: "wg", className: "tkc-badge tkc-badge-warn", title: t("wsGoneHint") }, "⚠ " + t("wsGone"))
						: ws
							? h("span", { key: "ws", className: "tkc-badge", title: ws.path || ws.title }, ws.title)
							: h("span", { key: "wm", className: "tkc-badge tkc-badge-warn" }, "⚠ " + t("wsMissing")),
					card.sessionId
						? h("button", { type: "button", key: "ses", className: "tkc-badge tkc-badge-btn", title: ses || card.sessionId, onClick: openSession }, ses ? ses.slice(0, 18) : card.sessionId.slice(0, 10))
						: h("span", { key: "sn", className: "tkc-badge tkc-badge-new" }, t("sessionNew")),
					creatorSid
						? h("span", {
							key: "cb",
							className: "tkc-badge tkc-badge-creator",
							title: creatorTip,
						}, interpolate(t("creatorBadge"), { title: creatorTitle }))
						: null,
					h("span", { key: "src", className: "tkc-src" }, t("src." + card.source)),
				]),
				hs("div", { key: "act", className: "tkc-card-actions" }, [
					h("button", { type: "button", key: "e", onClick: () => setEditing(true) }, t("btnEdit")),
					h("button", { type: "button", key: "m", onClick: () => onModify(card) }, t("btnModify")),
					h("button", { type: "button", key: "r", className: "tkc-btn-primary", disabled: busy || card.status === "queued" || card.status === "running", onClick: run }, t("btnRun")),
					h("span", { key: "o", className: "tkc-order-ctl" }, [
						h("button", { type: "button", key: "u", title: t("btnUp"), onClick: () => nudgeOrder(card.id, -1) }, "↑"),
						h("button", { type: "button", key: "d", title: t("btnDown"), onClick: () => nudgeOrder(card.id, 1) }, "↓"),
					]),
					h("button", { type: "button", key: "x", className: "tkc-card-del", title: t("btnDelete"), onClick: () => onDelete && onDelete(card.id) }, "✕"),
				]),
			]);
		}
		//#endregion

		//#region sidebar-tab
		/** Right-sidebar tab body: the task-card workbench embedded in the official panel. */
		function TaskCardsPanel(props) {
			const t = typeof props.t === "function" ? props.t : (k) => k;
			const state = useStore();
			const useSessions = props.useSessions;
			const useWorkspaces = props.useWorkspaces;
			const useSessionStatus = props.useSessionStatus;
			// The tab is session-scoped: cards created here default to that session.
			const tabSessionId = typeof props.sessionId === "string" ? props.sessionId : null;
			const targetSession = () => tabSessionId || env.currentSessionId || undefined;
			const [draft, setDraft] = useState("");
			const composingRef = useRef(false);
			const [modifyCard, setModifyCard] = useState(null);
			const [toastTick, setToastTick] = useState(0);

			useEffect(() => {
				const fn = () => setToastTick((x) => x + 1);
				env.toastListeners.add(fn);
				return () => env.toastListeners.delete(fn);
			}, []);

			const addFromDraft = () => {
				const text = draft.trim();
				if (!text) return;
				const sid = targetSession();
				const ws = sid ? workspaceOf(sid) || undefined : undefined;
				let immediate = false;
				let body = text;
				if (body.startsWith("!")) {
					immediate = true;
					body = body.slice(1).trim();
				}
				if (!body) return;
				const card = addCard({ title: body, prompt: body, source: "panel-input", sessionId: sid, workspaceId: ws, createdBy: env.currentSessionId, immediate });
				if (!card) {
					pushToast("error", "limitCards");
					return;
				}
				pushToast("ok", "toastCardAdded");
				setDraft("");
				if (immediate) dispatchRun(card.id, { source: "manual" });
			};

			const onDraftKey = (e) => {
				if (e.key === "Enter" && !e.shiftKey && !composingRef.current) {
					e.preventDefault();
					addFromDraft();
				}
			};

			const onDraftPaste = (e) => {
				try {
					const text = e.clipboardData && e.clipboardData.getData ? e.clipboardData.getData("text/plain") : "";
					if (text && text.split(/\r?\n/).filter((l) => l.trim()).length > 1) {
						e.preventDefault();
						const sid = targetSession();
						const ws = sid ? workspaceOf(sid) || undefined : undefined;
						let n = 0;
						for (const line of text.split(/\r?\n/)) {
							const body = line.trim().replace(/^!/, "");
							if (!body) continue;
							if (addCard({ title: body, prompt: body, source: "panel-input", sessionId: sid, workspaceId: ws, createdBy: env.currentSessionId })) n++;
						}
						if (n > 0) pushToast("ok", "toastCardAdded");
					}
				} catch (_) { /* keep default */ }
			};

			const pendingCount = state.cards.filter((c) => c.status === "pending").length;
			const sortedCards = useMemo(() => [...state.cards].sort((a, b) => a.order - b.order), [state.cards]);
			const history = useMemo(() => state.archived.slice(-HISTORY_SHOW).reverse(), [state.archived]);
			const activeMachines = useMemo(() => {
				let n = 0;
				for (const m of sequencer.machines.values()) if (m.state !== "idle" && m.state !== "stopped") n++;
				return n;
			}, [toastTick, state.seqMode, state.cards]);

			return h("div", { className: "tkc-panel" }, [
				h(Engine, { key: "engine", useSessions: useSessions, useWorkspaces: useWorkspaces, useSessionStatus: useSessionStatus, usePanelInfo: props.usePanelInfo, ctx: props.ctx }),
				hs("div", { key: "head", className: "tkc-head" }, [
					h("span", { key: "title", className: "tkc-head-title" }, t("drawerTitle")),
					hs("button", {
						key: "seq",
						type: "button",
						className: classList("tkc-seq-btn", state.seqMode && "tkc-seq-on"),
						title: t("seqHint"),
						onClick: () => sequencer.setEnabled(!state.seqMode),
					}, [
						h("span", { key: "g", className: "tkc-seq-glyph" }, "⛓"),
						h("span", { key: "l" }, state.seqMode ? t("seqOn") : t("seqOff")),
						state.seqMode && activeMachines > 0 ? h("span", { key: "c", className: "tkc-seq-count" }, String(activeMachines)) : null,
					]),
					h("span", { key: "count", className: "tkc-head-count" }, String(pendingCount)),
				]),
				hs("div", { key: "input", className: "tkc-input-row" }, [
					h("input", {
						key: "field",
						className: "tkc-input",
						value: draft,
						placeholder: t("inputPlaceholder"),
						onChange: (e) => setDraft(e.target.value),
						onKeyDown: onDraftKey,
						onPaste: onDraftPaste,
						onCompositionStart: () => { composingRef.current = true; },
						onCompositionEnd: () => { composingRef.current = false; },
					}),
					h("button", { key: "add", type: "button", className: "tkc-btn-primary", onClick: addFromDraft }, t("addCard")),
				]),
				h("div", { key: "list", className: "tkc-list" }, sortedCards.length === 0
					? h("div", { className: "tkc-empty" }, t("empty"))
					: sortedCards.map((c, i) => h(CardRow, {
						key: c.id,
						card: c,
						index: i,
						t: t,
						onModify: (card) => setModifyCard(card),
						onDelete: deleteCardFlow,
					}))),
				hs("div", { key: "history", className: "tkc-history" }, [
					h("button", {
						key: "toggle",
						type: "button",
						className: "tkc-history-toggle",
						onClick: () => store.mutate((st) => ({ ...st, ui: { ...st.ui, historyOpen: !st.ui.historyOpen } })),
					}, (state.ui.historyOpen ? "▾ " : "▸ ") + t("historyTitle") + " (" + state.archived.length + ")"),
					state.ui.historyOpen ? h("div", { key: "list", className: "tkc-history-list" }, history.length === 0
						? h("div", { className: "tkc-empty" }, t("historyEmpty"))
						: history.map((c) => hs("div", { className: "tkc-hist-row", key: c.id }, [
							h("span", { key: "d", className: classList("tkc-dot", STATUS_CLASS[c.status] || "tkc-dot-pending") }),
							h("span", { key: "t", className: "tkc-hist-title", title: c.title }, c.title),
							h("button", { type: "button", key: "r", onClick: () => restoreCard(c.id) }, t("btnRestore")),
							h("button", { type: "button", key: "p", onClick: () => purgeCard(c.id) }, t("btnPurge")),
						]))) : null,
				]),
				modifyCard ? h("div", { key: "modal", className: "tkc-modal-mask", onClick: () => setModifyCard(null) },
					h("div", { onClick: (e) => e.stopPropagation() }, h(ParamPanel, { card: modifyCard, t: t, onClose: () => setModifyCard(null) }))) : null,
				env.toasts.length > 0 ? h("div", { key: "toasts", className: "tkc-toasts" }, env.toasts.map((x) =>
					h("div", { key: x.id, className: classList("tkc-toast", x.kind === "error" && "tkc-toast-error", x.kind === "ok" && "tkc-toast-ok") },
						t(x.textKey) + (x.detail ? ": " + x.detail : "")))) : null,
			]);
		}

		/** Right-sidebar tab chip: title plus the live pending count. */
		function TaskCardsTabTitle(props) {
			const t = typeof props.t === "function" ? props.t : (k) => k;
			const state = useStore();
			let pending = 0;
			for (const c of state.cards) if (c.status === "pending") pending++;
			return h("span", { className: "tkc-tab-title", title: t("tabTitle") }, pending > 0 ? t("tabTitle") + " (" + pending + ")" : t("tabTitle"));
		}
		//#endregion

		//#region locale
		const zh = {
	drawerTitle: "待办任务",
	tabTitle: "待办任务",
	guideTitle: "待办任务",
	guideDesc: "把待办变成可派发的任务：执行、定时、顺序执行与历史",
	inputPlaceholder: "输入待办，回车创建任务；! 前缀立即执行",
	addCard: "创建任务",
	empty: "暂无待办任务",
	historyTitle: "历史",
	historyEmpty: "无历史记录",
	btnEdit: "编辑", btnModify: "修改", btnRun: "执行", btnUp: "上移", btnDown: "下移",
	btnSave: "保存", btnCancel: "取消", btnRestore: "恢复", btnPurge: "删除",
	editTitle: "标题", editPrompt: "派发指令（发给模型的内容）",
	wsMissing: "未设工作区", wsGone: "工作区不存在", wsGoneHint: "目标工作区已被删除，请重新设置",
	sessionNew: "执行时新建",
	creatorBadge: "建卡：{title}", creatorBadgeTitle: "会话：{id}｜创建：{time}",
	pinTitle: "将当前输入框文本转为待办任务（不发送）", pinLabel: "📌 转任务",
	seqOn: "顺序执行开", seqOff: "顺序执行",
	seqHint: "开启后按优先级逐张派发，前一张轮次结束后才派发下一张",
	paramTitle: "修改待办任务", paramWorkspace: "工作区", paramSession: "会话", paramNone: "（不指定）",
	paramSessionNew: "执行时新建会话", paramSchedule: "定时",
	paramQuick30m: "+30分", paramQuick1h: "+1时", paramTomorrow9: "明天9:00", paramScheduleClear: "清除定时",
	paramInSeq: "参与顺序执行", paramTargetLocked: "仅在待执行状态可修改目标",
	toastCardAdded: "已创建待办任务", toastDraftEmpty: "输入框没有可转任务的文本",
	toastNoWorkspace: "未设置工作区：请先在修改面板选择工作区",
	toastWorkspaceGone: "目标工作区已不存在，请重新设置",
	toastScheduleDead: "定时到期但目标失效，已转失败，请重新设置",
	toastDispatchFailed: "派发失败", toastNoService: "服务不可用，稍后重试",
	toastSessionGone: "原会话已失效，将改在工作区新建会话执行", toastWsHealed: "已按会话实际归属修正工作区", btnDelete: "删除", toastDeleted: "已删除待办任务", toastDeletedLive: "已删除待办任务（不影响已派发的会话）",
	toastSeqStopped: "连续失败过多，顺序执行已停止", toastBadTime: "无效的时间",
	limitCards: "活动任务已达上限（500），请先清理历史",
	"status.pending": "待执行", "status.queued": "已入列", "status.running": "运行中",
	"status.done": "已完成", "status.failed": "失败", "status.cancelled": "已取消", "status.stale": "清单已移除",
	"src.agent-todo": "来自待办清单", "src.composer-pinned": "来自输入框固定",
	"src.agent-notify": "会话通知",
	"toastNoticeCard": "已按会话通知创建待办任务",
	"toastNoticeTarget": "通知目标会话未找到，请手动指定",
	"toastTaskDeleted": "已删除待办任务",
	"src.panel-input": "手动输入", "src.import": "导入",
};

		const en = {
	drawerTitle: "Todo Tasks",
	tabTitle: "Todo Tasks",
	guideTitle: "Todo Tasks",
	guideDesc: "Turn todos into dispatchable tasks: run, schedule, sequential runs and history",
	inputPlaceholder: "Type a todo, Enter to create a task; ! prefix runs now",
	addCard: "Add",
	empty: "No todo tasks yet",
	historyTitle: "History",
	historyEmpty: "No history",
	btnEdit: "Edit", btnModify: "Modify", btnRun: "Run", btnUp: "Move up", btnDown: "Move down",
	btnSave: "Save", btnCancel: "Cancel", btnRestore: "Restore", btnPurge: "Delete",
	editTitle: "Title", editPrompt: "Dispatch prompt (sent to the model)",
	wsMissing: "No workspace", wsGone: "Workspace gone", wsGoneHint: "Target workspace was deleted; set it again",
	sessionNew: "New on run",
	creatorBadge: "by {title}", creatorBadgeTitle: "session: {id} | created: {time}",
	pinTitle: "Pin current composer draft as a todo task (does not send)", pinLabel: "📌 To task",
	seqOn: "Seq on", seqOff: "Sequential",
	seqHint: "Dispatch cards one by one in priority order; next starts after the previous turn ends",
	paramTitle: "Modify todo task", paramWorkspace: "Workspace", paramSession: "Session", paramNone: "(none)",
	paramSessionNew: "Create session on run", paramSchedule: "Schedule",
	paramQuick30m: "+30m", paramQuick1h: "+1h", paramTomorrow9: "Tomorrow 9:00", paramScheduleClear: "Clear schedule",
	paramInSeq: "Join sequential run", paramTargetLocked: "Target is editable only while pending",
	toastCardAdded: "Todo task created", toastDraftEmpty: "No draft text to pin",
	toastNoWorkspace: "No workspace set: pick one in the modify panel first",
	toastWorkspaceGone: "Target workspace no longer exists; set it again",
	toastScheduleDead: "Schedule due but target invalid; marked failed",
	toastDispatchFailed: "Dispatch failed", toastNoService: "Service unavailable, retry later",
	toastSessionGone: "Original session gone; a new session will be created in the workspace", toastWsHealed: "Workspace badge healed to the session's actual workspace", btnDelete: "Delete", toastDeleted: "Todo task deleted", toastDeletedLive: "Todo task deleted (dispatched session unaffected)",
	toastSeqStopped: "Too many consecutive failures; sequential run stopped", toastBadTime: "Invalid time",
	limitCards: "Active tasks reached the limit (500); clean history first",
	"status.pending": "Pending", "status.queued": "Queued", "status.running": "Running",
	"status.done": "Done", "status.failed": "Failed", "status.cancelled": "Cancelled", "status.stale": "Removed from list",
	"src.agent-todo": "from todo list", "src.composer-pinned": "pinned draft",
	"src.agent-notify": "session notice",
	"toastNoticeCard": "Created a todo task from a session notice",
	"toastNoticeTarget": "Target session not found; pick one manually",
	"toastTaskDeleted": "Todo task deleted",
	"src.panel-input": "typed", "src.import": "imported",
};
		//#endregion

		//#region css
		const CSS = ".tkc-head { display: flex; align-items: center; gap: 8px; padding: 12px 16px 8px 20px; }\n.tkc-head-title { font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary); flex: 1; }\n.tkc-head-count { font-size: 12px; color: var(--dsw-alias-label-tertiary); }\n.tkc-seq-btn { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; padding: 4px 8px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; }\n.tkc-seq-btn.tkc-seq-on { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }\n.tkc-seq-count { font-size: 11px; color: var(--dsw-alias-state-success-primary); }\n.tkc-input-row { display: flex; gap: 6px; padding: 0 12px 8px 18px; }\n.tkc-input { flex: 1; font-size: 13px; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }\n.tkc-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }\n.tkc-btn-primary { border: 1px solid var(--dsw-alias-brand-primary); background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-primary-inverted); border-radius: 6px; padding: 5px 10px; font-size: 12px; cursor: pointer; }\n.tkc-btn-primary:disabled { opacity: 0.5; cursor: default; }\n.tkc-list { flex: 1; overflow-y: auto; padding: 0 12px 8px 18px; }\n.tkc-list::-webkit-scrollbar { width: 8px; }\n.tkc-list::-webkit-scrollbar-thumb { background: var(--dsw-alias-scrollbar-bg-l2); border-radius: 4px; }\n.tkc-list::-webkit-scrollbar-thumb:hover { background: var(--dsw-alias-scrollbar-hover-l2); }\n.tkc-card { border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; padding: 8px 10px; margin-bottom: 8px; background: var(--dsw-alias-bg-layer-1); }\n.tkc-card:hover { border-color: var(--dsw-alias-border-l3); }\n.tkc-card-dragover { border-color: var(--dsw-alias-brand-primary); }\n.tkc-card-main { display: flex; align-items: center; gap: 8px; }\n.tkc-card-title { font-size: 13px; color: var(--dsw-alias-label-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }\n.tkc-when { font-size: 11px; color: var(--dsw-alias-label-tertiary); white-space: nowrap; }\n.tkc-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }\n.tkc-dot-pending { background: var(--dsw-alias-label-dimmed); }\n.tkc-dot-queued { background: var(--dsw-alias-brand-primary); }\n.tkc-dot-running { background: var(--dsw-alias-brand-primary); animation: tkc-pulse 1.2s infinite; }\n.tkc-dot-done { background: var(--dsw-alias-state-success-primary); }\n.tkc-dot-failed { background: var(--dsw-alias-state-error-primary); }\n.tkc-dot-cancelled { background: var(--dsw-alias-label-dimmed); opacity: 0.5; }\n.tkc-dot-stale { background: var(--dsw-alias-state-warn-primary); }\n@keyframes tkc-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }\n.tkc-card-badges { display: flex; align-items: center; gap: 6px; margin-top: 6px; flex-wrap: wrap; }\n.tkc-badge { font-size: 11px; color: var(--dsw-alias-label-secondary); border: 1px solid var(--dsw-alias-border-l2); border-radius: 4px; padding: 1px 6px; max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.tkc-badge-warn { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }\n.tkc-badge-new { color: var(--dsw-alias-label-tertiary); }\n.tkc-badge-btn { cursor: pointer; background: transparent; }\n.tkc-badge-btn:hover { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }\n.tkc-src { font-size: 10px; color: var(--dsw-alias-label-tertiary); }\n.tkc-card-actions { display: flex; align-items: center; gap: 4px; margin-top: 6px; }\n.tkc-card-actions button { font-size: 11px; padding: 3px 8px; border-radius: 4px; border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; }\n.tkc-card-actions button:hover { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }\n.tkc-card-actions button:disabled { opacity: 0.5; cursor: default; }\n.tkc-order-ctl { margin-left: auto; display: inline-flex; gap: 2px; }\n.tkc-edit-title, .tkc-edit-prompt { width: 100%; font-size: 12px; padding: 5px 6px; border-radius: 4px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); margin-bottom: 6px; box-sizing: border-box; }\n.tkc-history { border-top: 1px solid var(--dsw-alias-border-l2); padding: 6px 12px 6px 18px; }\n.tkc-history-toggle { background: transparent; border: none; color: var(--dsw-alias-label-secondary); font-size: 12px; cursor: pointer; padding: 4px 0; }\n.tkc-history-list { max-height: 140px; overflow-y: auto; }\n.tkc-hist-row { display: flex; align-items: center; gap: 6px; padding: 3px 0; }\n.tkc-hist-title { flex: 1; font-size: 12px; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.tkc-hist-row button { font-size: 11px; border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-tertiary); border-radius: 4px; padding: 2px 6px; cursor: pointer; }\n.tkc-empty { font-size: 12px; color: var(--dsw-alias-label-tertiary); padding: 12px 4px; }\n.tkc-modal-mask { position: fixed; inset: 0; background: rgba(0,0,0,0.25); display: flex; align-items: center; justify-content: center; z-index: 60; }\n.tkc-param { width: 320px; max-width: calc(100vw - 32px); border-radius: 10px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }\n.tkc-param-head { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }\n.tkc-param-row { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--dsw-alias-label-secondary); }\n.tkc-param-label { width: 48px; flex: none; }\n.tkc-param-row select, .tkc-param-row input[type=\"datetime-local\"] { flex: 1; font-size: 12px; padding: 4px 6px; border-radius: 4px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }\n.tkc-param-quick { display: flex; gap: 4px; flex-wrap: wrap; }\n.tkc-param-quick button { font-size: 11px; border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-secondary); border-radius: 4px; padding: 2px 6px; cursor: pointer; }\n.tkc-param-locked { font-size: 11px; color: var(--dsw-alias-state-warn-primary); }\n.tkc-param-actions { display: flex; justify-content: flex-end; gap: 8px; }\n.tkc-param-actions button { font-size: 12px; padding: 5px 12px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; }\n.tkc-toasts { position: absolute; left: 14px; bottom: 10px; display: flex; flex-direction: column; gap: 6px; z-index: 50; }\n.tkc-toast { font-size: 12px; padding: 6px 10px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); max-width: 280px; }\n.tkc-toast-error { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }\n.tkc-toast-ok { border-color: var(--dsw-alias-state-success-primary); }\n.tkc-pin-btn { font-size: 12px; padding: 3px 8px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; }\n.tkc-pin-btn:hover { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }\n.tkc-card-del:hover { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }\n.tkc-panel{display:flex;flex-direction:column;height:100%;min-height:0;position:relative;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;box-sizing:border-box}\n.tkc-tab-title{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:160px;display:inline-block;vertical-align:bottom}\n.tkc-head{padding:12px 12px 8px 12px}\n.tkc-list{padding:0 12px 8px 12px}\n.tkc-input-row{padding:0 12px 8px 12px}\n.tkc-history{padding:6px 12px}\n.tkc-toasts{left:12px}";
		//#endregion

		//#region apply
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "ui-taskcards: dictionaries");
			ctx.effect(() => {
				const style = document.createElement("style");
				style.setAttribute("data-plugin", "dsh-ui-taskcards");
				style.setAttribute("data-plugin-css", "dsh-ui-taskcards/taskcards.css");
				style.textContent = CSS;
				document.head.appendChild(style);
				return () => style.remove();
			}, "ui-taskcards: style");
			// Scheme B: native right-sidebar tab through the official cross-plugin faces.
			const tabs = typeof ctx.get === "function" ? ctx.get("sidebarRightTabs") : undefined;
			if (tabs != null && typeof tabs.register === "function") {
				const t = typeof ctx.locale.bind === "function" ? ctx.locale.bind(NS) : (k) => k;
				ctx.effect(() => tabs.register({
					id: TAB_TYPE_ID,
					kind: TAB_KIND,
					title: () => t("tabTitle"),
					guide: [{
						id: "taskcards",
						order: 20,
						title: () => t("guideTitle"),
						description: () => t("guideDesc"),
					}],
				}), "ui-taskcards: right-sidebar tab type");
				ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
					name: "sidebar.right.pane.tab",
					key: TAB_TYPE_ID,
					locale: NS,
					inject: () => ({ ctx }),
				}, TaskCardsPanel)), "ui-taskcards: right-sidebar tab body");
				ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab.title", () => ctx.slots.register({
					name: "sidebar.right.pane.tab.title",
					key: TAB_TYPE_ID,
					locale: NS,
				}, TaskCardsTabTitle)), "ui-taskcards: right-sidebar tab title");
			}
			try {
				ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
					name: "conversation.composer.dock",
					id: "taskcards-pin",
					order: 20,
					locale: NS,
					inject: () => ({}),
				}, PinButton));
			} catch (_) {
				// dock seat unavailable in this composition — degrade to panel-input only
			}
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
