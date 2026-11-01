# DSH 插件制作机制：我的理解

> 依据三方交叉：① 官方技能包 `cordis-plugin-development`（含 references 与 templates，从 app.asar 实读）
> ② 真实第三方插件源码（`E:\dshell\Nexus-Terminal\packages\dshell\*`，11 个包）
> ③ 本机已安装产物（`C:\Users\hp\.dsh\profiles\desktop\node_modules`）

## 1. 一句话概括

**DSH 插件 = 一个 npm 包（ESM）+ 一份 `cordis.patch.yml` 的"行插入"声明 + 一个导出 `apply(ctx, config)` 的模块。**
没有独立 SDK 编译步骤，没有注册表 JSON，也没有插件专属的 ABI。宿主是 Cordis 的"一切皆插件"容器。

## 2. 最小的 Host 插件（无 UI、无依赖、无构建）

```
my-plugin/
├── package.json
├── cordis.patch.yml
└── index.js
```

**package.json**（官方 Manifest 原文，Host-only 场景）：

```json
{
  "name": "@local/my-plugin",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./index.js" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

**cordis.patch.yml**：

```yaml
- insert:
    - id: my-plugin
      name: '@local/my-plugin'
      config: {}
```

**index.js**，导出形态二选一，**不可混用**：

```js
export const name = 'my-plugin'
export const inject = ['tools', 'skills']      // 可选：声明依赖的服务
export const Config = z.object({ ... })        // 可选：config 校验
export function apply(ctx, config) {
  // 所有注册都必须挂在 ctx 上，返回 disposer
  ctx.effect(() => { ...; return () => { /* 清理 */ } })
}
export default { name, inject, apply }         // 或这样组装
```

> 关键点：**`dsh.bundle.patch` 是"我是 bundle"的唯一标志**。不是 bundle 的包只会被当作普通依赖，不会被装进 composition。

## 3. 三个必须分清的概念

| 概念 | 是什么 | 谁创建 |
|---|---|---|
| **bundle** | 一个带 `dsh.bundle.patch` 的包；负责**往 composition 里插入若干行** | 插件作者 |
| **patch 行（row）** | composition 里的一条插件记录：`id` + `name` + `config` | bundle 的 patch |
| **plugin（模块）** | `name` 指向的真实 ESM 模块，导出 `apply` | 包本身 |

一个 bundle 可以插入**多行**（第三方 `dshell-bundle` 就一次插入 11 个 `@nexus-aethra/dshell-*` 行）。
这就是"多包一套装"的机制。

## 4. 我们需要的核心能力：在模型步骤前注入内容

这是本项目的技术命门。**`agent/pre-step` 是 waterfall 钩子**，签名与真实用法（取自 `dshell-mode` 的生产代码）：

```js
ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
  const downstream = await next()            // ① 必须先调 next() 拿下游决策
  if (downstream.kind !== 'enter') return downstream   // ② 非进入步则放行
  const context = createUserMessage({        // ③ 构造一条 user 消息
    content: [{ type: 'text', text }],
    source: CONTEXT_SOURCE,
  })
  return { ...downstream, messages: [context, ...downstream.messages] }  // ④ spread 后替换 messages
})
```

**四条铁律**（官方 practices 明确要求）：

1. **不拥有决策权时必须 `return next()`**——否则会吞掉其它插件的注入。
2. **改写决策要 spread**（`{ ...decision, messages }`），否则会丢掉 `startsRequestSeries` 等字段。
3. **先 `await next()` 再改写**，因为要基于下游结果判断。
4. **注入内容必须可从会话日志重建**——会话日志是唯一事实源，插件内存只是派生缓存。

## 5. 技能相关的两个服务 API

| 用途 | API | 出处 |
|---|---|---|
| 枚举技能目录 | `ctx.skills.list({ scope, cwd, signal })` | `dsh-skill` L224 |
| 取目录快照 | `ctx.skills.snapshot(...)` → `{ skills, complete }` | L234 |
| **取技能正文** | `ctx.skills.get(name, { scope, cwd })` | L250 |
| 注册运行时技能 | `ctx.skills.register({ name, description, content })` | L193 |
| 注册技能提供方 | `ctx.skills.registerProvider(create)` | L147 |

官方 `dsh-tool-skill` 就是这么做的：在 `agent/pre-step` 里 `snapshot()` 拿目录 → 渲染成一条
`<system-reminder>` 的 user 消息 → append 进 `decision.messages`。**我们的插件要做的，是在这之前
先决定"注入哪个技能的正文"，而不是整份目录。**

## 6. 作用域与生命周期（容易踩的坑）

- 注册进**哪个 ctx，就归属哪个作用域**，卸载时自动清理。`agent.ctx` 上注册的东西要**同时**留一份
  disposer 在插件自己的 effect 里，否则卸载插件不会清掉它。
- 每个 agent 一个作用域，用 `agent/created` 拿 `agent.ctx`；`agent/disposed` 做清理。
- **不要 append 新的 session 事件 type**：阅读器只接受带 `ignorable: true` 的信封，而 live
  `Session.append()` 设不了该标记，会导致会话无法重开。要持久化就存进 storage 服务。
- 要按会话累积状态，用 `ctx.sessionProjections`（纯函数 `apply(state, event)`），不要自己订阅
  `session/event` 重扫全量事件。

## 7. 分发与安装

- **安装**：`plugin_manager` 的 `install_bundle`（传包目录绝对路径或 npm/git 规格），
  **不要**自己写 profile 的 package.json 或跑 pnpm。
- **配置**：可调参数放 `Config`，用户在 `cordis.patch.yml` 改，patch 层跨版本保留。
- **热加载边界**：新装 bundle 可经 HMR 生效；**替换已安装包必须重启**才能加载新的 JS 模块代。
- **packed vs linked**：本地目录安装是**软链**，此时 `files` 字段不过滤文件——直接改源码即生效，
  但发布成 tgz 时必须核对实际打包清单。

## 8. 给本项目的直接结论

我们要做的插件形态已经确定：

```
decision-skills/
├── package.json                 # dsh.bundle.patch + dsh.client(如需 UI)
├── cordis.patch.yml             # insert 一行 decision-skills-router
└── index.js                     # apply(ctx): 注册 agent/pre-step
```

在 `agent/pre-step` 里做三件事：
1. 用**确定性召回**（BM25/词典）从 `ctx.skills.list()` 取 Top-K；
2. 只在信号弱时调用**本地 CPU 决策模型**裁决；
3. 把选中技能的正文（`ctx.skills.get(name)`）作为一条 user 消息注入。

失败即 fail-open：模型不可用/超时就 `return downstream`，退回官方目录行为。

## 9. 我尚未验证的部分

- `agent/pre-step` 的 `decision.kind` 全部取值（我只在真实代码里见到 `'enter'` 判断）。
- `ctx.skills.get()` 返回对象的完整字段（`content`/`body` 的确切键名需在实现时确认）。
- Client 侧 UI（若要做技能命中可视化面板）——目前只读了 `ui-plugin.md`，未实做。
