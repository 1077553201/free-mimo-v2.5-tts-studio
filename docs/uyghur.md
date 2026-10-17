# 维吾尔语支持调研

**结论先说：MiMo 的 TTS / ASR 都不支持维吾尔语，需要外挂模型。**

- TTS `mimo-v2.5-tts`：预置音色只有中文（冰糖/茉莉/苏打/白桦）和英文（Mia/Chloe/Milo/Dean），文档里没有维吾尔语音色，也没法用「音色设计」凭空造出可靠的非训练语种发音。
- ASR `mimo-v2.5-asr`：`asr_options.language` 只接受 `auto` / `zh` / `en`；官方说的「方言」是粤语、吴语、闽南语、四川话这类汉语方言，不含维吾尔语（突厥语族，文字也不同）。
- 好消息：平台的 OpenAI 兼容接口只负责搬运，外挂模型完全可以在本地先转成文本/音频，再走 MiMo 做后续处理。

---

## 可引用的 TTS 模型

| 模型 | 参数 | 说明 | 许可 |
|---|---|---|---|
| `facebook/mms-tts-uig-script_arabic` | 36M | Meta MMS 项目，VITS 端到端，阿拉伯字母维吾尔语（新疆通用书写），transformers 直接加载，CPU 可跑 | **CC-BY-NC 4.0**（非商用） |
| `facebook/mms-tts-uig-script_cyrillic` | 36M | 同上，西里尔字母版本 | CC-BY-NC 4.0 |
| 社区微调 `mms-tts-uig-script_arabic-UQSpeech` | 36M | 在 MMS 基础上针对维吾尔语继续训练，16kHz，单说话人 | 见仓库 |
| `anke01/qwen3-tts-uyghur` | 0.6B | 基于 Qwen3-TTS-12Hz-0.6B-Base 用 Common Voice 维吾尔语微调，质量更好但需要 GPU | 见仓库 |

**推荐从 MMS 起步**：36M、CPU 就能实时，一行 `VitsModel.from_pretrained(...)`。

```python
from transformers import VitsModel, AutoTokenizer
import torch, scipy.io.wavfile

model = VitsModel.from_pretrained("facebook/mms-tts-uig-script_arabic")
tok = AutoTokenizer.from_pretrained("facebook/mms-tts-uig-script_arabic")
inputs = tok("ياخشىمۇسىز، بۇ ئۇيغۇر تىلىدا سۆزلەيدۇ", return_tensors="pt")
with torch.no_grad():
    wav = model(**inputs).waveform
scipy.io.wavfile.write("uig.wav", rate=model.config.sampling_rate, data=wav.squeeze().numpy())
```

## 可引用的 ASR 模型

| 模型 | 参数 | 指标 | 说明 |
|---|---|---|---|
| `ixxan/whisper-small-uyghur-thugy20` | 244M | CER 4.93% / WER 17.94%（THUGY20） | whisper-small 微调，**性价比最高**，可用 faster-whisper 转 CTranslate2 再提速 |
| `purkat/Whisper-medium-uyghur-cer12` | 769M | CER 12.56% / WER 22.53% | whisper-medium 微调，参数更大但 CER 反而一般 |
| MMS wav2vec2 微调（如 `AIDman/…uyghur-latin`） | 300M–1B | CER 5.98% | 需配合语言模型，工程复杂度高 |

**推荐 whisper-small 微调版**：0.2B，和现在用的 SenseVoice-Small（234M）同一量级，CPU int8 可以做到准实时。

## 接入本项目的方式

当前架构已经把 ASR 抽成了引擎接口（`asr.py`），加一个语种只需：

1. `asr.py` 里加 `LocalUyghurWhisper`（faster-whisper，`language="ug"`），返回同样的 `{text, engine, ms}`；
2. `config.py` 的 `TALK_LANGUAGES` 里加 `{"id": "ug", "label": "维吾尔语", "engine": "whisper-ug"}`；
3. 前端对话页的「识别」菜单多一项，选它就切模型。

TTS 侧同理：`mimo_client.build_payload` 之外再加一个 `local_tts.py`（VITS），在 `/api/tts` 里按 `engine` 分流，音频直接返回 wav/pcm，前端播放逻辑不用改。

## 三个坑

1. **书写系统**：MMS 分 `script_arabic` 和 `script_cyrillic` 两个模型，输出文字必须和模型对应（新疆日常用阿拉伯字母）。ASR 输出如果是拉丁转写，还要过一层转写工具。
2. **许可**：MMS 全系 CC-BY-NC 4.0，只能非商用；要商用得换 Apache/MIT 的模型或自己训练。
3. **音色单一**：MMS 每个语种是单说话人，做不出 MiMo 那种「温柔/御姐/方言」的风格控制；要多样音色只能走 Qwen3-TTS 微调那条路。

## 如果只是想让 MiMo 说维吾尔语

做不到。TTS 是自回归语音模型，不在训练分布里的语言，靠 `(维吾尔语)` 这类标签提示不会生效，最多出来像中文腔的乱读。老老实实外挂一个维吾尔语 TTS 才靠谱。
