// 用 GCM 凭据创建 GitHub 仓库 + 加 dsh-plugin topic（token 不落盘不打印）
import { execSync } from 'node:child_process'

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

const NAME = 'dsh-webui-perf'

// 1. 创建公开仓库（已存在则跳过）
const create = await fetch('https://api.github.com/user/repos', {
  method: 'POST',
  headers,
  body: JSON.stringify({
    name: NAME,
    description: 'DeepSeek Harness WebUI 性能优化开关插件：长代码流式渲染/历史加载/高亮缓存优化，设置面板一键开关（with official-package patches）',
    homepage: `https://github.com/topics/dsh-plugin`,
    private: false,
    has_issues: true,
    has_wiki: false,
    auto_init: false,
  }),
})
console.log('create repo:', create.status)
const created = await create.json().catch(() => ({}))
if (create.status !== 201 && create.status !== 422) {
  console.error(JSON.stringify(created).slice(0, 500))
  process.exit(1)
}

// 2. 添加 topics
const topics = await fetch(`https://api.github.com/repos/${user}/${NAME}/topics`, {
  method: 'PUT',
  headers,
  body: JSON.stringify({
    names: ['dsh-plugin', 'dsh', 'deepseek-harness', 'webui', 'performance'],
  }),
})
console.log('set topics:', topics.status)
const topicsBody = await topics.json().catch(() => ({}))
console.log('topics:', JSON.stringify(topicsBody.names ?? topicsBody))

// 3. 仓库主页
console.log(`repo: https://github.com/${user}/${NAME}`)
