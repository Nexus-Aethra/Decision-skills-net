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
import { readFile, mkdir, rename, rm, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseFrontmatter, readSwitches } from './discovery.js'
import { setSkillEnabled } from './mutate.js'
import { listAsarDir, readAsarFile } from './asar.js'

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

  /**
   * 额外扫描根：宿主安装自带、但没有 provider 认领的技能目录。
   *
   * office 系列（7 个）随安装发布在 `<install>/resources/runtime/office-skills`，
   * 而 `dsh-skill-office` 这个 provider 并没有出现在安装里，
   * 所以注册表看不到它们。这里把它们作为普通目录根补扫。
   *
   * 目录由 `DSH_INSTALL_ROOT` 或从当前模块位置推导；找不到就跳过。
   */
  extraRoots() {
    const roots = []
    const seen = new Set()
    const push = (p) => {
      if (typeof p !== 'string' || p === '' || seen.has(p)) return
      seen.add(p)
      roots.push(p)
    }
    try {
      const env = process.env.DSH_INSTALL_ROOT
      if (env) push(join(env, 'resources', 'runtime', 'office-skills'))
    } catch { /* 无 env */ }
    // 常见安装位置兜底
    for (const candidate of [
      'E:\\dsh\\resources\\runtime\\office-skills',
      join(process.env.ProgramFiles ?? '', 'DeepSeek Harness', 'resources', 'runtime', 'office-skills'),
    ]) {
      if (candidate && existsSync(candidate)) push(candidate)
    }
    return roots.filter((r) => existsSync(r))
  }

  /**
   * 直接扫一个目录根，产出与注册表同形状的行。
   * 只用于 extraRoots()：注册表不认这些目录，只能自己读 frontmatter。
   */
  async scanExtraRoot(rootPath) {
    const rows = []
    let entries
    try { entries = await readdir(rootPath, { withFileTypes: true }) } catch { return rows }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const file = join(rootPath, entry.name, 'SKILL.md')
      if (!existsSync(file)) continue
      let text
      try { text = await readFile(file, 'utf8') } catch { continue }
      const fm = parseFrontmatter(text)
      const name = fm.fields.name
      if (typeof name !== 'string' || name === '') continue
      const switches = readSwitches(fm.fields)
      rows.push({
        name,
        description: fm.fields.description ?? '',
        whenToUse: fm.fields.whenToUse ?? '',
        source: 'bundled',
        provider: 'install-assets',
        scope: 'bundled',
        path: file,
        modelDisabled: switches.modelDisabled,
        userDisabled: switches.userDisabled,
        enabled: switches.enabled,
        editable: true,
      })
    }
    return rows
  }

  /**
   * 定位 app.asar 位置。
   * 优先环境变量，其次从常见安装路径推导。
   */
  asarPath() {
    const candidates = []
    if (process.env.DSH_ASAR_PATH) candidates.push(process.env.DSH_ASAR_PATH)
    if (process.env.DSH_INSTALL_ROOT) candidates.push(join(process.env.DSH_INSTALL_ROOT, 'resources', 'app.asar'))
    candidates.push('E:\\dsh\\resources\\app.asar')
    candidates.push(join(process.env.ProgramFiles ?? '', 'DeepSeek Harness', 'resources', 'app.asar'))
    for (const c of candidates) {
      if (typeof c === 'string' && c !== '' && existsSync(c)) return c
    }
    return null
  }

  /**
   * 扫描 asar 内置技能。
   *
   * `dsh-agent-preset/skills` 里有 4 个技能
   * （cordis-plugin-development、cordis-composition-reference、
   *  editing-cordis-compositions、agent-experience），
   * 它们的实体在归档内，磁盘上没有对应目录，注册表也不认——
   * 只能直接解 asar 读 frontmatter。
   */
  async scanAsarSkills() {
    const archive = this.asarPath()
    if (archive === null) return []
    const prefix = '/dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/'
    const dirs = await listAsarDir(archive, prefix)
    const rows = []
    for (const dir of dirs) {
      const inner = prefix + dir + '/SKILL.md'
      const text = await readAsarFile(archive, inner)
      if (text === null) continue
      // asar 内的 SKILL.md 可能省略 --- 分隔符，直接以 key: value 开头。
      // parseFrontmatter 认不出这种形态，这里先补出分隔符再解析。
      const fm = parseFrontmatter(text)
      let fields = fm.fields
      let body = fm.body
      if (!fm.hasFrontmatter && /^[A-Za-z][\w-]*\s*:/.test(text)) {
        const synthetic = parseFrontmatter('---\n' + text)
        if (synthetic.hasFrontmatter) {
          fields = synthetic.fields
          body = synthetic.body
        }
      }
      const name = fields.name
      if (typeof name !== 'string' || name === '') continue
      rows.push({
        name,
        description: fields.description ?? '',
        whenToUse: fields.whenToUse ?? '',
        source: 'bundled',
        provider: 'asar:agent-preset',
        scope: 'bundled',
        // 归档内路径，只用于展示；不可写
        path: null,
        archivePath: inner,
        modelDisabled: false,
        userDisabled: false,
        enabled: true,
        editable: false,
      })
    }
    return rows
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

  /**
   * 列出会话（供「按会话查看」下拉）。
   *
   * 不能用 `ctx.sessions.list()`：它只返回**当前存活**的会话
   * （源码注释 "All live sessions"），重启后归零，用户看到的就是
   * "会话数量不对"。要列全部历史，必须走持久化的 sessionQuery。
   *
   * 顺序：sessionQuery（全量） → sessions（存活） → workspace 登记。
   */
  async listSessions() {
    // 磁盘扫描最先做：它只依赖 fs，不受服务形状差异影响，
    // 是任何部署下都成立的事实源。
    const fromDisk = await this.scanSessionDirs()
    if (fromDisk.length > 0) return fromDisk

    // 1) 持久化查询：唯一的全量来源
    try {
      const query = this.ctx.get('sessionQuery')
      if (query && typeof query.listSessions === 'function') {
        // 不同版本签名不同：有的要 signal，有的不要。两种都试。
        let records
        try { records = await query.listSessions() } catch { records = await query.listSessions(undefined) }
        if (Array.isArray(records) && records.length > 0) {
          return records
            .map((r) => ({
              id: String(r.id ?? r.sessionId ?? ''),
              title: String(r.title ?? r.name ?? r.id ?? ''),
              updatedAt: r.updatedAt ?? r.updated ?? null,
            }))
            .filter((r) => r.id !== '')
            .slice(0, 200)
        }
      }
    } catch { /* 无该服务或调用失败 */ }

    // 2) 存活会话
    try {
      const sessions = this.ctx.get('sessions')
      const items = sessions?.list?.() ?? []
      if (items.length > 0) {
        return items
          .map((item) => ({
            id: String(item?.id ?? item ?? ''),
            title: String(item?.title ?? item?.summary ?? item?.id ?? ''),
            updatedAt: item?.updatedAt ?? null,
          }))
          .filter((r) => r.id !== '')
          .slice(0, 200)
      }
    } catch { /* 继续 */ }

    // 3) 工作区登记的会话
    try {
      const registry = this.ctx.get('workspaceRegistry')
      const items = registry?.list?.() ?? []
      const out = []
      for (const item of items) {
        for (const sid of item?.sessionIds ?? []) {
          if (typeof sid === 'string' && sid !== '') out.push({ id: sid, title: sid, updatedAt: null })
        }
      }
      if (out.length > 0) return out.slice(0, 200)
    } catch { /* 忽略 */ }

    return []
  }

  /** 诊断：会话来源、候选路径与各自命中数。 */
  async sessionDiagnostics() {
    const out = { services: {}, env: {}, roots: [], scanned: {} }
    for (const name of ['sessionQuery', 'sessions', 'workspaceRegistry']) {
      try { out.services[name] = this.ctx.get(name) !== undefined } catch { out.services[name] = false }
    }
    out.env.DSH_HOME = process.env.DSH_HOME ?? null
    out.env.DSH_PROFILE_DIR = process.env.DSH_PROFILE_DIR ?? null
    out.env.USERPROFILE = process.env.USERPROFILE ?? null
    const roots = []
    const seen = new Set()
    const push = (p) => {
      if (typeof p !== 'string' || p === '' || seen.has(p)) return
      seen.add(p)
      roots.push({ path: p, exists: existsSync(p) })
    }
    push(process.env.DSH_HOME ? join(process.env.DSH_HOME, 'sessions') : null)
    push(process.env.DSH_PROFILE_DIR ? join(process.env.DSH_PROFILE_DIR, 'sessions') : null)
    if (process.env.DSH_HOME) push(join(dirname(process.env.DSH_HOME), 'sessions'))
    try {
      let dir = dirname(fileURLToPath(import.meta.url))
      for (let i = 0; i < 8; i += 1) {
        push(join(dir, 'sessions'))
        const parent = dirname(dir)
        if (parent === dir) break
        dir = parent
      }
    } catch { /* 忽略 */ }
    push(join(process.env.USERPROFILE ?? '', '.dsh', 'sessions'))
    out.roots = roots
    const scanned = await this.scanSessionDirs()
    out.scanned.count = scanned.length
    for (const r of roots) {
      if (!r.exists) continue
      try {
        const groups = await readdir(r.path, { withFileTypes: true })
        out.scanned[r.path] = groups.filter((g) => g.isDirectory()).length
      } catch { out.scanned[r.path] = 'ERR' }
    }
    return out
  }

  /**
   * 扫会话存储目录，返回 { id, title }。
   *
   * 路径候选不止 DSH_HOME：dshbox 容器把 home 放在 profile/ 下，
   * 而进程内的 DSH_HOME 未必指向那里。这里把能从 ctx 或环境
   * 推出的位置都试一遍。
   */
  async scanSessionDirs() {
    const roots = []
    const push = (p) => { if (typeof p === 'string' && p !== '' && existsSync(p)) roots.push(p) }
    push(process.env.DSH_HOME ? join(process.env.DSH_HOME, 'sessions') : null)
    push(process.env.DSH_PROFILE_DIR ? join(process.env.DSH_PROFILE_DIR, 'sessions') : null)
    if (process.env.DSH_HOME) {
      // dshbox 容器把 profile 放在 <DSH_HOME>/profiles/<name>，
      // 而会话落在 <DSH_HOME>/sessions —— 与 DSH_HOME 同级。
      push(join(dirname(process.env.DSH_HOME), 'sessions'))
    }
    // 从插件自身位置反推：<DSH_HOME>/profiles/<name>/node_modules/@local/<pkg>
    try {
      const here = fileURLToPath(import.meta.url)
      let dir = dirname(here)
      for (let i = 0; i < 8; i += 1) {
        push(join(dir, 'sessions'))
        const parent = dirname(dir)
        if (parent === dir) break
        dir = parent
      }
    } catch { /* 忽略 */ }
    push(join(process.env.USERPROFILE ?? '', '.dsh', 'sessions'))
    const out = []
    const seen = new Set()
    for (const root of roots) {
      let groups
      try { groups = await readdir(root, { withFileTypes: true }) } catch { continue }
      for (const group of groups) {
        if (!group.isDirectory()) continue
        let sessions
        try { sessions = await readdir(join(root, group.name), { withFileTypes: true }) } catch { continue }
        for (const s of sessions) {
          if (!s.isDirectory()) continue
          if (!s.name.startsWith('session-')) continue
          if (seen.has(s.name)) continue
          seen.add(s.name)
          // 目录名本身就是会话 id
          out.push({ id: s.name, title: s.name, updatedAt: null, workspace: group.name })
        }
      }
    }
    return out.slice(0, 200)
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
    // 补扫宿主安装自带、但没有 provider 认领的目录（office 系列）。
    // 注册表看不到它们，只能自己读；同名不覆盖注册表结果。
    for (const rootPath of this.extraRoots()) {
      for (const row of await this.scanExtraRoot(rootPath)) {
        const key = row.name + '\u0000' + (row.path ?? '')
        if (!byKey.has(key)) byKey.set(key, row)
      }
    }

    // 补扫 app.asar 内 agent-preset 技能（cordis-plugin-development 等）。
    for (const row of await this.scanAsarSkills()) {
      const key = row.name + '\u0000' + (row.archivePath ?? '')
      if (!byKey.has(key)) byKey.set(key, row)
    }

    const rows = [...byKey.values()]
    rows.sort((a, b) => a.name.localeCompare(b.name))
    return { skills: rows, complete, missingRegistry: false, extraRoots: this.extraRoots() }
  }

  /** 设置页首屏（全局视角）。 */
  async list() {
    const data = await this.readCatalog(undefined)
    return {
      skills: data.skills,
      complete: data.complete,
      missingRegistry: data.missingRegistry,
      projects: this.listProjects(),
      sessions: await this.listSessions(),
      diag: await this.sessionDiagnostics(),
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
      sessions: await this.listSessions(),
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
