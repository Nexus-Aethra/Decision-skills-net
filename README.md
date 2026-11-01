# Decision-skills-net

DSH（DeepSeek Harness）插件实验仓库：**用本机超小决策模型驱动 skill 的动态加载**。

决策方向不交给主模型，而是交给一个跑在本机 CPU 上的小决策模型——它判断"这一步该加载哪个 skill"，
然后由插件在模型步骤前把该 skill 的正文注入上下文。

## 当前状态

**研究阶段已完成，进入实现前准备。** 可行性结论见 [doc/feasibility-decision.md](doc/feasibility-decision.md)。

## 核心结论（详见 doc/）

- **机制可行**：`agent/pre-step` 可在模型步骤前替换该步消息批；`ctx.skills.list()/get()` 可枚举目录与取正文。
  官方 `dsh-tool-skill` 正是用这条路径注入 skill 目录。
- **CPU 可行**：DSH 自带 `onnxruntime.dll`/`sherpa-onnx.node`（Node-API），纯 CPU 推理有官方先例。
- **市场有空位**：插件市场 4092 个插件中，skill 类 122 个、本地决策模型类 30 个，
  但**"本地 CPU 小模型 + 动态加载 skill 正文"这个组合尚无人发布**。
- **关键风险**：小模型单打 top-1 仅 62%~67%（融合确定性召回后可达 86.9%），
  因此架构必须"召回先挡、模型只裁决边界"；平民 x86 CPU 的实测延迟仍待测。

## 建议形态（MVP）

```
用户消息
  → ① 确定性召回（BM25/词典/名字匹配，~0ms）取 Top-K
  → ② K 小则直接注入；K 大或信号弱时才唤 CPU 小模型裁决（校准概率 + 阈值）
  → ③ agent/pre-step 注入选中 SKILL.md 正文（而非全量目录）
  → ④ 置信不足 / 模型不可用 → fail-open 退回官方目录行为
  → ⑤ eval：从真实会话日志挖标注，量化 top-k recall 与假阳性
```

## 文档

| 文档 | 内容 |
|---|---|
| [doc/feasibility-decision.md](doc/feasibility-decision.md) | 可行性结论备忘（机制 / CPU / 市场三线交叉验证 + MVP 建议） |
| [doc/community-findings.md](doc/community-findings.md) | GitHub 与社区同类实现查重、横向对比 |
| [doc/market-and-api-findings.md](doc/market-and-api-findings.md) | DSH 插件市场现状与插件 API 侦察 |

## 分支约定

调研文档在 `docs/*` 分支积累，经评审后再合入 `main`；功能实现另开 `feat/*` 分支。
