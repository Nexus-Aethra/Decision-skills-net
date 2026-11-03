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

兜底规则见 `defaultMode()`，要点是**系统级内部还要再分两种**：

| 系统级来源 | provider 名 | 默认 | 原因 |
|---|---|---|---|
| asar 内置 | `asar:agent-preset` | off | 宿主没有 provider 认领，不给就整个不存在 |
| 安装 assets | `install-assets` | off | 同上 |
| 官方认领的（office/badge/acl） | `dsh-office` 等 | on | 它们本来一直在目录里 |

这条区分是实测出来的：早期一律按 off 处理，界面显示 office「关闭」，
模型侧却照样看得见——两边说的不是同一件事。

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

反向（全局关、本会话开）不需要特殊处理：放行永远由**原本提供该技能的那个 provider**
负责——系统级归我们的 visibility provider（它同样按会话读档位），磁盘级归官方
filesystem provider。少一条放行分支，就少一处正文读取、少一个出错的地方。

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
    "/home/u/.dsh/skills/alpha/SKILL.md": { "mode": "off", "name": "alpha", "path": "…", "source": "user-dsh" }
  },
  // 会话覆盖。内层键是**技能名**——注册表的合并与去重都以名字为单位，
  // 用路径做键会出现「同名两条策略、注册表只认一条」的自相矛盾。
  "sessions": {
    "session-1793…": { "alpha": { "mode": "on" } }
  },
  "projects": {}
}
```

## 6. Remote 方法

| 方法 | 参数 | 作用 |
|---|---|---|
| `sessionPolicy` | `{sessionId}` | 该会话的放行策略（含 `mode` / `globalMode` / `overridden`） |
| `setSessionVisibility` | `{sessionId, name, mode, path?, archivePath?, source?}` | 改这一个会话的档位 |
| `resetSessionVisibility` | `{sessionId}` | 清掉该会话全部覆盖，回到跟随默认 |
| `setVisibility` | `{key, name?, path?, mode, …}` | 改全局默认（仓库页滑块） |

`sessionPolicy` 返回 `overridden`：该技能在本会话是否偏离了全局默认。
界面用它区分「仅本会话」与「跟随默认」两种状态，并决定要不要显示「恢复默认」按钮。

## 7. 界面约定

- **仓库页**：系统级与通用级有滑块，项目级**没有滑块**——
  项目级必须按会话调，在仓库里放统一开关只会误导。
- **会话策略弹层**（三个点菜单 →「查看技能策略」）：三种来源**都有**三段式滑块，
  改动只写会话层，立刻生效。
- 仓库页底部有一句说明，讲清这个页面的开关管的是「新会话的默认值」。
