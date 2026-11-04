/**
 * 技能采集器（skillScanner）。
 *
 * 职责单一：**只负责把技能目录凑齐**，不写任何文件、不碰 UI。
 *
 * 四个来源，缺一不可：
 *   1. 官方注册表 ctx.skills.snapshot({ cwd, scope })
 *      —— 覆盖 user-dsh / user-agents / custom / runtime / project-*
 *   2. 每个工作区的项目根（注册表只在传了 cwd 时才扫项目根）
 *   3. 安装自带但无 provider 认领的目录（office 系列）
 *   4. app.asar 内的 agent-preset 技能（cordis-plugin-development 等）
 *
 * 后三类注册表看不到，只能自己读——这是实测出来的硬事实，不是偷懒。
 *
 * 未来决策层要接的正是这里：它只需要消费 catalog()，不必关心来源。
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeRow, sortRows, EVENTS, SERVICES, SCOPE } from '../shared/index.js'
import { loadPrefs, resolveMode, sessionOverrides, globalEntries, entryMode, hasSessionOverride, locatorOf } from './prefs.js'
import { installVisibility } from './visibility.js'
import { installSessionPolicy } from './session.js'
import { installChangeNotifier } from './notifier.js'
import { readAsarFile } from './asar.js'

/** 极简 frontmatter 解析：只取标量字段，够展示与开关判断。 */
export function parseFrontmatter(text) {
  const result = { fields: {}, body: text, hasFrontmatter: false }
  // UTF-8 BOM 会让 startsWith('---') 失败，技能因此"莫名消失"。
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  if (!src.startsWith('---')) return result
  const end = src.indexOf('\n---', 3)
  if (end === -1) return result
  const raw = src.slice(3, end)
  result.hasFrontmatter = true
  result.body = src.slice(end + 4).replace(/^\r?\n/, '')
  for (const line of raw.split(/\r?\n/)) {
    const m = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (!m) continue
    let value = m[2].trim()
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1)
    }
    result.fields[m[1]] = value
  }
  return result
}

/** 调用开关的字面量解析，与官方同样严格。 */
const TRUE_WORDS = new Set(['true', 'yes', 'on', '1'])
const FALSE_WORDS = new Set(['false', 'no', 'off', '0'])
function parseBool(value) {
  if (value === undefined) return undefined
  const v = String(value).trim().toLowerCase()
  if (TRUE_WORDS.has(v)) return true
  if (FALSE_WORDS.has(v)) return false
  return undefined
}

/** 从 frontmatter 字段读出开关状态。 */
export function readSwitches(fields) {
  const modelDisabled = parseBool(fields['disable-model-invocation']) === true
  const userDisabled = parseBool(fields['user-invocable']) === false
  return { modelDisabled, userDisabled, enabled: !modelDisabled && !userDisabled }
}

const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * 采集器服务。
 */
export class SkillScanner {
  constructor(ctx) {
    this.ctx = ctx
    this.name = SERVICES.scanner
    // 见过的技能行（name -> 轻量行）。给会话级策略的**遮蔽占位**兜底：
    // 占位候选会把它遮蔽的那条真实条目顶掉，之后的快照里就读不到了，
    // 只剩这里记着的描述与位置能把那一行还原出来。
    this.knownRowsByName = new Map()
  }

  /** 列出已注册工作区。 */
  listProjects() {
    let registry
    try { registry = this.ctx.get('workspaceRegistry') } catch { return [] }
    if (registry == null) return []
    let items
    try { items = registry.list() } catch { return [] }
    const out = []
    for (const item of items) {
      try {
        const path = typeof item.path === 'string' ? item.path : item.path?.path ?? null
        if (typeof path !== 'string' || path === '') continue
        out.push({ path, title: typeof item.title === 'string' && item.title !== '' ? item.title : path })
      } catch { /* 跳过坏条目 */ }
    }
    return out
  }

  /**
   * 列出会话。
   *
   * **不自己算：直接问系统的会话服务。**
   * DSH 的侧边栏由 `sessionController` 驱动，它的 `list()` 已经做完：
   *   - 可见性（remoteAccess.allows）
   *   - cwd 过滤
   *   - blank 过滤（没有消息的空会话）
   *
   * 早期版本自己扫目录、自己写体积阈值，结果是"容器里 1 个会话显示成 7 个"——
   * 因为把 zstd 头只有几百字节的空壳也算进去了。那是重复实现别人已有的逻辑。
   *
   * 两层回退只在服务缺失时使用（非 GUI 部署）。
   */
  async listSessions() {
    this.lastSessionDiag = { source: 'none' }

    // 1) 官方会话控制器 —— 唯一权威来源，与侧边栏完全一致
    try {
      const controller = this.ctx.get('sessionController')
      if (controller !== undefined) {
        let value
        try {
          // 签名是 (request, signal)。JSON-RPC 语义下 request 可为空对象，
          // 直接调时 signal 可省略。
          value = await controller.list?.({})
          if (value === undefined) value = await controller.list?.()
        } catch {
          value = undefined
        }
        const items = value?.items ?? (Array.isArray(value) ? value : undefined)
        if (Array.isArray(items)) {
          this.lastSessionDiag = { source: 'sessionController', counts: { total: items.length } }
          return items
            .map((item) => ({
              id: String(item.sessionId ?? item.id ?? ''),
              title: String(item.title ?? item.sessionId ?? item.id ?? ''),
              updatedAt: item.updatedAt ?? null,
            }))
            .filter((r) => r.id !== '')
        }
      }
    } catch { /* 无该服务 */ }

    // 2) 存活会话（精简部署）
    try {
      const sessions = this.ctx.get('sessions')
      const items = typeof sessions?.list === 'function' ? sessions.list() : undefined
      if (Array.isArray(items) && items.length > 0) {
        this.lastSessionDiag = { source: 'sessions', counts: { total: items.length } }
        return items
          .map((item) => ({ id: String(item?.id ?? item ?? ''), title: String(item?.title ?? item?.id ?? ''), updatedAt: null }))
          .filter((r) => r.id !== '')
      }
    } catch { /* 继续 */ }

    // 3) 磁盘兜底：只能靠体积判断空壳，不如上面的服务准
    const disk = await this.scanSessionDirs()
    this.lastSessionDiag = { source: 'disk', counts: { total: disk.length } }
    return disk
  }

  /**
   * 扫会话存储目录：<DSH_HOME>/sessions/<workspace-slug>/session-* /
   * 这是持久化事实源，任何服务缺失都能读到。
   */
  async scanSessionDirs() {
    const roots = this.sessionRoots()
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
          if (!s.isDirectory() || !s.name.startsWith('session-')) continue
          if (seen.has(s.name)) continue
          // 空会话过滤：zstd 头只有几百字节，真实会话至少几十 KB。
          // 实测空壳 319~401 字节，正常会话 400KB~4MB。
          // 不滤会把"没发过消息的会话"算进去，与侧边栏对不上。
          const size = await this.sessionBytes(join(root, group.name, s.name))
          if (this.lastSessionDiag) {
            this.lastSessionDiag.sizes = this.lastSessionDiag.sizes ?? []
            this.lastSessionDiag.sizes.push({ id: s.name.slice(0, 24), size })
          }
          if (size >= 0 && size < 4096) continue
          seen.add(s.name)
          out.push({ id: s.name, title: s.name, workspace: group.name })
        }
      }
    }
    return out.slice(0, 200)
  }

  /**
   * 会话目录的总字节数；读不到返回 -1（视为未知，不因此丢弃）。
   * @param {string} dir
   */
  async sessionBytes(dir) {
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      let total = 0
      for (const entry of entries) {
        if (!entry.isFile()) continue
        try {
          const stat = await stat(join(dir, entry.name))
          total += stat.size
        } catch { /* 单个文件失败不影响 */ }
      }
      return total
    } catch {
      return -1
    }
  }

  /** 会话目录候选（去重、只保留存在的）。 */
  sessionRoots() {
    const roots = []
    const seen = new Set()
    const push = (p) => {
      if (typeof p !== 'string' || p === '' || seen.has(p) || !existsSync(p)) return
      seen.add(p)
      roots.push(p)
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
    return roots
  }

  /** 解析会话的工作目录。 */
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
      if (found != null) return found
    } catch { /* 无该服务 */ }
    return undefined
  }

  /**
   * 安装自带、但**没有 provider 认领**的技能目录。
   *
   * office 系列是个特例：官方 `@deepseek-ai/dsh-skill-office` provider 就会读
   * `<runtime>/../office-skills`（assetRoot 由 DSH_BUNDLED_OFFICE_SKILLS 或
   * runtime 路径推导）。它的候选**不带 path 字段**，所以注册表快照里那几条
   * 看起来「没有路径」。
   *
   * 若我们也扫一遍同一个目录，同名技能会出现两条（一条官方、无路径；
   * 一条我们扫的、有路径）——界面上就是重复条目。
   *
   * 所以：**官方 provider 已认领时不扫**，只在它缺席时才用磁盘兜底。
   *
   * @returns {string[]} 目录根
   */
  extraRoots() {
    const roots = []
    const seen = new Set()
    const push = (p) => {
      if (typeof p !== 'string' || p === '' || seen.has(p) || !existsSync(p)) return
      seen.add(p)
      roots.push(p)
    }
    if (this.officeProviderPresent()) return roots
    if (process.env.DSH_INSTALL_ROOT) push(join(process.env.DSH_INSTALL_ROOT, 'resources', 'runtime', 'office-skills'))
    push('E:\\dsh\\resources\\runtime\\office-skills')
    push(join(process.env.ProgramFiles ?? '', 'DeepSeek Harness', 'resources', 'runtime', 'office-skills'))
    return roots
  }

  /**
   * 官方 office provider 是否已注册。
   *
   * 注册表没有公开的 provider 名单方法，但内部结构是稳定的：
   *   skills.layers.global.providers —— NamedEntries，键是 provider 名
   * 官方那个的 provider 名就是 'dsh-office'。
   *
   * 结果缓存到下次 invalidate：注册表状态变了缓存要作废。
   *
   * @returns {boolean}
   */
  officeProviderPresent() {
    if (this._officeProviderPresent !== undefined) return this._officeProviderPresent
    let present = false
    try {
      const skills = this.ctx.get('skills')
      const providers = skills?.layers?.global?.providers
      // NamedEntries.has(name)；兼容未来换成 Map 的情况。
      present = typeof providers?.has === 'function'
        ? providers.has('dsh-office')
        : providers?.get?.('dsh-office') !== undefined
    } catch { /* 服务形状未知：当作没有，交给磁盘兜底 */ }
    this._officeProviderPresent = present
    return present
  }

  /** 清掉「官方 provider 是否在场」的缓存（注册表状态变化后要重算）。 */
  resetCaches() {
    this._officeProviderPresent = undefined
  }

  /** 扫一个普通目录根。 */
  async scanDirectoryRoot(rootPath) {
    const rows = []
    let entries
    try { entries = await readdir(rootPath, { withFileTypes: true }) } catch { return rows }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      // .trash 是回收目录，不是技能
      if (entry.name === '.trash' || entry.name === '.system') continue
      const file = join(rootPath, entry.name, 'SKILL.md')
      if (!existsSync(file)) continue
      let text
      try { text = await readFile(file, 'utf8') } catch { continue }
      const fm = parseFrontmatter(text)
      if (typeof fm.fields.name !== 'string' || !SKILL_NAME_RE.test(fm.fields.name)) continue
      const sw = readSwitches(fm.fields)
      rows.push(makeRow({
        name: fm.fields.name,
        description: fm.fields.description,
        whenToUse: fm.fields.whenToUse,
        source: 'bundled',
        provider: 'install-assets',
        path: file,
        editable: true,
        modelDisabled: sw.modelDisabled,
        userDisabled: sw.userDisabled,
      }))
    }
    return rows
  }

  /** 定位 app.asar。 */
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

  /** 扫 app.asar 内 agent-preset 技能。 */
  async scanArchiveSkills() {
    const archive = this.asarPath()
    if (archive === null) return []
    let asar
    try { asar = await import('./asar.js') } catch { return [] }
    const prefix = '/dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/'
    const dirs = await asar.listAsarDir(archive, prefix)
    const rows = []
    for (const dir of dirs) {
      const text = await asar.readAsarFile(archive, prefix + dir + '/SKILL.md')
      if (text === null) continue
      let fm = parseFrontmatter(text)
      // asar 内的 SKILL.md 可能没有 --- 分隔符，直接以 key: 开头。
      if (!fm.hasFrontmatter && /^[A-Za-z][\w-]*\s*:/.test(text)) {
        fm = parseFrontmatter('---\n' + text)
      }
      if (typeof fm.fields.name !== 'string' || !SKILL_NAME_RE.test(fm.fields.name)) continue
      rows.push(makeRow({
        name: fm.fields.name,
        description: fm.fields.description,
        whenToUse: fm.fields.whenToUse,
        source: 'bundled',
        provider: 'asar:agent-preset',
        path: null,
        archivePath: prefix + dir + '/SKILL.md',
        editable: false,
      }))
    }
    return rows
  }

  /**
   * 只扫**不经过注册表**的系统级来源：安装自带目录 + asar 内置技能。
   *
   * 为什么单独开一个方法：给 visibility provider 用。
   *
   * provider 的 list() 是**被注册表调用**的（collect → collectFresh → provider.list()）。
   * 若 list() 里再回调 ctx.skills.snapshot()，就形成
   *     collect → provider.list() → snapshot → collect → provider.list() → …
   * 的无限递归：爆栈（RangeError: Maximum call stack size exceeded），
   * 每次爆栈都留下一串未处理的 promise 拒绝，最后把 host 进程撑到 OOM
   * （FATAL ERROR: … JavaScript heap out of memory，进程 abort，退出码 134）。
   *
   * 所以 provider 侧只能读**不经过注册表**的来源。
   * 这不丢东西：scope === 'system' 的行（source === 'bundled'）本来就只有两个出处
   * ——extraRoots() 扫的安装目录，和 scanArchiveSkills() 扫的 asar 内置技能。
   * 官方 filesystem provider 的 bundled 根（bundledSkillDir）在本机并未配置，
   * 那条路上本来就没有行。
   *
   * @returns {Promise<Array>} 系统级技能行
   */
  async systemRows() {
    const byKey = new Map()
    const add = (row) => {
      const key = row.name + '\u0000' + (row.path ?? row.archivePath ?? '')
      if (!byKey.has(key)) byKey.set(key, row)
    }
    for (const root of this.extraRoots()) {
      for (const row of await this.scanDirectoryRoot(root)) add(row)
    }
    for (const row of await this.scanArchiveSkills()) add(row)
    return sortRows([...byKey.values()])
  }

  /**
   * 记住见过的行，供会话级策略使用（provider 侧与策略行还原）。
   *
   * **累积而不是替换**：被会话策略屏蔽的技能，本轮快照里根本读不到
   * （遮蔽候选把它顶掉了）。若这里跟着把它丢掉，下一轮就再也补不回
   * 它的路径与描述，界面上那一行会彻底消失、连「恢复默认」都没处点。
   *
   * 又不能无限累积——技能真被删掉时那一行必须消失。折中：
   * 被档位表显式提到的名字一直留着（看不见正是屏蔽造成的），
   * 其余连续 MISS_LIMIT 轮没出现就当它没了。
   *
   * @param {Array} rows 本轮目录
   * @param {object} prefs 档位表
   * @param {string|undefined} sessionId 本轮口径的会话
   */
  rememberRows(rows, prefs, sessionId) {
    const MISS_LIMIT = 3
    const seen = new Set()
    for (const row of rows) {
      seen.add(row.name)
      this.knownRowsByName.set(row.name, {
        name: row.name,
        scope: row.scope,
        source: row.source,
        provider: row.provider,
        description: row.description,
        path: row.path ?? null,
        archivePath: row.archivePath ?? null,
        projectPath: row.projectPath ?? null,
        projectTitle: row.projectTitle ?? null,
        misses: 0,
      })
    }
    const explicit = new Set()
    for (const entry of globalEntries(prefs)) {
      if (typeof entry.name === 'string') explicit.add(entry.name)
    }
    for (const row of sessionOverrides(prefs, sessionId)) explicit.add(row.name)
    for (const [name, entry] of this.knownRowsByName) {
      if (seen.has(name)) continue
      if (explicit.has(name)) { entry.misses = 0; continue }
      entry.misses = (entry.misses ?? 0) + 1
      if (entry.misses >= MISS_LIMIT) this.knownRowsByName.delete(name)
    }
    this.lastKnownRows = [...this.knownRowsByName.values()]
  }

  /**
   * 完整目录：注册表 + 项目根 + 安装目录 + asar。
   * @param agent 会话作用域，省略则只读全局与各工作区
   * @param sessionId 会话 id，用于解析会话级档位（省略则只看全局默认）
   */
  async catalog(agent, sessionId) {
    const byKey = new Map()
    const add = (row) => {
      const key = row.name + '\u0000' + (row.path ?? row.archivePath ?? '')
      if (!byKey.has(key)) byKey.set(key, row)
    }
    // 同名技能的合并表：同一个技能可能被**两个来源**同时报上来。
    //   例：office 系列——官方 dsh-skill-office provider 从 asar 内的 assets
    //   目录注册（快照里没有 path），而扫描器又从磁盘上的
    //   <install>/resources/runtime/office-skills 扫了一遍（有 path）。
    // 按「名字 + 路径」去重会把两者都留下，界面上就出现两条同名技能。
    // 这里按**名字**去重，保留信息更全的那条：
    //   1. 官方 provider 认领的（带 resourceBase）优先——正文由官方读，最权威
    //   2. 其次有磁盘路径的——可预览、可编辑
    //   3. 再其次任意一条
    const byName = new Map()
    const rank = (row) => {
      if (row.official === true) return 3
      if (row.path) return 2
      return 1
    }
    const addDeduped = (row) => {
      const previous = byName.get(row.name)
      if (previous === undefined) { byName.set(row.name, row); return }
      if (rank(row) > rank(previous)) byName.set(row.name, row)
    }

    // 档位表要在**读快照之前**拿到：下面会遇到会话策略的遮蔽占位，
    // 那一行只能靠 prefs 里记下的位置认回来。
    const prefs = await loadPrefs()

    let skills
    try { skills = this.ctx.get('skills') } catch { skills = undefined }
    let complete = true
    const errors = []
    if (skills === undefined) {
      complete = false
      errors.push('skills service unavailable (ctx.get("skills") === undefined)')
    } else {
      const contexts = [{ cwd: undefined }]
      for (const project of this.listProjects()) {
        contexts.push({ cwd: project.path, projectPath: project.path, projectTitle: project.title })
      }
      if (agent !== undefined) {
        const cwd = this.resolveCwd(agent)
        if (cwd !== undefined) contexts.push({ cwd, projectPath: cwd, projectTitle: null })
      }
      for (const context of contexts) {
        let snapshot
        try {
          snapshot = await skills.snapshot({ cwd: context.cwd, scope: agent })
        } catch (error) {
          complete = false
          errors.push('cwd=' + String(context.cwd) + ': ' + ((error && error.message) || String(error)))
          continue
        }
        if (snapshot.complete !== true) complete = false
        for (const summary of snapshot.skills) {
          const invocation = summary.invocation ?? {}
          const isSessionPolicy = typeof summary.provider === 'string' && summary.provider.startsWith('decision-skills-session:')
          // 会话策略 provider 的两类候选，处理方式正好相反：
          //   放行项——与真实条目同名同路径，留着只会把真条目的路径 / 来源顶掉 → 跳过
          //   屏蔽项——它已经把真实条目**遮在更远的层**，这一轮快照里读不到那条了。
          //           跟着跳过就等于让这一行从界面上彻底消失：用户调一次「关闭」，
          //           技能就从会话面板和仓库页一起不见了，连改回来的地方都没有。
          //           所以照常收下，缺的描述 / 位置从记忆与档位记录里补。
          if (isSessionPolicy && invocation.modelInvocable !== false) continue
          if (isSessionPolicy) {
            const remembered = this.knownRowsByName.get(summary.name)
            const stored = locatorOf(prefs, sessionId, summary.name)
            const path = remembered?.path ?? stored?.path ?? summary.path ?? null
            const archivePath = remembered?.archivePath ?? stored?.archivePath ?? summary.archivePath ?? null
            add(makeRow({
              name: summary.name,
              // 描述优先级：本轮内存 → 档位记录（写入时顺手存的）→ 占位的兜底文案
              description: remembered?.description || stored?.description || summary.description,
              // source 决定它归哪个仓库；缺失会被错归到「通用级」。
              source: remembered?.source ?? stored?.source ?? summary.source,
              provider: summary.provider,
              path,
              archivePath,
              editable: typeof path === 'string' && path !== '',
              projectPath: remembered?.projectPath ?? null,
              projectTitle: remembered?.projectTitle ?? null,
            }))
            continue
          }
          add(makeRow({
            name: summary.name,
            description: summary.description,
            whenToUse: summary.whenToUse,
            source: summary.source,
            provider: summary.provider,
            path: summary.path ?? null,
            editable: typeof summary.path === 'string' && summary.path !== '',
            modelDisabled: invocation.modelInvocable === false,
            userDisabled: invocation.userInvocable === false,
            projectPath: context.projectPath ?? null,
            projectTitle: context.projectTitle ?? null,
            // 官方 provider 认领的技能带 resourceBase，正文由它自己读，最权威。
            official: summary.resourceBase !== undefined,
          }))
        }
      }
    }

    for (const root of this.extraRoots()) {
      for (const row of await this.scanDirectoryRoot(root)) add(row)
    }
    for (const row of await this.scanArchiveSkills()) add(row)

    // 按名字合并：注册表条目与扫描条目可能指向同一个技能
    // （官方 provider 从 asar 内 assets 注册，扫描器又从磁盘扫了一遍）。
    // 合并后丢弃 byKey——它按「名字+路径」分桶，正是重复条目的来源。
    for (const row of [...byKey.values()]) addDeduped(row)

    // 叠加档位。
    //
    // 两层解析（见 prefs.js 的 resolveMode）：
    //   会话覆盖 > 全局默认 > 按来源兜底
    // 传了 sessionId 就给**这个会话的实际口径**，没传就是全局默认口径。
    const rows = [...byName.values()].map((row) => {
      const mode = resolveMode(prefs, sessionId, row)
      const globalMode = resolveMode(prefs, null, row)
      return {
        ...row,
        mode,
        // 全局默认档位单列：仓库页显示的就是它，会话面板显示的是 mode。
        // 两者在有会话覆盖时会不一样，这正是「实例偏离默认」的可视化。
        globalMode,
        // 这个会话是否**显式**调过：看 prefs 里有没有落键，
        // 而不是比较两个值——用户把它设成与默认相同的值也是一次显式决定，
        // 也要能「恢复默认」撤销。
        overridden: hasSessionOverride(prefs, sessionId, row.name),
        // 智能态在接入决策模型前对 agent 不可见（等同于 off），
        // 但状态保留，将来接上模型只需改这里。
        visible: mode === 'on',
      }
    })

    // 记一份轻量快照：会话执行端在 provider.list() 里不能回调注册表，
    // 只能读内存——它靠这份缓存兜底历史数据（全局键只有路径），
    // 目录侧靠它把**被自己遮蔽掉**的那一行还原出来。
    this.rememberRows(rows, prefs, sessionId)

    return { skills: sortRows(rows), complete, errors }
  }

  /**
   * 读技能正文，**完全不经过注册表**。
   *
   * 给会话级策略 provider 用：那个 provider 是在注册表 collect() 里被调的，
   * 若在这里回调 ctx.skills.get() 就是无限递归（爆栈 → host OOM）。
   * 所以只做磁盘 / asar 的直接读取。
   *
   * @param {{path?: string|null, archivePath?: string|null}} locator
   * @returns {Promise<object|undefined>} 完整技能定义，读不到时 undefined
   */
  async rawBodyOf(locator) {
    const name = typeof locator?.name === 'string' ? locator.name : ''
    const archivePath = typeof locator?.archivePath === 'string' ? locator.archivePath : ''
    const path = typeof locator?.path === 'string' ? locator.path : ''
    // 候选上已经带了可信描述；正文解析不出来时用它兜底。
    // asar 内的 SKILL.md 有时**没有** `---` 分隔符，直接以 key: 开头，
    // parseFrontmatter 会认为没有 frontmatter，description 变成空串，
    // 加载器随后报 "loaded skill ... requires a description"。
    const fallbackDescription = typeof locator?.description === 'string' ? locator.description : ''
    const fromText = (text) => {
      let fm = parseFrontmatter(text)
      if (!fm.hasFrontmatter && /^[A-Za-z][\w-]*\s*:/.test(text)) fm = parseFrontmatter('---\n' + text)
      return fm
    }
    if (archivePath !== '') {
      const archive = this.asarPath()
      if (archive !== null) {
        try {
          const text = await readAsarFile(archive, archivePath)
          if (text !== null) {
            const fm = fromText(text)
            return {
              name: fm.fields.name ?? name,
              description: fm.fields.description ?? fallbackDescription,
              invocation: { modelInvocable: true, userInvocable: true },
              source: 'bundled',
              provider: 'decision-skills',
              content: fm.body,
            }
          }
        } catch { /* 退回磁盘 */ }
      }
    }
    if (path === '') return undefined
    try {
      const fm = fromText(await readFile(path, 'utf8'))
      return {
        name: fm.fields.name ?? name,
        description: fm.fields.description ?? fallbackDescription,
        invocation: { modelInvocable: true, userInvocable: true },
        source: 'bundled',
        provider: 'decision-skills',
        content: fm.body,
      }
    } catch {
      return undefined
    }
  }

  /**
   * 读技能正文。
   *
   * 三种来源按可靠性排序：
   *   1. 注册表按名字取 —— 它对 bundled 也有效，且走 provider 自己的读取逻辑；
   *   2. asar 归档内路径 —— 归档里的技能没有磁盘路径；
   *   3. 磁盘文件 —— 普通技能。
   *
   * @param {{ name?: string, path?: string|null, archivePath?: string|null }} target
   */
  async bodyOf(target) {
    const { name, path, archivePath } = target ?? {}

    if (typeof name === 'string' && name !== '') {
      try {
        const skills = this.ctx.get('skills')
        const definition = await skills?.get?.(name, {})
        if (definition !== undefined) return { ok: true, content: definition.content ?? '' }
      } catch { /* 退回下一种 */ }
    }

    if (typeof archivePath === 'string' && archivePath !== '') {
      const archive = this.asarPath()
      if (archive !== null) {
        try {
          const asar = await import('./asar.js')
          const text = await asar.readAsarFile(archive, archivePath)
          if (text !== null) return { ok: true, content: parseFrontmatter(text).body }
        } catch { /* 忽略 */ }
      }
    }

    if (typeof path !== 'string' || path === '') return { ok: false, error: 'MISSING_TARGET' }
    try {
      const text = await readFile(path, 'utf8')
      return { ok: true, content: parseFrontmatter(text).body }
    } catch (error) {
      return { ok: false, error: 'READ_FAILED: ' + error.message }
    }
  }
}

/**
 * 挂载采集器。
 * @param {any} ctx
 */
export function apply(ctx) {
  const scanner = new SkillScanner(ctx)
  const dispose = ctx.provide(SERVICES.scanner, scanner)
  ctx.effect(() => dispose, SCOPE + ': scanner service')

  // 可见度桥接：让「已开启」的内嵌技能对 agent 可见。
  // 注册失败（例如注册表尚未就绪）不应拖垮整个插件。
  //
  // collect 必须走 systemRows() 而不是 catalog()：
  // provider.list() 是被注册表 collect() 调用的，回调 catalog()（内含 skills.snapshot()）
  // 会构成无限递归 —— collect → provider.list() → snapshot → collect → …，
  // 最终爆栈并把 host 进程撑到 OOM（退出码 134）。
  try {
    const uninstall = installVisibility(ctx, {
      collect: () => scanner.systemRows(),
      readBody: (innerPath) => {
        const archive = scanner.asarPath()
        return archive === null ? Promise.resolve(null) : readAsarFile(archive, innerPath)
      },
    })
    ctx.effect(() => uninstall, SCOPE + ': visibility provider')
  } catch (error) {
    ctx.logger?.warn?.('[' + SCOPE + '] visibility provider skipped: ' + (error?.message ?? error))
  }

  // ── 会话级策略执行端 ────────────────────────────────────────────
  //
  // 每个活的会话在**自己的作用域层**上挂一个屏蔽 provider：
  // 该会话关掉的技能被同名遮蔽（modelInvocable:false），
  // 全局关、该会话开的技能由原本提供它的 provider 负责（不在这里放行）。
  // 只影响这一个会话。
  //
  // 为什么挂在 agent.ctx 上：注册表按「调用方 ctx 的作用域」入层
  // （registerProvider → layers.effect(scopeOf(ctx))），
  // 从插件自己的 ctx 调只会落进全局层，那就变成影响所有会话了。
  const sessionPolicies = new WeakMap()
  const mountSession = (agent) => {
    if (agent === undefined || agent === null) return
    if (sessionPolicies.has(agent)) return
    const sessionId = typeof agent.id === 'string' ? agent.id : ''
    if (sessionId === '') return
    try {
      const handle = installSessionPolicy(agent, {
        sessionId,
        // 历史数据兜底：全局档位可能只记了路径、没记名字，
        // 这里给出已知行让执行端能反查到名字。用缓存的方法行，不碰注册表。
        knownRows: () => scanner.lastKnownRows ?? [],
        // 放行方向要靠这两项：系统级技能的候选与正文都由我们自己给，
        // 因为模型读的是 preset 注册表，宿主级 visibility provider 不在里面。
        systemRows: () => scanner.systemRows(),
        readBody: (locator) => scanner.rawBodyOf(locator),
      })
      sessionPolicies.set(agent, handle)
    } catch (error) {
      ctx.logger?.warn?.('[' + SCOPE + '] session policy skipped: ' + (error?.message ?? error))
    }
  }
  const unmountSession = (agent) => {
    const handle = sessionPolicies.get(agent)
    if (handle === undefined) return
    sessionPolicies.delete(agent)
    try { handle.dispose() } catch { /* 已卸载 */ }
  }

  // 已存在的会话先挂上（插件可能是后装的）。
  try {
    const agents = ctx.get('agents')
    for (const agent of agents?.list?.() ?? []) mountSession(agent)
  } catch { /* 无该服务：等下面的生命周期事件 */ }

  try { ctx.on('agent/created', ({ agent }) => mountSession(agent), 'decision-skills: session policy mount') } catch { /* 事件名不认识就跳过 */ }
  try { ctx.on('agent/disposed', ({ agent }) => unmountSession(agent), 'decision-skills: session policy unmount') } catch { /* 同上 */ }

  // 列表变更通知：会话中途开关技能时，在上下文末尾告诉模型发生了什么。
  try {
    installChangeNotifier(ctx, {
      collectVisible: async (agent) => {
        // 按**本会话**的档位采集：传 sessionId 才会套用会话覆盖，
        // 否则模型收到的是全局默认口径，与它实际看到的目录不一致。
        const sessionId = typeof agent?.id === 'string' ? agent.id : undefined
        const catalog = await scanner.catalog(agent, sessionId)
        return catalog.skills.filter((row) => row.visible !== false).map((row) => row.name)
      },
    })
  } catch (error) {
    ctx.logger?.warn?.('[' + SCOPE + '] change notifier skipped: ' + (error?.message ?? error))
  }

  // 注册表内容变化时清掉「官方 provider 是否在场」的缓存：
  // provider 可能被装上或卸下，那会决定我们还要不要扫 office 目录。
  try {
    ctx.on('skills/change', () => scanner.resetCaches(), 'decision-skills: reset caches')
  } catch { /* 事件名不认识就跳过，缓存最坏只是过期一次 */ }

  ctx.logger?.debug?.('[' + SCOPE + '] scanner ready')
}

export const name = '@local/decision-skills-scanner'

/**
 * skills 是**可选**依赖：没有它时仍能扫项目根、安装目录与 asar，
 * 只是拿不到注册表那部分（user/custom/runtime 类）。
 * 声明为必需会让整个插件在精简部署里永久 pending——
 * 那比"少几个技能"严重得多。
 */
export const inject = []