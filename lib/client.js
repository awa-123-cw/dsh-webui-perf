// dsh-webui-perf 浏览器 half（手写 bundle，官方 __ModuleLoader__.load 契约）：
// 1) 绑定 Host 设置命名空间 webui-perf（settingsScope）；
// 2) 设置面板「通用」区注册开关行（settings.general.item，role=switch）；
// 3) 开关状态通过 localStorage + window CustomEvent 广播给官方包的优化代码
//    （ui-primitives / ui-conversation / ui-trajectory 的 cordis-free 通道），
//    无需刷新页面即可切换全部性能优化路径。
window.__ModuleLoader__.load({
	id: "dsh-webui-perf",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		var React = require("react");
		var h = React.createElement;
		var primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		var NS = "webui-perf";
		var STORAGE_KEY = "dsh.webui-perf.enabled";
		var CHANGE_EVENT = "dsh:webui-perf-change";
		var CSS_TAG = "dsh-webui-perf";
		var MEMORY_REFRESH_MS = 5000;
		var MEMORY_FREED_SETTLE_MS = 1500;

		// ---- 广播：写 localStorage + 发事件（官方包优化开关的读取通道）----
		function publish(enabled) {
			try {
				window.localStorage.setItem(STORAGE_KEY, String(enabled));
			} catch (e) { /* 隐私模式等场景静默 */ }
			window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { enabled: !!enabled } }));
		}

		// ---- 词典 ----
		var zh = {
			"perf.title": "WebUI 性能优化",
			"perf.description": "长代码流式渲染、历史加载与高亮/公式/渲染缓存优化（关闭即回退原始实现）",
			"perf.on": "已开启",
			"perf.off": "已关闭",
			"perf.patchMissing": "官方包补丁缺失：dsh 升级可能覆盖了补丁。请重跑 patches/apply-runtime-patches.mjs 后重启 dsh，开关才会生效。",
			"perf.patchMissingBadge": "补丁缺失",
			"mem.tip": "当前 JS 堆占用 / 上限 · 点击 🧹 清理渲染缓存并触发 GC（PCL 式内存优化）",
			"mem.clean": "内存优化：清理渲染缓存并触发垃圾回收",
			"mem.freed": "已释放 {mb} MB",
		};
		var en = {
			"perf.title": "WebUI performance optimizations",
			"perf.description": "Streaming render, history load and highlight/KaTeX/render-cache optimizations for long code and reasoning (off reverts to the original implementation)",
			"perf.on": "On",
			"perf.off": "Off",
			"perf.patchMissing": "Official-package patch missing: a dsh upgrade may have overwritten it. Re-run patches/apply-runtime-patches.mjs and restart dsh for the switch to take effect.",
			"perf.patchMissingBadge": "Patch missing",
			"mem.tip": "System available / total memory · 🧹 light clean (caches+GC+Edge cache processes) · ♻️ deep clean (PCL-style full-system, requires UAC)",
			"mem.clean": "Light clean: clear render caches and trigger garbage collection",
			"mem.deep": "Deep clean: reload the page to release process memory (session state is persisted and auto-restores)",
			"mem.deepConfirm": "Click again to confirm reload",
			"mem.reloading": "Reloading…",
			"mem.freed": "Freed {mb} MB",
			"mem.heap": "Page JS heap: {mb} MB",
		};
		var zh = {
			"perf.title": "WebUI 性能优化",
			"perf.description": "长代码流式渲染、历史加载与高亮/公式/渲染缓存优化（关闭即回退原始实现）",
			"perf.on": "已开启",
			"perf.off": "已关闭",
			"perf.patchMissing": "官方包补丁缺失：dsh 升级可能覆盖了补丁。请重跑 patches/apply-runtime-patches.mjs 后重启 dsh，开关才会生效。",
			"perf.patchMissingBadge": "补丁缺失",
			"mem.tip": "系统可用/总内存（host os.freemem）· 🧹 轻清理（清缓存+GC+Edge缓存进程）· ♻️ 深度清理（PCL 同款全系统优化，需 UAC 授权）",
			"mem.clean": "轻清理：清空渲染缓存并触发垃圾回收",
			"mem.deep": "深度清理：PCL 同款全系统内存优化（所有进程工作集+standby），将弹出系统授权(UAC)，所有程序短暂换页属正常现象",
			"mem.deepConfirm": "再点一次确认（将弹出 UAC 授权）",
			"mem.reloading": "刷新中…",
			"mem.freed": "已释放 {mb} MB",
			"mem.heap": "本页 JS 堆 {mb} MB",
		};

		// ---- 右上角内存指示 + 主动清理（PCL「内存优化」的 WebUI 对应）----
		// 显示口径 = 系统可用/总内存（host 提供，PCL 同款）；清理分两级：
		//   🧹 轻清理：清渲染缓存 + 尝试 GC（立即，影响 JS 堆）
		//   ♻️ 深度清理：刷新页面——浏览器进程内存打回原形（EmptyWorkingSet 的
		//      WebUI 等价物），dsh 会话状态由 host 持久化，刷新后自动恢复。
		function MemoryGauge(props) {
			var useState = React.useState, useEffect = React.useEffect, useRef = React.useRef;
			var [sys, setSys] = useState(null);        // { total, free } 系统内存
			var [heap, setHeap] = useState(null);      // { used, limit } JS 堆（tooltip 附注）
			var [freed, setFreed] = useState(null);    // 轻清理释放量（临时显示）
			var [busy, setBusy] = useState(false);
			var [deepArm, setDeepArm] = useState(false); // 深度清理二次确认
			var [reloading, setReloading] = useState(false);
			var busyRef = useRef(false);
			var deepTimerRef = useRef(null);
			var t = props.t;

			useEffect(function () {
				var readHost = function () {
					try {
						fetch("/webui-perf/memory", { cache: "no-store" })
							.then(function (r) { return r.ok ? r.json() : null; })
							.then(function (data) {
								if (data && typeof data.total === "number") setSys({ total: data.total, free: data.free });
							})
							.catch(function () { /* host 路由缺失时静默，降级 JS 堆 */ });
					} catch (e) { /* 忽略 */ }
				};
				var readHeap = function () {
					if (typeof performance !== "undefined" && performance.memory) {
						setHeap({ used: performance.memory.usedJSHeapSize, limit: performance.memory.jsHeapSizeLimit });
					}
				};
				readHost();
				readHeap();
				var id = window.setInterval(function () { readHost(); readHeap(); }, MEMORY_REFRESH_MS);
				return function () {
					window.clearInterval(id);
					if (deepTimerRef.current !== null) window.clearTimeout(deepTimerRef.current);
				};
			}, []);

			if (sys === null && heap === null) return null;

			var text = "";
			if (freed !== null) {
				text = freed; // 轻清理反馈：可为 "可用 +X.X GB" / "已释放 X MB" / "已清理 ✓"
			} else if (sys !== null) {
				var freeGB = sys.free / 1073741824;
				var totalGB = sys.total / 1073741824;
				text = "可用 " + freeGB.toFixed(1) + " / " + totalGB.toFixed(1) + " GB";
			} else {
				text = (heap.used / 1048576).toFixed(0) + " / " + Math.round(heap.limit / 1048576) + " MB";
			}
			var tip = t("mem.tip") + (heap !== null ? " · " + t("mem.heap", { mb: Math.round(heap.used / 1048576) }) : "");

			function lightClean() {
				if (busyRef.current) return;
				busyRef.current = true;
				setBusy(true);
				setFreed(null);
				// 1) 页面侧：清空渲染缓存 + 尝试 GC
				try { primitives.clearPerfCaches(); } catch (e) { /* 平台模块缺失时静默 */ }
				try { if (typeof window.gc === "function") window.gc(); } catch (e) { /* 忽略 */ }
				var beforeFree = sys !== null ? sys.free : null;
				// 2) host 侧：系统级清理（EmptyWorkingSet + standby + Edge 缓存进程）
				var settled = false;
				var finish = function (label) {
					if (settled) return;
					settled = true;
					busyRef.current = false;
					setBusy(false);
					setFreed(label);
					window.setTimeout(function () { setFreed(null); }, 6000);
					// 刷新系统内存显示
					try {
						fetch("/webui-perf/memory", { cache: "no-store" })
							.then(function (r) { return r.ok ? r.json() : null; })
							.then(function (data) {
								if (data && typeof data.free === "number") setSys({ total: data.total, free: data.free });
							}).catch(function () { /* 忽略 */ });
					} catch (e) { /* 忽略 */ }
				};
				var heapBefore = (typeof performance !== "undefined" && performance.memory) ? performance.memory.usedJSHeapSize : 0;
				try {
					fetch("/webui-perf/clean", { method: "POST", cache: "no-store" })
						.then(function (r) { return r.json(); })
						.then(function (data) {
							var parts = [];
							if (data && data.result) {
								var r = data.result;
								if (r.afterFreeKB && r.beforeFreeKB) {
									var freedGB = (r.afterFreeKB - r.beforeFreeKB) / 1048576;
									if (freedGB > 0.05) parts.push("可用 +" + freedGB.toFixed(1) + " GB");
								}
								if (r.edgeFreedMB > 0) parts.push("Edge 缓存 -" + r.edgeFreedMB + " MB");
								if (r.standbyOk) parts.push("standby ✓");
								else if (r.admin === false) parts.push("standby 跳过(需管理员)");
							}
							var heapAfter = (typeof performance !== "undefined" && performance.memory) ? performance.memory.usedJSHeapSize : 0;
							var heapFreed = heapBefore > 0 ? Math.round((heapBefore - heapAfter) / 1048576) : 0;
							if (heapFreed > 0) parts.push(t("mem.freed", { mb: heapFreed }));
							finish(parts.length > 0 ? parts.join(" · ") : (data && data.error ? "清理失败: " + String(data.error).slice(0, 40) : "已清理 ✓"));
						})
						.catch(function (e) {
							finish(beforeFree !== null ? "host 清理不可用" : "已清理 ✓");
						});
				} catch (e) {
					finish("已清理 ✓");
				}
				// 兜底：host 无响应时 8 秒后恢复按钮
				window.setTimeout(function () { finish(beforeFree !== null ? "清理超时" : "已清理 ✓"); }, 8000);
			}

			function deepClean() {
				if (reloading) return;
				if (!deepArm) {
					// 第一次点击：进入确认态（3 秒后复原）
					setDeepArm(true);
					if (deepTimerRef.current !== null) window.clearTimeout(deepTimerRef.current);
					deepTimerRef.current = window.setTimeout(function () { setDeepArm(false); }, 3000);
					return;
				}
				// 第二次点击：系统级深度清理（所有 Edge 渲染进程工作集换页），
				// 完成后刷新页面（本页进程打回原形）——PCL「内存优化」的完整对应。
				setReloading(true);
				try { primitives.clearPerfCaches(); } catch (e) { /* 忽略 */ }
				try {
					fetch("/webui-perf/clean-deep", { method: "POST", cache: "no-store" })
						.catch(function () { /* 清理失败也继续刷新 */ })
						.finally(function () {
							window.setTimeout(function () { window.location.reload(); }, 400);
						});
				} catch (e) {
					window.setTimeout(function () { window.location.reload(); }, 300);
				}
			}

			return h("div", { className: "dshWebuiPerfMem", title: tip },
				h("span", { className: "dshWebuiPerfMemText" }, text),
				h("button", {
					type: "button",
					className: "dshWebuiPerfMemBtn",
					"aria-label": t("mem.clean"),
					disabled: busy || reloading,
					onClick: lightClean,
				}, busy ? "…" : "🧹"),
				h("button", {
					type: "button",
					className: "dshWebuiPerfMemBtn" + (deepArm ? " dshWebuiPerfMemBtnArm" : ""),
					"aria-label": deepArm ? t("mem.deepConfirm") : t("mem.deep"),
					disabled: busy || reloading,
					onClick: deepClean,
				}, reloading ? "…" : (deepArm ? "✓" : "♻️"))
			);
		}

		// ---- 设置开关行 ----
		// scope 状态即补丁状态：host 注册必定成功，settings scope 变
		// 'unavailable' 的唯一原因是 api-proxy allowlist 不含 webui-perf
		// （官方升级覆盖了补丁）——此时渲染缺失警告而非开关。
		function PerfRow(props) {
			var snap = props.usePerf(function (v) { return v; });
			var status = snap !== undefined ? snap.status : "loading";
			var enabled = snap !== undefined && snap.value !== undefined ? snap.value.enabled : true;
			var t = props.t;
			if (status === "unavailable") {
				return h("div", { className: "dshWebuiPerfRow dshWebuiPerfRowWarn" },
					h("div", { className: "dshWebuiPerfRowText" },
						h("div", { className: "dshWebuiPerfTitle" }, t("perf.title")),
						h("div", { className: "dshWebuiPerfDesc dshWebuiPerfWarn" }, t("perf.patchMissing"))
					),
					h("span", { className: "dshWebuiPerfBadge" }, t("perf.patchMissingBadge"))
				);
			}
			return h("div", { className: "dshWebuiPerfRow" },
				h("div", { className: "dshWebuiPerfRowText" },
					h("div", { className: "dshWebuiPerfTitle" }, t("perf.title")),
					h("div", { className: "dshWebuiPerfDesc" }, t("perf.description")),
					h("div", { className: "dshWebuiPerfState" }, enabled ? t("perf.on") : t("perf.off"))
				),
				h("button", {
					type: "button",
					role: "switch",
					"aria-checked": enabled,
					"aria-label": t("perf.title"),
					className: "dshWebuiPerfSwitch" + (enabled ? " dshWebuiPerfSwitchOn" : ""),
					onClick: function () { props.setEnabled(!enabled); },
				}, h("span", { className: "dshWebuiPerfKnob" }))
			);
		}

		function apply(ctx) {
			// 词典
			ctx.effect(function () {
				return ctx.locale.register(NS, { zh: zh, en: en });
			}, "dsh-webui-perf: dictionaries");

			// 设置作用域：读取 Host 持久化值；任何变化（本插件写入或外部修改）都广播。
			var scope = ctx.settingsScope.bind({ namespace: NS });
			function onScopeChange() {
				var snap = scope.getSnapshot();
				var value = snap.value;
				publish(value === undefined ? true : value.enabled);
			}
			scope.subscribe(onScopeChange);
			// 立即发布一次：settings 尚未加载时用默认 true；加载完成后订阅回调会再纠正。
			onScopeChange();

			// 设置面板「通用」区开关行
			ctx.slots.inject("settings.general.item", function () {
				return ctx.slots.register({
					name: "settings.general.item",
					id: "webui-perf",
					order: 5,
					locale: NS,
					inject: function () {
						return {
							hooks: { perf: scope },
							setEnabled: function (value) {
								scope.set("enabled", !!value);
							},
						};
					},
				}, PerfRow);
			});

			// 右上角内存指示 + PCL 式「内存优化」按钮（header.utilities 最右，order 30，
			// 与 subagent-catalog(10)/job-list(20) 在 flex 中依次排开，不会重叠）
			ctx.slots.inject("conversation.session.header.utilities", function () {
				return ctx.slots.register({
					name: "conversation.session.header.utilities",
					id: "webui-perf-memory",
					order: 30,
					locale: NS,
				}, MemoryGauge);
			});

			// 行样式（沿用设置行视觉规范：标题/描述 + 右侧控件）
			var css = "" +
				".dshWebuiPerfRow{display:flex;align-items:center;gap:8px;padding:16px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}" +
				".dshWebuiPerfRowText{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px;padding-right:48px}" +
				".dshWebuiPerfTitle{font-size:14px;font-weight:400;line-height:22px;color:var(--dsw-alias-label-primary)}" +
				".dshWebuiPerfDesc{font-size:12px;font-weight:400;line-height:18px;color:var(--dsw-alias-label-tertiary)}" +
				".dshWebuiPerfState{font-size:12px;line-height:18px;color:var(--dsw-alias-label-caption)}" +
				".dshWebuiPerfSwitch{position:relative;flex:none;width:40px;height:22px;border:none;border-radius:11px;background:var(--dsw-alias-bg-module-platform);cursor:pointer;transition:background .15s ease;padding:0}" +
				".dshWebuiPerfSwitch:hover{background:var(--dsw-alias-interactive-bg-hover)}" +
				".dshWebuiPerfSwitchOn{background:var(--dsw-static-deepseek-500,var(--dsw-alias-state-ok-primary))}" +
				".dshWebuiPerfKnob{position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-primary);transition:transform .15s ease}" +
				".dshWebuiPerfSwitchOn .dshWebuiPerfKnob{transform:translateX(18px)}" +
				".dshWebuiPerfRowWarn .dshWebuiPerfTitle{color:var(--dsw-alias-state-error-primary)}" +
				".dshWebuiPerfWarn{color:var(--dsw-alias-state-error-primary)}" +
				".dshWebuiPerfBadge{flex:none;border-radius:999px;background:var(--dsw-alias-state-error-tertiary,color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent));color:var(--dsw-alias-state-error-primary);padding:3px 10px;font-size:12px;line-height:18px}" +
				// 右上角内存胶囊（与 header.utilities 既有条目同高 28px 视觉体系）
				".dshWebuiPerfMem{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 4px 0 10px;border-radius:14px;background:var(--dsw-alias-bg-module-platform);flex:none}" +
				".dshWebuiPerfMemText{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:nowrap;font-variant-numeric:tabular-nums}" +
				".dshWebuiPerfMemBtn{flex:none;width:24px;height:24px;border:none;border-radius:12px;background:transparent;cursor:pointer;font-size:13px;line-height:24px;padding:0}" +
				".dshWebuiPerfMemBtn:hover{background:var(--dsw-alias-interactive-bg-hover)}" +
				".dshWebuiPerfMemBtn:disabled{opacity:.5;cursor:default}" +
				".dshWebuiPerfMemBtnArm{background:var(--dsw-alias-state-warn-tertiary,color-mix(in srgb,var(--dsw-alias-state-warn-primary) 18%,transparent))}";
			if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_TAG) + "]") === null) {
				var tag = document.createElement("style");
				tag.dataset.plugin = "dsh-webui-perf";
				tag.dataset.pluginCss = CSS_TAG;
				tag.textContent = css;
				document.head.appendChild(tag);
			}
		}

		exports.apply = apply;
		exports.inject = ["locale", "settingsScope", "slots"];

		return module.exports;
	}
});
