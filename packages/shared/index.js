/**
 * 公共契约：所有 decision-skills 子插件共享的定义。
 *
 * 拆包原则：谁能被单独替换，谁就单独成包。
 * 这里只放**不依赖任何运行时状态**的常量与纯函数，
 * 任何包都可以安全 import 它，不会引入循环依赖。
 */

/** 插件命名空间前缀。 */
export const SCOPE = 'decision-skills'

/** 各子插件注册的服务名。 */
export const SERVICES = {
  /** 技能目录采集器（scanner）。 */
  scanner: 'skillScanner',
  /** 技能状态与写入（store）。 */
  store: 'skillStore',
  /** 对外 Remote 面（api）。 */
  api: 'skillManager',
}

/** 子插件之间的内部事件名。 */
export const EVENTS = {
  /** 目录已刷新，载荷为 SkillRow[]。 */
  catalog: 'decision-skills/catalog',
  /** 单个技能状态变化，载荷为 { name, enabled }。 */
  toggled: 'decision-skills/toggled',
  /** 技能被移除，载荷为 { name, movedTo }。 */
  removed: 'decision-skills/removed',
}

/**
 * source -> 界面分组（三个仓库）。
 *
 * 与产品定义严格对齐：
 *   system  = 内嵌技能（asar 内 + 安装自带 assets）—— 只能控可见度，不可删
 *   common  = ~/.dsh/skills 及用户级根目录 —— 通用级
 *   project = 各工作区的 .agents/skills —— 项目级
 */
export const SOURCE_SCOPE = {
  bundled: 'system',
  'user-dsh': 'common',
  'user-agents': 'common',
  custom: 'common',
  runtime: 'common',
  'project-dsh': 'project',
  'project-agents': 'project',
}

/** 仓库标识与顺序（界面按此排序）。 */
export const REPOS = ['system', 'common', 'project']

/**
 * 把 source 归一成仓库键。
 * @param {string} source
 * @returns {'system'|'common'|'project'}
 */
export function scopeOfSource(source) {
  return SOURCE_SCOPE[source] ?? 'common'
}

/**
 * 技能行的稳定身份：有路径用路径，否则用名字。
 * UI 的 React key、busy/preview 状态都以此为准。
 * @param {{ path?: string|null, name: string }} skill
 */
export function rowKey(skill) {
  return skill.path || skill.name
}

/**
 * 构造一条统一的技能行。
 * @param {object} input
 * @returns {object}
 */
export function makeRow(input) {
  const source = input.source ?? 'runtime'
  const modelDisabled = input.modelDisabled === true
  const userDisabled = input.userDisabled === true
  return {
    name: input.name,
    description: input.description ?? '',
    whenToUse: input.whenToUse ?? '',
    source,
    provider: input.provider ?? 'unknown',
    scope: scopeOfSource(source),
    path: input.path ?? null,
    archivePath: input.archivePath ?? null,
    enabled: !modelDisabled && !userDisabled,
    modelDisabled,
    userDisabled,
    editable: input.editable === true,
    projectPath: input.projectPath ?? null,
    projectTitle: input.projectTitle ?? null,
  }
}

/** 按名字排序（稳定、可预测）。 */
export function sortRows(rows) {
  return [...rows].sort((a, b) => a.name.localeCompare(b.name))
}
