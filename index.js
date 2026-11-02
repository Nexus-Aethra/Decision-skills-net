/**
 * decision-skills 整合包入口。
 *
 * 这个包**不注册任何东西**——它把四个子插件打成一个可安装的 bundle：
 *
 *   packages/scanner  技能采集（注册表 + 项目根 + 安装目录 + asar）
 *   packages/store    状态写入（开关改 frontmatter、删除移入回收目录）
 *   packages/api      对外 Remote 面
 *   packages/ui       设置页界面（dsh.client 指向它的 browser 半边）
 *
 * 为什么拆：每一层都能被单独替换。
 *   - 接决策模型？新增插件消费 skillScanner.catalog()，api 与 ui 都不用动。
 *   - 加过滤器？包一层 skillStore 即可。
 *   - 换界面？只改 packages/ui。
 *
 * 实际注册行为在子插件里，见 cordis.patch.yml 的 insert 行。
 */

export const name = '@local/decision-skills'
export const inject = []
export function apply() {}
