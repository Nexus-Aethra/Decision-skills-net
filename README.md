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
└── ui/        界面：设置页「技能」分区（dsh.client 指向它的 browser 半边）
```

**为什么拆**：每一层都能被单独替换。

| 想做的事 | 只动哪 |
|---|---|
| 接本地决策模型 | 新增插件消费 `skillScanner.catalog()` |
| 加技能过滤器 | 包一层 `skillStore` |
| 换界面 | 只改 `packages/ui` |
| 换数据源 | 只改 `packages/scanner` |

子插件之间只通过**服务名**耦合（`skillScanner` / `skillStore`），不直接 import 彼此的实现。

## 数据来源（四个都必需）

| 来源 | 为什么不能省 |
|---|---|
| `ctx.skills.snapshot({ cwd, scope })` | 覆盖 user / custom / runtime / project |
| 每个工作区的项目根 | 注册表只在**传了 cwd** 时才扫项目根 |
| `<install>/resources/runtime/office-skills` | 8 个 office 技能没有 provider 认领 |
| `app.asar` 内 `dsh-agent-preset/skills` | cordis-plugin-development 等 4 个，磁盘无目录 |

## 关键实现约束

- **不要静态 import `@deepseek-ai/*`**：插件解析不到，会让整个模块导入失败。
  需要的能力用 `ctx.get(服务名)`。
- **Remote 描述符常量必须是** `@deepseek-ai/dsh-typert-protocol/remote-methods`。
- **方法名不能叫 `remove`**：与 `RemoteNamespaceService.prototype` 冲突，整次挂载失败。
- **`client.js` 的 `__ModuleLoader__.load({ id })` 中 id 必须等于包名**。
- **`inject` 不能声明自己要注册的服务**（会永久 pending）。

详见 `.agents/skills/dsh-plugin-debugging`。

## 安装

```
dsh plugin --profile <name> add "link:E:/decision-skills"
```

子插件需要各自可解析（pnpm 会自动处理 workspace；手工 junction 时为每个
`packages/*` 建一个 `@local/decision-skills-<name>` 链接）。

## 已验证

容器实测：12 个技能（8 office + 4 asar）、4 个会话、会话隔离、开关、删除、控制台干净。
