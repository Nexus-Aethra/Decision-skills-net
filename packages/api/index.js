/**
 * 对外 Remote 面（skillManager）。
 *
 * 职责单一：**只做协议适配**。采集交给 scanner，写入交给 store，
 * 这一层不碰文件系统、不碰 UI。
 *
 * 网关发现靠两件事，缺一不可：
 *   1. 原型上写 REMOTE_METHOD_DESCRIPTOR（常量值必须是官方的）
 *   2. 实例挂 typertRemote = { service, serviceKey, namespace }
 *
 * 注意：不要继承 TypertRemoteService —— 那是 @deepseek-ai/* 的包，
 * 插件的 node_modules 解析不到，静态 import 会让整个模块导入失败。
 *
 * 未来的"决策层"插件可以在这里再加方法，或独立挂在别的命名空间上。
 */
import { EVENTS, SERVICES, SCOPE } from '../shared/index.js'

/** 网关据此枚举端点，**必须是这个确切字符串**。 */
export const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods'
/** 客户端通过 ctx.get('remote.skillManager') 访问。 */
export const NAMESPACE = SERVICES.api

/**
 * 方法 -> wire 参数名。
 * 必须与宿主方法实参逐个对应：网关会校验 args 字段集合，
 * 多一个少一个都报 gateway/arguments-invalid。
 */
export const METHOD_PARAMS = {
  list: [],
  listForSession: ['request'],
  read: ['request'],
  setEnabled: ['request'],
  removeSkill: ['request'],
  setVisibility: ['request'],
  promoteSkill: ['request'],
}

/** 服务实现。 */
export class SkillManagerRemote {
  /**
   * @param {any} ctx
   * @param {any} scanner
   * @param {any} store
   */
  constructor(ctx, scanner, store) {
    this.ctx = ctx
    this.scanner = scanner
    this.store = store
    this.name = NAMESPACE
  }

  /**
   * 首屏。
   *
   * 注意：web 面的宿主级 skill-filesystem 是被 dsh-web-app 禁用的
   * （本地发现归各 agent preset 的层管），所以不带 scope 的快照
   * 永远拿不到磁盘技能——这不是缺陷，是机制设计。
   * 这里借一个已存在会话的 scope 来读：它链上的 preset 层装着
   * 自己的 skill-filesystem，项目级与用户级技能才能被看到。
   */
  async list() {
    let agent
    try {
      const sessions = await this.scanner.listSessions()
      const first = sessions.find((s) => s.id)
      if (first) agent = this.scanner.resolveAgent(first.id)
    } catch { /* 无会话就退回全局视角 */ }
    const catalog = await this.scanner.catalog(agent)
    return {
      skills: catalog.skills,
      complete: catalog.complete,
      errors: catalog.errors ?? [],
      projects: this.scanner.listProjects(),
      sessions: await this.scanner.listSessions(),
      generatedAt: Date.now(),
    }
  }

  /** 按会话读目录（会话级隔离）。 */
  async listForSession(request) {
    const sessionId = request?.sessionId
    const agent = this.scanner.resolveAgent(sessionId)
    const catalog = await this.scanner.catalog(agent)
    return {
      sessionId: sessionId ?? null,
      scoped: agent !== undefined,
      skills: catalog.skills,
      complete: catalog.complete,
      projects: this.scanner.listProjects(),
      sessions: await this.scanner.listSessions(),
      generatedAt: Date.now(),
    }
  }

  /** 读正文。 */
  async read(request) {
    return this.scanner.bodyOf({
      name: request?.name,
      path: request?.path ?? request?.file,
      archivePath: request?.archivePath,
    })
  }

  /** 开 / 关。 */
  async setEnabled(request) {
    return this.store.setEnabled({ file: request?.file, enabled: request?.enabled })
  }

  /** 删除。
   *  方法名不能叫 remove：RemoteNamespaceService.prototype 自带 remove()，
   *  网关会判 "conflicts with its namespace service" 并拒绝整次挂载。 */
  async removeSkill(request) {
    return this.store.remove({ path: request?.path, name: request?.name })
  }

  /**
   * 设置「对 agent 可见」。
   * 这是系统级技能唯一的可操作项——实体在内嵌资源里，改不了文件。
   */
  async setVisibility(request) {
    return this.store.setVisibility({
      key: request?.key,
      name: request?.name,
      path: request?.path,
      archivePath: request?.archivePath,
      mode: request?.mode,
    })
  }

  /** 提升：把项目技能复制到 ~/.dsh/skills/，成为通用级。 */
  async promoteSkill(request) {
    return this.store.promote({ path: request?.path })
  }
}

const METHODS = Object.keys(METHOD_PARAMS)

/** 给原型打上网关可识别的描述符。 */
function markRemoteMethods(ctor) {
  Object.defineProperty(ctor.prototype, REMOTE_METHOD_DESCRIPTOR, {
    value: Object.freeze({
      version: 1,
      methods: Object.freeze(METHODS.map((method) => Object.freeze({ method, invocation: Object.freeze({ kind: 'direct' }) }))),
    }),
    enumerable: false,
    configurable: true,
    writable: true,
  })
}
markRemoteMethods(SkillManagerRemote)

/**
 * 挂载 Remote 面。
 * @param {any} ctx
 */
export function apply(ctx) {
  const scanner = ctx.get(SERVICES.scanner)
  const store = ctx.get(SERVICES.store)
  if (scanner === undefined || store === undefined) {
    throw new Error('[' + SCOPE + '] api 需要 scanner 与 store 先挂载')
  }
  const instance = new SkillManagerRemote(ctx, scanner, store)
  // typertRemote 绑定：派发时 readBinding 会校验 service 指回实例本身。
  instance.typertRemote = Object.freeze({
    service: instance,
    serviceKey: NAMESPACE,
    namespace: NAMESPACE,
  })
  const dispose = ctx.provide(NAMESPACE, instance)
  ctx.effect(() => dispose, SCOPE + ': api remote')
}

export const name = '@local/decision-skills-api'
export const inject = [SERVICES.scanner, SERVICES.store]
export { METHODS }
