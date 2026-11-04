/**
 * 档位状态持久化。
 *
 * 两层语义（这是整个插件的状态模型，改之前先读懂）：
 *
 *   1. visibility  —— **全局默认**，即仓库页里那个三态滑块。
 *                     语义是「**以后新建的会话**默认是什么样」，不针对任何具体会话。
 *   2. sessions    —— **会话级覆盖**，键是 sessionId，内层键是**技能名**。
 *                     只有被显式调过的技能才在这里出现；
 *                     没出现就是「跟随全局默认」。
 *
 * 为什么必须分两层：仓库是「策略仓库」，会话是「策略实例」。
 * 调单个会话时不该被迫改全局默认（那会波及所有新会话）；
 * 反过来，改全局默认也不该悄悄改动已经存在的会话。
 *
 * 文件位置：<DSH_HOME>/storages/decision-skills.json
 * 选这里的原因：和宿主其它 storages 放一起，容器/桌面都自动隔离。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 合法技能名（kebab-case），与官方 SKILL_NAME 同规则。 */
export const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** 状态文件路径。 */
function statePath() {
  const home = process.env.DSH_HOME || join(process.env.USERPROFILE ?? '', '.dsh')
  return join(home, 'storages', 'decision-skills.json')
}

/** 空状态。 */
function emptyState() {
  return { version: 2, visibility: {}, sessions: {}, projects: {}, updatedAt: null }
}

/**
 * 读取状态。
 * @returns {Promise<{version:number, visibility:Record<string,unknown>, sessions:Record<string,Record<string,unknown>>, projects:Record<string,unknown>, updatedAt:string|null}>}
 */
export async function loadPrefs() {
  const path = statePath()
  if (!existsSync(path)) return emptyState()
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw)
    return {
      version: parsed.version ?? 1,
      // 技能键（路径 / 归档路径 / 名字）-> 全局默认档位条目
      visibility: parsed.visibility ?? {},
      // sessionId -> { 技能名 -> 会话档位条目 }
      sessions: parsed.sessions ?? {},
      projects: parsed.projects ?? {},
      updatedAt: parsed.updatedAt ?? null,
    }
  } catch {
    return emptyState()
  }
}

/**
 * 写状态。
 * @param {object} state
 */
export async function savePrefs(state) {
  const path = statePath()
  try {
    await mkdir(dirname(path), { recursive: true })
    const next = { ...state, version: 2, updatedAt: new Date().toISOString() }
    await writeFile(path, JSON.stringify(next, null, 2), 'utf8')
    return { ok: true, path }
  } catch (error) {
    return { ok: false, error: 'WRITE_FAILED: ' + error.message }
  }
}

/** 全局档位键：优先磁盘路径，其次归档路径，最后名字。系统级没有路径，用名字。 */
export function prefKey(row) {
  return row.path || row.archivePath || row.name
}

/** 合法档位。 */
export const MODES = ['off', 'smart', 'on']

/**
 * 把一个存下来的原始值归一成三态档位。
 * 历史数据里可能是布尔（true/false），这里统一收敛。
 * @param {unknown} stored
 * @returns {'off'|'smart'|'on'|undefined}
 */
export function normalizeMode(stored) {
  if (stored === 'off' || stored === 'smart' || stored === 'on') return stored
  if (typeof stored === 'boolean') return stored ? 'on' : 'off'
  return undefined
}

/**
 * 从一条档位记录里取出档位。
 * 记录可能是裸字符串（早期写法）或 { mode, name, path, ... } 对象。
 * @param {unknown} entry
 * @returns {'off'|'smart'|'on'|undefined}
 */
export function entryMode(entry) {
  if (typeof entry === 'string' || typeof entry === 'boolean') return normalizeMode(entry)
  if (entry !== null && typeof entry === 'object') return normalizeMode(entry.mode)
  return undefined
}

/**
 * 把全局 visibility 表展开成结构化的条目数组。
 *
 * 为什么需要展开：旧数据是 `路径 -> 'off'` 的裸映射，拿不到技能名；
 * 而会话级的执行端（session.js）必须**按名字**屏蔽，
 * 所以这里尽量把名字恢复出来（键本身是合法技能名时就是它）。
 *
 * @param {object} prefs
 * @returns {Array<{key: string, name: string|null, mode: 'off'|'smart'|'on', path: string|null, archivePath: string|null, source: string}>}
 */
export function globalEntries(prefs) {
  const out = []
  for (const [key, raw] of Object.entries(prefs.visibility ?? {})) {
    const mode = entryMode(raw)
    if (mode === undefined) continue
    const record = raw !== null && typeof raw === 'object' ? raw : {}
    const declared = typeof record.name === 'string' && record.name !== '' ? record.name : null
    const name = declared ?? (NAME_RE.test(key) ? key : null)
    out.push({
      key,
      name,
      mode,
      path: typeof record.path === 'string' ? record.path : null,
      archivePath: typeof record.archivePath === 'string' ? record.archivePath : null,
      source: typeof record.source === 'string' ? record.source : 'runtime',
      description: typeof record.description === 'string' ? record.description : null,
    })
  }
  return out
}

/**
 * 解析一条技能在**某个会话**里的最终档位。
 *
 * 优先级：会话覆盖 > 全局默认 > 按来源兜底。
 *
 * @param {object} prefs
 * @param {string|null|undefined} sessionId 会话；省略时只看全局层
 * @param {{scope?: string, path?: string|null, archivePath?: string|null, name: string}} row
 * @returns {'off'|'smart'|'on'}
 */
export function resolveMode(prefs, sessionId, row) {
  if (typeof sessionId === 'string' && sessionId !== '') {
    const own = entryMode(prefs.sessions?.[sessionId]?.[row.name])
    if (own !== undefined) return own
  }
  const global = entryMode(prefs.visibility?.[prefKey(row)])
  if (global !== undefined) return global
  return defaultMode(row)
}

/**
 * 某个会话里被显式调过的条目。
 * @param {object} prefs
 * @param {string|null|undefined} sessionId
 * @returns {Array<{name: string, mode: 'off'|'smart'|'on', path: string|null, archivePath: string|null, source: string}>}
 */
export function sessionOverrides(prefs, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return []
  const table = prefs.sessions?.[sessionId]
  if (table === undefined) return []
  const out = []
  for (const [name, raw] of Object.entries(table)) {
    const mode = entryMode(raw)
    if (mode === undefined) continue
    const record = raw !== null && typeof raw === 'object' ? raw : {}
    out.push({
      name,
      mode,
      path: typeof record.path === 'string' ? record.path : null,
      archivePath: typeof record.archivePath === 'string' ? record.archivePath : null,
      source: typeof record.source === 'string' ? record.source : 'runtime',
      description: typeof record.description === 'string' ? record.description : null,
    })
  }
  return out
}

/**
 * 按技能名找回显式配置里记下的**位置**（会话覆盖优先，其次全局桶）。
 *
 * 给会话级策略的「遮蔽占位」用：那条占位候选一出现，就把真实条目顶到了
 * 更远的层、目录快照里再也读不到它的路径与来源；宿主重启之后内存里也没有。
 * 这时只剩用户上次调档位时顺手写下的 path / archivePath / source 能把这一行认回来。
 *
 * @param {object} prefs
 * @param {string|null|undefined} sessionId
 * @param {string} name
 * @returns {{path: string|null, archivePath: string|null, source: string|null}|null}
 */
export function locatorOf(prefs, sessionId, name) {
  if (typeof name !== 'string' || name === '') return null
  for (const row of sessionOverrides(prefs, sessionId)) {
    if (row.name === name) {
      return { path: row.path, archivePath: row.archivePath, source: row.source, description: row.description }
    }
  }
  for (const entry of globalEntries(prefs)) {
    if (entry.name === name) {
      return { path: entry.path, archivePath: entry.archivePath, source: entry.source, description: entry.description }
    }
  }
  return null
}

/**
 * 一个技能「没有被任何档位配置提到」时的默认档位。
 *
 * 规则只有一条：**系统级默认关，其余默认开。**
 *
 * ⚠️ 判据绝不能看 provider，也不能看路径。踩过的坑：
 * 早先按 provider 名判（我们扫的默认关、官方 provider 认领的默认开）。
 * 但同一个技能由谁提供**会漂移**——office 系列在官方 `dsh-office` 在场时由它提供，
 * 一旦那次采集没拿到（注册表刚失效重建，providers 表瞬时为空），就由我们的
 * 磁盘扫描补上。于是同一个技能两次刷新之间在「开」和「关」之间跳，
 * 用户看到的是「我没点，它自己变了」，一次刷新能连带六七条一起变。
 *
 * 为什么系统级默认关：
 *   - 它们内嵌在宿主 / 安装目录里，不属于用户自己的技能库，
 *     不主动塞进模型的上下文 = 省 token、少干扰；
 *   - 更重要的是**界面即事实**：默认关 ⇒ 注册表里就是被遮蔽的，
 *     用户在门户里点开 ⇒ 我们负责把正文交出去。不会出现
 *     「界面显示开启、模型却说 unknown」这种两套说法。
 *
 * @param {{scope?: string}} row
 * @returns {'off'|'on'}
 */
export function defaultMode(row) {
  return row.scope === 'system' ? 'off' : 'on'
}

/**
 * 这个会话是否**显式**调过这条技能。
 *
 * 注意与「值是否不同于默认」区分：用户把它设成和默认一样的值，
 * 仍然是一次显式决定（也要能「恢复默认」撤销）。所以看表里有没有这个键，
 * 而不是比较两个值。
 *
 * @param {object} prefs
 * @param {string|null|undefined} sessionId
 * @param {string} name
 * @returns {boolean}
 */
export function hasSessionOverride(prefs, sessionId, name) {
  if (typeof sessionId !== 'string' || sessionId === '') return false
  const table = prefs.sessions?.[sessionId]
  return table !== undefined && Object.hasOwn(table, name)
}

/** 三态里只有 on 对 agent 真的可见。智能档待决策模型接入后才有独立行为。 */
export function isVisibleMode(mode) {
  return mode === 'on'
}

export { statePath }
