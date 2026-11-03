/**
 * 会话级策略的**执行端**（session enforcement）。
 *
 * 要解决的问题：仓库页的开关只能表达「默认策略」，
 * 而开发者真正想要的是「这个会话里，这个技能放不放行」——
 * 会话之间来回切换去改仓库极不方便。
 *
 * ── 机制 ──────────────────────────────────────────────────────
 * 注册表的合并规则是**近层覆盖远层**：
 *   collectFresh(): layers = [global, ...chainLayers(scope)]
 *                   merged.set(entry.candidate.name, entry)  // 后写赢
 * 而 provider 只能**添加**候选，删不掉别人加的候选。
 *
 * 所以屏蔽一个技能的干净做法是**在更近的层遮蔽同名**：
 * 往这个会话自己的作用域层注册一个 provider（rank = 1），
 * 对要屏蔽的名字返回 invocation.modelInvocable === false 的候选。
 * 同层内按 rank 排序取先，1 压过官方的 100~600；
 * 那条候选两个开关都是 false，官方目录过滤（isModelInvocable）
 * 把它整个滤掉，`skill` 工具按名字加载也会被拒
 * （tool-skill 里 "not available for model invocation"）。
 *
 * 这个 provider **只做屏蔽**，不做放行：
 * 放行永远由「谁本来提供这个技能」负责——系统级归 visibility provider
 * （它同样按会话读档位），磁盘级归官方 filesystem provider。
 * 少一条放行分支 = 少一处正文读取 = 少一个出错的地方。
 *
 * ── 为什么这不是 hack ─────────────────────────────────────────
 * 只用公开 API：`agent.ctx.skills.registerProvider(...)`。
 * 注册表按「调用方 ctx 的作用域」入层（registerProvider →
 * layers.effect(scopeOf(ctx))），而 cordis 的服务访问器会把 service.ctx
 * 重绑到访问方，所以从 agent.ctx 调就落在**这个会话**的层里，
 * 只影响这一个会话。注册挂在会话自己的 fiber 上，会话结束自动注销。
 * 不碰磁盘、不碰官方 provider、不改别人的代码。
 *
 * ⚠️ 铁律：list() 绝不能回头调注册表（ctx.skills.snapshot / list）。
 *    那是 collect → provider.list() → snapshot → collect 的无限递归，
 *    会把 host 进程撑到 OOM（退出码 134）。
 *    这里只读 prefs 与内存，一个宿主服务都不碰。
 */
import { loadPrefs, resolveMode, sessionOverrides, globalEntries, NAME_RE, defaultMode } from './prefs.js'

/** provider 名。带 sessionId 只为日志可读；每个会话独占一层。 */
export const SESSION_PROVIDER_PREFIX = 'decision-skills-session:'

/**
 * 遮蔽候选的 rank：必须小到能压过官方 provider 的 rank（100~600）。
 * 同层内 compareIndexedCandidates 先比 rank，再比注册顺序。
 */
const PRIORITY_RANK = 1

/**
 * 算出这个会话里**需要屏蔽**的技能名。
 *
 * 只看两处，不需要知道技能从哪来：
 *   ① 全局默认里被关掉的（按名字）
 *   ② 会话自己显式调过的（压过全局）
 * 没出现在这两处的技能一律不干预——它们本来怎样就怎样。
 *
 * @param {object} prefs
 * @param {string} sessionId
 * @param {Array<{name: string, scope?: string}>} [knownRows] 已知技能行（可为空）
 * @returns {Set<string>}
 */
export function blockedNamesFor(prefs, sessionId, knownRows = []) {
  const blocked = new Set()
  // 已经由显式配置定过调的门类；③ 不再改动它们。
  // 这条约束保证「会话里点了开启」不会被后面的兜底逻辑悄悄推翻。
  const decided = new Set()

  // ① 全局默认关闭项。系统级技能的键就是名字；磁盘级写入时带 name。
  for (const entry of globalEntries(prefs)) {
    if (entry.name === null) continue
    decided.add(entry.name)
    if (entry.mode !== 'on') blocked.add(entry.name)
  }

  // ② 会话覆盖压过全局。
  for (const row of sessionOverrides(prefs, sessionId)) {
    if (!NAME_RE.test(row.name)) continue
    decided.add(row.name)
    if (row.mode === 'on') blocked.delete(row.name)
    else blocked.add(row.name)
  }

  // ③ 兜底：已知行里没被显式配置过、但按默认档位不该放行的。
  //    主要覆盖两种：
  //      - 历史数据（全局键只有路径、名字丢了），靠行本身反查出档位
  //      - 系统级里只有我们能提供的技能（默认 off）
  //    绝不覆盖 ①② 已经定过的名字。
  for (const row of knownRows) {
    if (typeof row?.name !== 'string' || !NAME_RE.test(row.name)) continue
    if (decided.has(row.name)) continue
    if (resolveMode(prefs, sessionId, row) !== 'on') blocked.add(row.name)
  }

  return blocked
}

/**
 * 造这个会话的策略 provider（只屏蔽）。
 *
 * @param {object} deps
 * @param {string} deps.sessionId
 * @param {() => Array<{name: string, scope?: string}>} [deps.knownRows]
 *        已知技能行；给不出来也不影响主流程（只是少了历史数据兜底）
 * @returns {object} SkillProvider
 */
export function createSessionProvider({ sessionId, knownRows }) {
  const providerName = SESSION_PROVIDER_PREFIX + sessionId

  return {
    name: providerName,

    async list() {
      // ⚠️ 只读 prefs 与已知行。任何 ctx.skills.* 调用都会构成递归 → OOM。
      const prefs = await loadPrefs()
      let rows = []
      try { rows = typeof knownRows === 'function' ? knownRows() : [] } catch { rows = [] }
      const blocked = blockedNamesFor(prefs, sessionId, Array.isArray(rows) ? rows : [])

      const out = []
      for (const name of blocked) {
        out.push({
          name,
          // description 不能为空（validateCandidate 拒绝空串），
          // 但这条候选对模型永远不可见，内容合规即可。
          description: "hidden by this session's skill policy",
          invocation: { modelInvocable: false, userInvocable: false },
          source: 'runtime',
          provider: providerName,
          rank: PRIORITY_RANK,
          locator: { policy: 'blocked', name },
        })
      }
      return out
    },

    async get() {
      // 被屏蔽的技能不该被加载。
      return undefined
    },
  }
}

/**
 * 往一个**会话的作用域层**挂上策略 provider。
 *
 * 关键：用 `agent.ctx` 而不是插件自己的 ctx。
 * 只有从 agent.ctx 调，候选才落进这个会话的层，
 * 从而只影响这一个会话，其他会话完全不受干扰。
 *
 * @param {any} agent 会话 agent（dsh-agent-loop 构造，agent.ctx 是其作用域 ctx）
 * @param {{ sessionId: string, knownRows?: () => Array }} deps
 * @returns {{ dispose: () => void }} 注销句柄
 */
export function installSessionPolicy(agent, deps) {
  const skills = agent?.ctx?.get?.('skills')
  // 没有 skills 服务的会话（精简部署、或 preset 没挂注册表）安静跳过：
  // 少一个会话级开关，比让插件在这里抛错好。
  if (skills === undefined || skills === null) return { dispose: () => {} }
  const provider = createSessionProvider({ sessionId: deps.sessionId, knownRows: deps.knownRows })
  let unregister
  try {
    unregister = skills.registerProvider(() => provider)
  } catch {
    return { dispose: () => {} }
  }
  let disposed = false
  return {
    dispose: () => {
      if (disposed) return
      disposed = true
      try { unregister() } catch { /* 会话已卸载 */ }
    },
  }
}
