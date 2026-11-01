/**
 * decision-skills 宿主入口。
 *
 * 只做一件事：把 `skillManager` Remote 服务挂进 cordis，供设置页读取
 * 跨工作区的技能清单并切换启用状态。
 */
import { installSkillManager } from './lib/service.js'

export const name = 'decision-skills'
export const inject = []

export function apply(ctx) {
  installSkillManager(ctx)
}
