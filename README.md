# decision-skills

DSH（DeepSeek Harness）技能管理器：**整合包**，内含四个职责单一的子插件。

> 仓库根即包根。`cordis.patch.yml` 一个 insert 插入四行，每行一个子插件。

## 架构

```
packages/
├── shared/    常量与纯函数：source 归类、行形状、服务名、事件名
├── scanner/   采集：注册表 + 项目根 + 安装目录 + asar 内置技能
├── store/     写入：开关（改 frontmatter）、删除（移入回收目录）
├── api/       协议：对外 Remote 面（list / listForSession / read / setEnabled / removeSkill）
└── ui/        界面：仓库页 + 会话策略弹层（dsh.client 指向它的 browser 半边）

scanner/ 内部：index.js 采集、prefs.js 两层状态、visibility.js 全局可见度、
session.js 会话级执行端、notifier.js 变更通知、asar.js 读内嵌资源
```

**为什么拆**：每一层都能被单独替换。

| 想做的事 | 只动哪 |
|---|---|
| 接本地决策模型 | 新增插件消费 `skillScanner.catalog()` |
| 加技能过滤器 | 包一层 `skillStore` |
| 换界面 | 只改 `packages/ui` |
| 换数据源 | 只改 `packages/scanner` |

子插件之间只通过**服务名**耦合（`skillScanner` / `skillStore` / `skillManager`），
不直接 import 彼此的实现。

## 数据来源（四个都必需）

| 来源 | 为什么不能省 |
|---|---|
| `ctx.skills.snapshot({ cwd, scope })` | 覆盖 user / custom / runtime / project |
| 每个工作区的项目根 | 注册表只在**传了 cwd** 时才扫项目根 |
| `<install>/resources/runtime/office-skills` | 8 个 office 技能没有 provider 认领 |
| `app.asar` 内 `dsh-agent-preset/skills` | cordis-plugin-development 等 4 个，磁盘无目录 |

## 两套状态：仓库默认 vs 会话策略

| 层 | 存在哪 | 管什么 | 在哪改 |
|---|---|---|---|
| 全局默认 | `prefs.visibility` | **新会话**默认长什么样 | 仓库页的三段式滑块 |
| 会话覆盖 | `prefs.sessions[<sessionId>]` | **这一个**会话里放不放行，改完立刻生效 | 会话菜单 →「查看技能策略」 |

分仓：系统级（内嵌只读）/ 通用级（`~/.dsh/skills`）/ 项目级（各工作区 `.agents/skills`）。
仓库页对系统级、通用级给滑块，项目级**没有滑块**——项目级必须按会话调，
在仓库里放统一开关只会误导。

两边都有分类分页（仓库页三页，策略弹层四页：全部 + 三层），页签带条数。
输入框打 `/` 弹出的「技能」分组也按**本会话**的策略过滤（被拦的不出现）。

> 细节（注册表分层、遮蔽机制、为什么宿主里有两个注册表、被屏蔽的行怎么保住）
> 见 [doc/session-skill-policy.md](doc/session-skill-policy.md)。

## Remote 方法

| 方法 | 作用 |
|---|---|
| `list` | 仓库页数据（三个仓库 + 各项目 + 会话列表） |
| `listForSession` | 按某个会话的作用域列技能 |
| `sessionPolicy` | 该会话的放行策略（每行带 `mode` / `globalMode` / `overridden` / `visible`） |
| `read` | 读技能正文 |
| `setVisibility` | 改全局默认档位 |
| `setSessionVisibility` | 改这一个会话的档位 |
| `resetSessionVisibility` | 带 `name` 只清这一条，不带清整个会话 |
| `setEnabled` / `removeSkill` / `promoteSkill` | 改 frontmatter / 移入回收目录 / 提升为通用级 |

## 关键实现约束

- **不要静态 import `@deepseek-ai/*`**：插件解析不到，会让整个模块导入失败。
  需要的能力用 `ctx.get(服务名)`。
- **Remote 描述符常量必须是** `@deepseek-ai/dsh-typert-protocol/remote-methods`。
- **方法名不能叫 `remove`**：与 `RemoteNamespaceService.prototype` 冲突，整次挂载失败。
- **`client.js` 的 `__ModuleLoader__.load({ id })` 中 id 必须等于包名**。
- **`inject` 不能声明自己要注册的服务**（会永久 pending）。
- **provider 的 `list()` 里绝不能回头调 `ctx.skills.*`**：那是
  `collect → provider.list() → snapshot → collect` 的无限递归，最终把宿主撑到 OOM
  （退出码 134）。provider 只能读 prefs 与内存。
- **遮蔽候选出现后，真实条目就从快照里消失了**：目录侧必须把它补回成一整行，
  否则用户一关就再也找不到这个技能。
- **官方 source 覆盖不了，只能包**：`/` 菜单的「技能」分组由
  `dsh-client-ui-skill` 注册，`registerSource` 对同名 `(trigger, name)` 直接抛错，
  契约里也没有 filter。对齐门户的做法是包一层它的 `candidates()` 做减法
  （见 doc §3.8）；形状不对就放弃，菜单维持原样。

详见 `.agents/skills/dsh-plugin-debugging`。

## 安装

```
dsh plugin --profile <name> add "link:E:/decision-skills"
```

子插件需要各自可解析（pnpm 会自动处理 workspace；手工 junction 时为每个
`packages/*` 建一个 `@local/decision-skills-<name>` 链接）。

## 已验证

容器实测（dshbox，dsh-v0.2.1-rc.5）：

- 仓库页 系统级 12 / 通用级 1 / 项目级 2，顶部分页切换正常
- 会话策略弹层 全部 15 / 系统级 12 / 通用级 1 / 项目级 2，三段式滑块改完立刻生效
- 真实模型回合：放行 → 返回 `<skill_content>`；拦截 → `not available for model invocation`
- 被屏蔽的条目**仍然留在列表里**（否则没地方点回来），重启宿主后描述与归属都还在
- 单元测试 12 条（11 过 1 跳过——真实注册表那条需要宿主安装目录）
