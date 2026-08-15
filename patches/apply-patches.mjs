#!/usr/bin/env node
/**
 * dsh-webui-perf 补丁应用脚本（对 deepseek-harness 源码 checkout）。
 *
 * 用法：
 *   node apply-patches.mjs [--reverse] [<deepseek-harness 源码路径>]
 *
 * 默认把 patches/dsh-webui-perf.patch 应用到源码仓库（git apply）。
 * --reverse 回滚（git apply -R）。
 * 未给路径时自动探测：当前目录、../dsh-src、~/dsh-src。
 *
 * 应用后需要重新构建：
 *   npm run build:lib:client      # ui-conversation / ui-trajectory client bundles
 *   pnpm --filter @deepseek-ai/dsh-web-frontend run build   # dist（含 ui-primitives）
 * 并把产物部署到运行环境（dist -> dsh-web-frontend/dist，lib/client.js -> 各包 lib/）。
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const PATCH = join(HERE, 'dsh-webui-perf.patch')

const reverse = process.argv.includes('--reverse')
const given = process.argv.slice(2).filter(a => !a.startsWith('--'))[0]

const candidates = [
  given,
  process.cwd(),
  resolve(HERE, '..'),
  resolve(HERE, '../dsh-src'),
  resolve(process.env.USERPROFILE ?? process.env.HOME ?? '.', 'dsh-src'),
].filter(Boolean)

const repo = candidates.find(dir => dir !== undefined && existsSync(join(dir, '.git')))
if (repo === undefined) {
  console.error('✗ 未找到 deepseek-harness 源码仓库（.git）。请传入源码路径，例如：')
  console.error('  node apply-patches.mjs D:\\dsh-src')
  process.exit(1)
}
if (!existsSync(PATCH)) {
  console.error(`✗ 找不到补丁文件：${PATCH}`)
  process.exit(1)
}

const op = reverse ? ['apply', '-R', '--check'] : ['apply', '--check']
const check = spawnSync('git', [...op, PATCH], { cwd: repo, encoding: 'utf8' })
if (check.status !== 0) {
  console.error(`✗ 预检失败（${reverse ? '回滚' : '应用'}）：`)
  console.error(check.stderr || check.stdout)
  console.error('提示：--reverse 回滚需要补丁已应用；应用需要源码未被其它修改冲突。')
  process.exit(1)
}

const run = spawnSync('git', [...(reverse ? ['apply', '-R'] : ['apply']), PATCH], { cwd: repo, encoding: 'utf8' })
if (run.status !== 0) {
  console.error('✗ 应用失败：')
  console.error(run.stderr || run.stdout)
  process.exit(1)
}

console.log(`✔ 补丁已${reverse ? '回滚' : '应用'}：${repo}`)
console.log('下一步：')
if (!reverse) {
  console.log('  1. npm run build:lib:client')
  console.log('  2. pnpm --filter @deepseek-ai/dsh-web-frontend run build')
  console.log('  3. 部署 dist 与各 client bundle 到运行环境')
  console.log('  4. 安装 dsh-webui-perf 插件（见 README.md）并重启 dsh')
} else {
  console.log('  重新构建并部署即可还原官方行为。')
}
