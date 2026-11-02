---
name: dsh-plugin-debugging
description: Use when a DeepSeek Harness plugin crashes the Web boot, shows "entry did not activate", fails to mount its Remote namespace, or renders nothing in a slot. Covers the exact failure chain and how to verify in a dshbox container before touching a live profile.
---

# DSH 插件调试

从零搭一个 DSH 插件时，失败几乎总发生在这五个位置之一。
按顺序查，不要跳步——它们的报错信息全都长得像"插件坏了"。

## 铁律：先容器，后真机

**永远不要直接把插件装进正在使用的 profile 验证。** 一个 client 侧异常会让
整个 Web 起不来，宿主只报一行 `1 entry did not activate`。

```
# 建隔离容器（与目标同版本）
容器模板 = github.com/deepseek-ai/deepseek-harness:dsh-v<同名版本>

# 装插件（容器停了才能改 profile）
把仓库 junction 到 <实例>/profile/profiles/web/node_modules/@local/<包名>
在 profile 的 package.json 里把包名加进 dsh.profile.bundles 与 dependencies
启动容器 → 打开 UI → 看控制台
```

**改 profile 的 package.json 时不要用 PowerShell `Set-Content -Encoding UTF8`**：
它会写 BOM，宿主 JSON 解析直接失败（`cannot parse profile: expected value at line 1 column 1`）。
用 `[System.IO.File]::WriteAllText($p, $json, (New-Object System.Text.UTF8Encoding($false)))`。

## 失败链：五个真实坑

### 1. 顶层访问 window 没有守卫

```js
// 错：宿主可能在非浏览器上下文执行这个文件
window.__ModuleLoader__.load({ ... })

// 对
if (typeof window === 'undefined' || !window.__ModuleLoader__) return
```

症状：Web 完全起不来，控制台只有 `entry did not activate`。

### 2. inject 没声明，或声明了自己要注册的服务

```js
// 错：运行时抛 "cannot get property 'locale' without inject"
return { apply }

// 错：声明自己要注册的命名空间 → fiber 永远 pending
return { inject: ['slots', 'locale', 'remote', 'remote.myNs'], apply }

// 对
return { inject: ['slots', 'locale', 'remote'], apply }
```

报错形如 `pending (waiting for service: remote.myNs)`——**这个服务是你自己要注册的**。
命名空间挂上后用 `ctx.get('remote.<ns>')` 现取，不要写进 inject。

另外 `inject` 必须是 **factory 返回对象的属性**，不是模块导出。

### 3. typert 描述符：常量名、result、参数个数

手写 Remote 描述符（外部包走不到官方的生成流水线）时三个必查项：

```js
const DESCRIPTOR_KEY = '@deepseek-ai/dsh-typert-protocol/remote-methods'  // 自造名字会静默失败
// 每个描述符必须有 result codec，否则运行期抛
//   "Cannot read properties of undefined (reading 'mode')"
result: { mode: 'strict', typeSymbol: '...#method:result', create: PASS_THROUGH }
```

**参数个数必须与宿主方法实参逐个对应**：
`list()` 就是 0 个参数，客户端传 `{}` 会得到 `gateway/arguments-invalid`。
`setEnabled(request)` 就是 1 个，description 里写 `{ request }` 再包一层会让参数静默丢失。

### 4. 方法名撞了命名空间保留字

```
client api: method "myNs/remove" conflicts with its namespace service
```

`RemoteNamespaceService.prototype` 自带 `remove`、`get`、`has`、`install` 等方法。
**不要用 `remove`**，改名 `removeSkill` 之类。这个错误会让整次 `$mount` 失败，
表现为「端点全部不可达」。

### 5. 静态 import 宿主包解析不到

```js
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'  // 多半解析失败
```

`@deepseek-ai/*` 在 harness 自己的树里，不在插件能解析的位置。
**不要静态 import**：手工复刻所需行为。

```js
// 复刻 TypertRemoteService 的两件事
this.ctx = ctx
this.typertRemote = Object.freeze({ service: this, serviceKey: NS, namespace: NS })
const dispose = ctx.provide(NS, this)
ctx.effect(() => dispose, 'label')
```

## 宿主不告诉你原因，所以自己留痕

官方 `boot-client.ts` 的审计只报 `<name>: failed`，**不打印异常**。
所以 apply 内必须自己打到控制台：

```js
const DIAG = (phase, detail) => { try { console.error('[pkg] ' + phase + ': ' + detail) } catch {} }
...
try { /* apply 主体 */ }
catch (error) { DIAG('apply', error.message + '\n' + error.stack); throw error }
```

这条 DIAG 是唯一能看见真实原因的东西。第一次崩溃时没有它，
只能靠一行 "failed" 去猜。

## $mount 是异步的，disposer 要晚拿

```js
// 错：effect 是同步的，此刻 disposer 还是 null，卸载时泄漏
ctx.effect(() => mounted.then(d => d))

// 错：挂载成功立刻调用 disposer，命名空间活不到一秒
mounted.then(d => d())

// 对：稳定引用包装
const ref = { current: null }
Promise.resolve(mounted).then(d => { ref.current = typeof d === 'function' ? d : null })
ctx.effect(() => () => { ref.current?.(); ref.current = null })
```

## 铁律二：先找系统已有的服务，再考虑自己实现

**这是本项目踩得最久的一类坑。** 想拿某类数据时，先问宿主有没有现成服务，
而不是直接去读底层存储。

实例：会话列表。

```js
// 错：自己扫目录 + 自己写过滤规则
const dirs = await readdir(join(DSH_HOME, 'sessions'))
// 结果：侧边栏 1 个会话，插件显示 7 个 —— 空壳会话全被算进去了

// 对：问系统的会话插件
const items = (await ctx.get('sessionController')?.list({}))?.items
```

`sessionController.list()` 内部已做完三层过滤：可见性（remoteAccess）、
cwd、`blank`（没有消息的空会话）。**自己重实现就会和界面对不上**，
而且每补一条规则就换一种形式出错。

判断方法：**界面上看到的东西，就去找驱动那个界面的服务**。
侧边栏、列表页、面板——各自都有对应的 host 服务，它们已经把
"显示什么、怎么排、过滤什么" 算好了。插件只该复用，不该重算。

同类例子：

| 想拿 | 用这个 | 不要用 |
|---|---|---|
| 会话列表 | `ctx.get('sessionController').list()` | 扫 `sessions/` 目录 |
| 技能目录 | `ctx.skills.snapshot()` | `readdir` 技能根 |
| 工作区列表 | `ctx.get('workspaceRegistry').list()` | 读 `workspace.json` |

磁盘扫描只在**服务确实缺失**时作为兜底，且要在注释里写明为什么退化。

## 技能从哪来：注册表比扫盘可靠

不要自己 `readdir` 技能根。`ctx.skills.snapshot({ cwd, scope })` 覆盖六类 source：

| source | 说明 |
|---|---|
| `bundled` | 随宿主发布，实体可能在 **app.asar 内**，磁盘上没有目录 |
| `user-dsh` / `user-agents` | 用户级 |
| `custom` / `runtime` | 自定义与运行时注册 |
| `project-dsh` / `project-agents` | **只在传了 cwd 时才扫描** |

两个必知事实：

1. **不传 `cwd` 就没有项目级技能**。要跨工作区浏览，就对每个工作区各查一次。
2. **`scope` 决定会话隔离**：省略 = 全局层；传 agent = 该会话完整作用域链。
   这是「每个会话独立技能上下文」的实现基础。

### asar 里的技能要自己解

`<install>/resources/app.asar` 内的 `dsh-agent-preset/skills/*` 有 4 个技能
（cordis-plugin-development 等）。磁盘上没有目录，注册表也不认。

读法：解析 asar 头（8 字节前缀 → 4 字节长度 → JSON 头 → 数据区，offset 相对数据区起点）。

**坑：asar 里的 SKILL.md 可能没有 `---` frontmatter 分隔符**，直接以 `name:` 开头。
`parseFrontmatter` 认不出，需要补一个合成的分隔符再解析。表现为「目录读到了但技能数 0」。

## 其他实测坑

- **`.trash` 子目录会被当成技能**：移走技能时目标目录要么放技能根之外，
  要么在扫描时排除 `.trash`。
- **改完文件注册表可能用旧缓存**：删除/移动技能后界面「删了没反应」，
  磁盘上其实已经变了。需要主动失效 provider。
- **别用 `ctx.sessions.list()` 当会话列表**：源码注释写明只返回
  "All live sessions"，重启即归零。列会话请用 `sessionController.list()`（见铁律二）。
  精简部署里该服务可能只有 `searchSessions` 没有 `listSessions`，两种都要试。
- **原生 `<select>` 的 option 读不到**：无障碍树里不暴露，自动化测试拿不到，
  样式也难统一。用按钮 + 列表自绘。
- **主题变量不是随便起的**：真实可用的是 `--dsw-alias-bg-layer-1/2/3`、
  `--dsw-alias-border-l1`、`--dsw-alias-label-primary/secondary/tertiary`、
  `--dsw-alias-state-business-primary` 等。**`--dsw-alias-bg-container` 不存在**，
  用了会渲染成透明或黑块。不确定时去 CSS 里搜一遍真实令牌。

## 验证清单

```
node --check client.js
node --check index.js
node --check lib/*.js
```

装好后在容器里确认：

1. 页面能渲染（不是空白），控制台无 error
2. 设置里出现目标分区
3. 数据能读出来（列表非空 / 有正确的计数）
4. 写操作真的落盘（`Test-Path` 查文件）
5. 交互后界面刷新

**只有容器通过之后，才装进真机 profile。**
