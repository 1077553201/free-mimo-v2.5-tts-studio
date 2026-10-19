# 接口契约

只写接口层的事实：地址、请求体、响应、错误。CLI 参数见 `SKILL.md` 与 `--help`；词表见 `presets.md`。

## 端点

```
POST {base_url}/chat/completions
Authorization: Bearer <API_KEY>
Content-Type: application/json
```

默认 `base_url = https://api.xiaomimimo.com/v1`。`normalize_base()` 会去掉尾部 `/`、去掉误填的 `/chat/completions`，**不会**自动补 `/v1`。

浏览器直连时上游只放行 `authorization` 与 `content-type` 两个请求头（`Access-Control-Allow-Origin: *`），不能加自定义头。脚本走服务端，不受此限。

## 请求体

```json
{
  "model": "mimo-v2.5-tts",
  "messages": [
    { "role": "user", "content": "风格指令（可选）" },
    { "role": "assistant", "content": "要合成文本" }
  ],
  "audio": { "format": "pcm16", "voice": "冰糖" },
  "stream": true
}
```

- `messages` 顺序固定：`user` 在前、`assistant` 在后。**待合成文本永远放 `assistant`**。
- `audio.format`：`pcm16`（流式）或 `wav`（非流式）。
- `stream` 只在流式时出现，值必须是 `true`；非流式**完全不传**该字段。
- `audio.voice`：预置模型是音色 id（如 `冰糖`）；复刻模型是 `data:audio/...;base64,...`；设计模型不带。

### 三种模型的差异

| | `mimo-v2.5-tts` | `mimo-v2.5-tts-voicedesign` | `mimo-v2.5-tts-voiceclone` |
|---|---|---|---|
| user 语义 | 风格指令（可选） | **音色描述（必填）** | 风格指令（可选） |
| assistant | 必填 | 可空（需 optimize） | 必填 |
| `audio.format` | `pcm16` | `wav` | `wav` |
| `stream` | `true` | 不传 | 不传 |
| `audio.voice` | 音色 id | 不传 | data URL |
| 额外字段 | — | `optimize_text_preview` | — |
| 能力 | 唱歌 / 标签 / 流式 | 文本造音色 / 润色文本 | 样本复刻 / 标签 |

`optimize_text_preview` 仅设计模型使用，**`false` 也要显式下发**。为真时可以不给 assistant，模型自己生成播报文本（从 `message.content` 或 `delta.content` 取回）。

## 响应

### 流式（`stream: true`）

`text/event-stream`，逐帧 `data: {...}`，以 `[DONE]` 结束。

音频在 `choices[0].delta.audio.data`，base64 编码的**裸 PCM16LE**，没有 WAV 头；文本在 `choices[0].delta.content`。

解析要点：
- 按空行分帧，兼容 `\n\n` 与 `\r\n\r\n`。
- `delta.audio` 可能是对象 `{data: "..."}` 也可能是字符串，两种都接受。
- **每块解码后长度不保证偶数**，多出的 1 字节必须留到下一块；直接 join 会让后续所有样本错位半个采样，听起来是噪声。

### 非流式

单个 JSON，音频在 `choices[0].message.audio.data`（base64 的完整 WAV），文本在 `choices[0].message.content`。

WAV 不一定是 44 字节头：可能带 `LIST` / `JUNK`，可能有多个 `data`，奇数长度的 chunk 后面还有 1 字节对齐。解析要遍历 RIFF chunk，不能写死偏移。

## 音频规格

采样率 24000Hz、单声道、16bit 有符号小端。WAV 头 44 字节：

| 偏移 | 长度 | 值 |
|---|---|---|
| 0 | 4 | `RIFF` |
| 4 | 4 | 36 + PCM 字节数 |
| 8 | 4 | `WAVE` |
| 12 | 4 | `fmt ` |
| 16 | 4 | 16 |
| 20 | 2 | 1（PCM） |
| 22 | 2 | 1（单声道） |
| 24 | 4 | 24000 |
| 28 | 4 | 48000（byteRate） |
| 32 | 2 | 2（blockAlign） |
| 34 | 2 | 16（位深） |
| 36 | 4 | `data` |
| 40 | 4 | PCM 字节数 |

时长 = PCM 字节数 ÷ 2 ÷ 24000。

## 错误

| 状态 | kind | 可重试 | 提示 |
|---|---|---|---|
| 401 | `auth` | 否 | Key 无效或过期 |
| 403 | `auth` | 否 | 没有该模型权限 |
| 404 | `upstream` | 否 | 地址不对，检查是否到 `/v1` |
| 429 | `rate_limit` | 是 | 限流，按 `Retry-After` 退避 |
| 413 | `payload` | 否 | 请求体太大，样本建议 ≤7MB |
| 5xx | `upstream` | 是 | 上游异常，指数退避 |
| 网络/超时 | `network` | 是 | 检查网络与 Base URL |
| WAV 解析失败 | `audio` | 否 | 上游返回格式异常 |

错误体解析顺序：`error`（字符串）→ `error.message` → `message` → `detail`。

## 样本上限

`audio.voice` 的 data URL 会让请求体膨胀约 4/3。原始样本限制 **7MB**（base64 后约 9.3MB），上限是请求体 10MB。

## 参数速查

```
synth | plan | voices | presets | tags

--text TEXT            可重复；@file 读文件，@- 读 stdin，@@ 转义
--model ID             默认 mimo-v2.5-tts
--voice NAME           预置音色 id 或名称，默认 mimo_default
--voice-desc TEXT      设计模型必填
--voice-sample PATH    复刻模型必填
--preset NAME          取 12 条风格预设之一（与 --instruction 互斥）
--instruction TEXT     自定义风格指令
--opening-tag TAG      可重复或逗号分隔；与 --singing 互斥
--singing              唱歌模式
--optimize-preview / --no-optimize-preview   仅设计模型
--max-chars N          默认 400
--no-split             不自动切分
--concurrency N        默认 3（设计模型强制 1）
--gap-ms N             段间静音
--out PATH             输出 wav
--timeout SEC          默认 180
--retries N            默认 2
--env-file PATH / --base-url URL
--dry-run              等价 plan
--quiet / --compact
```
