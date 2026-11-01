/**
 * 宿主侧技能管理服务：跨全部工作区与系统根做扫描与开关。
 *
 * 通道说明：官方推荐用 `@deepseek-ai/dsh-typert-generator` 从 FaceModel
 * **生成** `./remote` 产物，再由 `ctx.remote.$mount()` 挂载。外部包走不到
 * 那条生成流水线，因此这里按 `dsh-paper-fetch` 已验证的方式**手写等价描述符**：
 *
 *   1. 原型上写 `REMOTE_METHOD_DESCRIPTOR`（网关据此枚举端点）；
 *   2. 实例挂 `typertRemote` 绑定（派发时 `readBinding` 会校验）；
 *   3. `ctx.provide(ns, instance)` 注册成 service，网关才扫得到。
 *
 * 描述符里每个参数的 codec 必须是 `mode: 'strict'`，否则 `$mount` 会拒掉。
 * 校验权在宿主端，客户端的透传 codec 只是占位，符合官方既有做法。
 */
import { scanRoot, systemRoots, projectRoots, ROOT_KINDS, parseFrontmatter, normalizePath } from './discovery.js'
import { setSkillEnabled } from './mutate.js'
import { readFile } from 'node:fs/promises'

/** 网关据此枚举端点的原型描述符键。 */
export const REMOTE_METHOD_DESCRIPTOR = '@dsh/typert/remote-method'
/** Remote 命名空间，客户端以 `ctx.remote.skillManager` 访问。 */
export const NAMESPACE = 'skillManager'

/** 每个方法都收一个 request 对象；线上包一层 args.request。 */
const PASS_THROUGH = () => ({ parse: (value) => value })

/**
 * 列出所有工作区。
 *
 * 优先用 `ctx.workspaceRegistry`（持久、含标题与顺序）；服务缺失时
 * 退化为「只有系统根」，设置页仍可用，只是看不到项目级技能。
 */
async function listProjects(ctx) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined || registry === null) return []
  try {
    const items = registry.list()
    const out = []
    for (const item of items) {
      let path = null
      let title = null
      try {
        path = typeof item.path === 'string' ? item.path : item.path?.path ?? null
        title = typeof item.title === 'string' ? item.title : null
      } catch {
        continue
      }
      if (!path) continue
      out.push({ path, title: title ?? path })
    }
    return out
  } catch {
    return []
  }
}

/** 汇总扫描：系统根 + 每个工作区的项目根。 */
async function collect(ctx) {
  const projects = await listProjects(ctx)
  const roots = []
  // 按规范化路径去重：工作区可能恰好就是 $HOME（如 C:\Users\<name>），
  // 那样它的 `.dsh/skills` 会与系统根指向同一目录，
  // 不过滤就会把同一个技能扫描两遍，界面上出现重复行。
  const seen = new Set()

  const addRoot = (root) => {
    const key = normalizePath(root.path)
    if (seen.has(key)) return
    seen.add(key)
    roots.push(root)
  }

  for (const r of systemRoots()) addRoot({ ...r })
  for (const p of projects) {
    for (const r of projectRoots(p.path)) {
      addRoot({ ...r, projectPath: p.path, projectTitle: p.title })
    }
  }
  const scanned = []
  for (const root of roots) scanned.push(await scanRoot(root))

  // 同名技能按 rank 取先，与官方注册表的合并规则一致。
  const byName = new Map()
  for (const block of scanned) {
    for (const skill of block.skills) {
      const existing = byName.get(skill.name)
      if (existing === undefined || skill.rank < existing.skill.rank) {
        byName.set(skill.name, { skill, shadowed: existing?.skill ?? null })
      }
    }
  }
  const skills = [...byName.values()].map(({ skill, shadowed }) => ({
    ...skill,
    shadowedBy: null,
    shadows: shadowed ? shadowed.rootPath : null,
  }))
  skills.sort((a, b) => a.name.localeCompare(b.name))
  return { projects, roots: scanned.map((b) => b.root), skills }
}

/**
 * 技能管理 Remote 服务。
 *
 * 所有方法都返回纯 JSON，可直接走 wire。
 */
export class SkillManagerRemote {
  constructor(getCtx) {
    this.getCtx = getCtx
  }

  /** 设置页首屏：工作区列表、根目录清单与全部技能。 */
  async list(request = {}) {
    const ctx = this.getCtx()
    const data = await collect(ctx)
    return {
      projects: data.projects,
      roots: data.roots,
      skills: data.skills,
      generatedAt: Date.now(),
    }
  }

  /** 读单个技能的正文，用于预览。 */
  async read(request = {}) {
    const file = request?.file
    if (typeof file !== 'string' || file === '') {
      return { ok: false, error: 'MISSING_FILE' }
    }
    try {
      const text = await readFile(file, 'utf8')
      const fm = parseFrontmatter(text)
      return { ok: true, content: fm.body, fields: fm.fields }
    } catch (error) {
      return { ok: false, error: 'READ_FAILED: ' + error.message }
    }
  }

  /** 开 / 关一个技能（改 frontmatter）。 */
  async setEnabled(request = {}) {
    const { file, enabled } = request ?? {}
    if (typeof file !== 'string' || file === '') {
      return { ok: false, error: 'MISSING_FILE' }
    }
    if (typeof enabled !== 'boolean') {
      return { ok: false, error: 'MISSING_ENABLED' }
    }
    return setSkillEnabled(file, enabled)
  }
}

/**
 * 把服务挂进 cordis。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {SkillManagerRemote}
 */
export function installSkillManager(ctx) {
  const instance = new SkillManagerRemote(() => ctx)
  const methods = ['list', 'read', 'setEnabled']
  Object.defineProperty(Object.getPrototypeOf(instance), REMOTE_METHOD_DESCRIPTOR, {
    value: {
      version: 1,
      methods: methods.map((method) => ({ method, invocation: { kind: 'direct' } })),
    },
    enumerable: false,
    configurable: true,
    writable: true,
  })
  instance.typertRemote = { service: instance, serviceKey: NAMESPACE, namespace: NAMESPACE }
  const dispose = ctx.provide(NAMESPACE, instance)
  ctx.effect(() => dispose, 'decision-skills: skillManager remote')
  return instance
}

export { ROOT_KINDS, PASS_THROUGH, collect }
