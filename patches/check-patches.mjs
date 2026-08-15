#!/usr/bin/env node
/**
 * dsh-webui-perf 补丁健康检测：检查运行环境里官方包补丁是否仍在。
 *
 * 官方升级 dsh 会覆盖 node_modules 产物，导致补丁（api-proxy allowlist、
 * 优化代码）悄悄失效——本脚本检测三类痕迹并给出修复提示。
 *
 * 用法：
 *   node check-patches.mjs [--dsh <安装根>] [--fix]
 *
 *   --dsh   dsh 安装根（默认自动探测：D:/dsh-harness、node_modules 常见位置）
 *   --fix   缺失项自动重打（api-proxy allowlist），等价于 apply-runtime-patches.mjs
 *
 * 检测项：
 *   1. api-proxy allowlist 是否含 "webui-perf"（设置开关能暴露的前提）
 *   2. ui-conversation / ui-trajectory client bundle 是否含优化开关代码
 *   3. web dist 是否含 ui-primitives 优化代码
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const fix = process.argv.includes('--fix')
const argIndex = process.argv.indexOf('--dsh')
const givenRoot = argIndex !== -1 ? process.argv[argIndex + 1] : undefined

// ---- 探测 dsh 安装根 ----
const candidates = [
  givenRoot,
  'D:/dsh-harness',
  resolve('node_modules/@deepseek-ai/dsh'),
  resolve(process.env.USERPROFILE ?? '.', 'dsh-harness'),
].filter(Boolean)
const root = candidates.find((dir) => existsSync(join(dir, 'node_modules/@deepseek-ai/dsh')))
if (root === undefined) {
  console.error('✗ 未找到 dsh 安装根（node_modules/@deepseek-ai/dsh）。请用 --dsh 指定。')
  process.exit(1)
}
const BASE = join(root, 'node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai')

const results = []

// ---- 1. api-proxy allowlist ----
const proxyFiles = [
  join(BASE, 'dsh-host-apiproxy/lib/index.js'),
  join(BASE, 'dsh-host-apiproxy/lib/types/api-proxy.js'),
]
const proxyHits = proxyFiles.filter((f) => existsSync(f) && readFileSync(f, 'utf8').includes('"webui-perf"'))
results.push({
  name: 'api-proxy allowlist (webui-perf 设置暴露)',
  ok: proxyHits.length >= 1,
  detail: proxyHits.length === 0
    ? 'WEB_SETTINGS_NAMESPACES 不含 webui-perf —— 设置开关会被 settings-not-exposed 拒绝'
    : `已包含（${proxyHits.map((f) => f.split('/').slice(-2).join('/')).join(', ')}）`,
})

// ---- 2. client bundles（conversation / trajectory 优化开关代码）----
for (const pkg of ['dsh-client-ui-conversation', 'dsh-client-ui-trajectory']) {
  const file = join(BASE, pkg, 'lib/client.js')
  if (!existsSync(file)) {
    results.push({ name: `${pkg} client bundle`, ok: false, detail: '文件不存在（bundle 未部署）' })
    continue
  }
  const text = readFileSync(file, 'utf8')
  const ok = text.includes('dsh.webui-perf')
  results.push({
    name: `${pkg} client bundle（优化开关代码）`,
    ok,
    detail: ok ? '含优化开关代码' : '不含 dsh.webui-perf —— 需重新构建并部署该 bundle',
  })
}

// ---- 3. web dist（ui-primitives 优化代码）----
const distRoot = join(BASE, 'dsh-web-frontend/dist')
const indexHtml = join(distRoot, 'index.html')
const referenced = existsSync(indexHtml)
  ? /assets\/index-[A-Za-z0-9_-]+\.js/.exec(readFileSync(indexHtml, 'utf8'))?.[0]
  : undefined
const indexChunk = referenced ?? (existsSync(join(distRoot, 'assets'))
  ? readDir(join(distRoot, 'assets'))
      .filter((f) => /^index-[A-Za-z0-9_-]+\.js$/.test(f))
      .sort((a, b) => statMtime(b) - statMtime(a))[0]
  : undefined)
if (indexChunk === undefined) {
  results.push({ name: 'web dist（ui-primitives 优化代码）', ok: false, detail: 'dist/assets 无 index chunk' })
} else {
  const chunkFile = referenced !== undefined
    ? join(distRoot, referenced)
    : join(distRoot, 'assets', indexChunk)
  const text = existsSync(chunkFile) ? readFileSync(chunkFile, 'utf8') : ''
  const ok = text.includes('dsh.webui-perf')
  results.push({
    name: 'web dist（ui-primitives 优化代码）',
    ok,
    detail: ok
      ? `含优化开关代码（${referenced ?? indexChunk}）`
      : `不含 dsh.webui-perf（${referenced ?? indexChunk}）—— 需重新构建并部署 dist`,
  })
}

// ---- 汇总 ----
console.log(`dsh 安装根：${root}\n`)
let failed = 0
for (const r of results) {
  console.log(`${r.ok ? '✔' : '✗'} ${r.name}`)
  console.log(`    ${r.detail}`)
  if (!r.ok) failed += 1
}
console.log(`\n${failed === 0 ? '✔ 全部补丁在位，无需处理。' : `✗ ${failed} 项缺失`}`)

if (failed > 0) {
  console.log('\n修复：')
  console.log('  1) 重打运行时补丁（api-proxy allowlist）：')
  console.log(`     node ${join(HERE, 'apply-runtime-patches.mjs')}` + (fix ? '（--fix 已自动执行）' : ''))
  console.log('  2) dist / client bundle 缺失时：应用源码补丁后重新构建部署：')
  console.log('     node patches/apply-patches.mjs <deepseek-harness 源码路径>')
  console.log('     npm run build:lib:client && pnpm --filter @deepseek-ai/dsh-web-frontend run build')
  console.log('  3) 重启 dsh。')
}

function readDir(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function statMtime(name) {
  try {
    return statSync(name).mtimeMs
  } catch {
    return 0
  }
}

// --fix：自动重打 api-proxy allowlist
if (fix && failed > 0 && !proxyHits.length) {
  console.log('\n--fix：正在重打 api-proxy allowlist…')
  const { spawnSync } = await import('node:child_process')
  const fixRun = spawnSync(process.execPath, [join(HERE, 'apply-runtime-patches.mjs')], { encoding: 'utf8' })
  console.log(fixRun.stdout || fixRun.stderr)
}
