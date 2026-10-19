---
name: mimo-tts
description: 调用小米 MiMo 语音合成接口，把一段或多段文字合成为 WAV 音频，并按原顺序拼接成一个长音频文件。覆盖预置音色、文本描述生成音色、音色复刻三种模式，支持风格指令、开场标签、行内情绪标签与唱歌。当用户要求文字转语音、配音、旁白、朗读、批量合成、把多段稿子拼成一条音频时使用。触发词：语音合成、文字转语音、TTS、配音、旁白、朗读、生成音频、音色设计、音色复刻、多段拼接、MiMo。
version: 1.0.0
display_name_zh: MiMo 语音合成
agent_created: true
---

# MiMo 语音合成

把文字合成为 24kHz 单声道 16bit 的 WAV。多段文字按传入顺序逐段合成，再拼成一个文件。
所有请求经 `scripts/mimo_tts.py` 发出，**不要手写 curl，也不要在回复里粘贴 base64 音频**。

## 何时使用

- 用户给出文本，要求读出来、配音、做旁白、生成音频文件。
- 用户指定音色、风格、情绪、唱歌，或用一段文字描述想要的声音。
- 用户给了多段稿子，要合成成一条连贯的音频。

## 何时不用

- 语音识别、实时对话、音乐生成 —— 不属于本 skill。
- 需要视频或图片 —— 交给对应的多模态能力。

## 先 plan，再 synth

`plan` 不联网、不需要 Key、不花配额，用来确认切分和请求体对不对。**改完参数先跑 plan**。

```bash
python "D:/xiangmu/tts/skills/mimo-tts/scripts/mimo_tts.py" plan \
  --text "第一段。" --text @D:/稿子/第二段.txt --voice 冰糖
```

`plan` 会输出每个分块的 `payload`，可以直接检查 role、`audio.format`、`stream` 是否符合预期。

> 脚本当前**只存在于仓库**，未安装到 `~/.workbuddy/skills`，所以用仓库绝对路径调用。
> 若之后复制到技能目录，把路径换成 `${CODEBUDDY_SKILL_DIR}/scripts/mimo_tts.py`（Bash 的 cwd 是 workspace 根，不能用相对路径）。

## 合成一段

```bash
python "D:/xiangmu/tts/skills/mimo-tts/scripts/mimo_tts.py" synth \
  --text "你好，这是 MiMo 的合成测试。" \
  --voice 冰糖 \
  --out "D:/输出/hello.wav"
```

`--voice` 默认 `mimo_default`。`--out` 省略时会写到当前目录 `mimo-tts-<时间戳>.wav`。

## 多段文字按原顺序拼接

`--text` 可以重复，**参数顺序就是拼接顺序**；`@文件路径` 读整个文件当作一段，`@-` 读 stdin，`@@x` 表示字面量 `@x`。

```bash
python "D:/xiangmu/tts/skills/mimo-tts/scripts/mimo_tts.py" synth \
  --text "第一段，开场。" \
  --text @D:/稿子/body.txt \
  --text "最后一段，收尾。" \
  --voice 茉莉 \
  --out "D:/输出/full.wav"
```

- 单段太长会自动按句切分（默认 400 字/块），逐块请求，最后只写一个 WAV 头。
- 并发默认 3，**结果严格按原始顺序拼接**，与请求完成的先后无关。
- `--no-split` 关闭自动切分；`--max-chars` 调整块大小；`--gap-ms` 在段间插静音。
- 风格前缀与 `(唱歌)` 会在**每个分块**开头重复，避免后续段丢失风格。

## 三种模式怎么选

| 场景 | 用哪个 |
|---|---|
| 有现成音色，正常配音 | 默认模型 + `--voice` |
| 没有样本，想用文字描述造一个音色 | `--model mimo-v2.5-tts-voicedesign --voice-desc "描述"` |
| 有目标音色的音频样本 | `--model mimo-v2.5-tts-voiceclone --voice-sample 路径` |

音色设计每次分段是独立生成，音色可能有细微差异：**尽量 `--no-split` 一次合成**，或加大 `--max-chars`。

## 文本怎么写

- **圆括号 `()` / `（）` / `【】` = 风格前缀**，必须放在最开头，例如 `(温柔 磁性)你好呀`。
- **方括号 `[]` = 行内情绪**，可以插在任意位置，例如 `你[叹气]真的这么想吗`。
- 唱歌模式：加 `--singing`，脚本会把 `(唱歌)` 顶到第 0 个字符并删除所有括号组（唱歌不认行内标签）。
- 开场标签与唱歌互斥；手写的风格前缀优先于 `--opening-tag`。

细节规则见 `references/presets.md`。

## 查词表

不要凭记忆写音色名或标签，先查：

```bash
python "D:/xiangmu/tts/skills/mimo-tts/scripts/mimo_tts.py" voices
python "D:/xiangmu/tts/skills/mimo-tts/scripts/mimo_tts.py" presets
python "D:/xiangmu/tts/skills/mimo-tts/scripts/mimo_tts.py" tags
```

完整参数表见 `references/api.md` 末尾，或直接 `--help`。

## 读输出

成功时 stdout 是 JSON：

- `output`：WAV 绝对路径
- `wav.duration_sec`：总时长
- `parts[]`：每块的 `index / chars / elapsed_ms / audio_sec`
- `warnings[]`：例如末尾有残余字节、设计模式分段提示

失败时 stdout 是 `{"ok": false, "error": {"kind": ..., "message": ...}}`，退出码 1。
`kind` 取值：`usage` 参数错、`auth` Key 无效、`upstream` 上游异常、`rate_limit` 限流、`network` 网络、`audio` 音频异常。

**失败时把 `error.message` 原样转达给用户，不要重试三次以上，也不要伪造文件路径。**

## 凭据

按顺序读取：环境变量 `MIMO_API_KEY` → `--env-file` 指定文件 → 当前目录 `.env` → 仓库根 `.env`。
地址同理（`--base-url` → `MIMO_BASE_URL` → 官方默认）。

**不要在命令里明文传 Key，不要在回复里打印 Key。**

## 约束

- 只产出 WAV；不转 MP3（避免引入 ffmpeg 依赖）。
- 不假定上游返回的 WAV 是固定 44 字节头，脚本已按 RIFF chunk 遍历解析。
- 切分不会切进括号组内部；标签超长时允许该块超限并给出 warning。
- 合成完成后用绝对路径告知用户，需要展示就 `present_files`。
