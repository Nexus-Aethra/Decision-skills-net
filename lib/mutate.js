/**
 * 技能开关：通过改写 frontmatter 实现启用/停用。
 *
 * 为什么改 frontmatter 而不是移走文件：
 * - `disable-model-invocation` 与 `user-invocable` 是**机制内的正规开关**，
 *   注册表与 `/` 菜单都尊重它们；
 * - 不移动文件，用户的项目目录结构与 git 历史保持可读；
 * - 第一方 write 工具会触发 `fs/observed`，目录在下一个模型步骤即刷新。
 *
 * 关键约束（来自官方解析器）：开关值必须是合规布尔字面量，
 * 写成别的值会让**整份技能被丢弃**，所以写入时统一用 `true`/`false`。
 */
import { readFile, writeFile } from 'node:fs/promises'
import { parseFrontmatter } from './discovery.js'

const MODEL_KEY = 'disable-model-invocation'
const USER_KEY = 'user-invocable'

/**
 * 在 frontmatter 文本块里设置一个字段：存在则替换，不存在则追加。
 * @param {string[]} lines frontmatter 内的行（不含 --- 分隔符）
 * @param {string} key
 * @param {string} value
 * @returns {string[]}
 */
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
    // 插到末尾前，避免落在空行之后形成孤立块。
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
 *
 * 启用：移除两个开关键，回到「省略字段 = 默认允许」的官方语义。
 * 停用：同时写 `disable-model-invocation: true` 与 `user-invocable: false`，
 *       使模型目录与用户 `/` 菜单都看不到它。
 *
 * @param {string} file 技能文件绝对路径
 * @param {boolean} enabled 目标状态
 * @returns {Promise<{ ok: true, enabled: boolean } | { ok: false, error: string }>}
 */
export async function setSkillEnabled(file, enabled) {
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    return { ok: false, error: 'READ_FAILED: ' + error.message }
  }
  // 与解析器保持一致：先剥掉 BOM，否则下面的 indexOf('---') 全部错位。
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const fm = parseFrontmatter(src)
  if (!fm.hasFrontmatter) {
    // 没有 frontmatter 的技能本就不会被发现，这里明确拒绝而不是猜。
    return { ok: false, error: 'NO_FRONTMATTER' }
  }
  const end = src.indexOf('\n---', 3)
  if (end === -1) return { ok: false, error: 'BAD_FRONTMATTER' }
  const innerRaw = src.slice(3, end)
  const body = src.slice(end + 4)
  let lines = innerRaw.split(/\r?\n/).filter((line) => line.trim() !== '')

  if (enabled) {
    lines = dropField(lines, MODEL_KEY)
    lines = dropField(lines, USER_KEY)
  } else {
    lines = setField(lines, MODEL_KEY, 'true')
    lines = setField(lines, USER_KEY, 'false')
  }

  const rebuilt = '---\n' + lines.join('\n') + '\n---' + (body.startsWith('\n') ? '' : '\n') + body
  try {
    await writeFile(file, rebuilt, 'utf8')
  } catch (error) {
    return { ok: false, error: 'WRITE_FAILED: ' + error.message }
  }
  return { ok: true, enabled }
}
