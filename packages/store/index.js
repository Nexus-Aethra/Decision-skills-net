/**
 * 技能状态写入（skillStore）。
 *
 * 职责单一：**只负责改盘**。不采集、不渲染、不注册 Remote。
 *
 * 两条写路径：
 *   1. 开关 —— 改 frontmatter 的 disable-model-invocation / user-invocable。
 *      这是机制内的正规开关，注册表与 / 菜单都尊重；
 *      值必须是合规布尔字面量，写成别的会让**整份技能被丢弃**。
 *   2. 删除 —— 移到 <技能根>/.trash/<时间戳>/<名字>，保留可恢复性。
 *      绝不直接 rm：用户没有 undo。
 *
 * 未来的"过滤器"插件可以在这里前后挂：它只需要包一层 store。
 */
import { readFile, writeFile, mkdir, rename, rm, cp, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { SERVICES, SCOPE } from '../shared/index.js'
import { loadPrefs, savePrefs, prefKey } from '../scanner/prefs.js'

const MODEL_KEY = 'disable-model-invocation'
const USER_KEY = 'user-invocable'

/** 设置 frontmatter 字段：存在则替换，否则追加。 */
function setField(lines, key, value) {
  const re = new RegExp('^(' + key + '\\s*:\\s*)(.*)$')
  let found = false
  const next = lines.map((line) => {
    const m = re.exec(line)
    if (!m) return line
    found = true
    return m[1] + value
  })
  if (!found) {
    while (next.length > 0 && next[next.length - 1].trim() === '') next.pop()
    next.push(key + ': ' + value)
  }
  return next
}

/** 删除一个字段行。 */
function dropField(lines, key) {
  const re = new RegExp('^' + key + '\\s*:')
  return lines.filter((line) => !re.test(line))
}

/**
 * 改写一个技能文件的启用状态。
 * @param {string} file 绝对路径
 * @param {boolean} enabled 目标状态
 */
export async function setSkillEnabled(file, enabled) {
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    return { ok: false, error: 'READ_FAILED: ' + error.message }
  }
  // 与解析器一致：先剥 BOM，否则 indexOf('---') 全部错位。
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  if (!src.startsWith('---')) return { ok: false, error: 'NO_FRONTMATTER' }
  const end = src.indexOf('\n---', 3)
  if (end === -1) return { ok: false, error: 'BAD_FRONTMATTER' }

  const body = src.slice(end + 4)
  let lines = src.slice(3, end).split(/\r?\n/).filter((line) => line.trim() !== '')
  if (enabled) {
    lines = dropField(dropField(lines, MODEL_KEY), USER_KEY)
  } else {
    lines = setField(setField(lines, MODEL_KEY, 'true'), USER_KEY, 'false')
  }

  const rebuilt = '---\n' + lines.join('\n') + '\n---' + (body.startsWith('\n') ? '' : '\n') + body
  try {
    await writeFile(file, rebuilt, 'utf8')
  } catch (error) {
    return { ok: false, error: 'WRITE_FAILED: ' + error.message }
  }
  return { ok: true, enabled }
}

/**
 * 状态写入服务。
 */
export class SkillStore {
  constructor(ctx) {
    this.ctx = ctx
    this.name = SERVICES.store
  }

  /** 开 / 关。 */
  async setEnabled({ file, enabled }) {
    if (typeof file !== 'string' || file === '') return { ok: false, error: 'NOT_EDITABLE' }
    if (typeof enabled !== 'boolean') return { ok: false, error: 'MISSING_ENABLED' }
    const result = await setSkillEnabled(file, enabled)
    if (result.ok) {
      await this.invalidate()
      this.ctx.emit?.('decision-skills/toggled', { file, enabled })
    }
    return result
  }

  /**
   * 删除：移到技能根下的 .trash/<时间戳>/。
   * @param {{ path?: string, name?: string }} input
   */
  async remove({ path, name }) {
    if (typeof path !== 'string' || path === '') return { ok: false, error: 'NOT_REMOVABLE' }
    if (basename(path) !== 'SKILL.md' && !path.endsWith('.md')) {
      return { ok: false, error: 'UNEXPECTED_TARGET' }
    }
    // 目录 bundle 移父目录，平铺文件移自身。
    const target = basename(path) === 'SKILL.md' ? dirname(path) : path
    const root = dirname(target)
    // .trash 必须放在**技能根之外**，否则它自己会被当成技能扫出来。
    const trashRoot = join(dirname(root), '.trash-' + basename(root))
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const dest = join(trashRoot, stamp, basename(target))
    try {
      await mkdir(dirname(dest), { recursive: true })
      await rename(target, dest)
    } catch (error) {
      return { ok: false, error: 'REMOVE_FAILED: ' + error.message }
    }
    await this.invalidate()
    this.ctx.emit?.('decision-skills/removed', { name, movedTo: dest })
    return { ok: true, movedTo: dest }
  }

  /**
   * 提升项目技能到通用级：复制到 ~/.dsh/skills/<name>/。
   *
   * 语义是**复制**而不是移动：项目里的原件保留——项目随时还在用它，
   * 移走等于偷偷改了项目的文件。两份之后各自演化，这是有意的。
   * 目录技能整个目录复制；平铺 .md 文件补成 <name>/SKILL.md。
   */
  async promote({ path }) {
    if (typeof path !== 'string' || path === '') return { ok: false, error: 'MISSING_PATH' }
    const isDirSkill = basename(path) === 'SKILL.md'
    if (!isDirSkill && !path.endsWith('.md')) return { ok: false, error: 'UNEXPECTED_TARGET' }
    const source = isDirSkill ? dirname(path) : path

    // 名字取 frontmatter，缺了退回目录名；必须过技能名正则，否则写进去也扫不出来。
    let text
    try { text = await readFile(path, 'utf8') } catch (error) {
      return { ok: false, error: 'READ_FAILED: ' + error.message }
    }
    const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
    const fmEnd = src.indexOf('\n---', 3)
    const fmMatch = /^name\s*:\s*(.+)$/m.exec(src.slice(0, fmEnd === -1 ? 256 : fmEnd))
    const fallback = isDirSkill ? basename(source) : basename(path, '.md')
    const name = (fmMatch ? fmMatch[1].trim().replace(/^["']|["']$/g, '') : '') || fallback
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) return { ok: false, error: 'BAD_NAME: ' + name }

    // 目标根与 scanner 的 user-dsh 根保持同一解析：DSH_HOME 优先，
    // 否则 ~/.dsh。容器/桌面 profile 各自隔离，不写串。
    const home = process.env.DSH_HOME || join(homedir(), '.dsh')
    const destDir = join(home, 'skills', name)
    // 已存在不覆盖：覆盖会静默毁掉用户在通用级的手改。
    if (existsSync(destDir)) return { ok: false, error: 'TARGET_EXISTS: ' + destDir }
    try {
      await mkdir(destDir, { recursive: true })
      if (isDirSkill) await cp(source, destDir, { recursive: true })
      else await copyFile(path, join(destDir, 'SKILL.md'))
    } catch (error) {
      return { ok: false, error: 'PROMOTE_FAILED: ' + error.message }
    }
    await this.invalidate()
    this.ctx.emit?.('decision-skills/promoted', { name, dest: destDir })
    return { ok: true, name, dest: destDir, mode: 'copy' }
  }

  /** 清空回收目录。 */
  async purge({ root }) {
    if (typeof root !== 'string' || root === '') return { ok: false, error: 'MISSING_ROOT' }
    const trash = join(dirname(root), '.trash-' + basename(root))
    if (!existsSync(trash)) return { ok: true, removed: 0 }
    try {
      await rm(trash, { recursive: true, force: true })
      return { ok: true, removed: 1 }
    } catch (error) {
      return { ok: false, error: 'PURGE_FAILED: ' + error.message }
    }
  }

  /**
   * 设置「对 agent 可见」。
   *
   * 这是系统级技能唯一的可操作项：它们的实体在 asar / 安装 assets 里，
   * 不能改文件，只能改状态。状态一变，可见度 provider 下次 list()
   * 就会反映出来（注册表会因 invalidate 重建）。
   *
   * 三态：
   *   off   关闭 —— agent 完全看不到
   *   smart 智能 —— 进入候选池，等决策模型决定何时注入（当前尚无模型，
   *                 行为等同于 off，但状态保留，接口不变）
   *   on    开启 —— 始终对 agent 可见
   *
   * @param {{ key?: string, name?: string, path?: string, archivePath?: string, mode: 'off'|'smart'|'on' }} input
   */
  async setVisibility(input) {
    const mode = input?.mode
    if (mode !== 'off' && mode !== 'smart' && mode !== 'on') {
      return { ok: false, error: 'MISSING_MODE' }
    }
    const key = input?.key || input?.path || input?.archivePath || input?.name
    if (typeof key !== 'string' || key === '') return { ok: false, error: 'MISSING_KEY' }

    const prefs = await loadPrefs()
    // 兼容旧数据：历史上是布尔，这里统一写成 mode 字符串。
    prefs.visibility[key] = mode
    const saved = await savePrefs(prefs)
    if (saved.ok !== true) return saved

    await this.invalidate()
    this.ctx.emit?.('decision-skills/toggled', { key, mode })
    return { ok: true, mode }
  }

  /**
   * 让注册表失效。
   *
   * 不做这一步的话，界面会"删了没反应"——磁盘变了但缓存还返回旧目录。
   *
   * **旧实现调的是 `skills.providers()`，那个方法根本不存在**——异常被
   * catch 静默吞掉，失效从未真正发生。注册表对外的有效入口是实例方法
   * `invalidateCache()`（bump revision + 清 collect 缓存 + 通知变更）。
   *
   * @returns {boolean} 是否成功触发了失效
   */
  async invalidate() {
    try {
      const skills = this.ctx.get('skills')
      if (skills === undefined) return false
      if (typeof skills.invalidateCache === 'function') {
        skills.invalidateCache()
        return true
      }
      return false
    } catch {
      // 失效失败不能阻断写入本身（磁盘已经改了），静默即可。
      return false
    }
  }
}

/**
 * 挂载状态写入服务。
 * @param {any} ctx
 */
export function apply(ctx) {
  const store = new SkillStore(ctx)
  const dispose = ctx.provide(SERVICES.store, store)
  ctx.effect(() => dispose, SCOPE + ': store service')
}

export const name = '@local/decision-skills-store'
export const inject = []
