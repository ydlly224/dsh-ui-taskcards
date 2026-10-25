# dsh-ui-taskcards

<p align="center">
  <a href="https://github.com/ydlly224/dsh-ui-taskcards"><img alt="GitHub" src="https://img.shields.io/badge/GitHub-ydlly224%2Fdsh-ui-taskcards-181717?logo=github"></a>
  <img alt="License" src="https://img.shields.io/badge/license-MIT-blue">
  <img alt="DSH" src="https://img.shields.io/badge/DSH-0.1.x%20~%200.2.x-8A2BE2">
  <a href="https://github.com/topics/dsh-plugin"><img alt="dsh-plugin" src="https://img.shields.io/badge/topic-dsh--plugin-blueviolet"></a>
</p>

<p align="center"><img src="docs/screenshot.png" width="360" alt="sidebar tab screenshot"></p>

DSH（DeepSeek Harness）Web UI 的插件（客户端 bundle + 宿主半边）：**官方右侧栏原生标签页「待办任务」**（`sidebarRightTabs` 注册类型 + `sidebar.right.pane.tab` 槽位，与「工作区文件/浏览器/终端」同一套 dock 体验：可拖拽分栏、全屏、宽度拖拽、会话级布局记忆）+ 输入框固定按钮（`conversation.composer.dock`）。

> 兼容性：DSH Web 0.1.x ~ 0.2.x（依赖官方 `sidebarRightTabs` 服务与 `sidebar.right.pane.tab` 槽位；在 0.2.1-rc.2 上验证）。纯客户端 bundle，无 npm 依赖。

## 功能

- **采集**：会话 todos 投影 diff（LCS + 相似度 ≥0.8 模糊对齐）自动转卡（source=agent-todo；仅当前会话建卡）；卡片执行状态随 todos 自动同步（`in_progress`→`running`、`completed`→`done`，已入列/运行中的卡片不会被降级回待执行），且跨会话也能同步（非当前会话只同步已有卡片状态与失效标记）；输入框 📌 按钮固定草稿转卡（composer-pinned，不发送不清草稿）；面板快捷输入建卡（panel-input，`!` 前缀立即执行，多行粘贴逐行建卡）
- **卡片**：编辑（标题/派发指令）、修改（工作区/会话/定时/顺序执行成员，仅 pending 可改目标）、执行（`sessions.prompt` mode=queue）；**回合观察器回写**（手动执行的卡：会话 running→`running`，回合结束且收件队列空→`done` 并自动归档；从未观察到 running 时需满 15s 快速回合窗口；目标会话消失 45s 后置 `failed`）；工作区/会话徽标（会话徽标点击 `uiWorkspace.openSession` 跳转）；拖拽 + ↑↓ 排序；终态自动归档（历史区可恢复/删除）
- **定时**：本地 30s 心跳调度器；设置定时时前置校验目标；到期派发后清除；补触发复用 requestId 幂等；到期目标失效即转 failed（防心跳反复拾起）；单轮心跳最多 3 张
- **顺序执行**：每会话一台状态机（idle/dispatching/waiting-running/waiting-interaction/advancing/stopped）；复合轮次结束判定（running=false 且收件队列空，队列不可探测时降级为 3s 连续空闲）；pendingInteraction 暂停 + 10s 恢复计时；批次内同工作区复用新建会话（`seqIsolatedSessions` 可切逐卡新建）；连续 3 张 blocked 即停止；顺序执行开关（⛓）默认关闭且不持久化（每次打开页面需手动开启）；由会话 todos 自动捕获的卡片默认不加入顺序执行队列，可在「修改」中显式加入；跨窗口存储同步时会立即停止本窗口在途的顺序执行批次
- **目标解析**：会话存活→直接派发+归属自愈；无会话有工作区→`sessions.create({workspaceId})` 新建并回写；否则拦截引导设置工作区
- **幂等**：write-ahead lastDispatch + requestId 单飞检查；跨窗口 storage 事件同步
- **会话通知（agent 工具）**：宿主半边注册 agent 工具 `taskcard_notify(target, content)` 与会话投影 `taskcards`。任意会话的 agent 调用该工具后，本插件自动生成一张**已预设目标会话/工作区**的待办任务卡（来源标记「会话通知」，默认不加入顺序执行），用户只需在面板点一次【执行】即把任务投递到目标会话；`target` 支持标题**模糊匹配**（精确/前缀/包含）、「工作区-会话」复合写法或会话 id 前缀/包含（**不提供反向包含**）；同名会话**优先在通知来源会话所属工作区**内解析，未命中时生成未绑定目标的卡片（可预填工作区）并提示手动指定。**该能力需要重启一次 dsh web 加载宿主半边**（客户端部分刷新页面即可）
- **入口（方案 B）**：右侧栏「+ 新标签页 → 待办任务」添加（引导入口），打开后与文件/浏览器面板同款 dock 行为；面板内创建任务默认绑定该标签页所属会话；旧的 shell.overlay 抽屉已移除

## 文件

| 文件 | 说明 |
| --- | --- |
| `package.json` | dsh.client.inject：locale / ui-conversation / ui-primitives / ui-workspace |
| `cordis.patch.yml` | bundle patch（宿主注册工具 `taskcard_notify` 与会话投影 `taskcards`） |
| `lib/index.js` | 宿主半边：注册 agent 工具 `taskcard_notify` + session projection `taskcards`（零 npm 依赖，运行时只用到 `.parse`，故用 pass-through schema） |
| `lib/client.js` | 浏览器 bundle（ModuleLoader CJS 工厂，单文件 region 分区） |

## 会话通知（agent 工具 `taskcard_notify`）

半自动跨会话投递：让某个会话的 agent 把任务「投」给另一个会话。

1. 会话 A 的 agent 调用工具：
   ```json
   { "target": "部署会话", "content": "任务A：升级 staging 并回报结果" }
   ```
   `target` 也支持模糊写法与会话 id 片段（前导 `#` 会被剥离）。

   **目标解析规则**（每层必须唯一命中，歧义自动降级；先在本工作区跑完全部层级，再跨工作区）：

   | 层 | 规则 | 示例 |
   | --- | --- | --- |
   | T1 | 标题精确（忽略大小写/首尾空白） | `部署会话` |
   | T2 | 标题前缀 | `部署` → `部署会话` |
   | T3 | 标题包含 | `部署` → `RG-部署会话（生产）` |
   | T5 | 会话 id 前缀 | `7bb53fb7` / `session-7bb5` |
   | T6 | 会话 id 包含 | `7bb537` |

   另外支持**「工作区-会话」复合写法**（分隔符可用 `-` `_` `·` 或空格，取最长工作区前缀，**切分点只能落在分隔符上**）：例如 `Centauri-主线` = 先在 `Centauri` 工作区里找「主线」会话；工作区匹配但会话找不到时**不会回退全局**，直接生成未绑定卡片（避免误绑到同名/短标题会话），并且该卡片会**预填这个工作区**——「修改」里可直接选该工作区会话，或走「执行时新建会话」。工作区标题本身含分隔符（如 `权小赚DSH- Native-发布线`）时按最长前缀切分。

   注：纯会话 id（如 `session-7bb5`）不会被当作复合引用；不含分隔符的粘连写法（如 `CentauriX-主线`）也按常规路径处理。

   注：**不提供反向包含**（`输入 ⊃ 标题`）匹配，避免短标题会话（如 `Centauri`）把 `Centauri-主线` 这类复合引用误判为命中。

   全部层都无法唯一确定时，卡片仍会创建但**不绑定目标会话**（标题带 `→ 目标：` 前缀），由你在「修改」里手动指定。
2. 【待办任务】面板自动出现一张卡片：标题/派发文本 = `content`，**执行会话/工作区已预设为 target 对应会话**，来源「会话通知」，默认不参与顺序执行。
3. 你在面板点一次【执行】→ 任务以用户消息形式投递到目标会话（queue 模式，目标忙时排队），卡片状态随后按回合观察器更新（queued → running → done）。

实现要点：工具向调用方会话 append `taskcards/notify` 事件；宿主投影 fold 成 `{ notices: [...] }`（最多 20 条）；客户端从 `projectionValues.taskcards.notices` 消费并去重（`noticeSeen` 持久化），因此刷新页面不会重复建卡。

> ⚠️ 宿主半边（`lib/index.js`）在 dsh web 启动时加载：**首次安装或升级含宿主改动的版本后，需要重启一次 dsh web**；仅客户端改动刷新页面即可。

## 安装

```bash
# 1) 安装包（本地目录或 Git 仓库；GitHub 简写亦可）
dsh plugin --profile web add file:<本插件目录>
#   或：dsh plugin --profile web add git+https://github.com/ydlly224/dsh-ui-taskcards.git
```

2) 在 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 数组里追加 `"dsh-ui-taskcards"`（pnpm 已把依赖写入 `dependencies`，注册 bundle 需手动加一行）；
3) 重启一次 dsh web，浏览器刷新后在右侧栏「+ 新标签页 → 待办任务」打开；此后仅改 `lib/client.js` 会自动 HMR 热重载。

纯客户端插件：无 npm 依赖、不发起网络请求、不写除 `localStorage["dsh.taskcards.v1"]` 之外的本机持久化。

## 自检

```
node --check lib/index.js   # 通过
node --check lib/client.js  # 通过
```

## 已知边界

- 定时触发需页面开启；关闭期间错过的到期卡下次打开补触发一次
- 轮次归因是会话级近似；用户排队消息会推迟顺序执行推进（不卡死不跳队）
- v1 单窗口约束（多窗口写冲突靠 storage 事件尽力同步）

## English

A pure client-side plugin for [DeepSeek Harness](https://github.com/deepseek-ai) Web UI: registers a **native right-sidebar tab** (`sidebarRightTabs`) — a **Todo Tasks** tab that captures session todos as durable cards with run / schedule / sequential execution and history.

- Repo: https://github.com/ydlly224/dsh-ui-taskcards
- Install: `dsh plugin --profile web add git+https://github.com/ydlly224/dsh-ui-taskcards.git`, then register the bundle name in `~/.dsh/profiles/web/package.json` → `dsh.profile.bundles`, restart dsh web and refresh.
- Extends: DSH Web 0.1.x ~ 0.2.x (verified on 0.2.1-rc.2); pure client bundle, zero dependencies.
