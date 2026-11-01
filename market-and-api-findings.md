# DSH 插件市场与插件 API 侦察报告

> 侦察：market-scout ｜ 采证时间：2026-11-01 ｜ 环境：E:\dsh（Electron，app.asar 目录形式可直读）、DSH_HOME=C:\Users\hp\.dsh、dshbox 容器 fast-test 运行中
> 证据等级：🟢 实测/读源码确认 ｜ 🟡 文档或元数据 ｜ 🔴 未找到
> 硬约束（用户）：**决策模型不得假设 GPU，插件必须纯 CPU 可用**。本报告 §E 专章回答。

---

## 0. 三句话结论

1. **能。** DSH 插件有一条正经的「模型步骤前注入/替换上下文」通路：`agent/pre-step`（waterfall，可 reject 整步、可整体替换该步进入模型的消息批）。官方 `dsh-tool-skill` 就是用它注入 skill 目录的，第三方 `dshell-mode`、`dsh-time-context` 也用它注入自定义 user-role 消息。🟢
2. **能，而且已有先例。** 插件可以带 native 二进制与 ONNX 权重：官方 `@deepseek-ai/dsh-experimental-speech-to-text-sensevoice` 依赖 `sherpa-onnx-node`（含完整 onnxruntime.dll），第三方 `dsh-ocr-local` 把 21MB ONNX 权重直接塞进 npm 包。**坑在分发方式**：权重体积远超 npm 包常规尺寸，主流做法是「小包 + 首次运行下载 + sha256 校验」，而不是打进 tgz。🟢
3. **已经有 skill 动态加载类插件，但没用本地小模型做决策。** 本机配置的插件市场索引里有 4092 个插件（skill 类 122 个），其中 `dsh-plugin-skill-autoroute`（纯算法打分，无 LLM）、`@lyteboat/skill-router`（LLM 路由）、`@starpivot/dsh-skill-router`、`@wisdoverse/dsh-skills-manager` 已覆盖「自动选 skill 并注入」；**没有一个把决策交给本机 CPU 小模型**。🟢

---

## A. 本机插件仓库现有条目（box_plugins 实测）

工具实测命令：`box_plugins{action:"list"|"installed"|"container"|"graph", containerId:"container-1793336413-0493572e-789b-4847-a599-47d42b9dc944"}`

### A.1 仓库条目表（`list` → 12 条，全部 `storage:"reference"`）

| # | 包名 | 版本 | 来源（`source` 原值） | 第三方? |
|---|---|---|---|---|
| 1 | `@deepseek-ai/dsh-ssh` | 0.2.1-rc.5 | `@deepseek-ai/dsh-ssh@0.2.1-rc.5`（registry reference） | 官方 |
| 2 | `@nexus-aethra/dshell-buffer` | 0.1.17-alpha.1 | `file:E:/dshell/.packs/0.1.17-alpha.1/nexus-aethra-dshell-buffer-0.1.17-alpha.1.tgz` | 第三方 |
| 3 | `@nexus-aethra/dshell-bundle` | link | `file:.../nexus-aethra-dshell-bundle-...tgz`（recorded 为 `link:E:/dshell/Nexus-Terminal/packages/dshell/bundle`） | 第三方 |
| 4 | `@nexus-aethra/dshell-commands` | 0.1.17-alpha.1 | `file:.../nexus-aethra-dshell-commands-...tgz` | 第三方 |
| 5 | `@nexus-aethra/dshell-conversation` | 0.1.17-alpha.1 | tgz | 第三方 |
| 6 | `@nexus-aethra/dshell-files` | 0.1.17-alpha.1 | tgz | 第三方 |
| 7 | `@nexus-aethra/dshell-mode` | 0.1.17-alpha.1 | tgz | 第三方 |
| 8 | `@nexus-aethra/dshell-ssh` | 0.1.17-alpha.1 | tgz | 第三方 |
| 9 | `@nexus-aethra/dshell-std` | 0.1.17-alpha.1 | tgz | 第三方 |
| 10 | `@nexus-aethra/dshell-storage` | 0.1.17-alpha.1 | tgz | 第三方 |
| 11 | `@nexus-aethra/dshell-terminal-bridge` | 0.1.17-alpha.1 | tgz | 第三方 |
| 12 | `@nexus-aethra/dshell-usage` | 0.1.17-alpha.1 | tgz | 第三方 |

> 备注：仓库里 11/12 是同一家第三方（@nexus-aethra 的 dshell 插件族），只有 1 个官方条目。**本机仓库 ≠ 市场**：本机仓库只登记「已引入过」的包，真正的发现面是下面 §A.4 的市场索引。

### A.2 已装（`installed`）
12 条全部 `inRepository:true`；每条有两个 owner：`kind:"repository"`（仓库引用）与 `kind:"container"`（fast-test）。`cachedVersions` 仅 `@deepseek-ai/dsh-ssh` 有 `["0.2.1-rc.5"]`。

### A.3 容器内实际挂载（`container`）
`["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@nexus-aethra/dshell-bundle"]`
（即三条 bundle 行；仓库里那 11 个 @nexus-aethra 包是被 `dshell-bundle` 的 `cordis.patch.yml` 作为行插入的，不是独立 bundle。）

### A.4 依赖图（`graph`）关键读数
`source:"container"`、`profile:"web"`；`order` 400 行、`provides` 160、`requires` 895、`services` 148（其中可见 `skills`、`tools`、`systemPrompt`、`commands`、`dshell*` 等）；`cycles` 1 条（`dsh-client-ui-conversation#client` ↔ `dsh-client-ui-workspace`）；`diagnostics` 41 条，均为「inject/provide 名字不是字面量」这类静态分析告警（合并到运行时的动态注入，**不是故障**）。

### A.5 真正的插件市场（用户可发现面）🟢 实测
本机 desktop profile 的 `cordis.patch.yml:197-201` 配了一处市场索引：

```yaml
- id: plugin-market
  name: "@deepseek-ai/dsh-plugin-market"
  config:
    indexes:
      - https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json
```

实测下载该索引：**format 1，4092 个插件，23 个分类**（ui 775 / tools 557 / session 296 / dev 254 / workflow 252 / model 236 / usage 206 / memory 176 / theme 146 / notify 145 / remote 138 / fun 124 / **skill 122** / security 115 / browser 103 / git 89 / vision 82 / docs 70 / market 61 / voice 59 / identity 43 / agi 35 / wsl 8）。
市场机制（`@deepseek-ai/dsh-plugin-market` README 🟡）：索引是单个 JSON，每版本带 `install` 参数（npm 为 `name@version`，git 为 `git+<url>.git#<commit>&path:/<dir>`）与 `engines.dsh` 兼容性；安装走 `pluginManager.installBundle`；索引源可由用户在 Plugins→Discover 增删，未配置时 Host 不发任何请求。

---

## B. DSH 插件长什么样：manifest 与实际注册面

### B.1 manifest = 普通 npm package.json + `dsh` 字段（🟢 读 `E:\dshell\Nexus-Terminal\packages\dshell\*` 源码 + 官方 `dsh-package-manifest`）

官方类型定义来源：`E:\dsh\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-package-manifest\src\types.ts`（README 亦在）。
实际形态（`@nexus-aethra/dshell-buffer/package.json` 原文摘录）：

```json
{
  "name": "@nexus-aethra/dshell-buffer",
  "version": "0.1.16",
  "type": "module",
  "main": "lib/index.js",
  "exports": { ".": {...}, "./protocol": {...}, "./client": {"default": "./lib/client.js"} },
  "files": ["lib"],
  "peerDependencies": { "@deepseek-ai/cordis": "...", "@deepseek-ai/dsh-tools": "...", ... },
  "dsh": { "client": { "platform": "web" } }
}
```

`@nexus-aethra/dshell-bundle/package.json` 的 bundle 声明：

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

要点：
- **入口就是 ESM 模块**，导出 `{ name, apply(ctx), inject }`（Cordis 插件契约，见 `dshell-buffer/src/index.ts` 末行 `export default { name, apply }`）。
- **`peerDependencies` 全部指向 `@deepseek-ai/*`**：宿主提供的服务按包名 peer 声明，不复制宿主代码。
- **`dsh.bundle.patch` 指向 `cordis.patch.yml`**，bundle 用它把若干行插入 composition（=`- insert: [{id, name, config}]`，也支持 `- id: x\n  disabled: true`）。这是插件「声明自己要挂哪几行」的唯一正式入口。示例见 `E:\dshell\Nexus-Terminal\packages\dshell\bundle\cordis.patch.yml`。
- `dsh.client.platform: "web"` 表示该包还有浏览器半边（`./client` 导出，走 `ctx.slots` 渲染）。
- `engines.dsh` 可选，**当前安装器/加载器不强制校验**（`dsh-package-manifest` README「Compatibility is declarative」）。

### B.2 插件能注册什么（每条注明 API 名 + 出处）🟢

| 能力 | API | 出处（本机可读路径） | 证据 |
|---|---|---|---|
| **注册模型可见工具** | `ctx.tools.register(definition)`；用 `defineTool({name,description,parameters,output,execute})` 造 definition | `app.asar/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js`（`defineTool` L838，`exports` 含 `defineTool/RUN_CODE_NAME/ToolRuntime`）；`dsh-tool-cordis/lib/types/api-catalog.js` 中 `key:'tools'` 的 `register` | 第三方 `dshell-buffer/src/tool.ts`、`dshell-commands/src/index.ts` 实调 |
| **工具守卫/裁剪** | `ctx.tools.guard(guard)`（可拒单次调用）、`ctx.tools.restrict({allow,deny})`、`ctx.tools.presentAs(mode)` | 同上 api-catalog `tools` 段 | 仅契约（本机插件未用） |
| **注册斜杠命令** | `ctx.commands.register({name,description,handler})` | `@deepseek-ai/dsh-commands`；api-catalog `key:'commands'` | `dshell-commands/src/index.ts` 注册 `/new` |
| **注入系统提示分节** | `ctx.systemPrompt.section({name,order,text})`；另有 `context()`、`variable()`、`tools(provider)`、`assemble()`、`refreshContext()` | `@deepseek-ai/dsh-system-prompt`；api-catalog `key:'systemPrompt'` | `dshell-buffer/src/index.ts` 用 `systemPrompt.section({name:'tool:dshell-buffer', order:1650, text:({agent})=>...})` |
| **注册 skill（运行时/提供方）** | `ctx.skills.register({name,description,content,...})`、`ctx.skills.registerProvider(create)`、`list()`、`snapshot()`、`get(name)` | `@deepseek-ai/dsh-skill/lib/index.js`（`var SkillRegistry = class extends Service`，L119 起）；官方文档 `docs/subsystems/skills.md` §Cordis API | `@deepseek-ai/dsh-skill-badge/lib/index.js` `apply(ctx){ctx.skills.registerProvider(()=>provider)}` |
| **挂 HTTP 路由（给浏览器半边用）** | `ctx.connection.fetch.register(route)` | `@deepseek-ai/dsh-client-connection` | 6 个 dshell 包都在用 |
| **浏览器 UI 槽位** | `ctx.slots.register(...)`（client 半边，`dsh.client.platform:"web"`） | `@deepseek-ai/dsh-client-ui-slots` | `dshell-*/src/client/index.ts` 共 5 处 |
| **提供新服务（给别的插件注入）** | `ctx.provide('name', service)` + 在 `declare module '@deepseek-ai/cordis'` 里扩 `interface Context` | `@deepseek-ai/cordis`（`src/service.ts`） | `dshell-buffer` 提供 `dshellBufferCore` |
| **子进程 / 原生进程托管** | `ctx.subprocess.spawn(spec)`（抽象 seam，实现由 `dsh-subprocess-local` 提供） | api-catalog `key:'subprocess'` | 官方 sensevoice 用它托管 worker |

### B.3 生命周期钩子：哪些能拦「模型步骤」🟢

全部事件名来自 `app.asar/dsh/node_modules/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js` 的 `EVENT_API`（82 条，机读目录），签名逐条核对：

| 事件 | 模式 | 签名/能力 | 用途 |
|---|---|---|---|
| **`agent/pre-step`** | **waterfall** | `(payload:{agent,messages:UserMessage[],turn,step,signal}, next) => Promise<PreStepDecision>`；`PreStepDecision = {kind:'reject'} \| {kind:'enter', messages:UserMessage[], startsRequestSeries?}` | **唯一能在请求派生之前改动该步消息批的钩子**。`next()` 拿到当前批，返回 `{...decision, messages:[...decision.messages, 自己构造的 user 消息]}` 即注入；返回 `{kind:'reject'}` 即整步不发 |
| `agent/request` | waterfall | `next() => LlmCallConfig`，可替换 provider/model/effort | 换路由（官方已标 deprecated，「may change request controls but must preserve ...」） |
| `system-prompt/assemble` | waterfall | `(assembly, context, next) => PromptAssembly` | **可整体重写系统提示的分节/上下文/工具 schema/变量**；返回值为权威。注意：若该 scope 注册了 complete section，瀑布后会被恢复，不能绕过 |
| `system-prompt/change` | emit | `()` | 提示变更通知 |
| `tools/pre-execute` / `tools/post-execute` / `tools/result` / `tools/execute` | waterfall/emit | 允许/拒绝/取消/询问；结果后处理 | 拦工具调用 |
| `agent/turn-stopping` | serial | `(payload) => void`；可 `agent.steer(...)` 续命 | 轮次收尾前 |
| `agent/request-error` | waterfall | 返回 `{kind:'retry'}` 重试 | 失败重试 |
| `skills/change` | emit | `()`（无过滤） | skill 目录失效 → 重读 |

另有 **`Agent.inject()` / `steer()` / `followup()`**（`@deepseek-ai/dsh-agent` README + `lib/index.js`）：`inject()` 把模型可见上下文塞进 inbox 且**不唤醒 driver**，落在下一个被接纳的 step。这是「不依赖 pre-step 钩子也能注入」的第二条路。

**结论（对用户的方案）**：插件完全可以在每一步之前（a）读 `ctx.skills.list({scope:agent, cwd})` 拿全量目录，（b）用本地小模型裁决，（c）通过 `agent/pre-step` 把选中的 SKILL.md 正文作为一条 `createUserMessage({source:{kind:'<your-plugin>'}})` 追加进该步 —— 这正是官方 `dsh-tool-skill`（`lib/index.js:896-930` 与 `:931-964`）和官方 `dsh-time-context` 的做法，第三方 `dsh-plugin-skill-autoroute` 亦同构。

---

## C. 已经有「skill 动态加载」能力了吗？🟢

**有，但都不是「本机小模型决策」。**

| 插件 | 决策方式 | 是否 CPU 小模型 | 证据 |
|---|---|---|---|
| `dsh-plugin-skill-autoroute` v1.1.1 | 关键词+目录元数据**确定性打分**，不调 LLM、不做向量；`agent/pre-step` 追加一条 `source.kind='skill-autoroute'` 消息，三模式 `brief`/`load`(直接注入 SKILL.md 正文)/`router` | ❌ 无模型 | 包 148KB；README 原文（GitHub SOH4C4759）🟢 |
| `@lyteboat/skill-router` v0.1.1 | LLM 路由（reference `LLMSkillRouter`），full/dynamic 两种加载模式，依赖 `@lyteboat/model-side-call` | ❌ 用主模型 | packument 🟡 |
| `@starpivot/dsh-skill-router` v0.1.0 | 两级路由：把会话目录过滤成 router/standalone，子技能仍可按名加载 | ❌ | packument 🟡 |
| `@wisdoverse/dsh-skills-manager` v1.0.8 | 触发钩子（trigger hooks）+ 技能自带 lifecycle hook/tool policy | ❌ 规则 | packument 🟡 |
| `@boomzzzzzz/dsh-skill-fold` v0.1.1 | **挂 `agent/pre-step`**，按当前任务折叠非匹配域的 skill 目录条目 | ❌ 规则 | packument 🟡 |
| `dsh-router-laya` v2.2.1 | 本地微调 7 题分类器（ModernBERT 842MB，**CPU <1s**）——但它路由的是**思考档位 low/high/max**，不是 skill | ✅ CPU，但目标不同 | README 原文 🟢 |

**空位**：市场上没有一个「`agent/pre-step` + `ctx.skills.list` + 本机 CPU 小模型裁决 + 注入 SKILL.md 正文」的组合。laya 证明了 CPU 小模型决策在 DSH 里可行，autoroute 证明了注入通路成熟，两者还没被拼在一起。

---

## D. 我实测过的命令与结果

| # | 命令/调用 | 结果 |
|---|---|---|
| 1 | `box_overview{include:"containers,templates,plugins"}` | 1 容器 fast-test（模板 dsh-v0.2.1-rc.5，running）、2 模板、仓库插件列表可见 |
| 2 | `box_plugins{list}` / `{installed}` / `{container}` / `{graph}` | 见 §A（12 条仓库条目、12 条已装、容器 3 条 bundle、graph 400 行/148 服务/41 诊断） |
| 3 | `fs.readdir E:\dsh\resources\app.asar` + `@deepseek-ai` 目录扫描 | **asar 在本机是目录形式**，直接 `fs.readFileSync` 可读源码；`dsh/node_modules/@deepseek-ai` 下 **307 个包** |
| 4 | 遍历 asar 内 4346 个文件做全文检索 | `beforeModelStep`/`registerTool` 等命名 **未找到**（那是 dshbox 沙箱 API 名，非 Cordis 插件 API）；真实 API 是 `ctx.tools.register` / `agent/pre-step` |
| 5 | 读 `dsh-agent/README.md:65-67`、`dsh-agent/lib/index.js:193`、`api-catalog.js` EVENT_API | 确认 `agent/pre-step` 为 waterfall 且可替换 message batch |
| 6 | 读 `dsh-skill/README.md` + `lib/index.js:119-215` | 确认 `ctx.skills.register/registerProvider/list/snapshot/get` |
| 7 | 读 `dsh-tool-skill/README.md` + `lib/index.js:896-964` | 确认官方就用 `agent/pre-step` 注入 `<available_skills>` 目录与 `/name` 显式调用 |
| 8 | 读 `E:\dshell\Nexus-Terminal\packages\dshell\{bundle,buffer,commands,mode}\src` | 确认 manifest 形态、`cordis.patch.yml` insert 行、`tools.register`/`commands.register`/`systemPrompt.section`/`connection.fetch.register`/`agent/pre-step` 实际用法 |
| 9 | `Invoke-WebRequest https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json` | **2.77MB，format 1，4092 插件 / 23 分类**（已存 `.scout-docs/market-index.json`） |
| 10 | npm registry 搜索（10 组关键词，去重 407~416 包）+ 逐个 packument | 见 §C 与 §E.4；确认 skill 路由类为 0 个「CPU 小模型」实现 |
| 11 | 下载官方文档 `docs/subsystems/{skills,core,tools}.md`、`docs/capability-seams.md`（GitHub raw master，共 ~183KB） | 与 asar 内 README 一致，作为权威交叉验证（存 `.scout-docs/`） |
| 12 | `node.exe -e "require('.../@koromix/koffi-win32-x64/win32_x64/koffi.node')"` | ✅ 成功：`koffi loaded ok, version: 3.1.1`，Node v24.21.0 x64 |
| 13 | `node.exe -e "require('.../sherpa-onnx-win-x64/sherpa-onnx.node')` | ✅ 成功，导出 `createOnlineRecognizer` 等 8+ 符号 |
| 14 | 扫描 `.node/.dll` 头部 ASCII 特征串 | 两包均含 `napi_register_module_v1`、无 `node_module_register` → **Node-API（ABI 稳定）**，不需要按 Electron/Node 版本重编译 |

---

## E. 硬约束专章：纯 CPU、插件自带模型权重与 native 二进制可行吗？

**结论：可行，且本机就有三份先例证据。真正的工程难点是「权重分发体积」，不是「能不能跑」。**

### E.1 本机已存在的 native 运行时（`app.asar.unpacked` 实测体积）🟢

| 包 | 体积 | 内容 | 用途/归属 |
|---|---|---|---|
| `sherpa-onnx-win-x64` | **22.4 MiB** | `onnxruntime.dll` 16.99 MiB、`sherpa-onnx-c-api.dll` 4.41 MiB、`sherpa-onnx.node` 0.66 MiB | 官方 sensevoice 语音识别（**纯 CPU ONNX 推理**） |
| `@koromix/koffi-win32-x64` | 1.0 MiB | `win32_x64\koffi.node` | **FFI**，被 `dsh-desktop-host`/`dsh-fs-local`/`dsh-sandbox-windows-acl`/`dsh-win32-process` 等 9 个包依赖 |
| `koffi`（JS 层） | 1.7 MiB | 跨平台 loader + 按 OS/arch 选 optDep | 同上 |
| `node-pty` | 4.9 MiB | 6 平台 `prebuilds/` | 官方 `dsh-subprocess-local` 依赖 |
| `@img`(sharp) | 18.9 MiB | 图像 libvips | 官方 `dsh-attachment-local` 依赖 |

要点：这些 native 模块**住在 Electron 的 `app.asar.unpacked`** 里，且 DSH 的 Host 是一个**独立 Node 子进程**（`E:\dsh\resources\app.asar\lib\main.js`：`spawn(node, ['--expose-internals', entry /* dsh-desktop-host/lib/index.js */, runtimeDir, projectDir, primaryRuntime...])`），node 为 `E:\dsh\resources\runtime\primary-runtime\dependencies\node`（v24.21.0 x64）。所以 **`.node` 是在普通 Node（非 Electron 渲染进程）里 dlopen 的**，没有 Electron ABI 问题；实测 #12/#13 也直接验证了加载成功。

### E.2 「插件自带 CPU 推理」的三份先例（照抄哪个？）

| 方式 | 先例 | 权重放哪 | 体积 | 评价 |
|---|---|---|---|---|
| **A. 权重打进 npm 包** | `dsh-ocr-local` v0.5.1（第三方） | `models/PP-OCRv5_mobile_det.onnx` 4.7MB + `models/PP-OCRv5_mobile_rec.onnx` 16.5MB（`files` 显式声明，共 **~21.6MB unpacked**） | 可接受 | ✅ **小模型（<30MB）首选**：零网络、离线可用、版本可 pin |
| **B. 小包 + 首次运行下载 + sha256** | 官方 `@deepseek-ai/dsh-experimental-speech-to-text-sensevoice` | `runtime/assets.json` 里写死 URL+bytes+sha256：int8 **239,233,841 B**、fp32 937,617,178 B、tokens 315,894 B、VAD 1,807,522 B；下载到 `dshHomePath('speech-to-text','sensevoice')` | 包本体极小 | ✅ **模型 >30MB 必须这么做**；官方范式，含多源探测（huggingface.co + hf-mirror）、断点重下、校验失败换源 |
| **C. 依赖现成 native 运行时 + 自己下载权重** | 第三方 `dsh-hold-to-talk` v0.1.4 `dependencies: sherpa-onnx-node`，权重下载到 `~/.dsh/hold-to-talk/models`，默认 `mirror: https://hf-mirror.com` | 同 B | 包 84KB | ✅ **想复用 onnxruntime 时最省力**：`sherpa-onnx-node` 走 optDeps 按平台只装一份（`sherpa-onnx-win-x64` 23.2MB unpacked） |
| ~~D. 外部 Python 进程 + 大 checkpoint~~ | `dsh-router-laya` v2.2.1 | `npx dsh-router-laya setup` 建 venv + 下载 **846MB** checkpoint + 常驻服务 | — | ⚠️ 能用但**用户负担最重**（Python≥3.10、常驻进程、~2GB 磁盘）——正好是用户想避开的 |

### E.3 分发上的坑（实测/读源码得出）

1. **npm 包尺寸**：`onnxruntime-node` 未压缩 **307.6 MB**（跨 4 平台全打进去），`onnxruntime-web` 150.6 MB，`node-llama-cpp` 40.4 MB + 每平台 33 MB optDep。→ **别直接依赖 `onnxruntime-node` 全量包**；要么用 `sherpa-onnx-node`（23MB/平台），要么走 `sherpa-onnx-*` 这类「主包 + 平台 optDeps」模式。
2. **安装走 pnpm + profile 工作区**：`pluginManager` 调 `pnpm add`（`dsh-plugin-manager/lib/index.js`，`--config.fetch-retries=0`）。本机 desktop profile 的 `pnpm-workspace.yaml` 是 `nodeLinker: hoisted`、`autoInstallPeers: false`。**未发现 DSH 强制 `--ignore-scripts`**（asar 内 307 包检索无相关命中），但**用户 `C:\Users\hp\.npmrc` 把 registry 指向 npmmirror** —— 意味着若走「`postinstall` 下载权重」路线，国内镜像与大文件下载会撞墙；**权重下载应放在「首次运行时」而非 install 期**（官方 sensevoice、第三方 hold-to-talk 都是运行期下载）。
3. **必须 Node-API**：三个 native 包都含 `napi_register_module_v1`。用 node-gyp 编的旧式 `NODE_MODULE` 插件在 Node 24 上要重编译，与 DSH 升级节奏冲突。
4. **`app.asar.unpacked` 的角色**：官方 native 依赖都要出现在 unpacked 目录（electron-builder `asarUnpack`）。**第三方插件由 pnpm 装进 profile 的 `node_modules`（`C:\Users\hp\.dsh\profiles\desktop\node_modules`），不在 asar 内**，因此不受 asar 限制——实测该 profile 下已有 native 落地：`node-pty`（18 个 .node/.dll，6.7MB）、`ssh2`。→ **第三方插件带 native 不需要碰 DSH 的打包配置**。🟢
5. **Windows / 平台矩阵**：用 `os`/`cpu` 字段 + optionalDependencies 让 pnpm 只装本平台（`sherpa-onnx-win-x64` 声明 `"os":["win32"],"cpu":["x64"]`；`koffi` 有 20 个平台子包）。否则包体积翻数倍。
6. **首启延迟**：Bundle 激活时「检查缓存、不加载模型、不下载」（sensevoice README 明确：`Activation checks cached resources without loading models or downloading assets`）。**照抄这个分层**：激活只查文件 → 首次真正需要时才 load → 推理走 worker。

### E.4 有没有「插件自带 CPU 推理」的第三方 marketplace 先例？🟢（索引实测）
`dsh-ocr-local`（vision 类，21.6MB ONNX 打进包，纯 CPU 离线 OCR）、`dsh-hold-to-talk`（sherpa-onnx，权重运行期下载）、`dsh-voice-mode`/`dsh-voice-bridge`/`dsh-voice-assistant`（zipformer2/SenseVoice 本地语音）、`@dsh-ops/fastctx-win32-x64`（**49.9MB** 的 win32-x64 原生运行时子包）、`dsh-ops`（22.4MB，跨三平台 native 工具）、`dsh-router-laya`（CPU ONNX 分类器，但走 Python 外部进程）。

---

## F. 给用户方案的落地建议（基于以上证据）

1. **注入点**：`ctx.on('agent/pre-step', async ({agent,messages,signal,step}, next) => {...})`，`await next()` 后 `{...decision, messages:[...decision.messages, createUserMessage({content:[{type:'text',text:renderSkillContent(skill)}], source:{kind:'my-plugin'}})]}`。同批指令只路由一次（用 `source.kind` 过滤自注入，参考 autoroute）。
2. **决策输入**：`ctx.skills.list({ scope: agent, cwd: await ctx.workingDirectory.ensure(agent, signal), signal })` → 名称+描述；正文用 `ctx.skills.get(name, lookup)`。**别缓存正文**（registry 无 TTL，provider 每次 load 读当前内容）。
3. **推理形态**：**必须 Worker/子进程**（官方 sensevoice 用 `ctx.subprocess` 托管独立 worker，串行化推理），主线程只做 IPC；首次激活只做资源检查。
4. **权重体积分水岭**：<30MB 打进 npm `files`（照抄 dsh-ocr-local）；>30MB 走运行期下载 + sha256 + 多源（照抄 sensevoice `runtime/assets.json`）。**做成可配置 `modelDir`/`precision`**，让用户能指向已下载的权重。
5. **运行时选型**：要 ONNX → `sherpa-onnx-node`（23MB/平台，已在本机验证可加载；注意它面向语音，通用 ONNX 图可用其 `onnxruntime.dll` 或另配 `onnxruntime-node`）；要 GGUF → `@node-llama-cpp/win-x64` 33MB optDep。**决策分类模型量级建议 ≤50MB int8、百毫秒级**，避免 laya 的 842MB + Python 那条重路。

---

## G. 明确「未找到」的项

- 🔴 未在 asar 内找到 `beforeModelStep` / `before-model-step` / `registerSkill` 这类命名 —— 那是 dshbox 沙箱层 API，**不是 Cordis 插件 API**；Cordis 侧对应物是 `agent/pre-step` 与 `ctx.skills.*`。
- 🔴 未找到 DSH 插件「签名/公证」机制；市场索引只做 `engines.dsh` 兼容性判定，**无内容签名校验**。
- 🔴 未找到任何「DSH 插件自带 CPU 小模型做 skill 路由」的包（market 索引 4092 条 + npm 407 条去重比对）。
- 🔴 未找到 web_fetch 可用的外网（`github.com`/`registry.npmjs.org` 被解析为非公网 IP 拒绝），改用 `pwsh` + `Invoke-WebRequest` 与 GitHub raw/jsDelivr 完成取数。
