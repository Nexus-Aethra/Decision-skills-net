# 决策：DSH「本地小模型动态选技能」插件 —— 可行性结论

> 结论日期 2026-11-01 ｜ 由 lead 汇总，两条独立侦察线交叉验证
> 证据来源：[community-findings.md](community-findings.md)（GitHub/社区）、[market-and-api-findings.md](market-and-api-findings.md)（市场/API），以及 lead 直接读取 app.asar 源码与 dsh-plugin-catalog 索引（4092 条，均实测）

## 一、结论先行

**可行，而且值得做；但"纯 CPU、零外部进程、本地小模型决策"这个组合目前是空位。**

打分：**机制可行性 9/10 ｜ CPU 可行性 8/10 ｜ 撞车风险 中高 ｜ 差异化空间 明确存在**

## 二、机制侧：完全成立（已从源码实证）

| 能力 | API | 实证 |
|---|---|---|
| 每步前注入/替换上下文 | `agent/pre-step`（waterfall；可 `reject` 整步，或整体替换该步 messages） | 官方 `dsh-tool-skill` 正是这样注入 `<available_skills>` 目录；`dsh-agent-instructions` 同用此钩子注入指令 |
| 枚举技能目录 | `ctx.skills.list()` / `snapshot()` | `dsh-skill/lib/index.js:224/234` |
| 取技能正文 | `ctx.skills.get(name)` → 含 body | 同上 L250 |
| 注册运行时技能 | `ctx.skills.register({name,description,content})` | 官方 `dsh-skill-badge` 即此用法 |
| 不唤醒 agent 的注入 | `Agent.inject()` | `dsh-agent` 内实现 |
| 工具门控 | `ctx.tools.guard/restrict` | api-catalog |

> 关键设计约束（来自官方 practices）：**会话日志是唯一事实源**，注入内容必须可从已提交事件重建；`agent/pre-step` 改写决策时要 spread 保留其它字段；**未被选中时必须 `return next()`**。

## 三、CPU 侧：可行，且已有先例

- **宿主自带 CPU 推理底座**：`onnxruntime.dll`(17.8MB)、`sherpa-onnx.node`、`koffi.node` 均在 `app.asar.unpacked` 内，且是 Node-API（无 ABI 重编译问题）。官方 `sensevoice` 插件即为先例。
- **CPU 实测数字**：`dsh-router-laya` 的 ModernBERT 842MB，**CPU 推理 <1s**；Laya 官方默认 `executionProviders: ["cpu"]`。
- **决策模型形态**：应选**编码器 + 决策头**（`noul`/`choice`/`score`），一次前向直接给**校准概率**；**不要选生成式小模型**（要解码、要 JSON、拿不到校准概率，CPU 上最不划算）。
- **推荐选型**：`laya-multilingual` 322M（Apache-2.0，100+ 语种，适配中文），ONNX int8 后体积可控。
- **必须的降级链**：模型不可用时 fail-open（照常放行/退回确定性召回），绝不阻塞回合。

## 四、市场侧：撞车分析（实测 4092 插件）

- skill 分类 **122 个**；Jev/Laya/决策模型类 **30 个**；**两者都沾的只有 2 个，且都不是"小模型选 skill"**：`dsh-jev-tools`（用 Jev 裁剪工具输出）、`dsh-typesafe-ai-skill`（把 Jev 能力注册成 skill）。
- 已有 skill 路由实现但决策器不对：
  - `dsh-plugin-skill-autoroute` —— 纯确定性算法，**无模型**
  - `@lyteboat/skill-router` / `dsh-skill-router` 系 —— 交给**主模型**
  - `skill-bartender` —— **路由表 + 元技能**，启发式
- 唯一 CPU 小模型插件 `dsh-router-laya` 路由的是**思考档位**，不是 skill。
- **空位确认**：把"本地 CPU 决策模型"接到"skill 选择"上，目前无人发布。

## 五、风险与必做验证

1. **小模型单打准确率只有 62%~67%**，融合确定性召回后可达 86.9%（多个实现实测一致）。
   → 架构必须是「**确定性召回先挡掉大部分 + 模型只裁决边界**」，不能每轮都跑模型。
2. **CPU 延迟未在 x86 平民机上实测**（140ms 是 Apple-silicon 数据）——**这是启动前第一个要测的数字**。
3. **权重分发**：<30MB 打进 npm；>30MB 用"小包 + 首次运行下载 + sha256 + 多源镜像"。注意本机 `.npmrc` 指向 npmmirror，**不能靠 postinstall 下载权重**。
4. **许可证**：优先 Apache-2.0/MIT；避开 gemma（自定义条款）与无 LICENSE 的仓库。

## 六、建议的最小可行形态（MVP）

```
用户消息
  → ① 确定性召回（BM25/词典/名字匹配，~0ms）取 Top-K
  → ② K 很小时直接注入；K 大或信号弱时才唤 CPU 小模型裁决（校准概率 + 阈值）
  → ③ agent/pre-step 注入：选中的 SKILL.md 正文（而非全量目录）
  → ④ 置信不足 / 模型不可用 → fail-open 退回官方目录行为
  → ⑤ eval：从真实会话日志挖标注，量化 top-k recall 与假阳性
```

关键差异化（相对现有插件）：**零外部进程**（不装 Ollama、不起 sidecar）+ **编码器校准概率**（非生成式凑分）+ **CPU 优先门控**（CPU 负载/内存探针，冷模型不阻塞本轮）。

## 七、一句话答复

> 可行，机制与 CPU 两条路都已被实证打通；市场上确有人做过相近的（skill 自动路由、Jev/Laya 决策模型两个族群各自成熟），但**没有一个是"本地 CPU 小模型 + 动态加载 skill 正文"**——这个交叉点仍是空的。真正的技术风险不在"能不能做"，而在**小模型准确率（需融合召回）**和**平民 CPU 的实测延迟**这两件事上。
