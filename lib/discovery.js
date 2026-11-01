/**
 * 技能发现：扫描系统级与所有工作区的项目级技能根。
 *
 * 官方 `ctx.skills.list()` 按**单个 cwd** 查询，而设置页要跨全部工作区浏览，
 * 因此这里直接读磁盘上的已知根目录，不依赖某个会话的 cwd。
 *
 * 根目录与 rank 取自 `@deepseek-ai/dsh-skill-filesystem`：
 *   100 project-dsh      <项目根>/.dsh/skills
 *   200 project-agents   <项目根>/.agents/skills
 *   400 user-dsh         <dshHome>/skills      （跳过 .system）
 *   500 user-agents      <agentsHome>/skills
 * 本项目另有自定义根 300（custom），当前未启用。
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, basename, resolve } from 'node:path'
import { homedir } from 'node:os'

/** 技能名必须是 kebab-case，与官方解析器一致。 */
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** 调用开关接受的布尔字面量（大小写不敏感），与官方一致。 */
const TRUE_WORDS = new Set(['true', 'yes', 'on', '1'])
const FALSE_WORDS = new Set(['false', 'no', 'off', '0'])

export const ROOT_KINDS = {
  'project-dsh': { rank: 100, scope: 'project', label: '.dsh/skills' },
  'project-agents': { rank: 200, scope: 'project', label: '.agents/skills' },
  'user-dsh': { rank: 400, scope: 'system', label: '~/.dsh/skills' },
  'user-agents': { rank: 500, scope: 'system', label: '~/.agents/skills' },
}

/** 系统级根路径。 */
export function systemRoots(env = process.env) {
  const dshHome = env.DSH_HOME || join(homedir(), '.dsh')
  const agentsHome = env.DSH_AGENTS_HOME || join(homedir(), '.agents')
  return [
    { kind: 'user-dsh', path: join(dshHome, 'skills') },
    { kind: 'user-agents', path: join(agentsHome, 'skills') },
  ]
}

/** 某个工作区下的项目级根路径。 */
export function projectRoots(projectPath) {
  return [
    { kind: 'project-dsh', path: join(projectPath, '.dsh', 'skills') },
    { kind: 'project-agents', path: join(projectPath, '.agents', 'skills') },
  ]
}

/**
 * 极简 YAML frontmatter 解析。
 *
 * 只处理官方文档列出的标量字段；嵌套的 `metadata` 等一律忽略——
 * 设置页只关心展示与开关，不需要完整 YAML 语义。
 */
export function parseFrontmatter(text) {
  const result = { fields: {}, body: text, hasFrontmatter: false }
  // 去掉 UTF-8 BOM：Windows 编辑器与 PowerShell 写文件默认带 BOM，
  // 它会让 startsWith('---') 失败，技能因此"莫名消失"。
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
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1)
    }
    result.fields[m[1]] = value
  }
  return result
}

/** 把 frontmatter 里的调用开关字面量解析成布尔；无法识别时返回 undefined。 */
function parseBoolWord(value) {
  if (value === undefined) return undefined
  const v = String(value).trim().toLowerCase()
  if (TRUE_WORDS.has(v)) return true
  if (FALSE_WORDS.has(v)) return false
  return undefined
}

/**
 * 判定一个技能的启用状态。
 *
 * 一个技能只要被任一调用口关掉，就视为「已关闭」：
 * 模型看不到、用户 `/` 菜单也看不到。
 */
export function readSwitches(fields) {
  const modelDisabled = parseBoolWord(fields['disable-model-invocation']) === true
  const userDisabled = parseBoolWord(fields['user-invocable']) === false
  return { modelDisabled, userDisabled, enabled: !modelDisabled && !userDisabled }
}

/** 这是不是一份可用的技能文件。 */
function isSkillFileName(name) {
  return name === 'SKILL.md'
}

/**
 * 扫描一个根目录，返回发现到的技能。
 *
 * 支持两种布局：目录 bundle `<name>/SKILL.md` 与平铺 `<name>.md`。
 * 嵌套目录不被发现，与官方一致；`.system` 子目录对 user-dsh 根跳过。
 */
export async function scanRoot(root) {
  const { kind, path, projectPath, projectTitle } = root
  const meta = ROOT_KINDS[kind]
  // 作用域由根类型决定，而不是由调用方传：避免项目根忘记带 scope
  // 导致技能落进 "undefined" 分组。
  const scope = meta.scope
  const out = []
  let entries
  try {
    entries = await readdir(path, { withFileTypes: true })
  } catch {
    return { root: { kind, path, scope, rank: meta.rank, projectPath, projectTitle, exists: false }, skills: out }
  }
  for (const entry of entries) {
    if (kind === 'user-dsh' && entry.name === '.system') continue
    let file = null
    let dirPath = null
    if (entry.isDirectory()) {
      const candidate = join(path, entry.name, 'SKILL.md')
      try {
        await stat(candidate)
        file = candidate
        dirPath = join(path, entry.name)
      } catch {
        continue
      }
    } else if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'SKILL.md') {
      file = join(path, entry.name)
      dirPath = null
    } else {
      continue
    }
    let text
    try {
      text = await readFile(file, 'utf8')
    } catch {
      continue
    }
    const fm = parseFrontmatter(text)
    const name = fm.fields.name
    if (!name || !NAME_RE.test(name)) continue
    const switches = readSwitches(fm.fields)
    out.push({
      name,
      description: fm.fields.description ?? '',
      whenToUse: fm.fields.whenToUse ?? '',
      enabled: switches.enabled,
      modelDisabled: switches.modelDisabled,
      userDisabled: switches.userDisabled,
      file,
      dir: dirPath,
      rootKind: kind,
      rootPath: path,
      scope,
      rank: meta.rank,
      projectPath: projectPath ?? null,
      projectTitle: projectTitle ?? null,
      bundle: dirPath !== null,
    })
  }
  return { root: { kind, path, scope, rank: meta.rank, projectPath, projectTitle, exists: true }, skills: out }
}

/** 解析真实路径，用于去重与归属判断。 */
export function normalizePath(p) {
  try {
    return resolve(p)
  } catch {
    return p
  }
}

export { isSkillFileName, basename, existsSync }
