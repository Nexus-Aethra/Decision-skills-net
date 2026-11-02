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
import { readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeRow, sortRows, EVENTS, SERVICES, SCOPE } from '../shared/index.js'

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

  /** 列出会话（磁盘优先，服务回退）。 */
  async listSessions() {
    const fromDisk = await this.scanSessionDirs()
    if (fromDisk.length > 0) return fromDisk
    try {
      const query = this.ctx.get('sessionQuery')
      if (query && typeof query.listSessions === 'function') {
        let records
        try { records = await query.listSessions() } catch { records = await query.listSessions(undefined) }
        if (Array.isArray(records) && records.length > 0) {
          return records
            .map((r) => ({ id: String(r.id ?? r.sessionId ?? ''), title: String(r.title ?? r.name ?? r.id ?? '') }))
            .filter((r) => r.id !== '')
            .slice(0, 200)
        }
      }
    } catch { /* 无该服务 */ }
    try {
      const sessions = this.ctx.get('sessions')
      const items = sessions?.list?.() ?? []
      if (items.length > 0) {
        return items
          .map((item) => ({ id: String(item?.id ?? item ?? ''), title: String(item?.title ?? item?.id ?? '') }))
          .filter((r) => r.id !== '')
          .slice(0, 200)
      }
    } catch { /* 继续 */ }
    return []
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
          seen.add(s.name)
          out.push({ id: s.name, title: s.name, workspace: group.name })
        }
      }
    }
    return out.slice(0, 200)
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

  /** 安装自带、无 provider 认领的技能目录。 */
  extraRoots() {
    const roots = []
    const seen = new Set()
    const push = (p) => {
      if (typeof p !== 'string' || p === '' || seen.has(p) || !existsSync(p)) return
      seen.add(p)
      roots.push(p)
    }
    if (process.env.DSH_INSTALL_ROOT) push(join(process.env.DSH_INSTALL_ROOT, 'resources', 'runtime', 'office-skills'))
    push('E:\\dsh\\resources\\runtime\\office-skills')
    push(join(process.env.ProgramFiles ?? '', 'DeepSeek Harness', 'resources', 'runtime', 'office-skills'))
    return roots
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
   * 完整目录：注册表 + 项目根 + 安装目录 + asar。
   * @param agent 会话作用域，省略则只读全局与各工作区
   */
  async catalog(agent) {
    const byKey = new Map()
    const add = (row) => {
      const key = row.name + '\u0000' + (row.path ?? row.archivePath ?? '')
      if (!byKey.has(key)) byKey.set(key, row)
    }

    let skills
    try { skills = this.ctx.get('skills') } catch { skills = undefined }
    let complete = true
    if (skills === undefined) {
      complete = false
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
        } catch {
          complete = false
          continue
        }
        if (snapshot.complete !== true) complete = false
        for (const summary of snapshot.skills) {
          const invocation = summary.invocation ?? {}
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
          }))
        }
      }
    }

    for (const root of this.extraRoots()) {
      for (const row of await this.scanDirectoryRoot(root)) add(row)
    }
    for (const row of await this.scanArchiveSkills()) add(row)

    return { skills: sortRows([...byKey.values()]), complete }
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
