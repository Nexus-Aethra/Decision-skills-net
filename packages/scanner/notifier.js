/**
 * 技能列表变更通知。
 *
 * 目标：会话进行中开关技能时，让**大模型知道列表变了**，
 * 就像插件新增工具时会注入一条通知一样。
 *
 * 实现沿用官方 dsh-tool-skill 的路径：`agent/pre-step` 里在消息末尾
 * 追加一条 user 消息。官方就是这样注入 <available_skills> 目录的，
 * 所以这里的行为与宿主一致，不引入新机制。
 *
 * 关键约束（来自官方 practices）：
 *   - 必须先 `await next()` 再改写
 *   - 改写时要 spread 决策对象，否则会丢 startsRequestSeries 等字段
 *   - 需要带 signal 检查，避免在中断后写
 */
import { makeRow, SCOPE } from '../shared/index.js'

/** 每条会话已发布的变更摘要，避免重复通知。 */
const published = new WeakMap()

/**
 * 把变更渲染成一条简短的提醒。
 * @param {{ added: string[], removed: string[] }} change
 * @returns {string}
 */
export function renderChangeNotice(change) {
  const lines = ['<system-reminder>']
  lines.push('The available skill catalog changed during this session.')
  if (change.added.length > 0) {
    lines.push('')
    lines.push('Added (now visible to you):')
    for (const name of change.added) lines.push('- ' + name)
  }
  if (change.removed.length > 0) {
    lines.push('')
    lines.push('Removed (no longer available; do not use these names):')
    for (const name of change.removed) lines.push('- ' + name)
  }
  lines.push('')
  lines.push('Call the `skill` tool with a name from the current catalog when a task matches it.')
  lines.push('</system-reminder>')
  return lines.join('\n')
}

/**
 * 构造一个 user 消息形状。
 *
 * 不依赖宿主的 createUserMessage（那是 @deepseek-ai/* 包，插件解析不到），
 * 手工构造与宿主期望一致的字段。宿主只读 content 与 source。
 * @param {string} text
 */
function userMessage(text) {
  return {
    id: 'decision-skills-change-' + Math.random().toString(36).slice(2, 10),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'skill-catalog', form: 'update' },
    createdAt: Date.now(),
  }
}

/**
 * 安装通知监听。
 *
 * @param {any} ctx
 * @param {{ collectVisible: (agent: any) => Promise<string[]> }} deps
 * @returns {() => void}
 */
export function installChangeNotifier(ctx, deps) {
  const dispose = ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision?.kind === 'reject') return decision
    try { signal?.throwIfAborted?.() } catch { return decision }
    if (decision?.kind !== undefined && decision.kind !== 'enter') return decision

    let names
    try {
      // 按**本会话的作用域**采集：省略 scope 时注册表只回全局层，
      // 项目级与用户级技能不会出现在通知里，模型就漏知道了变更。
      names = await deps.collectVisible(agent)
    } catch {
      return decision
    }
    const current = new Set(names)
    const before = published.get(agent)
    if (before === undefined) {
      // 首个步骤只记基线，不打扰模型。
      published.set(agent, current)
      return decision
    }

    const added = [...current].filter((n) => !before.has(n))
    const removed = [...before].filter((n) => !current.has(n))
    if (added.length === 0 && removed.length === 0) return decision

    published.set(agent, current)
    const notice = userMessage(renderChangeNotice({ added, removed }))
    return {
      ...decision,
      messages: [...decision.messages, notice],
    }
  }, 'decision-skills: skill change notice')

  ctx.effect(() => dispose, SCOPE + ': change notifier')
  return dispose
}

export { published }
