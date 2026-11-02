/**
 * 开关状态持久化。
 *
 * 存两个位置，与技能来源对应：
 *   - 系统级（内嵌/asar）：**不能改文件**，只能改这里的状态
 *   - 通用级/项目级：也记这里，但真正生效靠改 frontmatter（对齐官方语义）
 *
 * 文件位置：<DSH_HOME>/storages/decision-skills.json
 * 选这里的原因：和宿主其它 storages 放一起，容器/桌面都自动隔离。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 状态文件路径候选（按优先级）。 */
function statePath() {
  const home = process.env.DSH_HOME || join(process.env.USERPROFILE ?? '', '.dsh')
  return join(home, 'storages', 'decision-skills.json')
}

/** 空状态。 */
function emptyState() {
  return { version: 1, visibility: {}, projects: {}, updatedAt: null }
}

/**
 * 读取状态。
 * @returns {Promise<{version:number, visibility:Record<string,boolean>, projects:Record<string,unknown>, updatedAt:string|null}>}
 */
export async function loadPrefs() {
  const path = statePath()
  if (!existsSync(path)) return emptyState()
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw)
    return {
      version: parsed.version ?? 1,
      // key -> 是否对 agent 可见
      visibility: parsed.visibility ?? {},
      // 项目级相关：提升记录、默认项目等
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
    const next = { ...state, version: 1, updatedAt: new Date().toISOString() }
    await writeFile(path, JSON.stringify(next, null, 2), 'utf8')
    return { ok: true, path }
  } catch (error) {
    return { ok: false, error: 'WRITE_FAILED: ' + error.message }
  }
}

/** 状态的稳定键：优先磁盘路径，其次名字。系统级没有路径，用名字。 */
export function prefKey(row) {
  return row.path || row.archivePath || row.name
}

export { statePath }
