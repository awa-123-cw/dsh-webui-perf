# dsh-webui-perf 🐳⚡

DeepSeek Harness Web GUI 性能优化开关插件：长代码流式渲染、历史加载、语法高亮/公式/渲染缓存的优化，全部收敛到一个**设置面板开关**，随时一键开启或回退原始实现。

## ✨ 优化内容（开关开启时生效）

| 场景 | 优化 |
|---|---|
| 流式输出长代码 | 未闭合代码块增量解析（每帧只处理新增字节，O(n²)→O(n)） |
| 长代码写完瞬间 | 大代码块（>3000 字符）改空闲回调懒高亮，不再同步阻塞主线程 |
| 载入长历史会话 | 增量可见性判断（去掉每 chunk 的全文本 trim/rope 展平）；工具调用树深度检查去 BFS |
| 长思考（Think 块） | 展开正文 100ms 节流更新，折叠摘要保持实时 |
| 重复渲染 | shiki 高亮 / KaTeX / settled markdown 渲染三层 LRU 缓存 |
| 读大文件 | ReadBlock 折叠时只高亮可见窗口（head/tail 16 行） |
| 内存/显存 | 消息列表 `content-visibility`（离屏行跳过渲染/布局，长会话内存有界 + 滚动流畅）；历史图片缩略图降采样到 ≤640px（原图解码内存/显存省 70%+，点击查看仍加载原图） |

实测：打开长代码历史会话的主线程冻结从 **8.3s → 0.3s**（-96%）。

## 📦 结构

```
dsh-webui-perf/
├── package.json            # 插件清单（host + client 双面）
├── cordis.patch.yml        # bundle patch（挂载到 web profile）
├── lib/
│   ├── index.js            # host half：注册 webui-perf 设置命名空间
│   └── client.js           # 浏览器 half：设置开关行 + localStorage/事件广播
└── patches/
    ├── dsh-webui-perf.patch        # 对 deepseek-harness 源码的补丁（git apply）
    ├── apply-patches.mjs           # 源码补丁应用/回滚脚本
    ├── apply-runtime-patches.mjs   # 已安装环境的运行时补丁（api-proxy allowlist）
    └── check-patches.mjs           # 补丁健康检测（升级后必跑）
```

> 为什么需要补丁：优化代码在官方包内部（`ui-primitives` 是 shell 平台模块、`ui-conversation`/`ui-trajectory` 是官方 client bundle，插件无法替换），因此优化以**带开关的源码补丁**形式随插件发布；插件本体负责开关 UI 与状态广播（localStorage + `dsh:webui-perf-change` 事件，cordis-free 通道）。关闭开关即回退官方原始实现。

## 🚀 安装

### 1. 应用官方包补丁

**方式 A：源码构建（推荐，可长期维护）**

```bash
# 在 deepseek-harness 源码 checkout 里
git clone --depth 1 https://github.com/deepseek-ai/deepseek-harness.git
cd dsh-webui-perf/patches
node apply-patches.mjs <源码路径>      # git apply --check + apply（自动备份语义，可 --reverse 回滚）

# 重新构建
cd <源码路径>
npm run build:lib:client
pnpm --filter @deepseek-ai/dsh-web-frontend run build
# 部署 dist 到 dsh-web-frontend/dist，lib/client.js 到各 client 包 lib/
```

**方式 B：已安装环境（免构建）**

```bash
node patches/apply-runtime-patches.mjs    # 打 api-proxy allowlist（自动备份）
# 再把构建好的 dist 与 client bundle 部署到 node_modules 对应包
```

### 2. 安装插件本体

把 `dsh-webui-perf` 加入 web profile：

```jsonc
// D:\dsh\profiles\web\package.json
{
  "dependencies": { "dsh-webui-perf": "link:D:/dsh-plugins/dsh-webui-perf" },
  "dsh": { "profile": { "bundles": [ /* ... */, "dsh-webui-perf" ] } }
}
```

（或使用 super-injector 的 `dev_install_package` 热装配。）

### 3. 重启 dsh

```
dsh web
```

## 🎛️ 使用

设置 → 通用 → **WebUI 性能优化** 开关：

- **开**：全部优化生效（默认）
- **关**：立即回退官方原始实现（无需刷新页面）

开关状态持久化在用户设置文档（`webui-perf.enabled`），切换通过 localStorage + CustomEvent 实时广播给运行中的优化代码。

## ↩️ 回滚

```bash
# 源码补丁回滚
node apply-patches.mjs --reverse <源码路径>

# 运行时补丁回滚
node patches/apply-runtime-patches.mjs --reverse

# 插件移除
# 从 profile package.json 的 dependencies/bundles 移除 dsh-webui-perf，重启即可
```

## 🔍 升级后检测（重要）

**dsh 官方升级会覆盖 node_modules 产物，补丁可能悄悄失效**（开关不再起作用，且设置面板会显示「补丁缺失」警告）。升级后请运行健康检测：

```bash
node patches/check-patches.mjs          # 检测三类补丁痕迹（allowlist / client bundle / dist）
node patches/check-patches.mjs --fix    # 缺失时自动重打 api-proxy allowlist
```

检测项：
1. **api-proxy allowlist** 是否仍含 `webui-perf`（设置开关暴露的前提）
2. **ui-conversation / ui-trajectory client bundle** 是否含优化开关代码
3. **web dist**（index.html 实际引用的 chunk）是否含 ui-primitives 优化代码

检测结果也**实时显示在设置面板**：官方补丁缺失时，开关行变为红色警告（「补丁缺失：请重跑 patches/apply-runtime-patches.mjs 后重启 dsh」），不会假装生效。

## ✅ 兼容性

- deepseek-harness `0.1.0-rc.5` / `0.1.0-rc.6`
- 随插件附带的 1021 项官方测试全部通过（ui-primitives / ui-conversation / ui-trajectory）

## 📄 License

MIT
