# 会话级技能策略：两层状态模型

> 依据：宿主实现实读（`dsh-skill/lib/index.js`、`dsh-scope/lib/index.js`、`dsh-tool-skill/lib/index.js`）
> 与本仓库 `packages/scanner/{prefs,session,visibility}.js` 的实际行为。

## 1. 一句话

**仓库页的开关是「新会话的默认策略」，会话里能改的是「这个会话的实际策略」；
后者存在会话层，压过前者。**

## 2. 为什么必须分两层

早期只有一层 `visibility`（技能键 → 档位），于是出现一个说不清的问题：
在仓库页点一下，到底改了谁？

- 对**已有会话**：注册表已经缓存了目录，改了要等失效才生效；
- 对**未来的会话**：新会话天然继承这份状态。

这两种语义混在一个开关上，用户无法预期。开发者真正需要的又是第三种：
**「就这个会话，把这一个技能关掉」**——而不是改全局默认（那会波及以后所有会话）。

所以拆成两层：

| 层 | 存储位置 | 语义 | 谁来改 |
|---|---|---|---|
| 全局默认 | `prefs.visibility[技能键]` | 新会话的默认档位 | 仓库页的系统级/通用级滑块 |
| 会话覆盖 | `prefs.sessions[sessionId][技能名]` | 只影响这一个会话 | 会话菜单 →「查看技能策略」里的滑块 |

解析优先级：

```
会话覆盖 > 全局默认 > 按来源兜底
```

兜底规则见 `defaultMode()`，只有一条：**系统级默认关，其余默认开。**

| scope | 默认 | 原因 |
|---|---|---|
| `system` | off | 内嵌 / 安装自带，不属于用户自己的技能库；不主动塞进模型上下文 |
| `common` / `project` | on | 用户自己装的技能，本来就在目录里 |

⚠️ 判据**只能看 scope，不能看 provider，也不能看路径**。

踩过的坑（用户原话：「一堆 skills 也开启，我没点」）：早先按 provider 名分
（我们扫的默认关、官方 provider 认领的默认开）。但同一个技能**由谁提供会漂移**
——office 系列在官方 `dsh-office` 在场时由它提供，一旦那次采集没拿到
（注册表刚失效重建，providers 表瞬时为空），就由我们的磁盘扫描补上。
于是同一个技能在两次刷新之间在开 / 关之间跳，**点一条、六七条跟着变**。
默认值一旦依赖"谁提供了这一行"，界面就不再是用户意志的反映。

配套的另一半是**界面即事实**：默认关 ⇒ 注册表里就是被遮蔽的；用户点开 ⇒
必须由会话级 provider 亲自把正文交出去。不能指望官方 provider——它在模型
真正读的那个注册表里未必存在（实测：界面显示开启，模型回
`skill "office-docx" is unknown or no longer available`）。

## 3. 会话级怎么真正做到「只影响这一个会话」

### 3.1 注册表的合并规则（读源码得出）

```js
// dsh-skill/lib/index.js  collectFresh()
const layers = [this.layers.global, ...this.layers.chainLayers(options.scope)]
for (const layer of layers) {
  for (const entry of collected.entries) merged.set(entry.candidate.name, entry)  // 后写赢
}
```

两条硬事实：

1. **近层覆盖远层**，按**名字**覆盖，后写覆盖先写。
2. **provider 只能添加候选，删不掉别人加的候选**——没有 "deny entry" 这种概念。

### 3.2 于是「屏蔽」只能靠同层遮蔽

往**这个会话自己的作用域层**注册一个 provider，对要屏蔽的名字返回
`invocation.modelInvocable === false` 的候选，`rank = 1`：

- 同层内 `compareIndexedCandidates` 先比 rank，1 压过官方 provider 的 100~600；
- 官方目录过滤 `snapshot.skills.filter(isModelInvocable)` 把它整个滤掉；
- `skill` 工具按名字加载时也会被拒（`"not available for model invocation"`）。

反向（关 → 开）**也要我们自己做**，理由见 §3.5：宿主里有两个注册表，
本来提供这个技能的 provider 未必在模型读的那个里。所以会话级 provider 是
双向的——屏蔽给遮蔽候选，放行给真实候选并自己读正文。

### 3.3 怎么才能注册进「会话的层」

`registerProvider` 按**调用方 ctx 的作用域**入层：

```js
registerProvider(create) → this.layers.effect(this.ctx, ...) → scopeOf(ctx)
```

而 cordis 的服务访问器会把 `service.ctx` 重绑到访问方。所以：

```js
agent.ctx.get('skills')              // 返回绑定到 agent 作用域的实例
agent.ctx.get('skills').registerProvider(...)   // 落在 agent 的层里
```

从**插件自己的 ctx** 调只会落进全局层，那就变成影响所有会话了。
注册挂在会话自己的 fiber 上，`agent/disposed` 时自动注销。

### 3.4 验证过的行为

同一注册表、两个会话、一份 prefs：

| 会话 | prefs | 模型可见 | `get()` |
|---|---|---|---|
| A | `alpha:off`, `office:on` | beta, office | alpha → undefined |
| B | 无覆盖（全局 office:off） | alpha, beta | office → undefined |

两个会话互不污染，缓存也不串（`collectCacheKey` 含 scope 链，本来就按作用域隔离）。

## 3.5 关键发现：宿主里不止一个技能注册表

这是把功能真正跑通时才暴露出来的，只看源码看不出来：

```
宿主级注册表（ctx.get('skills')）
  ├─ 我们的 visibility provider   ← UI / 仓库页读这里
  └─ 项目级发现（cwd 相关）

preset 级注册表（agent.ctx.get('skills')，模型实际读的）
  ├─ skill-filesystem（用户级 / 项目级技能）
  └─ 我们的 session provider      ← 只有它能影响模型
```

后果：**visibility provider 把「系统级技能设为开启」这件事只告诉了 UI，没告诉模型。**
实测证据（容器内）：

| 操作 | 界面 | 模型 |
|---|---|---|
| 仓库页把内嵌技能设为「开启」 | 显示开启 | `skill "X" is unknown or no longer available` |
| 会话面板把该技能设为「关闭」 | 显示拦截 | `not available for model invocation` ✓ |

也就是说：**屏蔽一直有效（走 session provider），放行无效（走 visibility provider）。**

### 修法：放行也由 session provider 负责

session provider 现在做**双向**：

- **屏蔽**：对不该见的名字返回 `modelInvocable: false` 的遮蔽候选（rank 1，压掉官方同名条目）。
- **放行**：对「本会话该开、且我们能不经注册表读到」的系统级技能，直接给出**真实候选**，
  并由它自己的 `get()` 读正文（asar / 磁盘）。因为它在 preset 注册表里，模型才看得见。

放行的候选来自 `scanner.systemRows()`（只扫 asar 与安装 assets，**不碰注册表**），
正文由 `scanner.rawBodyOf()` 读——同样绝不走 `ctx.skills.get()`，否则就是那条 OOM 老路。

### 两个配套修正

1. **策略候选不能污染目录**。会话 provider 的**放行项**与真实条目同名同路径，
   若参与去重会把真实条目的路径/来源顶掉（表现为「系统级技能跑到通用级」）。
   所以目录侧直接跳过放行项；**屏蔽项反过来必须收下**，理由见 §3.7。
2. **`overridden` 的语义**：看 prefs 里**有没有落键**，而不是「值是否与默认不同」。
   用户把档位设成与默认相同的值，仍然是一次显式决定，也要能「恢复默认」撤销。

## 3.6 「恢复默认」是**按行**的

每行的「恢复默认」只清掉这一条覆盖（`resetSessionVisibility({ sessionId, name })`），
不动同会话的其它改动。不带 `name` 才是清整个会话。

## 3.7 屏蔽不能让技能从界面上消失

这是会话级策略最容易写错的一处，已经踩过。

遮蔽候选的 `rank = 1` 是它能压过官方的**唯一**手段，代价是：在**带会话作用域**的
那次 collect 里，真实条目被挤到更远的层，快照里这个技能只剩那条占位
（描述是固定文案、没有 path）。

早期的目录侧把「所有来自 session provider 的候选」一律跳过，于是链路变成：

```
用户在会话里点了「关闭」
  → 写 prefs
  → 注册表失效重算
  → 快照里只剩遮蔽占位
  → 目录侧跳过它
  → 这个技能从会话面板 **和** 仓库页一起消失
  → 用户再也没有地方把它点回「开启」
```

修法是把占位**补成一行完整的技能**。元数据按三级兜底取：

| 来源 | 提供什么 | 什么时候有 |
|---|---|---|
| 内存快照 `knownRowsByName` | 描述、路径、来源、所属工作区 | 本次宿主存活期间见过这一行 |
| prefs 记录 `locatorOf()` | 路径、归档路径、来源、描述 | 用户调过档位，**重启后仍然有** |
| 占位自带文案 | 一句 `hidden by this session's skill policy` | 前两级都缺 |

两条配套约束：

- **内存是累积的，不是替换的**（`rememberRows()`）。本轮看不见的名字里，
  被档位表显式提到的要留着——看不见正是屏蔽造成的；其余连续三轮没出现，
  当作技能真被删了，丢掉，免得界面上挂着一行幽灵。
- **写档位时顺手把描述存进 prefs**。否则宿主重启后内存是空的，
  被屏蔽的行只能显示那句兜底文案——能点，但认不出是什么东西。

验证方式：把某条项目级技能关掉，重启宿主（内存清零），再打开策略弹层——
那一行仍然是「拦截」，描述与仓库归属都还在。

## 3.8 「/」菜单里的技能分组也要同口径

输入框里敲 `/` 弹出的菜单有一个「技能」分组。**它不是我们画的**：

- 官方 `@deepseek-ai/dsh-client-ui-skill` 往 `inputTriggers` 注册了一个
  `(trigger='/', name='skill')` 的 source，自己调
  `remote.skills.list({ sessionId })` 列出**注册表里的全部技能**，
  不按任何策略过滤——它只给非模型可调用的条目加一个「user-only」前缀。
- 于是被本会话拦掉的技能照样出现在菜单里，点进去还会失败。

没有官方钩子：`registerSource` 对相同的 `(trigger, name)` **直接抛错**，
source 契约（见该包 README）里也没有 filter / exclude。唯一可行的做法是把
那个 source 的 `candidates()` 包一层做减法：

```js
const sources = ctx.get('inputTriggers')?.live?.sources
const source = sources.find((s) => s.trigger === '/' && s.name === 'skill')
const original = source.candidates.bind(source)
source.candidates = async (session, arg) => {
  const list = await original(session, arg)
  const { blocked } = await policyOf(session.sessionId) // 我们的 sessionPolicy
  return blocked === null ? list : list.filter((item) => !blocked.has(item.name))
}
```

要点：

- source 存在 `InputTriggerService.live.sources`（普通字段，非私有），
  控制器每次命中都**按引用**取用，所以就地替换方法立刻生效，
  连已经打开的会话控制器也一样。
- 这是**明说的内部分界**：形状不对（服务没就绪 / 字段改名 / 找不到 source）
  就什么都不做，菜单维持原样，只记一行诊断。`inputTriggers` 比我们晚就绪时
  用 200ms × 100 次轮询补上，随插件卸载一起清掉。
- 过滤只做减法：条目形状仍归官方 source，我们只按 `name` 剔除。
- 判定用自己的 `sessionPolicy`（`visible !== true` 即拦），2 秒缓存；
  任何一次档位写入都清缓存。
- 拿不到策略时**不过滤**：宁可多显示一条，也不要凭空藏掉。

过滤是**双向**的，两个方向都必须做，因为官方那份 catalog 是**客户端缓存**：

| 方向 | 做法 | 为什么必须自己来 |
|---|---|---|
| 关 → 从菜单消失 | 按名字剔除 | 官方列表包含全部技能，不剔除就照旧显示 |
| 开 → 立刻出现 | 按策略**补条目** | 官方缓存只在 `agent-preset/selected`、`plugin-manager/changed`、`connection/reset` 时失效；我们在门户里改档位不触发它们 |

第二条尤其要紧：住在 asar 里的技能**只有开启后才会进注册表**（由会话 provider 交付），
所以官方那份缓存里根本没有它，不补就永远等不到。

补条目时按 `queryHits()` 自己比一遍查询（名字优先、描述兜底），
排序交给官方那份，补的放末尾。

实测（全部不刷新页面）：

- 关掉 `office-docx` → 菜单里立刻没了；开回来 → 又有
- 打开 `agent-experience`（asar 内、官方缓存里不存在）→ 菜单末尾立刻出现，
  诊断显示 `base=10 kept=10 extra=1`（那 1 条就是我们补的）

## 4. ⚠️ 铁律：provider 回调里绝不能回头调注册表

`provider.list()` 是**被注册表 collect() 调用**的。若在里面再调
`ctx.skills.snapshot()` / `list()`，就是：

```
collect → provider.list() → snapshot → collect → provider.list() → …
```

爆栈（`RangeError: Maximum call stack size exceeded`），每次爆栈留下一串未处理的
promise 拒绝，最后把 host 进程撑到 OOM（`FATAL ERROR: … heap out of memory`，
退出码 134）。这条已经在真机上把桌面端干崩过两次。

所以 `session.js` 的 `list()` **只读 prefs 与内存**（`knownRows` 缓存），
一个宿主服务都不碰。`visibility.js` 同理，只走 `scanner.systemRows()`（非注册表来源）。

## 5. 数据形状

```jsonc
// <DSH_HOME>/storages/decision-skills.json
{
  "version": 2,
  // 全局默认。键是「磁盘路径 / 归档路径 / 技能名」，值是结构化记录。
  // 写记录而不是裸字符串，是因为会话层要**按名字**屏蔽，只存路径会让名字永久丢失。
  "visibility": {
    "/home/u/.dsh/skills/alpha/SKILL.md": {
      "mode": "off", "name": "alpha", "path": "…", "source": "user-dsh",
      // 描述也存一份：关掉之后快照里只剩遮蔽占位，界面上那一行
      // 要靠它把描述认回来（宿主重启后内存是空的）。
      "description": "Use when …"
    }
  },
  // 会话覆盖。内层键是**技能名**——注册表的合并与去重都以名字为单位，
  // 用路径做键会出现「同名两条策略、注册表只认一条」的自相矛盾。
  "sessions": {
    "session-1793…": {
      "alpha": { "mode": "on", "path": "…", "source": "project-agents", "description": "Use when …" }
    }
  },
  "projects": {}
}
```

## 6. Remote 方法

| 方法 | 参数 | 作用 |
|---|---|---|
| `sessionPolicy` | `{sessionId}` | 该会话的放行策略（含 `mode` / `globalMode` / `overridden`） |
| `setSessionVisibility` | `{sessionId, name, mode, path?, archivePath?, source?, description?}` | 改这一个会话的档位 |
| `resetSessionVisibility` | `{sessionId, name?}` | 带 name 只清这一条，不带清整个会话 |
| `setVisibility` | `{key, name?, path?, mode, source?, description?, …}` | 改全局默认（仓库页滑块） |

`description` 是**给界面认人用的**：技能被关掉之后，注册表快照里只剩遮蔽占位，
描述只能从这里取回（详见 §3.7）。

`sessionPolicy` 返回 `overridden`：该技能在本会话是否偏离了全局默认。
界面用它区分「仅本会话」与「跟随默认」两种状态，并决定要不要显示「恢复默认」按钮。

## 7. 界面约定

- **仓库页**：系统级与通用级有滑块，项目级**没有滑块**——
  项目级必须按会话调，在仓库里放统一开关只会误导。
- **会话策略弹层**（三个点菜单 →「查看技能策略」）：三种来源**都有**三段式滑块，
  改动只写会话层，立刻生效。
- 仓库页底部有一句说明，讲清这个页面的开关管的是「新会话的默认值」。

分类分页两边都有，页签上带条数：

| 位置 | 页签 |
|---|---|
| 仓库页 | 系统级 / 通用级 / 项目级 |
| 策略弹层 | 全部 / 系统级 / 通用级 / 项目级 |

弹层的汇总（放行 / 拦截 / 全部）**跟着当前页重算**——否则「系统级只有 12 行，
汇总却写着全部 15」会让人怀疑数据。

**弹层宽度**：原语（`@deepseek-ai/dsh-client-ui-primitives` 的 `Modal`）把宽度写死在
样式里（`width: min(380px, 100%)`），props 里没有宽度这一项，但 `className` 会并到
弹层根元素上。所以插件注入一条规则把本弹层撑到 680px：

```css
[role="dialog"].ds-policy-dialog { width: min(680px, 100%); }
```

选择器带上 `[role="dialog"]` 把优先级提到 (0,2,0)，压过原语的单类选择器，
不去赌样式表加载顺序；`<style>` 挂在 `ctx.effect` 里，插件卸载时一起移除。
