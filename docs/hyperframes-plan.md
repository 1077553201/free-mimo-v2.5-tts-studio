# HyperFrames 接入可行性评估（实时对话页）

调研时间：2026-10-17 · 仓库：<https://github.com/heygen-com/hyperframes> · 许可：Apache 2.0

## 一、它到底是什么

HeyGen 开源的 **HTML → 视频** 框架，口号是 "Write HTML. Render video. Built for agents."

- **创作层**：一个 composition 就是一个 `index.html`，元素用 `data-start` / `data-duration` / `data-track-index` 标注时间线；动画可以用 CSS、GSAP、WAAPI、Lottie、Anime.js、Three.js。
- **渲染层**：CLI/Producer 用无头 Chrome 逐帧 seek 截图，FFmpeg 编码成 **确定性 MP4**。这是离线管线，不是实时。
- **播放层**：`@hyperframes/player` 提供 `<hyperframes-player>` Web Component，在浏览器里**实时播放** composition（iframe + Shadow DOM + postMessage），有 `play/pause/seek`、`timeupdate`、`ready`、`scenes` 等事件。

关键判断：**HyperFrames 不是语音/口型/实时音频引擎**，它的"实时"只体现在「浏览器里按时间线播放 HTML」。真正让对话页"互动起来"的，仍然是我们自己的事件流（ASR 结果、LLM 分句、播放进度）。

## 二、能力边界

| 能做 | 不能做 |
|---|---|
| 在网页里播放带时间线的 HTML 动效（转场、图表、字幕动画、shader） | 生成语音 / 口型 / 数字人 |
| 用 `srcdoc` 注入一段动态 HTML 立刻播放（无需渲染管线） | 毫秒级"事件 → 任意动效"的通用响应（它是时间线播放器，不是粒子引擎） |
| 导出确定性 MP4（回顾视频、分享） | 直接替代我们现有的字幕 DOM（对纯字幕是过度设计） |
| 通过 `seek` / `range-start` 定位到某个片段 | 无构建直接跑？可以走 CDN ESM，但要接受外部依赖 |

## 三、三种接入方案

### 方案 A：预置场景 + `srcdoc` 注入（推荐先做）

把对话状态映射到 3–5 个**预置 composition**，用 `srcdoc` 把当前文本/数值填进模板，切换时播放：

| 场景 | 触发 | 视觉 |
|---|---|---|
| `listening` | 按下麦克风 | 声波环 + 呼吸光晕 |
| `thinking` | ASR 完成、等首字 | 三点流动 + 微光扫描 |
| `speaking` | 首句音频开始 | 逐句字幕卡 + 底部声波条 |
| `card` | LLM 输出含数字/列表 | 卡片式数据动效（滑入 + 高亮） |
| `error` | 请求失败 | 抖动 + 红色描边 |

- 依赖：CDN 引入 `@hyperframes/player`（零构建），失败自动回退到现有 CSS 字幕。
- 延迟：换 `srcdoc` 到首帧约 1 帧 + iframe 初始化（实测需验证，预估 30–80ms）。
- 成本：约 1–2 天（含 3 个 template + 事件总线 + 回退）。

### 方案 B：LLM 现场生成 composition（对标 LiveAvatar demo）

说"给我画个温度曲线"，让模型直接写一段 composition HTML，`srcdoc` 播放。

- 官方 demo 用 Claude Code 生成，耗时 **30 秒–2 分钟**，不适合对话节奏；若改用我们的流式 LLM + 强约束模板（只填数据、不写样式），可以压到 1–3 秒。
- 风险：模型生成的 HTML 要跑在 iframe sandbox 里（`allow-scripts` 但禁 `allow-same-origin`），否则 XSS。
- 这是"能玩但脆弱"的方案，建议 P2。

### 方案 C：对话回顾导出 MP4（离线）

一轮对话结束，把 transcript + 每句时长交给 Producer，渲染一段带字幕的 30 秒回顾视频。

- 完全离线，不影响实时链路。
- 用途：分享、留档、做 demo 素材。
- 成本：约 0.5–1 天（compositions 模板 + CLI 调用 + 进度轮询）。

## 四、和现有实现的冲突点

1. **零构建 vs npm 依赖**：项目现在是纯静态，CDN 引入可以绕过，但会多一个外部依赖；内网/离线场景需要把 player 的 ESM 文件 vendor 到 `static/vendor/`。
2. **字幕已经有更好实现**：现有字幕是 DOM + 播放时间轴高亮，字号/可访问性/双语都更好改。HyperFrames 适合做**动效层**，不适合替换字幕层。
3. **音频驱动**：HF 不读音频，字幕与口型的同步仍要靠我们的 `AudioEngine.state().position`。

## 五、落地计划（若要做）

**P0（1 天）可行性验证**
1. `static/proto/hyperframes.html`：CDN 引入 player，`srcdoc` 注入一个含 `${text}` 的字幕卡，量首帧时间。
2. 在对话页加 `?hf=1` 开关，A/B 对比现有字幕的观感与性能。
3. 结论门槛：首帧 < 100ms、CPU 影响 < 5%、无 console 报错。

**P1（1–2 天）场景化**
1. 抽 `talk-events.js`：`onListenStart / onAsr / onFirstToken / onSentence / onTurnEnd`。
2. 写 3 个 composition 模板（listening / thinking / speaking），共享一套 CSS 变量，跟随主题。
3. `srcdoc` 注入 + 切换节流（最短 400ms，避免闪烁）。
4. 无 CDN 时回退到现有 DOM 字幕。

**P2（2–3 天）互动卡片**
1. 检测 LLM 输出里的结构化片段（数字、列表、对比）。
2. 走"模板填充"而非自由生成：固定 4–6 个卡片模板，模型只输出 JSON 数据。
3. 卡片与语音同步：句子开始播报时滑入，播完滑出。

**P3（1 天）回顾导出**
1. `scripts/render_replay.py`：把一轮对话（含每句时长）写进 composition，调 Producer 输出 MP4。

## 六、风险清单

| 风险 | 影响 | 应对 |
|---|---|---|
| Player 版本迭代快（0.8.x） | API 变动 | 锁定版本 + vendor 本地 |
| iframe 沙箱与 Blob/`srcdoc` 限制 | 动态内容加载失败 | 用 `srcdoc` 内联，不依赖外部资源 |
| 动效抢戏剧本 | 字幕可读性下降 | 动效只在边缘/背景，正文保持 DOM |
| 生成式场景不稳定 | 输出不可控 | 只允许模板填充，禁止自由 HTML |
| 增加包体 | 首屏变慢 | 懒加载 player，仅对话页需要时加载 |

## 七、结论

- **能做"实时互动"**，但定位要说清：HyperFrames 提供的是**时间线上的动效层**，不是语音驱动的实时合成。
- **最划算的切入点是方案 A**：3 个预置场景 + `srcdoc` 注入，1 天能看到效果，失败可无痛回退。
- **不建议**用它替换现有字幕；也不建议一上来就做"LLM 现场写动效"。
- 想要"会说话的数字人"，HyperFrames 帮不上，那是 LiveAvatar（付费 API）或本地口型模型（MuseTalk / Wav2Lip / NanoAvatar，需要 GPU）的活；HF 可以做数字人**旁边**的信息层——这也是官方 demo 的做法。
