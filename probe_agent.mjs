
const { Context } = await import('file:///D:/dshbox/instances/container-1793336413-0493572e-789b-4847-a599-47d42b9dc944/harness/vendor/cordis/lib/index.js')
const ctx = new Context()
// 找 agent 相关的服务与事件
const g = await import('node:fs/promises')
// 直接看 dsh-agent-loop 如何拿 agent
const src = await g.readFile('D:/dshbox/instances/container-1793336413-0493572e-789b-4847-a599-47d42b9dc944/harness/packages/core/agent/src/types.ts', 'utf8')
const i = src.indexOf('inject')
console.log(src.slice(Math.max(0,i-500), i+800))
