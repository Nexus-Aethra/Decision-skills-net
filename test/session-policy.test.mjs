/**
 * 会话级策略回归测试。
 *
 * 覆盖三件事，任何一件坏了这个功能就不成立：
 *   1. prefs 的两层解析（会话覆盖 > 全局默认 > 按来源兜底）
 *   2. 执行端真的按会话屏蔽，且两个会话互不影响
 *   3. 不触发注册表递归（provider.list 里不碰 ctx.skills）
 *
 * 第 2 条必须跑**真实的** SkillRegistry 与作用域分层：
 * 用假注册表复现合并规则，等于测我自己写的假设，测不出真问题。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'

import { resolveMode, entryMode, globalEntries, normalizeMode, defaultMode } from '../packages/scanner/prefs.js'
import { createSessionProvider, blockedNamesFor } from '../packages/scanner/session.js'

/**
 * 宿主包目录候选。
 *
 * 宿主目录因安装位置而异，探测几个常见位置，找不到就跳过
 * （跳过会在输出里显式说明原因，不静默通过）。
 */
const HOST_CANDIDATES = [
  'E:/dsh/resources/app.asar/dsh/node_modules/@deepseek-ai/',
  'C:/Program Files/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/',
]
const hostBase = HOST_CANDIDATES.find((base) => existsSync(base + 'cordis/lib/index.js'))
const hostModule = (rel) => pathToFileURL(hostBase + rel).href

/** 在临时 DSH_HOME 里写一份 prefs，并把 DSH_HOME 指过去。 */
function withPrefs(state, run) {
  const home = mkdtempSync(join(tmpdir(), 'ds-prefs-'))
  mkdirSync(join(home, 'storages'), { recursive: true })
  writeFileSync(join(home, 'storages', 'decision-skills.json'), JSON.stringify(state, null, 2), 'utf8')
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  return Promise.resolve()
    .then(() => run(home))
    .finally(() => {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
      rmSync(home, { recursive: true, force: true })
    })
}

test('normalizeMode 收敛历史布尔与三态字符串', () => {
  assert.equal(normalizeMode(true), 'on')
  assert.equal(normalizeMode(false), 'off')
  assert.equal(normalizeMode('smart'), 'smart')
  assert.equal(normalizeMode('nonsense'), undefined)
  assert.equal(entryMode({ mode: 'on' }), 'on')
  assert.equal(entryMode('off'), 'off')
})

test('defaultMode 区分「只有我们能提供的」与「官方认领的」系统级技能', () => {
  // asar / 安装扫描出来的：宿主没有 provider 认领，默认不塞给模型
  assert.equal(defaultMode({ scope: 'system', provider: 'asar:agent-preset' }), 'off')
  assert.equal(defaultMode({ scope: 'system', provider: 'install-assets' }), 'off')
  // 官方 provider 自己认领的（office / badge / windows-acl）：本来就在目录里
  assert.equal(defaultMode({ scope: 'system', provider: 'dsh-office' }), 'on')
  assert.equal(defaultMode({ scope: 'common', provider: 'x' }), 'on')
  assert.equal(defaultMode({ scope: 'project', provider: 'x' }), 'on')
})

test('resolveMode：会话覆盖压过全局，全局压过兜底', () => {
  const prefs = {
    visibility: { '/a/SKILL.md': { mode: 'off', name: 'alpha' } },
    sessions: { s1: { alpha: { mode: 'on' } }, s2: { alpha: { mode: 'smart' } } },
  }
  const row = { name: 'alpha', scope: 'common', path: '/a/SKILL.md', provider: 'fs' }
  assert.equal(resolveMode(prefs, 's1', row), 'on', '会话覆盖')
  assert.equal(resolveMode(prefs, 's2', row), 'smart', '会话覆盖到智能')
  assert.equal(resolveMode(prefs, 's3', row), 'off', '无覆盖 -> 全局默认')
  assert.equal(resolveMode(prefs, null, row), 'off', '不给会话 -> 全局默认')
  const other = { name: 'beta', scope: 'common', path: '/b/SKILL.md', provider: 'fs' }
  assert.equal(resolveMode(prefs, 's1', other), 'on', '未配置的通用级兜底 on')
})

test('globalEntries 从裸映射里恢复技能名', () => {
  const prefs = { visibility: { 'some-skill-name': 'off', '/x/y/SKILL.md': { mode: 'smart', name: 'delta' } } }
  const entries = globalEntries(prefs)
  const byName = Object.fromEntries(entries.map((e) => [e.name, e.mode]))
  assert.equal(byName['some-skill-name'], 'off')
  assert.equal(byName.delta, 'smart')
  assert.equal(entries.find((e) => e.name === 'delta').key, '/x/y/SKILL.md')
})

test('blockedNamesFor：全局关 + 会话覆盖，两个方向都算对', () => {
  const prefs = {
    visibility: {
      'alpha': { mode: 'off', name: 'alpha' },
      '/b/SKILL.md': { mode: 'on', name: 'beta' },
    },
    sessions: { s1: { alpha: { mode: 'on' }, beta: { mode: 'off' } } },
  }
  const s1 = blockedNamesFor(prefs, 's1')
  assert.equal(s1.has('alpha'), false, '会话显式放行压过全局关闭')
  assert.equal(s1.has('beta'), true, '会话显式关闭压过全局开启')

  const s2 = blockedNamesFor(prefs, 's2')
  assert.equal(s2.has('alpha'), true, '无覆盖时跟随全局关闭')
  assert.equal(s2.has('beta'), false, '无覆盖时跟随全局开启')
})

test('blockedNamesFor：兜底不会推翻显式决定的档位', () => {
  // 会话里明确开启了 alpha，但已知行按默认档位算可能是别的——
  // 兜底必须让位给显式配置，否则界面点了没反应。
  const prefs = { visibility: { alpha: { mode: 'off', name: 'alpha' } }, sessions: { s1: { alpha: { mode: 'on' } } } }
  const blocked = blockedNamesFor(prefs, 's1', [{ name: 'alpha', scope: 'system', provider: 'install-assets' }])
  assert.equal(blocked.has('alpha'), false, '显式开启不被兜底推翻')
})

test('blockedNamesFor：已知行能补出「全局键只有路径」的历史数据', () => {
  const prefs = { visibility: { '/x/y/SKILL.md': { mode: 'off' } }, sessions: {} }
  const rows = [{ name: 'gamma', scope: 'common', path: '/x/y/SKILL.md', provider: 'fs' }]
  assert.equal(blockedNamesFor(prefs, 's9', rows).has('gamma'), true, '靠已知行反查到名字')
})

test('执行端真的按会话屏蔽：同注册表，A 拦截 B 放行', async (t) => {
  if (hostBase === undefined) {
    t.skip('宿主 dsh 安装目录未找到，无法验证真实注册表分层')
    return
  }
  await withPrefs({
    version: 2,
    visibility: { office: { mode: 'off', name: 'office' } },
    sessions: { 'sess-A': { alpha: { mode: 'off' }, office: { mode: 'on' } } },
    projects: {},
  }, async () => {
    const cordis = await import(hostModule('cordis/lib/index.js'))
    const skillMod = await import(hostModule('dsh-skill/lib/index.js'))
    const scopeMod = await import(hostModule('dsh-scope/lib/index.js'))
    const { Context } = cordis
    const { SkillRegistry, isModelInvocable } = skillMod
    const { createScope } = scopeMod

    const root = new Context()
    new SkillRegistry(root)

    // 模拟 preset 层：官方 filesystem provider 提供三条磁盘技能
    const presetKey = {}
    createScope(root, presetKey).ctx.skills.registerProvider(() => ({
      name: 'fake-fs',
      async list() {
        return ['alpha', 'beta', 'office'].map((name) => ({
          name, description: name,
          invocation: { modelInvocable: true, userInvocable: true },
          source: 'user-dsh', provider: 'fake-fs', rank: 400, locator: name,
        }))
      },
      async get(candidate) {
        return {
          name: candidate.name, description: candidate.name,
          invocation: { modelInvocable: true, userInvocable: true },
          source: 'user-dsh', provider: 'fake-fs', content: 'BODY',
        }
      },
    }))

    // 两个会话各挂一个策略 provider；构造方式与 dsh-agent-loop 一致
    const mountSession = (id) => {
      const agent = { id }
      agent.ctx = createScope(root, agent, { parent: presetKey }).ctx
      agent.ctx.skills.registerProvider(() => createSessionProvider({ sessionId: id }))
      return agent
    }
    const agentA = mountSession('sess-A')
    const agentB = mountSession('sess-B')

    const skills = root.get('skills')
    const visible = async (agent) => (await skills.snapshot({ scope: agent }))
      .skills.filter(isModelInvocable).map((s) => s.name).sort()

    assert.deepEqual(await visible(agentA), ['beta', 'office'],
      'A：alpha 被会话覆盖关掉，office 被会话覆盖打开')
    assert.deepEqual(await visible(agentB), ['alpha', 'beta'],
      'B：没有任何覆盖，跟随全局默认（office 关）')

    assert.equal(await skills.get('alpha', { scope: agentA }), undefined,
      'A 里被拦截的技能加载不到正文')
    assert.ok(await skills.get('office', { scope: agentA }), 'A 里被放行的技能加载得到')
    assert.equal(await skills.get('office', { scope: agentB }), undefined,
      'B 跟随全局默认，office 同样被拦截')
    assert.ok(await skills.get('beta', { scope: agentB }), 'B 未配置的技能照常放行')
  })
})
/**
 * 下面三条守的是同一个坑：**屏蔽会让那一行从目录里消失**。
 *
 * 遮蔽候选（invocation 两个 false）在更近的层把真实条目顶掉，
 * 目录快照里就只剩它自己。若目录侧把它当作「不是真技能」跳过，
 * 用户点一次「关闭」，这个技能就从会话面板和仓库页一起不见了，
 * 再也没有地方点回来。所以它必须冒充得像：带描述、带路径、带来源。
 */
test('遮蔽占位带上真实那一行的元数据', async () => {
  const path = '/w/.agents/skills/debugging/SKILL.md'
  await withPrefs(
    { version: 2, visibility: {}, sessions: { s1: { debugging: { mode: 'off', source: 'project-agents', path } } } },
    async () => {
      const provider = createSessionProvider({
        sessionId: 's1',
        knownRows: () => [{
          name: 'debugging', scope: 'project', source: 'project-agents',
          path, description: 'REAL DESCRIPTION', projectPath: '/w',
        }],
      })
      const stub = (await provider.list()).find((c) => c.name === 'debugging')
      assert.ok(stub, '屏蔽项必须出现在候选里')
      assert.equal(stub.invocation.modelInvocable, false, '仍然对模型不可见')
      assert.equal(stub.path, path, '路径要跟着走，否则目录侧认不出这一行')
      assert.equal(stub.source, 'project-agents', '来源要在，否则会被错归到「通用级」')
      assert.equal(stub.description, 'REAL DESCRIPTION', '描述沿用真实行')
      assert.equal(stub.locator.projectPath, '/w', '工作区归属要带出去，仓库页按它分组')
    },
  )
})

test('locatorOf：没有内存记忆时也能从档位记录认回位置', async () => {
  const { locatorOf } = await import('../packages/scanner/prefs.js')
  const prefs = {
    visibility: { '/g/SKILL.md': { mode: 'off', name: 'gamma', path: '/g/SKILL.md', source: 'user-dsh' } },
    sessions: { s1: { delta: { mode: 'off', path: '/d/SKILL.md', source: 'project-agents' } } },
  }
  assert.deepEqual(locatorOf(prefs, 's1', 'delta'),
    { path: '/d/SKILL.md', archivePath: null, source: 'project-agents', description: null })
  assert.deepEqual(locatorOf(prefs, 's1', 'gamma'),
    { path: '/g/SKILL.md', archivePath: null, source: 'user-dsh', description: null })
  assert.equal(locatorOf(prefs, 's1', 'nobody'), null)
})

test('目录记忆：被屏蔽的行不丢，真被删掉的行会自己消失', async () => {
  const { SkillScanner } = await import('../packages/scanner/index.js')
  const scanner = new SkillScanner({ get: () => undefined })
  const row = {
    name: 'alpha', scope: 'project', source: 'project-agents', provider: 'fs',
    path: '/w/a/SKILL.md', description: 'A', archivePath: null, projectPath: '/w', projectTitle: null,
  }
  const blocked = { visibility: {}, sessions: { s1: { alpha: { mode: 'off' } } } }
  scanner.rememberRows([row], blocked, 's1')
  scanner.rememberRows([], blocked, 's1')
  assert.ok(scanner.knownRowsByName.has('alpha'), '被策略挡住的行要留在记忆里')
  assert.equal(scanner.knownRowsByName.get('alpha').description, 'A', '描述留住才画得出那一行')
  assert.equal(scanner.lastKnownRows.length, 1, '会话执行端靠这份快照兜底')

  const empty = { visibility: {}, sessions: {} }
  for (let i = 0; i < 3; i += 1) scanner.rememberRows([], empty, 's1')
  assert.equal(scanner.knownRowsByName.has('alpha'), false, '真的没了就别一直挂在界面上')
})
