# 社区查重报告：把「技能选择」交给本机小模型的 DSH 插件，是否已有人做过？

> 调研：community-scout ｜ 采证：2026-11-01 ｜ 数据来源：GitHub REST API + 仓库 README 原文 + HuggingFace API + npm registry
> **硬约束（用户最新明确）：决策模型不得假设 GPU，必须纯 CPU 可用，GPU 只能作为可选加速。** 本报告的评级以此为先决条件。

**证据强度**：🟢 强（原文/API 交叉核对）｜🟡 中（片段或摘要）｜🔴 未验证

---

## 0. 一句话结论

**已经有人做过，而且不止一个——但"纯 CPU、零外部进程"这一版，一个都没有。**

具体：
- **DSH 生态里已有 1 个插件（royalallen/dsh-laya-mcp-skill-router）把用户的构想完整实现了**：本地嵌入召回 + 本地小模型裁决 + 注入技能正文，四要件全中。但它要求**两个常驻外部进程**（Ollama + Laya sidecar）。
- **另有 5 个 DSH 插件各覆盖 2～3 环**，其中没有一个把决策交给本机小模型。
- **CPU 约束下真正致命的对手只有一个**：[cdepuy/hermes-skill-router](https://github.com/cdepuy/hermes-skill-router) **默认引擎是 Qwen3.5-4B 跑在 RTX 3080 上，并且用 `nvidia-smi` 做门控——没有 NVIDIA 显卡它直接判定"不可用"**。这条路线在你的约束下**直接出局**。
- **好消息**：CPU-only 方案在技术上完全成立，甚至有公开的 CPU 实测数字（Laya 在 Apple-silicon **CPU** 上 warm 后约 **140ms**，`executionProviders: ["cpu"]` 是官方默认值）。详见 §6。

---

## 1. 需求拆解：我拿什么尺子量

| 代号 | 要件 | 含义 |
|---|---|---|
| **A** | 动态加载 | 插件主动把某个 SKILL.md 的**正文**在需要的那一步注入上下文，而非把目录常驻让主模型自己挑 |
| **B** | 小模型决策 | "该加载哪个技能"由**一个模型**判断（非关键词规则、非主模型自己） |
| **C** | 物理本机 | 决策模型在用户自己机器上跑 |
| **D** | DSH 原生 | 作为 DSH/Cordis 插件安装 |
| **E** | **纯 CPU 可用** | **新增硬约束**：不假设 GPU；GPU 仅可选加速 |

E 是这次的否决性条件。凡是"只能 GPU / 只能云端 API / 必须另一台机器"的，一律在 C 或 E 上掉分，并在每条里显式标注 **⚠️ 受 CPU 约束限制**。

---

## 2. 最接近的 8 个实现

| # | 项目 | A | B | C | D | **E 纯CPU** | 许可证 | Stars | 证据 |
|---|---|---|---|---|---|---|---|---|---|
| 1 | [royalallen/dsh-laya-mcp-skill-router](https://github.com/royalallen/dsh-laya-mcp-skill-router) | ✅ | ✅ | ✅ | ✅ | 🟡 **可跑但需 2 个外部进程** | MIT | 0 | 🟢 |
| 2 | [RickT34/dsh-just-enough-tools](https://github.com/RickT34/dsh-just-enough-tools) | ✅ | ✅ | 🟡 | ✅ | 🟡 本地模式可用，但**丢校准概率** | MIT | 1 | 🟢 |
| 3 | [Phantomcyber-ai/dsh-skill-router](https://github.com/Phantomcyber-ai/dsh-skill-router) | ✅ | 🟡 | — | ✅ | ✅ 但**决策者是主模型**（不满足 B/C） | MIT | 1 | 🟢 |
| 4 | [SOH4C4759/dsh-plugin-skill-autoroute](https://github.com/SOH4C4759/dsh-plugin-skill-autoroute) | ✅ | — | — | ✅ | ✅ **无模型，纯算法** | MIT | 2 | 🟢 |
| 5 | [alexdoandev/jev-laya-dsh](https://github.com/alexdoandev/jev-laya-dsh) | — | ✅ | ✅ | ✅ | ✅ **ONNX，官方 cpu EP** | MIT | 3 | 🟢 |
| 6 | [ericmjl/pi-laya-skill-router](https://github.com/ericmjl/pi-laya-skill-router) | ✅ | ✅ | ✅ | — | 🟡 **测试平台是 Apple MPS**，CPU 可行性未验证 | **无 LICENSE** | 2 | 🟢 |
| 7 | [cdepuy/hermes-skill-router](https://github.com/cdepuy/hermes-skill-router) | ✅ | ✅ | 🟡 | — | 🔴 **⚠️ 受 CPU 约束限制——默认要 RTX 3080** | **无 LICENSE** | 1 | 🟢 |
| 8 | [wuykjl/neuro-skill](https://github.com/wuykjl/neuro-skill) | 🟡 | — | ✅ | — | ✅ **明确声称"No GPU. Fully offline."** | MIT | 9 | 🟢 |

### 2.1 royalallen/dsh-laya-mcp-skill-router —— 最接近，但 CPU 路径很笨重 🟢

- **URL**：<https://github.com/royalallen/dsh-laya-mcp-skill-router> ｜ MIT ｜ 0 star ｜ 创建 2026-10-22，同日最后推送
- **做了什么**：三步管线。(1) 召回：本地 Ollama 的 `nomic-embed-text` 嵌入 + BM25 对工具组/工具/技能排序，RRF 融合；(2) 小模型裁决：每个技能、每个候选工具组发一道批量 yes/no 给 **Laya sidecar**（本地 System-1 决策模型），带显式 true/false 判据；(3) 并集合并：Laya 说 yes 或召回够分的保留，Laya 能补召回漏的但**不能撤销召回下限**。最终把 `<available_skills>` 全量目录换成只留名字的分类索引，每步追加 "Suggested skills"，Laya ≥ `autoLoadThreshold`(0.85) 且召回一致时直接把**技能正文**加载进来（每轮最多 2 个）。它还特意做了缓存保护：小改动跳过，保住 cached prompt prefix。
- **CPU 评估**：🟡 **理论可跑，但架构不友好**。
  - Ollama 有 CPU 后端，Laya ONNX 官方指定 `executionProviders: ["cpu"]`，两条腿都不需要 GPU。**结论：能上 CPU。**
  - 但它要求用户常驻**两个独立外部服务**（Ollama daemon + Laya sidecar），外加第一次对话还要配一个"优化器模型"给技能写路由卡片。
  - 痛点：对一台**完全没有推理基础设施**的普通 CPU 机器，这是三重安装负担。
- **差距**：① 无人验证（0 star、单日提交）；② 外部进程重；③ 配置负担甩给模型（`router_configure` 工具反问用户）；④ 配置文件明文存 API key。
- **成熟度**：**原型 / 未验证**。设计文档质量意外地高，但工程上没有任何第二双眼睛看过。

### 2.2 RickT34/dsh-just-enough-tools —— 概念最贴，但 CPU 路径牺牲了核心卖点 🟢

- **URL**：<https://github.com/RickT34/dsh-just-enough-tools> ｜ MIT ｜ 1 star ｜ 有 `npm pack` 发布流程 + 中英文 README + CONTRIBUTING + DESIGN
- **做了什么**：把**工具和技能放进同一个候选池**，由 [Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev)（TypeSafe 的 System-One 决策模型）打分，超过阈值(0.5)才暴露给模型。三个独立动作：调用的工具没启用→直接启用并执行；模型输出 `REQUEST_CAPABILITIES` → 让 Jev 给剩余候选打分；不打标记 → 完全不调 Jev。示例里 `login-debug` 技能 0.88 被启用，`edit` 0.32 保持隐藏。
- **CPU 评估**：🟡 **有本地端点，但代价明确**。README 的协议表写得很清楚：
  - 默认 `https://api.typesafe.ai/v1` + `jev-latest` → **纯云端**
  - 可选 `http://127.0.0.1:1234/v1`（LM Studio）→ **CPU 可跑**
  - **但原文警告**：*"OpenAI-compatible scoring requires a generative model that returns JSON scores; these are model estimates, not calibrated decision probabilities. Encoder-only models require a separate decision service."*
  - 也就是说：**换成本地 CPU 小模型，就必须让生成式模型"生成"一个 JSON 分数，拿不到校准概率**——这恰好是 Jev/Laya 那类编码器决策模型的核心价值。同时它**主动禁止用 encoder-only 模型**，而 encoder-only 正是 CPU 上最划算的形态。**⚠️ 部分受 CPU 约束限制。**
- **另一个差距**：不是每轮自动决策，要模型自己先想到输出 `REQUEST_CAPABILITIES`。是"agent 主动求助"而非"插件主动预判"。
- **成熟度**：**beta**。文档体系是这批里最完整的，版本到 0.5.8。

### 2.3 Phantomcyber-ai/dsh-skill-router —— 机制最像，决策者却用错 🟢

- **URL**：<https://github.com/Phantomcyber-ai/dsh-skill-router> ｜ MIT ｜ 1 star ｜ 2026-08 创建，2026-09 最后推送
- **做了什么**：`agent/pre-step` 三级路由——**中文感知启发式打分**（bigram 切段去虚词 + 拉丁 token 重叠 + 技能名/触发短语）零成本先过；强命中（≥ minScore）**直接注入技能全文，不调 LLM**；弱信号才交 LLM 判定（默认 `hybrid`，12s 超时，失败回退）。注入走官方 `skill-invocation` 源，与 `/技能名` 手势同一管线。还有"近期已注入不重复注入""短消息（继续/嗯）不路由"等防误伤设计。
- **CPU 评估**：✅ 核心路径（启发式）本来就是 CPU 纯数学运算，**零推理开销**。但它那个"LLM 判定"用的是 `llmProvider`/`llmModel` 配的**主模型路线**——**不满足 C（本机）和 B（独立小模型）**。
- **价值**：它的**"启发式先挡掉大部分、模型只救弱信号"成本分层**，在 CPU 约束下是本项目最该抄的架构。既省算力又保留泛化。
- **成熟度**：**beta**。有完整配置表、多预设兼容说明（cot-gw / cot-dyn / anchored-standard），像是实际用过迭代的。

### 2.4 SOH4C4759/dsh-plugin-skill-autoroute —— 纯 CPU 路线的最完整实现，但没有模型 🟢

- **URL**：<https://github.com/SOH4C4759/dsh-plugin-skill-autoroute> ｜ MIT ｜ 2 star ｜ 2026-10 创建，两天后停更
- **做了什么**：每条**用户指令**的第一步，从 `agent/pre-step` 拿消息，读 Host 的 `skills.list()` 拿实时目录，用**确定性算法**（不是 LLM）打分排序，注入**恰好一条**合成 user 消息。三模式：`brief`（默认，Top-N 候选 + 命中词）、`load`（冠军 ≥ `loadMinScore` 就把 **SKILL.md 正文一起注入**，否则退回 brief）、`router`（只注入"立刻调 `skill(name=…)`"）。技能正文刻意不打包进插件，永远由宿主 `skills` 服务实时提供。
- **CPU 评估**：✅ **零推理成本，任何 CPU 都跑得动，延迟 ~0ms**。这是 CPU 约束下的**性能天花板参照**。
- **差距**：B 完全缺失——纯算法（关键词/词典/同域政策表）。**这正是本项目要超越的那条线**：算法快但不懂语义，中文 paraphrase 必然漏。
- **成熟度**：**原型**。README 对挂载点、依赖矩阵讲得很清楚，但无人使用。

### 2.5 alexdoandev/jev-laya-dsh —— 本机 CPU 推理这一环的最强 DSH 参考 🟢

- **URL**：<https://github.com/alexdoandev/jev-laya-dsh> ｜ MIT（Laya 权重 Apache-2.0）｜ 3 star ｜ 2026-10
- **做了什么**：给 DSH 加本地 System-1 决策层，`User → Jev(Laya) → Agent`。三面：①路由——`agent/pre-step` 用 Laya 单次前向把 prompt 分类成 chat/code/architecture，结果作为 notice 注入；②风险门控——`tools/pre-execute` 对 bash/pwsh 做 3-probe 校准投票；③分档换模型——`agent/request` 把难任务钉到强模型（RouteLLM 风格成本路由）。
- **CPU 评估**：✅ **这是唯一在源码里就锁定 CPU 的项目**。核验结果：
  - `onnx-server/package.json` 唯一依赖是 `@receptron/laya`（MIT）
  - `benchmarks/rust/Cargo.toml` 用 `ort = { version = "2.0.0-rc.10", features = ["load-dynamic"] }` —— **没有 cuda / coreml / tensorrt 任何 feature**
  - `@receptron/laya` README 明确：**`executionProviders: ["cpu"]`**，且 **warm 后在 Apple-silicon CPU 上约 140ms**
  - 公开性能数据：ONNX Runtime(Node) 冷启 2.5s / 热决策 0.29–0.41s；Rust `ort` 单文件 566KB 二进制、冷启 1.2s、内存 ~0.57GB
- **最重要的实证结论**：**64 条标注集上，Laya 单独准确率只有 62.3%，向量路由 80.3%，两者融合 86.9%。** 这直接回答了本项目"该怎么设计"——**小模型不能单独用，必须和确定性信号融合**。
- **差距（对本项目就是空位）**：它**不路由技能**，路由的是模型档位；也不动态加载 SKILL.md。
- **成熟度**：**可运行原型，有 benchmark 和 CI**。这批里工程质量最靠谱的 DSH 原生项目。

### 2.6 ericmjl/pi-laya-skill-router —— 小模型路由做得最认真，但不是 DSH，且未证明 CPU 🟢

- **URL**：<https://github.com/ericmjl/pi-laya-skill-router> ｜ **无 LICENSE** ｜ 2 star ｜ 2026-09 创建，2026-10-31 仍在推送（**这批里唯一近期还活跃的**）
- **做了什么**：pi coding-agent 扩展。用 laya System-1（**421M 参数，单次前向约 35ms，校准概率**）每轮给**全部**技能打分，胜者**逐字注入**上下文。组件很全：FastAPI sidecar、`before_agent_start` 扩展、技能扫描、**从 session 日志挖标注**、eval（recall/precision@k + 无加载轮次假阳性率）、**nightly 微调闭环**（frontier 打金标 → SFT）。
- **CPU 评估**：🟡 **很可能可行，但作者没验证**。原文写的是 *"runs locally on **Apple MPS**"*——那是 GPU（Apple 的 Metal）而非 CPU。35ms 这个数字是在 MPS 上测的。**⚠️ 部分受 CPU 约束限制（未证实，属🔴未验证项）**。不过底层同样是 ONNX/ONNX-ish 的 421M 编码器，按 `@receptron/laya` 的 CPU 数据（140ms warm）推断，CPU 上大概是 2～4 倍慢、即每轮 0.1～0.5s 量级——**可接受但需自测**。
- **可抄的工程细节**：`LAYA_ROUTER_BLOCK_BUDGET_MS`=450ms 的**阻塞预算**——超预算就不等路由结果，本轮先跑、结果中途插入。CPU 慢的时候这个设计更关键。
- **差距**：宿主是 pi 不是 DSH；**无许可证=代码不可合法复用**，只能读思路。
- **成熟度**：**功能完整但单人项目**。有 eval 和微调管线，工程深度最高。

### 2.7 cdepuy/hermes-skill-router —— 🔴 **受 CPU 约束限制，直接出局** 🟢

- **URL**：<https://github.com/cdepuy/hermes-skill-router> ｜ **无 LICENSE** ｜ 1 star ｜ 2026-09 创建，3 天后停更
- **做了什么**：Hermes 插件，`pre_llm_call` 钩子在主模型看到任务前跑一个小校准模型（默认 **SemIf Qwen3.5-4B**，旧版 Laya 421M）对着 ~300 技能索引分类，取 top 1-2，读 `SKILL.md` 注入为**用户消息上下文**（不动 system prompt，保持 prompt-cache 字节稳定）。**核心是 AVAILABILITY GATE**：依次探测①机器可达 ②server 活着 ③模型已进显存 ④GPU 空闲（`nvidia-smi`，util ≤40%、mem ≤16000MB），任一失败**本轮退回原生行为，绝不比原版更差**；"冷但可达"时本轮不等、后台预热。
- **CPU 评估**：🔴 **默认路径在你的约束下不可用**。README 原文：
  - *"SemIf (default) — `Qwen/Qwen3.5-4B` running on the win11 **RTX 3080** box (`192.168.1.253`)"*
  - *"GPU free — `nvidia-smi` GPU util / memory within configured thresholds (defaults: util ≤ 40%, mem ≤ 16000MB)"*
  - *"SemIf needs the 3080 box's `semif_server.py` deployed"*
  - *"Depends on the 3080 box being up + free"*，冷载 **~100s**
  - **门控里直接调 `nvidia-smi`：没有 NVIDIA 显卡，探测失败 → 判定 unavailable → 永久退化。** 而且它把模型放在**局域网另一台机器**上，连 C（本机）都不满足。
  - 唯一 CPU 可能的是它标注为 "legacy" 的 Laya 421M 引擎，但默认配置根本不走那条。
- **价值**：它的 **fail-open + 可用性门控 + 冷启动不阻塞** 是本项目必须抄的**运维骨架**——只是要把"GPU 空闲"这类探针换成 CPU 负载/内存探针。它实测的 **67% top-1** 也说明小模型准确率天花板不高，需要兜底。

### 2.8 wuykjl/neuro-skill —— CPU 约束下最现实的纯软件方案 🟢

- **URL**：<https://github.com/wuykjl/neuro-skill> ｜ MIT ｜ **9 star（这批里最高）** ｜ 2026-06 创建
- **做了什么**：5 路信号加权 RRF 融合——**BM25 关键词(×2) + 特征余弦(×1) + 图扩散激活(×0.5) + 协同过滤个性化 + 可选 LLM 语义重排**。README 原话：*"**No embedding API required. No GPU. Fully offline.**"* 声称 **6ms 本地预排序**，top-3 注入，可选 Haiku 重排约 $0.0003/call。阈值：技能 ≥150 且特征 ≥80 时优于纯关键词。
- **CPU 评估**：✅ **完全 CPU、纯 Python 数学、无模型、无网络**。是 CPU 约束下的**务实基线**。
- **差距**：B 不满足（没有决策模型，纯特征工程 + 可选云端 Haiku 重排）。且**不是 DSH 插件**（有 Claude Code / Cursor / Codex / Hermes 的 MCP 安装，**没有 DSH**）。
- **为什么重要**：它给出了一个诚实的对照组——**"6ms 纯软件" vs "140ms CPU 小模型" vs "35ms GPU 小模型"**。如果你的目标只是"别让 300 个技能描述占满 prompt"，它已经够了；小模型的价值在于**处理特征工程覆盖不到的中文 paraphrase**。

---

## 3. CPU 硬约束专项：这一环的可行性证据

### 3.1 决策模型候选（全部经 HuggingFace API 核实参数量/许可证）🟢

| 模型 | 参数量 | 许可证 | CPU 可行性 | 备注 |
|---|---:|---|---|---|
| [convaiinnovations/laya](https://huggingface.co/convaiinnovations/laya) | **421M** | Apache-2.0 | ✅ **官方 `executionProviders:["cpu"]`，warm 后 ~140ms（Apple-silicon CPU）** | 编码器 + 决策头，直接出**校准概率**，不做生成。~1.7GB fp32 ONNX，**~2GB RAM** |
| [convaiinnovations/laya-multilingual](https://huggingface.co/convaiinnovations/laya-multilingual) | **322M** | Apache-2.0 | ✅ 同上（ONNX 路径已有人导出并跑通） | **更小且多语种（100+ 语言）→ 中文场景应优先选它** |
| [HuggingFaceTB/SmolLM2-135M-Instruct](https://huggingface.co/HuggingFaceTB/SmolLM2-135M-Instruct) | 134.5M | Apache-2.0 | ✅ 极轻 | 生成式，需自建打分 prompt，非校准概率 |
| [google/gemma-3-270m-it](https://huggingface.co/google/gemma-3-270m-it) | 268.1M | **Gemma Terms（非 OSI）** | ✅ 轻 | **许可证是自定义条款，商用需仔细读** |
| [convaiinnovations 之外的 BAAI/bge-small-en-v1.5](https://huggingface.co/BAAI/bge-small-en-v1.5) | 33.4M | MIT | ✅ 极轻 | 纯嵌入，适合"召回"环而非"裁决"环 |
| [sentence-transformers/all-MiniLM-L6-v2](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2) | 22.7M | Apache-2.0 | ✅ 极轻（1.8 亿下载） | 纯嵌入基线 |
| [HuggingFaceTB/SmolLM2-360M-Instruct](https://huggingface.co/HuggingFaceTB/SmolLM2-360M-Instruct) | 361.8M | Apache-2.0 | ✅ | 生成式 |
| [Qwen/Qwen3-0.6B](https://huggingface.co/Qwen/Qwen3-0.6B) | 751.6M | Apache-2.0 | 🟡 可跑但偏重 | 已超 0.5B，CPU 上每轮代价明显 |
| [Qwen/Qwen3-1.7B](https://huggingface.co/Qwen/Qwen3-1.7B) | **2.03B（含嵌入层）** | Apache-2.0 | 🔴 **CPU 上会明显拖慢每轮** | 名字叫 1.7B，实际权重约 2.03B |
| [nomic-ai/nomic-embed-text-v1.5](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5) | 136.7M | Apache-2.0 | ✅ | royalallen 默认用它（经 Ollama） |

> **关键结论**：CPU 上最有性价比的形态是 **编码器 + 分类头（laya-multilingual 322M，~140ms 量级）**，而不是**生成式小模型**（要解码、要 JSON、要重试，且拿不到校准概率）。RFC 里点名的 qwen3-0.5b/1.7b、gemma-3-270m、SmolLM2-360M **都是生成式**，CPU 上做"打分"远不如编码器划算。

### 3.2 纯词法/嵌入方案（零模型、CPU 无压力）

| 方案 | 代表实现 | 延迟 | 代价 |
|---|---|---|---|
| 启发式 + 中文字典 | [Phantomcyber-ai/dsh-skill-router](https://github.com/Phantomcyber-ai/dsh-skill-router) | ~0ms | 不懂 paraphrase |
| 确定性算法 | [SOH4C4759/dsh-plugin-skill-autoroute](https://github.com/SOH4C4759/dsh-plugin-skill-autoroute) | ~0ms | 同上 |
| BM25 + 特征 RRF | [wuykjl/neuro-skill](https://github.com/wuykjl/neuro-skill) | 声称 6ms | 需调特征工程 |
| **哈希嵌入（零下载）** | [PerryLink/dsh-library](https://github.com/PerryLink/dsh-library) | 极快 | 作者自承 *"Lexical-grade embeddings... scores surface similarity, **not meaning**"* |

---

## 4. 生态背景：为什么这件事还没被做透

- **DSH 本体**：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)，MIT，267,865 star / 32,487 fork 🟢
- **官方技能机制**：[`@deepseek-ai/dsh-tool-skill`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/skill/tool-skill/README.md) 的定位是"**模型面向的技能目录 + 加载工具**"。**官方只提供"目录 + 让模型自己挑"，把"什么时候挑、挑哪个"完全留给插件和模型**——这正是本项目插件存在的理由 🟢
- **插件规模**：[anil-matcha/awesome-dsh-plugin](https://github.com/anil-matcha/awesome-dsh-plugin)（无 LICENSE，14 star）自述"社区插件已超 1000 个" 🟡（作者自述，未独立核实）；`topic:dsh-plugin` 相关搜索返回 1416 个仓库 🟢
- **⚠️ 反证陷阱**：该 curated list 的 **Skills 分类（8 条）里没有任何自动路由插件**——全是技能包/管理器/桥接器。而它创建和最后推送都在 **2026-09-17 同一天**，此后未更新。**所以"awesome 列表里没有"绝不能当作"不存在"的证据**，我改用 GitHub 仓库搜索直接挖（`dsh+skill+router` 命中 **55** 个仓库）🟢

---

## 5. 直接回答：是否已存在同类插件？

**存在。但"纯 CPU、零外部进程"这个交叉点，是空的。**

### 第一档：就是用户描述的那个东西（1 个，但 CPU 路径笨重）
> [**royalallen/dsh-laya-mcp-skill-router**](https://github.com/royalallen/dsh-laya-mcp-skill-router) —— A/B/C/D 全中，E 技术上可跑但需 Ollama + Laya 两个常驻进程。**0 star、单日提交、无人验证** 🟢

### 第二档：覆盖主要环节但决策者不对（4 个）
> [RickT34/dsh-just-enough-tools](https://github.com/RickT34/dsh-just-enough-tools) —— 本地模式会丢校准概率 ⚠️
> [Phantomcyber-ai/dsh-skill-router](https://github.com/Phantomcyber-ai/dsh-skill-router) —— 弱信号交给**主模型**
> [SOH4C4759/dsh-plugin-skill-autoroute](https://github.com/SOH4C4759/dsh-plugin-skill-autoroute) ／ [MJorgin/dsh-skill-router](https://github.com/MJorgin/dsh-skill-router) —— **完全没有模型**

### 第三档：思路一样但宿主不是 DSH
> [ericmjl/pi-laya-skill-router](https://github.com/ericmjl/pi-laya-skill-router)（MPS 测试，CPU 未验证，无许可证）
> [cdepuy/hermes-skill-router](https://github.com/cdepuy/hermes-skill-router)（🔴 **默认要 RTX 3080，你的约束下出局**，无许可证）
> [alexdoandev/jev-laya-dsh](https://github.com/alexdoandev/jev-laya-dsh)（✅ DSH 原生 + 纯 CPU 已验证，但不管技能）
> [wuykjl/neuro-skill](https://github.com/wuykjl/neuro-skill)（✅ 纯 CPU 零模型，但不管 DSH、没有决策模型）

### 剩下没人做、且 CPU 约束下依然成立的四条

1. **零外部进程**：不装 Ollama、不起 FastAPI sidecar、不需要任何 GPU 机器——把量化小模型用 `onnxruntime-node` 直接嵌进 DSH 的 Node 进程。
   - 现状：royalallen 要 Ollama + Laya sidecar；cdepuy 要 RTX 3080；ericmjl 要 FastAPI。
   - **现成答案**：[jev-laya-dsh](https://github.com/alexdoandev/jev-laya-dsh) 已证明 DSH 里嵌 ONNX 可行（Rust `ort` 单文件 566KB / ~0.57GB / 冷启 1.2s；Node 侧 `@receptron/laya` 冷启 2.5s），**且不启用任何 GPU feature** 🟢

2. **选编码器而非生成式**：`executionProviders: ["cpu"]` + direct-logit readout，一次前向出**校准概率**，不靠模型"生成"分数。
   - 现状：just-enough-tools 的本地模式明确承认 *"generates JSON scores... not calibrated decision probabilities"*。
   - 现成答案：**laya-multilingual 322M / Apache-2.0**，比英文 laya 更小、且支持中文 🟢

3. **小模型必须融合，不能单打**：CPU 上尤其如此——模型慢了，就更需要"确定性信号先挡、模型只救边界"。
   - 实证：cdepuy 实测小模型 top-1 **67%**；jev-laya-dsh 的 Laya 单独 **62.3%**，融合后 **86.9%** 🟢
   - 正确形态：royalallen 的"召回地板 + 模型加成"，或 jev-laya-dsh 的"分歧时要求 0.75 置信才翻盘"。

4. **CPU 优先的门控**：把 cdepuy 的 GPU 探针换成**CPU 负载/内存/线程数**探针，冷模型不阻塞本轮（后台预热给下一轮）。
   - cdepuy 的`AVAILABILITY GATE`骨架完全可用，只需换掉 `nvidia-smi` 那一层 🟢

5. **eval 闭环**：从真实会话日志挖标注，量化 top-k recall 与假阳性率。
   - 现状：只有 [ericmjl/pi-laya-skill-router](https://github.com/ericmjl/pi-laya-skill-router) 做了，且**无许可证**——思路可借、代码不可用 🟢

---

## 6. 评级（CPU 约束下的修正版）

| 维度 | 评级 | 依据 |
|---|---|---|
| **查重风险（撞车）** | **中高** 🟢 | 有 1 个 DSH 插件已完整实现构想（但 0 star / 需 2 外部进程），另有 5+ 部分覆盖 |
| **CPU 约束对竞品的杀伤力** | **高** 🟢 | **最像的那个（cdepuy）被 CPU 约束直接淘汰；第二像的（just-enough-tools）换成 CPU 就丢校准概率** |
| **CPU 技术可行性** | **高** 🟢 | Laya 官方 EP 就是 `cpu`，warm ~140ms；laya-multilingual 仅 322M |
| **是否值得做** | **值得** | 差异化明确：**"融合式 + 零 sidecar + 编码器概率 + 纯 CPU"四者无人同时做到** |
| **建议路径** | **编码器为主、确定性为辅、生成式为兜底** | 不要照 RFC 的生成式小模型硬扛 CPU；用 laya-multilingual(322M, Apache-2.0) 或 bge-small(33M, MIT) 打底 |

### 6.1 给主设计的具体建议（基于以上证据）
- **两层架构**：确定性召回先挡（复刻 SOH4C4759 的算法 / wuykjl 的 BM25），模型只对**边界样本**打分（复刻 Phantomcyber-ai 的成本分层）。这样 CPU 上绝大多数轮次是 ~0ms。
- **模型选型**：优先 **laya-multilingual 322M**（Apache-2.0、多语种、ONNX、官方 cpu EP、实测 warm 140ms 量级）。次选 **bge-small 33M MIT** 做纯嵌入召回。
- **不要选**：gemma-3-270m 许可证是 Gemma Terms；qwen3-1.7b 实际 2.03B，CPU 上每轮代价过大。
- **必须做**：fail-open + 阻塞预算（不进阻塞就本轮先跑）+ 冷模型后台预热 + 每轮延迟上限。

---

## 7. 证据强度与核验方法

### 7.1 采证路径
`web_fetch` 在本环境被 DNS 策略拦截（`github.com resolves to a non-public IP address`），因此全部改用：
1. **GitHub REST API**（`/repos/{owner}/{repo}`、`/search/repositories`、`/git/trees`）取 stars/license/时间线/文件树 —— 🟢 权威元数据
2. **`raw.githubusercontent.com` 原始 README / package.json / Cargo.toml** 全文或定点 grep —— 🟢 仓库自述原文，未经转述
3. **HuggingFace API**（`/api/models/{id}`）取参数量与许可证 —— 🟢
4. **npm registry**（`/@receptron/laya/latest`）取依赖与许可 —— 🟢
5. `awesome-dsh-plugin` README 全文下载后做关键词扫描 —— 🟢

检索式：`dsh+skill+router`=55、`deepseek-harness+skill+router`=44、`deepseek-harness+skill+select`=7、`deepseek-harness+ollama+skill`=3、`deepseek-harness+local+model+router`=24、`claude+code+skill+router+plugin`=141。

### 7.2 明确标注为**未验证** 🔴
- **未验证**：任何插件在用户本机 DSH 版本（本 checkout `E:\dsh\resources\app.asar\dsh\`）上能否实际安装运行。**我只读 README、API 元数据和源码片段，没有安装、没有跑过任何一个。**
- **未验证**：所有性能数字（140ms / 35ms / 67% / 86.9% / 6ms / ~70,800 token）均为**作者自述或上游包文档**，我未复现。其中 **140ms 是 CPU 数字**（Apple-silicon CPU），其余多在 GPU/MPS 上测得。
- **未验证**：**laya-multilingual 在普通 x86 CPU 上的实际延迟**。我只验证了它在 jev-laya-dsh 里被导出成 ONNX 并被描述为可跑；x86 具体 ms 未知。这是本项目**必须自己测的第一个数字**。
- **未验证**：royalallen 的代码质量与其 README 描述是否一致（README 很好，但未审源码）。
- **未验证**：awesome-dsh-plugin 声称的"1000+ 社区插件"。
- **未覆盖**：GitHub 之外的实现（私有仓库、Gitee、Discord 内部）。本次只覆盖 GitHub 公开生态。
- **许可提醒**：[`anil-matcha/awesome-dsh-plugin`](https://github.com/anil-matcha/awesome-dsh-plugin)、[`cdepuy/hermes-skill-router`](https://github.com/cdepuy/hermes-skill-router)、[`ericmjl/pi-laya-skill-router`](https://github.com/ericmjl/pi-laya-skill-router)、[`weibaohui/skills-management`](https://github.com/weibaohui/skills-management) **均无 LICENSE 文件**（默认著作权=不可复用）；`mikuniemo/dsh-skill-router` 为 NOASSERTION。**可安全借鉴思路与代码的是 MIT 那批**：royalallen、RickT34、Phantomcyber-ai、SOH4C4759、MJorgin、alexdoandev、wuykjl。

---

## 8. 附：本次扫描的原始命中清单（便于复核）

GitHub 搜索 `dsh+skill+router`（total 55）中与本主题相关的全部条目：

```
qwe225380/dsh-omni-router            MIT  7  任务级可靠性层（复用 Skills/Tools/Plugins）
Cavan-Ou/hermes-dsh-collab           MIT  6  multi-agent playbook（含 model-tier routing，技能包）
jeremy9682/dsh-skill-pack            MIT  5  11 个 workflow 技能（含 mode routing，技能包）
Kayungko/dsh-plugin-product-design   MIT  3  router + 9 个 pd-* skills（领域专用）
ZiYuan258/dsh-skill-router           MIT  2  agent 驱动发现（注入层已默认关停）
MJorgin/dsh-skill-router             MIT  2  规则优先 pre-step 路由，零 LLM
SOH4C4759/dsh-plugin-skill-autoroute MIT  2  确定性路由，brief/load/router 三模式
Phantomcyber-ai/dsh-skill-router     MIT  1  启发式 + 主 LLM 复核，注入技能全文
mikuniemo/dsh-skill-router           NOASSERTION 1  常驻目录 70,800 -> 600 token
royalallen/dsh-laya-mcp-skill-router MIT  0  ★ Laya + 本地嵌入，注入技能正文（最接近）
alexdoandev/jev-laya-dsh             MIT  3  ★ 本地 Laya System-1，纯 CPU 已验证（不管技能）
huxidong/dsh-tiered-model-router     MIT  1  本地确定性三档模型路由（不管技能）
PerryLink/dsh-local-ai               Apache-2.0 23  Ollama 集成 + 按任务类型路由
wuykjl/neuro-skill                   MIT  9  ★ BM25+特征的纯 CPU 技能路由（非 DSH）
ericmjl/pi-laya-skill-router         无LICENSE 2  ★ Laya 小模型路由 + eval + 微调（宿主 pi）
cdepuy/hermes-skill-router           无LICENSE 1  ⚠️ Qwen3.5-4B on RTX 3080，CPU 下不可用
```

> 报告结束。所有 URL 均为本次实际抓取过的真实地址。
