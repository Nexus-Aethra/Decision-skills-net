/**
 * 可见度桥接（visibility）。
 *
 * 系统级技能（asar / 安装 assets 内的）**不能改文件**，
 * 但 agent 能不能在 skills 列表里看到它们，是由注册表决定的。
 *
 * 做法：本模块注册一个 provider 到【全局层】，只暴露「已开启」的内嵌技能。
 * agent 调 skill 工具时会合并所有层——包括这一层，于是：
 *   - 关闭（默认）：provider 不返回它 → agent 看不到
 *   - 开启：provider 返回它 → agent 可见、可读正文
 *
 * 关键点：**不改磁盘、不改官方 provider**，只在注册表层叠加。
 * 卸下插件即恢复原状，不会留下副作用。
 */
import { readAsarFile } from './asar.js'
import { loadPrefs, resolveMode } from './prefs.js'
import { parseFrontmatter } from './index.js'
import { SCOPE } from '../shared/index.js'

/** provider 名，必须与内置 provider 不同。 */
export const VISIBILITY_PROVIDER = 'decision-skills-visibility'

/**
 * 构造一个只暴露「已开启」内嵌技能的 provider。
 *
 * @param {object} deps
 * @param {() => Promise<Array>} deps.collect 采集系统级技能行（**不得回调注册表**）
 * @param {(innerPath: string) => Promise<string|null>} deps.readBody 读 asar 正文
 * @returns {object} SkillProvider
 */
export function createVisibilityProvider({ collect, readBody }) {
  return {
    name: VISIBILITY_PROVIDER,

    async list(options) {
      // ⚠️ collect 只能返回**不经过注册表**的行（scanner.systemRows()）。
      // provider.list() 是被注册表 collect() 调用的；这里若再回调 ctx.skills.snapshot()，
      // 会形成 collect → provider.list() → snapshot → collect 的无限递归，
      // 表现为爆栈后 host 进程 OOM 崩溃（退出码 134）。详见 scanner/index.js 的 systemRows()。
      const rows = await collect()
      const prefs = await loadPrefs()

      // 注册表会把 snapshot 的 options 原样传下来（cwd / scope / signal）。
      // scope 就是**正在查看的那个 agent**，所以全局层的 provider
      // 也能按会话决定可见度——这是会话级策略能在这一层生效的前提。
      const sessionId = typeof options?.scope?.id === 'string' ? options.scope.id : undefined

      const out = []
      for (const row of rows) {
        // 只处理内嵌技能：磁盘上的技能由官方 filesystem provider 负责，
        // 重复注册会造成同名冲突。
        if (row.scope !== 'system') continue
        // 会话覆盖 > 全局默认；只有 on 对 agent 可见。
        if (resolveMode(prefs, sessionId, row) !== 'on') continue
        out.push({
          name: row.name,
          description: row.description,
          ...(row.whenToUse ? { whenToUse: row.whenToUse } : {}),
          invocation: { modelInvocable: true, userInvocable: true },
          source: 'bundled',
          provider: VISIBILITY_PROVIDER,
          ...(row.path ? { path: row.path } : {}),
          locator: { name: row.name, archivePath: row.archivePath ?? null, path: row.path ?? null },
          rank: 600,
        })
      }
      return out
    },

    async get(candidate) {
      const locator = candidate?.locator ?? {}
      // 归档内技能：直接解 asar
      if (typeof locator.archivePath === 'string' && locator.archivePath !== '') {
        const text = await readBody(locator.archivePath)
        if (text === null) return undefined
        const fm = parseFrontmatter(text)
        return {
          name: candidate.name,
          description: fm.fields.description ?? '',
          content: fm.body,
          invocation: { modelInvocable: true, userInvocable: true },
          source: 'bundled',
          provider: VISIBILITY_PROVIDER,
        }
      }
      return undefined
    },
  }
}

/**
 * 把可见度 provider 注册进注册表。
 * @param {any} ctx
 * @param {object} deps
 * @returns {() => void} 注销函数
 */
export function installVisibility(ctx, deps) {
  const skills = ctx.get('skills')
  if (skills === undefined) return () => {}
  return skills.registerProvider(() => createVisibilityProvider(deps))
}

export { SCOPE }
