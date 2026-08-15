// 创建 GitHub Release v0.1.0 并上传 tgz 附件（token 不落盘不打印）
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const input = 'protocol=https\nhost=github.com\n\n'
const out = execSync('git credential fill', { input, encoding: 'utf8' })
const get = (key) => {
  const line = out.split('\n').find((x) => x.startsWith(`${key}=`))
  return line ? line.slice(key.length + 1) : undefined
}
const token = get('password')
const user = get('username')
if (!token || !user) {
  console.error('credential 缺失')
  process.exit(1)
}
const headers = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'Content-Type': 'application/json',
  'X-GitHub-Api-Version': '2022-11-28',
}
const REPO = `${user}/dsh-webui-perf`

const body = `## 🐳⚡ dsh-webui-perf — DeepSeek Harness WebUI 性能优化开关插件

长代码流式渲染、历史加载、语法高亮/公式/渲染缓存优化，全部收敛到一个**设置面板开关**，一键开启或回退官方原始实现。

### ✨ 优化内容（开关开启时生效）

| 场景 | 优化 |
|---|---|
| 流式输出长代码 | 未闭合代码块增量解析（每帧只处理新增字节，O(n²)→O(n)） |
| 长代码写完瞬间 | 大代码块（>3000 字符）空闲回调懒高亮，不再同步阻塞主线程 |
| 载入长历史会话 | 增量可见性判断（去掉每 chunk 全文本 trim/rope 展平）；工具调用树深度检查去 BFS |
| 长思考（Think 块） | 展开正文 100ms 节流更新，折叠摘要保持实时 |
| 重复渲染 | shiki 高亮 / KaTeX / settled markdown 渲染三层 LRU 缓存 |
| 读大文件 | ReadBlock 折叠时只高亮可见窗口 |

**实测**：打开长代码历史会话主线程冻结 **8.3s → 0.3s（-96%）**。

### 📦 安装

**方式 A：tgz 直接安装（本 Release 附件）**

\`\`\`bash
# 下载 dsh-webui-perf-0.1.0.tgz，放入任意插件目录后解压（或 npm install 到 profile）
# 然后：
# 1. 应用官方包补丁（patches/ 目录）
node patches/apply-runtime-patches.mjs        # 已安装环境（api-proxy allowlist，自动备份）
# 或源码构建：
node patches/apply-patches.mjs <deepseek-harness 源码路径>
npm run build:lib:client && pnpm --filter @deepseek-ai/dsh-web-frontend run build

# 2. 把 dsh-webui-perf 加入 web profile（package.json dependencies link + dsh.profile.bundles）
# 3. 重启 dsh，设置 → 通用 → 「WebUI 性能优化」开关
\`\`\`

**方式 B：git clone 安装**

\`\`\`bash
git clone https://github.com/awa-123-cw/dsh-webui-perf.git
cd dsh-webui-perf
# 其余步骤同方式 A
\`\`\`

### ↩️ 回滚

\`\`\`bash
node patches/apply-patches.mjs --reverse <源码路径>   # 源码补丁回滚
node patches/apply-runtime-patches.mjs --reverse      # 运行时补丁回滚
# 移除 profile 中的插件条目并重启
\`\`\`

### ✅ 兼容性

- deepseek-harness \`0.1.0-rc.5\` / \`0.1.0-rc.6\`
- 附带 1021 项官方测试全部通过（ui-primitives / ui-conversation / ui-trajectory）

### 📄 License

MIT`

// 1. 创建 Release（已存在则复用）
let rel
{
  const existing = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/v0.1.0`, { headers })
  if (existing.status === 200) {
    rel = await existing.json()
    console.log('release already exists:', rel.html_url)
  } else {
    const release = await fetch(`https://api.github.com/repos/${REPO}/releases`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        tag_name: 'v0.1.0',
        name: 'v0.1.0',
        body,
        draft: false,
        prerelease: false,
      }),
    })
    console.log('create release:', release.status)
    rel = await release.json()
    if (release.status !== 201) {
      console.error(JSON.stringify(rel).slice(0, 500))
      process.exit(1)
    }
    console.log('release url:', rel.html_url)
  }
}

// 2. 上传 tgz 附件（asset 上传走 uploads.github.com）
const tgz = 'dsh-webui-perf-0.1.0.tgz'
const file = readFileSync(tgz)
const asset = await fetch(`https://uploads.github.com/repos/${REPO}/releases/${rel.id}/assets?name=${tgz}`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/gzip',
    'X-GitHub-Api-Version': '2022-11-28',
  },
  body: file,
})
console.log('upload asset:', asset.status)
const assetBody = await asset.json().catch(() => ({}))
if (asset.status !== 201) {
  console.error(JSON.stringify(assetBody).slice(0, 400))
  process.exit(1)
}
console.log('asset:', assetBody.name, assetBody.browser_download_url)
