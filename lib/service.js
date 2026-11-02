/**
 * 宿主侧技能管理服务。
 *
 * 设计要点（多轮实测修正后）：
 *
 * 1. **数据源用官方注册表，不自己扫盘。**
 *    手写 readdir 只能覆盖 .dsh/.agents 两个根，会漏掉 bundled(600)、
 *    custom(300)、runtime 三类——office 系列与 cordis-plugin-development
 *    的实体在 asar 内，磁盘上没有目录。
 *
 * 2. **按工作区扫描。** skill-filesystem 只在传了 cwd 时才扫项目根，
 *    所以对每个已注册工作区各查一次，再合并去重。
 *
 * 3. **按会话隔离。** SkillViewOptions.scope 选「以哪个 agent 视角读」：
 *    省略 = 全局层，传入 agent = 该会话完整作用域链。这是每会话独立
 *    召回与技能上下文的基础。
 *
 * 4. **开关改 frontmatter，删除走回收目录。**
 *    注册表只读；provider 每次加载都重读文件，写盘即生效。
 *    删除不直接 rm：移到 .trash/<时间戳>/ 下，可恢复。
 */
import { readFile, mkdir, rename, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, basename } from 'node:path'
import { parseFrontmatter } from './discovery.js'
import { setSkillEnabled } from './mutate.js'

export const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods'
export const NAMESPACE = 'skillManager'

/** source -> 界面分组。 */
const SOURCE_SCOPE = {
  'user-dsh': 'system',
  'user-agents': 'system',
  custom: 'system',
  runtime: 'system',
  'project-dsh': 'project',
  'project-agents': 'project',
  bundled: 'bundled',
}

function scopeOfSource(source) {
  return SOURCE_SCOPE[source] ?? 'system'
}

/**
 * SkillSummary -> 界面行。
 * @param summary 官方注册表摘要
 */
function toRow(summary) {
  const invocation = summary.invocation ?? {}
  const modelDisabled = invocation.modelInvocable === false
  const userDisabled = invocation.userInvocable === false
  // bundled 的实体在 asar 内，没有可写文件。
  const editable = typeof summary.path === 'string' && summary.path !== ''
  return {
    name: summary.name,
    description: summary.description ?? '',
    whenToUse: summary.whenToUse ?? '',
    source: summary.source,
    provider: summary.provider,
    scope: scopeOfSource(summary.source),
    path: summary.path ?? null,
    modelDisabled,
    userDisabled,
    enabled: !modelDisabled && !userDisabled,
    editable,
  }
}

/** 服务类。手工复刻 TypertRemoteService 的两件事：provide + typertRemote 绑定。 */
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

  /** 列出已注册工作区。 */
  listProjects() {
    let registry
    try { registry = this.ctx.get('workspaceRegistry') } catch { return [] }
    if (registry === undefined || registry === null) return []
    let items
    try { items = registry.list() } catch { return [] }
    const out = []
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

  /** 列出会话（供「按会话查看」下拉）。 */
  listSessions() {
    let sessions
    try { sessions = this.ctx.get('sessions') } catch { return [] }
    if (sessions === undefined || sessions === null) return []
    let items
    try { items = sessions.list() } catch { return [] }
    const out = []
    for (const item of items ?? []) {
      try {
        const id = typeof item === 'string' ? item : (item.id ?? item.sessionId ?? null)
        if (typeof id !== 'string' || id === '') continue
        out.push({
          id,
          title: (item && (item.title ?? item.summary)) ?? id,
          updatedAt: item?.updatedAt ?? null,
        })
      } catch { /* 跳过 */ }
    }
    return out.slice(0, 100)
  }

  /** 尽力解析会话的工作目录。 */
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

  /** sessionId -> agent 作用域。 */
  resolveAgent(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return undefined
    try {
      const agents = this.ctx.get('agents')
      const found = agents?.get?.(sessionId) ?? agents?.find?.(sessionId)
      if (found !== undefined && found !== null) return found
    } catch { /* 无该服务 */ }
    return undefined
  }

  /**
   * 读完整技能目录：全局 + 每个工作区（+ 会话私有层）。
   * @param agent 会话作用域，省略则只读全局与各工作区
   */
  async readCatalog(agent) {
    const skills = this.ctx.get('skills')
    if (skills === undefined) {
      return { skills: [], complete: false, missingRegistry: true }
    }

    const contexts = [{ cwd: undefined }]
    for (const project of this.listProjects()) {
      contexts.push({ cwd: project.path, projectPath: project.path, projectTitle: project.title })
    }
    if (agent !== undefined) {
      const cwd = this.resolveCwd(agent)
      if (cwd !== undefined) contexts.push({ cwd, projectPath: cwd, projectTitle: null, scoped: true })
    }

    const byKey = new Map()
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
      for (const summary of snapshot.skills) {
        const row = toRow(summary)
        const key = row.name + '\u0000' + (row.path ?? '')
        if (byKey.has(key)) continue
        if (context.projectPath != null && row.scope === 'project') {
          row.projectPath = context.projectPath
          row.projectTitle = context.projectTitle
        }
        byKey.set(key, row)
      }
    }
    const rows = [...byKey.values()]
    rows.sort((a, b) => a.name.localeCompare(b.name))
    return { skills: rows, complete, missingRegistry: false }
  }

  /** 设置页首屏（全局视角）。 */
  async list() {
    const data = await this.readCatalog(undefined)
    return {
      skills: data.skills,
      complete: data.complete,
      missingRegistry: data.missingRegistry,
      projects: this.listProjects(),
      sessions: this.listSessions(),
      generatedAt: Date.now(),
    }
  }

  /**
   * 按会话读目录。
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
      projects: this.listProjects(),
      sessions: this.listSessions(),
      generatedAt: Date.now(),
    }
  }

  /** 读正文：优先按名字走注册表（bundled 无路径）。 */
  async read(request) {
    const name = request?.name
    if (typeof name === 'string' && name !== '') {
      try {
        const skills = this.ctx.get('skills')
        const definition = await skills?.get?.(name, {})
        if (definition !== undefined) {
          return { ok: true, content: definition.content ?? '', name: definition.name }
        }
      } catch { /* 退回按文件读 */ }
    }
    const file = request?.file
    if (typeof file !== 'string' || file === '') return { ok: false, error: 'MISSING_TARGET' }
    try {
      const text = await readFile(file, 'utf8')
      const fm = parseFrontmatter(text)
      return { ok: true, content: fm.body, fields: fm.fields }
    } catch (error) {
      return { ok: false, error: 'READ_FAILED: ' + error.message }
    }
  }

  /** 开 / 关一个技能。 */
  async setEnabled(request) {
    const file = request?.file
    const enabled = request?.enabled
    if (typeof file !== 'string' || file === '') return { ok: false, error: 'NOT_EDITABLE' }
    if (typeof enabled !== 'boolean') return { ok: false, error: 'MISSING_ENABLED' }
    return setSkillEnabled(file, enabled)
  }

  /**
   * 删除一个技能。
   *
   * 不直接 rm：移到技能根下的 `.trash/<时间戳>/<名字>`，保留可恢复性。
   * 目录 bundle 移整个目录，平铺 .md 移那一个文件。
   *
   * 方法名不能叫 `remove`：RemoteNamespaceService.prototype 自带 remove()，
   * 网关会判 "method conflicts with its namespace service" 并拒绝挂载。
   *
   * @param request `{ path, name }`
   */
  async removeSkill(request) {
    const file = request?.path
    if (typeof file !== 'string' || file === '') return { ok: false, error: 'NOT_REMOVABLE' }
    if (basename(file) !== 'SKILL.md' && !file.endsWith('.md')) {
      return { ok: false, error: 'UNEXPECTED_TARGET' }
    }
    // 目录 bundle 移父目录，平铺文件移自身。
    const target = basename(file) === 'SKILL.md' ? dirname(file) : file
    const root = dirname(target)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const trash = join(root, '.trash', stamp)
    try {
      await mkdir(trash, { recursive: true })
      await rename(target, join(trash, basename(target)))
    } catch (error) {
      return { ok: false, error: 'REMOVE_FAILED: ' + error.message }
    }
    // 让注册表立刻失效：否则它会把旧目录当缓存继续返回，
    // 界面看起来"删了没反应"，而磁盘上其实已经移走了。
    await this.invalidateProviders()
    return { ok: true, movedTo: join(trash, basename(target)), invalidated: true }
  }

  /** 尽力通知所有 skill provider 重新扫描。 */
  async invalidateProviders() {
    try {
      const skills = this.ctx.get('skills')
      const providers = skills?.providers?.()
      for (const entry of providers ?? []) {
        try { entry?.invalidate?.() ?? entry?.control?.invalidate?.() } catch { /* 单个失败不影响其它 */ }
      }
    } catch { /* 服务形状未知时静默 */ }
  }

  /** 清空回收目录（用户显式要求时）。同样避开保留名。 */
  async purgeTrashDir(request) {
    const root = request?.root
    if (typeof root !== 'string' || root === '') return { ok: false, error: 'MISSING_ROOT' }
    const trash = join(root, '.trash')
    if (!existsSync(trash)) return { ok: true, removed: 0 }
    try {
      await rm(trash, { recursive: true, force: true })
      return { ok: true, removed: 1 }
    } catch (error) {
      return { ok: false, error: 'PURGE_FAILED: ' + error.message }
    }
  }
}

const METHODS = ['list', 'listForSession', 'read', 'setEnabled', 'removeSkill', 'purgeTrashDir']

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

export function installSkillManager(ctx) {
  return new SkillManagerRemote(ctx)
}

export { METHODS, SOURCE_SCOPE, toRow, scopeOfSource }
