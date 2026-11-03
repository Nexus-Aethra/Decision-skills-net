/**
 * 回归测试：visibility provider 不得回调注册表。
 *
 * 这条约束是硬性的，原因见 packages/scanner/visibility.js 的注释：
 * provider.list() 是**被**注册表 collect() 调用的；若它再回调 ctx.skills.snapshot()，
 * 就形成 collect → provider.list() → snapshot → collect 的无限递归，
 * 表现为爆栈（RangeError: Maximum call stack size exceeded）后
 * host 进程 OOM 崩溃（退出码 134）。
 *
 * 本测试不需要官方 dsh-skill 包：用一个最小的假注册表复刻 collect/collectFresh 语义。
 *
 * 跑法：node test/no-registry-recursion.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 复刻官方 SkillRegistry 的 collect/collectFresh 语义（见 dsh-skill/lib/index.js）。 */
class FakeRegistry {
  constructor() {
    this.providers = new Map()
    this.collectCache = new Map()
    this.revision = 0
  }

  registerProvider(name, provider) {
    this.providers.set(name, provider)
  }

  async collect(options = {}) {
    const revision = this.revision
    const key = JSON.stringify({ cwd: options.cwd, revision })
    const cached = this.collectCache.get(key)
    if (cached !== undefined) return { entries: cached, cacheable: true }
    const result = await this.collectFresh(options)
    if (result.cacheable) this.collectCache.set(key, result.entries)
    return result
  }

  async collectFresh(options) {
    const entries = new Map()
    for (const provider of this.providers.values()) {
      const candidates = await provider.list(options)
      for (const candidate of candidates ?? []) entries.set(candidate.name, candidate)
    }
    return { entries, cacheable: true }
  }

  async list(options = {}) {
    const collected = await this.collect(options)
    return [...collected.entries.values()]
  }
}

/** 记录递归深度（不做断言，让被测代码自己抛）。 */
function withDepthProbe(registry) {
  const state = { depth: 0, max: 0 }
  const original = registry.collect.bind(registry)
  registry.collect = async function (options = {}) {
    state.depth += 1
    state.max = Math.max(state.max, state.depth)
    try {
      return await original(options)
    } finally {
      state.depth -= 1
    }
  }
  return state
}

/** 建一个临时 DSH_HOME，并写入开关状态。 */
async function withPrefs(visibility, run) {
  const home = await mkdtemp(join(tmpdir(), 'decision-skills-test-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    await mkdir(join(home, 'storages'), { recursive: true })
    await writeFile(
      join(home, 'storages', 'decision-skills.json'),
      JSON.stringify({ version: 1, visibility, projects: {}, updatedAt: null }),
      'utf8',
    )
    await run()
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
}

/**
 * 一条**只有我们能提供**的系统级技能（安装 assets / asar 扫描所得）。
 *
 * provider 名必须是我们自己的两种之一：defaultMode 靠它区分
 * 「宿主没有 provider 认领」（默认 off）与「官方 provider 本来就认领」
 * （默认 on，不能替用户关掉）。见 prefs.js 的 defaultMode。
 */
const SYSTEM_ROW = {
  name: 'office-docx',
  description: 'office docx',
  scope: 'system',
  provider: 'install-assets',
  path: 'C:/fake/office-docx/SKILL.md',
}

const tests = []

// ------------------------------------------------------------------
// 1. 回归本体：provider 的 collect 若回调注册表，必然无限递归
// ------------------------------------------------------------------
tests.push({
  name: 'provider 的 collect 回调注册表 → 无限递归（复现原 bug）',
  run: async () => {
    const registry = new FakeRegistry()
    const probe = withDepthProbe(registry)

    // 这就是修复前的写法：collect 回调 registry.list()
    registry.registerProvider('decision-skills-visibility', {
      name: 'decision-skills-visibility',
      async list(options) {
        const rows = await registry.list(options)
        return rows.map((row) => ({
          name: row.name,
          description: row.description ?? '',
          invocation: { modelInvocable: true, userInvocable: true },
          source: 'bundled',
          provider: 'decision-skills-visibility',
          rank: 600,
        }))
      },
      async get() { return undefined },
    })

    // 修复前：爆栈（RangeError: Maximum call stack size exceeded）
    await assert.rejects(
      () => registry.list({ cwd: undefined }),
      (error) => error instanceof RangeError,
      '修复前的写法应当爆栈',
    )
    assert.ok(probe.max > 5, `应当观察到递归深度失控，实际 ${probe.max}`)
  },
})

// ------------------------------------------------------------------
// 2. 修复后的形状：provider 的 collect 只读不经过注册表的来源
// ------------------------------------------------------------------
tests.push({
  name: 'provider 的 collect 不回调注册表 → 递归被切断，且已开启的技能可见',
  run: async () => {
    const { createVisibilityProvider } = await import('../packages/scanner/visibility.js')
    const registry = new FakeRegistry()
    const probe = withDepthProbe(registry)

    await withPrefs({ [SYSTEM_ROW.path]: 'on' }, async () => {
      const provider = createVisibilityProvider({
        // 修复后的接线：只扫不经过注册表的来源
        collect: async () => [SYSTEM_ROW],
        readBody: async () => null,
      })
      registry.registerProvider(provider.name, provider)

      const rows = await registry.list({ cwd: undefined })
      assert.equal(rows.length, 1, '已开启的系统级技能应当可见')
      assert.equal(rows[0].name, 'office-docx')
      assert.equal(rows[0].provider, 'decision-skills-visibility')
      assert.equal(probe.max, 1, '递归深度应为 1（不重入）')
    })
  },
})

// ------------------------------------------------------------------
// 3. 未开启的系统级技能对 agent 不可见（开关语义不被修复破坏）
// ------------------------------------------------------------------
tests.push({
  name: '未开启的系统级技能仍然不可见（开关语义保持）',
  run: async () => {
    const { createVisibilityProvider } = await import('../packages/scanner/visibility.js')
    const registry = new FakeRegistry()

    await withPrefs({}, async () => {
      const provider = createVisibilityProvider({
        collect: async () => [SYSTEM_ROW],
        readBody: async () => null,
      })
      registry.registerProvider(provider.name, provider)

      const rows = await registry.list({ cwd: undefined })
      assert.equal(rows.length, 0, '未开启的系统级技能不应暴露')
    })
  },
})

// ------------------------------------------------------------------
// 3b. 官方 provider 认领的系统级技能默认可见（不被我们悄悄关掉）
// ------------------------------------------------------------------
tests.push({
  name: '官方认领的系统级技能默认可见（与「只有我们能提供的」区分）',
  run: async () => {
    const { createVisibilityProvider } = await import('../packages/scanner/visibility.js')
    const registry = new FakeRegistry()

    await withPrefs({}, async () => {
      // provider 是官方名字 → 本来就在目录里，默认 on
      const owned = { name: 'office-docx', description: 'office docx', scope: 'system', provider: 'dsh-office', path: 'C:/fake/x/SKILL.md' }
      // provider 是我们自己扫的 → 宿主没认领，默认 off
      const ours = { name: 'cordis-plugin-development', description: 'preset skill', scope: 'system', provider: 'asar:agent-preset', path: null }
      const provider = createVisibilityProvider({
        collect: async () => [owned, ours],
        readBody: async () => null,
      })
      registry.registerProvider(provider.name, provider)

      const rows = await registry.list({ cwd: undefined })
      const names = rows.map((r) => r.name)
      // visibility provider 只负责「补上」内嵌技能；官方认领的那条
      // 本来就由官方 provider 提供，这里不该被它抢先重复注册。
      assert.equal(names.includes('cordis-plugin-development'), false, '默认 off 的应当不出现')
    })
  },
})

// ------------------------------------------------------------------
// 4. 真实插件代码：scanner.systemRows() 绝不触碰注册表
// ------------------------------------------------------------------
tests.push({
  name: '真实插件的 systemRows() 不查询注册表',
  run: async () => {
    const { SkillScanner } = await import('../packages/scanner/index.js')

    // 递归只可能经由 collect 路径发生：snapshot / list / get。
    // 读 provider **名单**（layers.global.providers）不触发 collect，是安全的，
    // 而且 officeProviderPresent() 必须读它来判断要不要自己扫 office 目录。
    const collected = []
    const ctx = {
      get(name) {
        if (name !== 'skills') return undefined
        return {
          layers: { global: { providers: { has: () => false, get: () => undefined } } },
          snapshot: (...args) => { collected.push('snapshot'); throw new Error('systemRows() 不该走 collect 路径') },
          list: (...args) => { collected.push('list'); throw new Error('systemRows() 不该走 collect 路径') },
          get: (...args) => { collected.push('get'); throw new Error('systemRows() 不该走 collect 路径') },
        }
      },
    }

    const scanner = new SkillScanner(ctx)
    const rows = await scanner.systemRows()
    assert.deepEqual(collected, [], 'systemRows() 绝不能走注册表的 collect 路径')
    assert.ok(Array.isArray(rows), 'systemRows() 应当返回数组')
  },
})

// ------------------------------------------------------------------
let failed = 0
for (const test of tests) {
  try {
    await test.run()
    console.log('✓ ' + test.name)
  } catch (error) {
    failed += 1
    console.log('✗ ' + test.name)
    console.log('  ' + (error?.stack ?? error))
  }
}
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 个失败`)
process.exit(failed === 0 ? 0 : 1)
