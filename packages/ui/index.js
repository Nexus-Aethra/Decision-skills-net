/**
 * 界面插件的宿主半边。
 *
 * 浏览器部分在 client.js；这一侧没有可执行逻辑。
 * 保留 apply 是为了让 Loader 有一行可挂载的条目——
 * 只有存在这一行，dsh.client 才会去加载 ./client。
 */
export const name = '@local/decision-skills-ui'
export const inject = []
export function apply() {}
