# LLM Subtitle Translator

用 **Gemini / OpenAI / Claude** 的 API 实时翻译 **Netflix、Disney+、Prime Video、YouTube、HBO Max、Apple TV+** 等流媒体的内置字幕。

## 工作原理

1. 内容脚本 (`content.js`) 读取已开启的原生 TextTrack 字幕，并轮询经过菜单/覆盖层过滤的平台字幕 DOM。
2. 每次字幕文本变化，脚本把原文通过 `chrome.runtime.sendMessage` 发给 Service Worker。
3. Service Worker (`background.js`) 调用你配置好的 LLM（Gemini / OpenAI / Anthropic / 自定义 OpenAI 兼容 endpoint）返回翻译。
4. 脚本把翻译后的文字叠在视频底部，并可选同时显示原文。
5. 本地缓存 + 最近上下文窗口：重复的同一条字幕不会重复消费 token；最近几行翻译会作为上下文传给模型，保持称谓、语气连贯。

## Apple TV 实验补丁（本地 1.2.3）

- `subtitle-reader.js` 读取当前选中的原生字幕轨道，保留 Apple TV 的字幕菜单和英文字幕，不强制切换轨道。
- `subtitle-parser.js` 解析完整的明文 fMP4 初始化段及 `wvtt` / `stpp` 字幕分片。不会解密 DRM 媒体，也不处理视频中的 CEA-608/708、图像字幕或 OCR。
- `inject.js` 在 `document_start` 被动观察 fetch、XHR（含 ArrayBuffer/Blob）和 SourceBuffer。只读取已有响应，不额外下载媒体。MSE 时间加上播放器的 `timestampOffset`；无法确认时间映射的网络字幕只用于预热缓存。
- 只提前翻译播放位置之后约 30 秒的字幕；重复原文共用请求，失败后等待重试，停用扩展后不发起新的翻译请求。
- 首次安装补丁后，在 `chrome://extensions` 重新加载扩展，确认版本 **1.2.3**，再刷新 Apple TV 页面，打开 **English CC**。开发者控制台应出现 `build 2026-09-24.1-runtime-invalidated`。**重载扩展后必须刷新播放页**，否则标签页里跑的还是旧脚本。
- 频道页直播根据播放弹窗的打开/关闭状态启停翻译，不要求页面地址变化，也不翻译频道预览。
- 中文覆盖层是浏览器**顶层（top layer）**的 popover，因此不会被 `dialog.showModal()` 的播放弹窗遮住，也不会在全屏时消失。
- 只重载扩展、不刷新页面时，旧脚本的 `chrome.runtime` 连接已失效，控制台会只提示一次「扩展上下文已失效…请刷新页面 (F5)」，并停止继续翻译 —— 不再按每条字幕刷屏报错（那种报错看起来像翻译坏了，其实只是页面没刷新）。
- Apple TV 已显示原生英文 CC 时，插件不再叠加第二份英文，只在下方补充中文。
- 开头的诊断日志会列出每条轨道的语言、mode、cues、active 及捕获数量，便于区别“未读取到字幕”和“已读取但翻译失败”。日志不打印 API Key。

这是兼容性实验：单元测试不等于所有 Apple TV 节目都可用。如果播放器不暴露原生 cue，且没有可读取的明文字幕分片，仍然无法产生翻译。解析器要求完整 MP4 box，不重组任意网络字节块，也不猜测 edit list / period 的时间偏移。

本地回归测试（无网络、无 API 费用）：

```sh
node --test tests/*.test.cjs
```

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

API key 保存在 `chrome.storage.sync`，开启 Chrome 同步时可能随浏览器账户同步。翻译请求从浏览器发往你配置的 LLM 提供商；本补丁不修改 Key 或提供商配置。

## 全屏时翻译字幕消失的修复（build 2026-09-23.8-fullscreen-top-layer）

**症状**：点击播放器全屏后，翻译字幕完全不再显示；一退出全屏立刻又出现。

**原因**：浏览器在全屏时只绘制「全屏元素」这棵子树，加上顶层（top layer）里的内容。旧实现把覆盖层搬进全屏元素里，但这条路走不通：

- 全屏元素可能就是这个 `<video>` 本身，而 `<video>` 是替换元素，它的子节点永远不会被渲染；
- `<dialog>` 根本不允许成为全屏元素（`requestFullscreen()` 会报 `Dialog elements are invalid`）；
- 旧代码优先把覆盖层放进 `dialog.showModal()` 打开的播放弹窗，而全屏元素是弹窗**内部**的视频或容器 —— 于是覆盖层待在全屏子树之外，全屏期间完全不绘制，退出全屏后立刻恢复。

**修复**：覆盖层改为 `popover="manual"`，由浏览器放进顶层。顶层元素只要是在全屏元素**之后**加入顶层的，就画在全屏元素之上，所以：

- 覆盖层的 DOM 父节点固定在 `<html>`，不再随全屏/弹窗搬来搬去；
- 每次 `fullscreenchange`、以及播放弹窗出现/消失时，都 `hidePopover()` + `showPopover()` 重新入栈，确保它排在全屏元素之上（只显示隐藏一次，同一帧内完成，不会闪烁）；
- `content.css` 复位了 popover 的 UA 默认样式（不透明背景、边框、内边距、`margin: auto`）；
- 若浏览器不支持 Popover API，则退回旧策略，并**优先选择全屏元素**而不是播放弹窗。

**已在真实 Chrome 中验证**（四种播放器结构 × 全屏前 / 全屏中 / 退出后，按截图像素差判定是否真的绘制）：

| 播放器结构 | 全屏元素 | 修复前 | 修复后 |
|---|---|---|---|
| 裸 `<video>` | `<video>` | 全屏中**不绘制** | 正常 |
| `<div>` 包住 video | `<div>` | 全屏中**不绘制** | 正常 |
| dialog + video | `<video>` | 全屏中**不绘制** | 正常 |
| dialog + div + video | `<div>` | 全屏中**不绘制** | 正常 |

`node --test tests/*.test.cjs` 的单元测试跑在无浏览器环境里，无法覆盖全屏与顶层，因此这个 bug 曾经躲过测试；上面的验证是在真实 Chrome 里用 CDP 截图做的。

## F1 直播延迟优化（build 2026-09-05.7-f1-live-queue）


- 在 F1 自动识别或强制模式下，对至少三个空格分隔词的原文前缀识别追加。原生 cue 还必须保持相同开始时间；仅 DOM 字幕使用保守前缀判断，最多连续保留 8 秒。
- 同句追加时保留已有中文，允许仍属于当前句的迟到片段补上中文；更完整的译文不会被后返回的旧片段覆盖。换句、修改已有词、字幕间隙和停用时不沿用前句中文。
- 滚动补词采用 120ms 短窗口合并；持续更新达到约 400ms 会提交最新快照，不要求字幕先停止变化。达到并发上限时仍需排队。
- 每个 frame 最多两个翻译请求同时执行；F1 预翻译最多占一个位置，当前字幕优先，已过时且尚未发出的实时字幕被淘汰。已经发到提供商的请求仍可能计费，不承诺能撤回。
- 所有后端网络请求增加 12 秒超时（包括响应体读取），避免网络请求永久占位。超时不会加快模型本身；Google v3 的 OAuth 与翻译分别计时。
- 设置 → 调试日志：`request dispatched` 中 `queuedMs` 是排队耗时，`translated in ...ms` 是发送到响应耗时；累计 `superseded` 表示未发出的过时请求，`late` 表示已译完但当前句不再适用或已有更新版本，`failed` 表示失败，`displayed` 表示显示成功。
- 应用更新：在 `chrome://extensions` 重新加载扩展，再刷新直播页；控制台启动横幅应包含上述 build。无需更改 API Key 或模型。若自动未识别 F1，可在设置中强制开启。

测试不包含真实直播或收费 API 性能测试，不能保证平台英文 CC 延迟或提供商响应时间。

## 已知限制

### 本地实验：F1 翻译增强

设置 → 翻译行为 → F1 翻译增强，默认根据页面标题或 Formula 1 频道地址自动启用；也可强制开启或关闭。
加入赛车术语和默认前 4 条原文上下文（可设 0–8 条，最多 1200 字符），按视频时间排序，不把 API 返回顺序当成字幕顺序。
原生字幕取当前句之前已结束的 cue；仅有 DOM 字幕时使用已观察到的原文。无上下文时直接翻译，不等待完整句子；同句滚动补词会使用短暂的 120ms 合并窗口。
上下文与术语会发送给已有的模型提供商，增加输入 token，可能影响响应时间；不更改 API Key、模型或提供商。
仅支持提示词型 LLM 后端，不适用于 Google Translate v2/v3。不能保证修正英文 CC 本身的听写错误，也不保证每句即时完成。

- 无法读取的原生字幕、加密字幕或图像字幕不会自动变成可翻译的文本；Apple TV 原生字幕始终保留。
- 各平台的播放器实现可能变化，Apple TV 需实播验证，不能仅凭出现字幕按钮就认为已经读取到 cue。
- 翻译仍有模型和网络延迟，预翻译可降低等待，但不保证每句即时完成。
