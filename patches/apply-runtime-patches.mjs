#!/usr/bin/env node
/**
 * dsh-webui-perf 运行时补丁：对已安装（node_modules 产物）环境打补丁，
 * 免去从源码构建。当前只处理 host 端 api-proxy 的 settings allowlist
 * （这是唯一不经过构建的 host 端修改；dist / client bundle 由源码补丁构建后部署）。
 *
 * 用法：
 *   node apply-runtime-patches.mjs [--reverse]
 *
 * 修改文件（自动备份 .bak-<时间戳>）：
 *   node_modules/@deepseek-ai/dsh-host-apiproxy/lib/index.js
 *   node_modules/@deepseek-ai/dsh-host-apiproxy/lib/types/api-proxy.js
 *
 * 注意：需要重启 dsh 进程后生效。
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const reverse = process.argv.includes('--reverse')

// 探测 dsh 安装根：从常见位置找 dsh-host-apiproxy 包。
const candidates = [
  resolve('D:/dsh-harness/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-host-apiproxy/lib'),
  resolve('node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-host-apiproxy/lib'),
  resolve('node_modules/@deepseek-ai/dsh-host-apiproxy/lib'),
]
const libDir = candidates.find(dir => existsSync(join(dir, 'index.js')))
if (libDir === undefined) {
  console.error('✗ 未找到 dsh-host-apiproxy 包。请在本脚本同目录放置 dsh 安装路径或手动修改：')
  console.error('  WEB_SETTINGS_NAMESPACES 数组加入 "webui-perf"')
  process.exit(1)
}

const files = ['index.js', 'types/api-proxy.js']
const marker = '"web-search-deepseek"'
const withPerf = '"web-search-deepseek", "webui-perf"'
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backupDir = join(libDir, '.webui-perf-backups')
mkdirSync(backupDir, { recursive: true })

for (const rel of files) {
  const path = join(libDir, rel)
  if (!existsSync(path)) continue
  const source = readFileSync(path, 'utf8')
  const target = reverse ? source.replaceAll(withPerf, marker) : source.replaceAll(marker, withPerf)
  if (target === source) {
    console.log(`- ${rel}: ${reverse ? '已回滚' : '已包含'}，跳过`)
    continue
  }
  const backup = join(backupDir, `${rel.replace(/[/\\]/g, '_')}.bak-${stamp}`)
  copyFileSync(path, backup)
  writeFileSync(path, target, 'utf8')
  console.log(`✔ ${rel}: ${reverse ? '回滚' : '应用'}完成（备份 ${backup}）`)
}

console.log(reverse
  ? '运行时补丁已回滚。'
  : '运行时补丁已应用。请重启 dsh 进程使 allowlist 生效，然后安装插件本体（见 README.md）。')
