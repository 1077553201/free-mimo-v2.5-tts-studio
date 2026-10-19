# MiMo TTS Studio · 纯静态版

小米 MiMo-V2.5-TTS 的纯前端演示台：**没有后端**，浏览器直接调用你填的接口。打开网页 → 填自己的接口地址和 Key → 直接用，所有数据只留在你自己的浏览器里。

- 预置音色 `mimo-v2.5-tts`：9 张音色卡 + 试听（可停止）、风格指令、导演模式、开场风格标签、行内音频标签、唱歌模式、低延迟流式边收边播
- 音色设计 `mimo-v2.5-tts-voicedesign`：点维度 chip 拼描述、成品模板、`optimize_text_preview` 智能润色
- 音色复刻 `mimo-v2.5-tts-voiceclone`：拖拽上传 / 麦克风录音（浏览器内转 WAV，不需要 ffmpeg）、多份样本库
- 历史记录：存在本机 IndexedDB，含完整参数与音频，点一条即可复原当时的界面

> 这个分支**去掉了实时对话页**。本地 SenseVoice 识别需要 Python 和 65MB 模型，浏览器跑不了；去掉它之后整个站点就是纯静态的，可以免费托管。

## 为什么能纯静态

MiMo 的接口允许跨域，实测两个节点都返回：

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Headers: authorization, content-type
```

所以浏览器可以直接 POST 到 `${你的接口地址}/chat/completions`，带上 `Authorization: Bearer <你的 Key>`，中间不需要任何服务器转发。

## 快速开始

用任意静态服务器打开即可：

```bash
python -m http.server 8000
# 然后打开 http://127.0.0.1:8000
```

首次打开点右上角齿轮，填：

- **接口地址**：默认 `https://api.xiaomimimo.com/v1`，也可以填 Token Plan 节点
- **API Key**：你自己的 Key

点「保存并测试」会发一次极短的试合成，成功才算配置完成。两项都只存在浏览器的 localStorage 里。

## 部署到 Cloudflare Pages

**推荐用 Git 集成**：在 Cloudflare Dashboard 里连接这个仓库，构建命令留空，输出目录填 `/`。这样只会部署仓库里提交过的文件，不会带上本地私货。

如果你用命令行直接上传：

```bash
npx wrangler pages deploy . --project-name mimo-tts-studio
```

⚠️ 它会把**整个目录**上传。本机如果还留着 `main` 分支的开发产物（`.env`、`models/`、`data/`、`.venv/`），一定先移走或换个干净目录再传——`.env` 里可能有你的 Key。

纯静态资源，不需要 Functions、不需要 D1/R2，免费额度足够。

## 数据存在哪

| 内容 | 位置 |
|---|---|
| 接口地址 | 浏览器 localStorage（`mimo.state`） |
| API Key | 浏览器 localStorage（`mimo.key`） |
| 音色 / 文本 / 风格 / 标签等界面状态 | localStorage（`mimo.state`） |
| 合成历史（含音频与参数） | IndexedDB `mimo-studio` / `records`，最多 60 条 |
| 音色复刻样本 | IndexedDB `mimo-studio` / `samples` |
| 音色试听缓存 | IndexedDB `mimo-studio` / `cache`，24 小时 |

**没有任何数据会离开你的浏览器**（除了发给你自己填的那个接口）。

代价是：清理浏览器数据 / 换浏览器 / 换电脑，记录就没了。重要的话点历史里的 ⬇ 把音频下载下来。

## 目录

```
index.html            单页结构，三个页签
static/
  ui-config.js        模型表、音色、标签词库、示例文本（想改词表改这里）
  ui-state.js         单一状态源 + 最终文本派生
  store.js            IndexedDB：历史 / 样本 / 缓存
  api.js              直连上游：payload 组装、流式 PCM、PCM→WAV、录音转 WAV
  audio.js            流式 PCM 无缝排播 + 频谱可视化
  style.css           柔光玻璃双主题
  app.js              控件绑定、请求编排、播放器、历史
```

## 几个实现要点

**流式播放**：请求 `audio.format: "pcm16"` + `stream: true`，逐块把 base64 解码成 PCM 交给 Web Audio 排播；同时在本地把 PCM 拼成 WAV，生成结束就能下载。

**录音转 WAV**：以前靠后端 ffmpeg 把 webm 转 mp3，现在用 `decodeAudioData` 解码后自己写 WAV 头，少一个依赖。

**音色复刻的样本**：以 `data:audio/wav;base64,...` 的形式放进 `audio.voice`，从 IndexedDB 现取，不常驻内存。

**标签约定**：圆括号 `()` 是风格前缀（放在最开头），方括号 `[]` 是行内情绪（任意位置）。唱歌模式会强制 `(唱歌)` 顶到第 0 个字符并去掉所有行内标签。

## 已知限制

- 页面应该是 `https://`（或 localhost），否则会受混合内容限制；
- 你填的接口必须允许跨域，否则浏览器会拦（报错会说「不允许浏览器直连」）；
- 预检只放行 `authorization` 和 `content-type`，所以不能用自定义请求头，只能走标准 `Authorization`；
- 清浏览器数据会丢失历史与样本；
- Key 是本机明文存储，公用电脑上注意清除。

## 附带技能：mimo-tts

`skills/mimo-tts/` 是一个 Agent Skill，把上面的接口契约固化成可复用的命令：三个模型都支持，多段文字按原顺序合成并拼成一个 WAV，长文本自动按句切分。

```bash
# 先看不花配额的预演
python skills/mimo-tts/scripts/mimo_tts.py plan --text "第一段。" --text @第二段.txt --voice 冰糖

# 分段合成并拼接
python skills/mimo-tts/scripts/mimo_tts.py synth --text "第一段。" --text "第二段。" --out out.wav
```

用法与参数见 `skills/mimo-tts/SKILL.md`，接口细节见 `skills/mimo-tts/references/api.md`。
这个目录只在 `skill/mimo-tts` 分支维护，不随站点发布。

## 分支说明

本仓库以 `pages` 为唯一在用的分支（默认分支）。

原来的 `main` 已经归档成 `archive/python-backend`：那是带 FastAPI 后端、本地 SenseVoice 实时对话、SQLite 记录、记忆文件和 ffmpeg 转码的完整本地版。只读参考，不再维护。
