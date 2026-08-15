// dsh-webui-perf Node half：向 Host 用户设置文档注册 webui-perf 命名空间
// （enabled: boolean，默认 true），并提供 /webui-perf/memory 系统内存统计端点。
// 浏览器 half 通过 settingsScope 读写开关，并把变化广播给官方包的
// cordis-free 优化开关通道；内存指示器从这里读取系统可用/总内存
// （PCL 内存优化的显示口径），清理动作在浏览器 half 完成。
//
// 有意只依赖 profile 可直接解析的 schemastery（顶层依赖）：settingsNamespace
// 运行时只是小写 kebab-case 校验（直接传字符串），避免拖入官方 @deepseek-ai
// 包依赖（profile 的 node_modules 不包含它们）。
import { freemem, totalmem } from 'node:os'
import z from 'schemastery'

export const name = 'dsh-webui-perf'
// 硬依赖 settings 与 webServer：cordis 会等两者就绪后再调用 apply。
export const inject = ['settings', 'webServer']

const NS = 'webui-perf'

/** Durable performance-switch section shared by the Host schema and the browser scope. */
export const schema = z.object({
  enabled: z.boolean().default(true),
})

export function apply(ctx) {
  ctx.settings.register(NS, schema)

  // 系统内存统计（浏览器端拿不到物理内存；host 是 Node，os 模块直接可读）。
  // 仅暴露总内存/空闲内存/自身 RSS 三个低敏数字，no-cache 每请求实时。
  ctx.effect(() => {
    const disposers = []
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/webui-perf/memory',
      handler: async (_req, res) => {
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-cache',
        })
        res.end(JSON.stringify({
          total: totalmem(),
          free: freemem(),
          rss: process.memoryUsage().rss,
          time: Date.now(),
        }))
      },
    }))
    return () => {
      for (const disposer of disposers) disposer()
    }
  }, 'dsh-webui-perf: memory stats route')
}
