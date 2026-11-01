---
name: dsh-plugin-development
description: Use when designing, reviewing, adding, enabling, disabling, or debugging a DeepSeek Harness plugin, bundle, feature, panel, tool, or MCP connection in this project.
---

# DSH 插件开发（本项目版）

本仓库根目录就是一个可安装的 DSH 插件（`package.json` + `cordis.patch.yml` + `index.js`）。

## 插件最小结构

```
（仓库根）
├── package.json          # dsh.bundle.patch 是"我是 bundle"的唯一标志
├── cordis.patch.yml      # - insert: { id, name, config }
├── index.js              # export function apply(ctx, config)
├── client.js             # 浏览器半边：window.__ModuleLoader__.load({ id, factory })
├── lib/                  # 宿主侧实现
└── locale/zh.json,en.json
```

## 三条必须遵守的规则

1. **不 import 任何 Harness Client 包**（`@deepseek-ai/dsh-client-ui-primitives` 等）。
   它们随时会变，组件一崩，整个插槽会被清空。自带控件 + 只用 `--dsw-alias-*` 主题变量。
2. **client.js 顶层没有 require**。React 只能从 `factory(require)` 的参数里拿，
   模块顶层不得有副作用。
3. **所有注册挂在 apply 的 ctx 上**，`ctx.effect(() => { ...; return cleanup })`。

## Host → Client 通道（typert Remote）

外部包走不到官方的代码生成流水线，因此**手写等价描述符**：

- **宿主侧**：原型上写 `@dsh/typert/remote-method` 描述符 + 实例挂
  `typertRemote = { service, serviceKey, namespace }` + `ctx.provide(ns, instance)`。
- **客户端**：`ctx.remote.$mount(TYPERT_REMOTE)`，每个参数的 codec 必须是
  `mode: 'strict'`，否则 `$mount` 当场拒绝。
- **两处方法清单必须逐项一致**，否则症状是「端点不可达」。

## 已踩过的坑

- `$mount` 返回的是 **Promise**，resolve 出 disposer。直接 `effect(() => DISPOSER)`
  会在 disposer 还是 null 时注册，卸载时挂载泄漏。
- 更糟的是挂载成功后立刻调用 disposer —— 命名空间活了不到一秒，方法全被摘掉。
- 命名空间是**异步**到位的，用状态驱动重渲染，别在首帧读 `ctx.remote.X`。
- **写 SKILL.md 时不要带 UTF-8 BOM**：PowerShell `Set-Content` 默认会加 BOM，
  它让 `startsWith('---')` 失败，技能"莫名消失"，日志里只有一条警告。

## 验证

```
node --check client.js
node --check index.js
```
装 bundle 后重启 DSH，看设置页是否出现目标分区。
