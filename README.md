# LLM Subtitle Translator

用 **Gemini / OpenAI / Claude** 的 API 实时翻译 **Netflix、Disney+、Prime Video、YouTube、HBO Max、Apple TV+** 等流媒体的内置字幕。

## 工作原理

1. 内容脚本 (`content.js`) 注入到播放页面，用 `MutationObserver` 监听平台自身的字幕 DOM 节点。
2. 每次字幕文本变化，脚本把原文通过 `chrome.runtime.sendMessage` 发给 Service Worker。
3. Service Worker (`background.js`) 调用你配置好的 LLM（Gemini / OpenAI / Anthropic / 自定义 OpenAI 兼容 endpoint）返回翻译。
4. 脚本把翻译后的文字叠在视频底部，并可选同时显示原文。
5. 本地缓存 + 最近上下文窗口：重复的同一条字幕不会重复消费 token；最近几行翻译会作为上下文传给模型，保持称谓、语气连贯。

## 安装（加载为未打包扩展）

1. 打开 `chrome://extensions`
2. 右上角开启 **开发者模式 / Developer mode**
3. 点「加载已解压的扩展程序 / Load unpacked」，选择本目录 (`subtitle-translator/`)
4. 点扩展图标 → 打开「完整设置」
5. 选择 provider、填入 API Key、选目标语言
6. 点「测试连接」确认能返回翻译
7. 打开 Netflix / Disney+ 等，**先在平台里把原文字幕（例如英文）打开**，扩展就会自动接管

## 文件结构

| 文件 | 作用 |
|---|---|
| `manifest.json` | MV3 清单，声明权限与 content script 匹配站点 |
| `background.js` | Service Worker：所有 LLM API 调用、消息路由、默认设置 |
| `content.js` | 监听字幕 DOM、去重、缓存、请求翻译、渲染覆盖层 |
| `content.css` | 翻译覆盖层样式（大字 + 黑描边，兼容全屏） |
| `popup.html/js/css` | 点图标后的快速开关面板 |
| `options.html/js/css` | 完整设置页（API key / 模型 / 上下文 / 语言） |
| `icons/` | 16 / 48 / 128 px 占位图标 |

## 支持的平台

- Netflix（`.player-timedtext`）
- Disney+ / Hotstar
- Prime Video / Amazon Video
- YouTube
- HBO Max / Max
- Apple TV+

如果你发现某个平台不工作，多半是 DOM 选择器变了——编辑 `content.js` 里的 `PLATFORMS` 数组加上新的 `containerSelectors` 即可。

## 成本提示

字幕一般每几秒变一次，长片可能产生上千次 API 调用。**强烈建议优先使用便宜的 flash / mini / haiku 级模型**：

- Gemini 2.5 Flash
- OpenAI gpt-4o-mini / gpt-4.1-mini
- Claude Haiku 4.5

扩展内部已做：
- 重复字幕缓存（500 条 LRU）
- 最近翻译作为上下文（避免每次都重新解释人物关系）
- 最小请求间隔节流

## 权限说明

- `storage`：保存你的 API key 和偏好（使用 `chrome.storage.sync`）
- `scripting` / `activeTab`：供内容脚本注入
- `host_permissions`：只匹配上述几个流媒体域名 + 对应 LLM API 域名

API key **只存在你本地的 Chrome sync storage 里**，不会上传到任何第三方服务器——请求直接从你的浏览器发到 LLM 提供商。

## 已知限制

- 部分平台（如 DRM 加密场景）可能把字幕绘制到 `<canvas>`，无法通过 DOM 抓取；此时扩展只能隐藏原生字幕，无翻译可显示。
- Apple TV+ 的字幕选择器最不稳定；如果遇到问题请用开发者工具找到真实的字幕类名并加进去。
- 翻译有 LLM 延迟（几百毫秒到 1 秒），快速对话场景下可能滞后。
