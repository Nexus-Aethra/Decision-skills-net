# decision-skills

DSH（DeepSeek Harness）插件：**跨全部工作区与系统级的技能管理器**。

在设置里新增「技能」分区，一屏看完系统级与每个工作区的 `SKILL.md`，并可开关任意技能。

> 仓库根就是包根：`package.json` + `cordis.patch.yml` + `index.js` 直接在本目录，
> 整个仓库可直接作为一个 bundle 安装。

## 功能

| 能力 | 说明 |
|---|---|
| 浏览系统级 | `~/.dsh/skills`（rank 400）、`~/.agents/skills`（rank 500） |
| 浏览项目级 | 每个已注册工作区的 `.dsh/skills`（rank 100）与 `.agents/skills`（rank 200） |
| 开关 | 改写 frontmatter 的 `disable-model-invocation` / `user-invocable` |
| 预览 | 读取技能正文，设置页内联展开 |

## 为什么改 frontmatter 而不是移动文件

`disable-model-invocation` 与 `user-invocable` 是**机制内的正规开关**：注册表与 `/` 菜单
都尊重它们。改动后第一方 `write` 会触发 `fs/observed`，目录在下一个模型步骤即刷新，
无需重启。不移动文件，项目目录结构与 git 历史保持可读。

停用会同时写入两个键：

```yaml
disable-model-invocation: true   # 模型目录不出现
user-invocable: false            # / 菜单不出现
```

启用则**移除**这两个键，回到「省略字段 = 默认允许」的官方语义。

> 值必须是合规布尔字面量。写成别的值会让**整份技能被丢弃**，且只在日志留警告。

## 结构

```
.
├── package.json          # dsh.bundle.patch 声明自己是 bundle
├── cordis.patch.yml      # insert 一行 decision-skills
├── index.js              # Host 入口：挂 skillManager Remote 服务
├── client.js             # 浏览器半边：设置分区
├── lib/
│   ├── discovery.js      # 扫描系统根与全部工作区项目根
│   ├── mutate.js         # 开关：改写 frontmatter
│   └── service.js        # Remote 服务：list / read / setEnabled
└── locale/zh.json,en.json
```

## Host ↔ Client 通道

外部包走不到官方的 `@deepseek-ai/dsh-typert-generator` 代码生成流水线，
因此**手写等价描述符**（照 `@local/dsh-paper-fetch` 已验证的做法）：

- **Host**：原型上写 `@dsh/typert/remote-method` 描述符，实例挂
  `typertRemote = { service, serviceKey, namespace }`，再 `ctx.provide(ns, instance)`。
- **Client**：`ctx.remote.$mount(TYPERT_REMOTE)`，参数 codec 必须是 `mode: 'strict'`。
- **两处方法清单必须逐项一致**，否则症状是「端点不可达」。

## 安装

```
# 通过插件管理器安装本目录
install_bundle → 传入本仓库绝对路径
```

## 已知边界

- `ctx.workspaceRegistry` 缺失时退化为「只有系统根」，不报错。
- 工作区路径与系统根重复时（工作区恰好是 `$HOME`）按规范化路径去重。
- 删除技能尚未实现（本次只做浏览与开关）。
- 技能根按路径扫描，因此**未注册为工作区**的目录不会被列出。
