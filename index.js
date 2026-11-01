/**
 * decision-skills 宿主入口。
 *
 * 只做一件事：把 `skillManager` Remote 服务挂进 cordis，供设置页读取
 * 跨工作区的技能清单并切换启用状态。
 *
 * 失败必须显式记录：宿主侧的 boot 审计只报「entry did not activate」，
 * 不带原因，所以 apply 内的任何异常都要先 logger.error 再抛出。
 */
import { installSkillManager } from './lib/service.js'

export const name = 'decision-skills'
export const inject = []

export function apply(ctx) {
  try {
    installSkillManager(ctx)
  } catch (error) {
    try { ctx.logger.error('[decision-skills] apply failed:', error) } catch { /* 没有 logger */ }
    throw error
  }
}
