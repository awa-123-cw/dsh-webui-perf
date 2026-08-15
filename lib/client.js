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

		var NS = "webui-perf";
		var STORAGE_KEY = "dsh.webui-perf.enabled";
		var CHANGE_EVENT = "dsh:webui-perf-change";
		var CSS_TAG = "dsh-webui-perf";

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
		};
		var en = {
			"perf.title": "WebUI performance optimizations",
			"perf.description": "Streaming render, history load and highlight/KaTeX/render-cache optimizations for long code and reasoning (off reverts to the original implementation)",
			"perf.on": "On",
			"perf.off": "Off",
		};

		// ---- 设置开关行 ----
		function PerfRow(props) {
			var snap = props.usePerf(function (v) { return v; });
			var enabled = snap !== undefined && snap.value !== undefined ? snap.value.enabled : true;
			var t = props.t;
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
				".dshWebuiPerfSwitchOn .dshWebuiPerfKnob{transform:translateX(18px)}";
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
