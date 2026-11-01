/**
 * 宿主侧技能管理服务。
 *
 * 设计要点（按真实 API 修正过两轮）：
 *
 * 1. **数据来源用官方注册表，不自己扫盘。**
 *    早期版本手写 `readdir` 只扫了 .dsh/.agents 两个根，漏掉：
 *      - `bundled`（rank 600）：office 系列、cordis-plugin-development 等内嵌技能，
 *        它们的实体在 asar 里，磁盘上根本没有对应目录；
 *      - `custom`（rank 300）与运行时注册的技能。
 *    `ctx.skills.list()` 已把全部 provider 合并好，且自带权威的 rank 与 source。
 *
 * 2. **按会话隔离。**
 *    `SkillViewOptions.scope` 选的是「以哪个 agent 的视角读」：
 *    省略 = 只读全局层，传入 agent = 读该会话的完整作用域链。
 *    这是未来做「每个 session 独立召回与技能上下文」的基础。
 *
 * 3. **开关仍然改 frontmatter。**
 *    注册表是只读的；provider 每次加载都重读文件，所以写盘即可生效。
 *    bundled 技能没有可写文件（在 asar 内），只能标记为只读。
 */
import { readFile } from 'node:fs/promises'
import { parseFrontmatter, readSwitches } from './discovery.js'
import { setSkillEnabled } from './mutate.js'

/** 网关据此枚举端点的原型描述符键（必须是官方常量值）。 */
export const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods'
/** Remote 命名空间，客户端以 `ctx.get('remote.skillManager')` 访问。 */
export const NAMESPACE = 'skillManager'

/** source -> 展示分组，前端据此分「系统级 / 工作区 / 内置」。 */
const SOURCE_SCOPE = {
  'user-dsh': 'system',
  'user-agents': 'system',
  custom: 'system',
  runtime: 'system',
  'project-dsh': 'project',
  'project-agents': 'project',
  bundled: 'bundled',
}

/** 按 source 归一出一个稳定的分组键。 */
function scopeOfSource(source) {
  return SOURCE_SCOPE[source] ?? 'system'
}

/**
 * 把一个 SkillSummary 转成界面需要的形状。
 * @param summary 官方注册表返回的摘要
 */
function toRow(summary) {
  const invocation = summary.invocation ?? {}
  const modelDisabled = invocation.modelInvocable === false
  const userDisabled = invocation.userInvocable === false
  // bundled 技能的实体在 asar 内，没有可写文件，开关无从落地。
  const editable = typeof summary.path === 'string' && summary.path !== ''
  return {
    name: summary.name,
    description: summary.description ?? '',
    whenToUse: summary.whenToUse ?? '',
    source: summary.source,
    provider: summary.provider,
    scope: scopeOfSource(summary.source),
    path: summary.path ?? null,
    resourceBase: summary.resourceBase ?? null,
    modelDisabled,
    userDisabled,
    enabled: !modelDisabled && !userDisabled,
    editable,
  }
}

/**
 * 技能管理 Remote 服务。
 *
 * 不继承 `TypertRemoteService`：那是 `@deepseek-ai/` 作用域的包，插件
 * node_modules 里没有它，静态 import 会让整个模块导入失败。这里手工复刻
 * 构造函数的两件事（provide + typertRemote 绑定）。
 */
export class SkillManagerRemote {
  constructor(ctx) {
    this.ctx = ctx
    this.name = NAMESPACE
    this.typertRemote = Object.freeze({
      service: this,
      serviceKey: NAMESPACE,
      namespace: NAMESPACE,
    })
    const dispose = ctx.provide(NAMESPACE, this)
    ctx.effect(() => dispose, 'decision-skills: skillManager service')
  }

  /**
   * 读出「全局 + 每个工作区」的完整技能目录。
   *
   * 关键：`skill-filesystem` 只在**传了 cwd** 时才扫描项目根
   * （`roots(cwd)` 里 `cwd !== undefined` 才去 findProjectRoot）。
   * 而设置页要跨全部工作区浏览，所以这里对每个工作区都查一次，
   * 各自用它的路径当 cwd，再合并去重。
   *
   * @param agent 会话作用域；给定时额外读取该会话的私有层
   */
  async readCatalog(agent) {
    const skills = this.ctx.get('skills')
    if (skills === undefined) return { skills: [], complete: false, missingRegistry: true }

    const contexts = []
    // 1) 全局层（cwd 省略 = 不扫项目根，只拿 user/custom/bundled）
    contexts.push({ cwd: undefined, projectPath: null, projectTitle: null })
    // 2) 每个已注册工作区的项目根
    for (const project of this.listProjects()) {
      contexts.push({ cwd: project.path, projectPath: project.path, projectTitle: project.title })
    }
    // 3) 会话视图（有 agent 时），用于观察该会话的私有层
    if (agent !== undefined) {
      const cwd = this.resolveCwd(agent)
      if (cwd !== undefined) contexts.push({ cwd, projectPath: cwd, projectTitle: null, scoped: true })
    }

    const byKey = new Map()
    const probeDetail = []
    let complete = true
    for (const context of contexts) {
      let snapshot
      try {
        snapshot = await skills.snapshot({ cwd: context.cwd, scope: agent })
      } catch {
        complete = false
        continue
      }
      if (snapshot.complete !== true) complete = false
      // 诊断：每个 cwd 各自拿回多少条、都是什么 source
      if (context.cwd !== undefined) {
        const counts = {}
        for (const s of snapshot.skills) counts[s.source] = (counts[s.source] ?? 0) + 1
        probeDetail.push({ cwd: context.cwd, count: snapshot.skills.length, bySource: counts })
      }
      for (const summary of snapshot.skills) {
        const row = toRow(summary)
        // 同一个技能可能被多个工作区看到（例如项目根相同），按 name+path 去重。
        const key = row.name + '\u0000' + (row.path ?? '')
        if (byKey.has(key)) continue
        if (context.projectPath !== null && row.scope === 'project') {
          row.projectPath = context.projectPath
          row.projectTitle = context.projectTitle
        }
        byKey.set(key, row)
      }
    }
    const rows = [...byKey.values()]
    rows.sort((a, b) => a.name.localeCompare(b.name))
    return {
      skills: rows,
      complete,
      missingRegistry: false,
      // 诊断：让设置页能看出「查了哪些 cwd、各拿到几条」，
      // 项目级技能缺席时不必再翻宿主日志。
      probe: contexts.map((c) => ({ cwd: c.cwd, title: c.projectTitle })),
      probeDetail,
    }
  }

  /** 列出已注册工作区（path + title）。 */
  listProjects() {
    let registry
    try { registry = this.ctx.get('workspaceRegistry') } catch { return [] }
    if (registry === undefined || registry === null) return []
    const out = []
    let items
    try { items = registry.list() } catch { return [] }
    for (const item of items) {
      try {
        const path = typeof item.path === 'string' ? item.path : item.path?.path ?? null
        if (typeof path !== 'string' || path === '') continue
        const title = typeof item.title === 'string' && item.title !== '' ? item.title : path
        out.push({ path, title })
      } catch { /* 跳过坏条目 */ }
    }
    return out
  }

  /** 尽力解析一个会话的工作目录，供 cwd 敏感的 provider 用。 */
  resolveCwd(agent) {
    if (agent === undefined) return undefined
    try {
      const dir = this.ctx.get('workingDirectory')
      const value = dir?.get?.(agent) ?? dir?.ensure?.(agent)
      if (typeof value === 'string') return value
    } catch { /* 无该服务 */ }
    try {
      const value = agent?.workingDirectory
      if (typeof value === 'string') return value
    } catch { /* 忽略 */ }
    return undefined
  }

  /** 设置页首屏：无会话视角（全局层）。 */
  async list() {
    const data = await this.readCatalog(undefined)
    return {
      skills: data.skills,
      complete: data.complete,
      missingRegistry: data.missingRegistry,
      probe: data.probe ?? [],
      probeDetail: data.probeDetail ?? [],
      generatedAt: Date.now(),
    }
  }

  /**
   * 按会话读技能目录。会话 id 由前端传入，服务端解析成 agent 作用域。
   * @param request `{ sessionId }`
   */
  async listForSession(request) {
    const sessionId = request?.sessionId
    const agent = this.resolveAgent(sessionId)
    const data = await this.readCatalog(agent)
    return {
      sessionId: sessionId ?? null,
      scoped: agent !== undefined,
      skills: data.skills,
      complete: data.complete,
      missingRegistry: data.missingRegistry,
      generatedAt: Date.now(),
    }
  }

  /** 把 sessionId 解析成 agent 作用域；解析不到就退回全局层。 */
  resolveAgent(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return undefined
    try {
      const agents = this.ctx.get('agents')
      const found = agents?.get?.(sessionId) ?? agents?.find?.(sessionId)
      if (found !== undefined && found !== null) return found
    } catch { /* 无该服务 */ }
    return undefined
  }

  /** 读单个技能的正文。 */
  async read(request) {
    const file = request?.file
    const name = request?.name
    // 优先走注册表按名字取：bundled 技能没有文件路径。
    if (typeof name === 'string' && name !== '') {
      try {
        const skills = this.ctx.get('skills')
        const definition = await skills?.get?.(name, {})
        if (definition !== undefined) {
          return { ok: true, content: definition.content ?? '', name: definition.name }
        }
      } catch { /* 退回按文件读 */ }
    }
    if (typeof file !== 'string' || file === '') return { ok: false, error: 'MISSING_TARGET' }
    try {
      const text = await readFile(file, 'utf8')
      const fm = parseFrontmatter(text)
      return { ok: true, content: fm.body, fields: fm.fields }
    } catch (error) {
      return { ok: false, error: 'READ_FAILED: ' + error.message }
    }
  }

  /** 开 / 关一个技能（改 frontmatter）。bundled 技能拒绝。 */
  async setEnabled(request) {
    const file = request?.file
    const enabled = request?.enabled
    if (typeof file !== 'string' || file === '') return { ok: false, error: 'NOT_EDITABLE' }
    if (typeof enabled !== 'boolean') return { ok: false, error: 'MISSING_ENABLED' }
    return setSkillEnabled(file, enabled)
  }
}

const METHODS = ['list', 'listForSession', 'read', 'setEnabled']

/** 给原型打上网关可识别的 Remote 方法描述符。 */
function markRemoteMethods(ctor) {
  Object.defineProperty(ctor.prototype, REMOTE_METHOD_DESCRIPTOR, {
    value: Object.freeze({
      version: 1,
      methods: Object.freeze(METHODS.map((method) => Object.freeze({ method, invocation: Object.freeze({ kind: 'direct' }) }))),
    }),
    enumerable: false,
    configurable: true,
    writable: true,
  })
}
markRemoteMethods(SkillManagerRemote)

/**
 * 把服务挂进 cordis。
 * @param {any} ctx
 */
export function installSkillManager(ctx) {
  return new SkillManagerRemote(ctx)
}

export { METHODS, SOURCE_SCOPE, toRow, scopeOfSource }
