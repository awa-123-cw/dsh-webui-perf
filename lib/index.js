// dsh-webui-perf Node half：向 Host 用户设置文档注册 webui-perf 命名空间
// （enabled: boolean，默认 true）。浏览器 half 通过 settingsScope 读写它，
// 并把变化广播给官方包的 cordis-free 优化开关通道。
//
// 有意只依赖 profile 可直接解析的 schemastery（顶层依赖）：settingsNamespace
// 运行时只是小写 kebab-case 校验（直接传字符串），避免拖入官方 @deepseek-ai
// 包依赖（profile 的 node_modules 不包含它们）。
import z from 'schemastery'

export const name = 'dsh-webui-perf'
// 硬依赖 settings：cordis 会等 settings 服务就绪后再调用 apply。
export const inject = ['settings']

const NS = 'webui-perf'

/** Durable performance-switch section shared by the Host schema and the browser scope. */
export const schema = z.object({
  enabled: z.boolean().default(true),
})

export function apply(ctx) {
  ctx.settings.register(NS, schema)
}
