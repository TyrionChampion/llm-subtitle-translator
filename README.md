# LLM Subtitle Translator

用 **Gemini / OpenAI / Claude** 的 API 实时翻译 **Netflix、Disney+、Prime Video、YouTube、HBO Max、Apple TV+** 等流媒体的内置字幕。

## 本分支：F1 术语与原文上下文增强（实验）

这是 TyrionChampion fork 的独立分支 `feat/f1-translation-context`，基于 Apple TV 兼容修复构建。
**F1 增强仅在本 fork 分支提供，不包含在提交给原作者的 Apple TV 修复 PR #1 中，也未为它新建上游 PR。**

- 在「完整设置 → 翻译行为 → F1 翻译增强」选择自动识别（默认）、强制开启或关闭。自动识别依据页面标题中的 F1 / Formula 1 或 Formula 1 频道地址。
- F1 模式使用赛车术语和统一译名，并参考默认前 4 条英文原文，而不是 API 完成顺序排列的译文。可配置 0–8 条（最多 1200 字符），设为 0 仅保留术语提示。
- Apple TV 按原生字幕时间取前文；其他 DOM 字幕使用已观察到的原文。没有前文时直接翻译，不增加等待下一句的合句延迟。预翻译和屏幕翻译共享包含上下文的缓存。
- 术语和上下文会发给已配置的模型，增加输入 token，可能影响响应时间；不更改 Key、模型或提供商。Google Translate v2/v3 不使用这套提示词增强。
- 具体术语在 `translation-context.js` 的 `f1Prompt()` 中编辑，设置页目前不能编辑术语文本。也可参考这个函数添加其他领域的模式，不要把赛车含义硬套到普通对话。

更新后需在 `chrome://extensions` 重新加载扩展并刷新视频页。增强效果仍需实播评估，不能保证修复英文 CC 的听写错误或实现零延迟。

本分支不包含本机其他字幕解析实验或 DeepSeek 专用请求参数改动。使用自定义 API 时仍需确认地址、权限及模型参数符合所选服务要求。

运行回归测试（无需真实 API Key 或网络）：

```sh
node tests/content.test.cjs
node tests/subtitle-reader.test.cjs
node tests/translation-context.test.cjs
node tests/background-context.test.cjs
```

## 工作原理

1. 内容脚本 (`content.js`) 注入到播放页面，轮询平台字幕 DOM；Apple TV 优先读取用户已开启的原生 TextTrack 字幕。
2. 每次字幕文本变化，脚本把原文通过 `chrome.runtime.sendMessage` 发给 Service Worker。
3. Service Worker (`background.js`) 调用你配置好的 LLM（Gemini / OpenAI / Anthropic / 自定义 OpenAI 兼容 endpoint）返回翻译。
4. 脚本把翻译后的文字叠在视频底部，并可选同时显示原文。
5. 本地缓存 + 上下文窗口：同一字幕在相同上下文下可复用译文；普通模式可使用最近译文，F1 模式使用按视频时间排序的原文。

## 安装（加载为未打包扩展）

1. 打开 `chrome://extensions`
2. 右上角开启 **开发者模式 / Developer mode**
3. 点「加载已解压的扩展程序 / Load unpacked」，选择本目录 (`subtitle-translator/`)
4. 点扩展图标 → 打开「完整设置」
5. 选择 provider、填入 API Key、选目标语言
6. 点「测试连接」确认能返回翻译
7. 打开 Netflix / Disney+ 等，**先在平台里把原文字幕（例如英文）打开**，扩展就会自动接管

### Apple TV

支持影视播放页、`/sporting-event/` 体育回放页，以及从频道页弹窗打开的直播。频道页仅在播放弹窗打开时启用翻译，不翻译普通预览视频。先在播放器字幕菜单中选择原文语言（例如 English CC）；扩展不会自动打开或切换字幕轨道。

Apple TV 的原生字幕和字幕菜单会保留，插件只补充译文，不重复显示同一份原文。译文挂载在播放器的模态弹窗内部，避免被浏览器顶层遮挡。若播放器没有暴露可读取的原生 cue 或字幕 DOM，本扩展无法从画面中识别字幕，也不解密媒体。

播放时最多提前翻译未来约 30 秒内已加载的字幕；预翻译与当前字幕共用请求和缓存，失败后等待重试，避免整片字幕一次性调用 API。

### 开发测试

使用 Node.js 18+ 运行无需 API Key、网络或额外依赖的回归测试：

```sh
node --test tests/*.test.cjs
```

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
