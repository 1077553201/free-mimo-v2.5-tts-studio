# MiMo TTS Studio

本地运行的小米 MiMo-V2.5-TTS 全功能演示台：三个模型、全部能力都做成可点击的控件，界面是柔光玻璃 / 毛玻璃双主题。

- 预置音色 `mimo-v2.5-tts`：9 张音色卡 + 一键试听、自然语言风格指令、导演模式、开场风格标签、行内音频标签、唱歌模式、低延迟流式边收边播
- 音色设计 `mimo-v2.5-tts-voicedesign`：点击维度 chip 拼描述、4 个成品模板、`optimize_text_preview` 智能润色
- 音色复刻 `mimo-v2.5-tts-voiceclone`：拖拽上传 / 麦克风录音（30 秒，ffmpeg 转 mp3）、多份样本库可试听切换

## 快速开始

```bash
# Windows 双击 run.bat 即可（首次会自动建 venv 装依赖）
run.bat

# 或者手动
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
.venv\Scripts\python.exe run.py
```

会打印 `http://127.0.0.1:8000` 并自动打开浏览器（端口被占会自动往后找）。

### 填 API Key

两种方式，任选：

1. 页面右上角齿轮 → 粘贴 Key → 「保存并测试」。Key 存在浏览器 localStorage，请求时通过 `X-API-Key` 头传给本地后端。
2. 复制 `.env.example` 为 `.env`，填 `MIMO_API_KEY=sk-...`（勾选「同时写入本机 .env」也会自动帮你写）。

Key 只在本机流动：浏览器 → 本地 FastAPI → 小米接口，不经任何第三方。日志里只记模型名、字数、耗时，不记 Key 和请求体。

## 先跑一次冒烟测试（建议）

界面能开起来不代表接口通，尤其是音色复刻的样本字段位置文档没写明。建议先用真实 Key 跑：

```bash
set MIMO_API_KEY=sk-xxx
.venv\Scripts\python.exe scripts\smoke_test.py --sample D:\your\voice.mp3
```

它会依次验证：非流式 wav、流式 pcm16（记录首包耗时）、音色设计（带/不带文本）、音色复刻（自动尝试 `audio.voice` 等字段），结果落在 `data/smoke/`，可以直接播放听。

## 目录

```
app.py                  FastAPI 路由、SSE 转发、样本管理、清理任务
mimo_client.py          payload 组装、上游请求、SSE 解析、错误翻译
audio_util.py           PCM→WAV（含跨块奇数字节处理）、ffmpeg 转码、原子落盘
config.py               音色表、标签词库、能力表、示例文本（前端也从这里取）
run.py                  启动器：找空闲端口 + 开浏览器
static/
  index.html            单页结构，三页签共用一套骨架
  style.css             柔光玻璃双主题（CSS 变量）
  ui-state.js           单一状态源 + 派生（最终 assistant/user 内容）
  audio.js              流式 PCM 无缝排播 + 频谱可视化
  app.js                控件绑定、请求编排、播放器、历史
data/
  outputs/              合成结果（2 小时后自动清理）
  uploads/              复刻样本
  cache/                音色试听缓存
scripts/smoke_test.py   三模型冒烟测试
```

接上后端：`app.py` 里 `/api/tts`（整段）与 `/api/tts/stream`（流式）分开，payload 统一由 `mimo_client.build_payload()` 生成，前端不自己拼请求体。

## 几个关键实现点

**流式不能先包 StreamingResponse**：必须先 `send(stream=True)` 拿到状态码，401/429 才能变成正常的 HTTP 错误，否则前端只会看到「一直转圈然后断开」。

**PCM 落盘要处理奇数字节**：base64 解码后每块长度不保证偶数，多出来的 1 字节必须留到下一块拼接，否则整段音频错位、听起来像爆音。前端 `audio.js` 和后端 `audio_util.PcmWavWriter` 两侧都做了 carry。

**采样率不要手动重采样**：`ctx.createBuffer(1, n, 24000)` 声明源采样率，浏览器会自己重采样到设备采样率。

**AudioContext 必须在点击的同步栈里 resume**，`await` 之后再 resume 会丢掉用户手势，Safari 直接静音。

**标签只是文本约定**：开场风格 `(温柔 磁性)`、行内 `（叹气）`、唱歌 `(唱歌)` 都拼在 `assistant` 内容里，后端零特殊分支。UI 负责把它们做成 chip，并把最终文本高亮回显。

## 常见问题

**录音按钮是灰的**：本机没检测到 `ffmpeg`。浏览器 MediaRecorder 只能产出 webm/ogg，而接口只收 mp3/wav，必须转码。装一个 ffmpeg 后重启即可；不装也能正常上传 mp3/wav。

**麦克风拿不到权限**：`getUserMedia` 只在 secure context 可用。`http://127.0.0.1` 和 `localhost` 算，局域网 IP（`http://192.168.x.x`）不算，所以服务只绑 `127.0.0.1`。

**流式开关是灰的**：只有 `mimo-v2.5-tts` 支持真低延迟流式；音色设计与音色复刻的流式是兼容模式（推理完一次性返回），所以直接走整段播放更合理。

**历史里的音频点了没声**：输出文件 2 小时后会被清理，历史记录会失效，重新生成即可。

**`(唱歌)` 不生效**：唱歌只有预置音色模型支持，且标签必须在文本最开头；页面上的唱歌开关会自动处理位置，手动输入时注意不要在前面加空格。

## 说明

- 模型能力与参数以官方文档为准：<https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/audio/speech-synthesis-v2.5>
- 当前限时免费，用量见控制台账单。
