"""全局配置：模型能力表、音色表、标签词库、目录与超时。

所有前端可点击的选项都来自这里，前端通过 /api/bootstrap 一次性拉取，
避免在 JS 里重复维护一份词表。
"""

from __future__ import annotations

import os
from pathlib import Path

# ---------------------------------------------------------------- 基础路径

ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
DATA_DIR = ROOT / "data"
UPLOAD_DIR = DATA_DIR / "uploads"
OUTPUT_DIR = DATA_DIR / "outputs"
CACHE_DIR = DATA_DIR / "cache"

for _d in (DATA_DIR, UPLOAD_DIR, OUTPUT_DIR, CACHE_DIR):
    _d.mkdir(parents=True, exist_ok=True)

# ---------------------------------------------------------------- 上游服务


def _load_dotenv(path: Path | None = None) -> None:
    """在读取 BASE_URL 之前先把 .env 灌进环境变量。

    必须放在这里而不是 app 启动时：BASE_URL 是模块级常量，
    如果等 startup 再 load，.env 里的自定义地址就永远不生效。
    """
    target = path or (ROOT / ".env")
    if not target.exists():
        return
    try:
        for raw in target.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value
    except OSError:
        pass


_load_dotenv()

BASE_URL = os.environ.get("MIMO_BASE_URL", "https://api.xiaomimimo.com/v1").rstrip("/")
CHAT_PATH = "/chat/completions"

SAMPLE_RATE = 24000  # 上游 PCM16 单声道 24kHz

# 超时（秒）
CONNECT_TIMEOUT = 10.0
WRITE_TIMEOUT = 30.0
READ_TIMEOUT_TOTAL = 180.0  # 外层总时长，代替 read timeout
FFMPEG_TIMEOUT = 60.0

MAX_UPLOAD_BYTES = 8 * 1024 * 1024  # 原始样本上限（base64 后约 10.6MB，仍留余量）
MAX_CONCURRENCY = 2
FILE_TTL_SECONDS = 2 * 60 * 60  # 输出文件保留 2 小时
CLEAN_INTERVAL = 10 * 60

# ---------------------------------------------------------------- 模型能力表

MODELS: list[dict] = [
    {
        "id": "mimo-v2.5-tts",
        "short": "预置音色",
        "name": "mimo-v2.5-tts",
        "desc": "内置 8 个精品音色，支持自然语言风格指令、音频标签、唱歌模式",
        "caps": {
            "preset_voice": True,
            "voice_design": False,
            "voice_clone": False,
            "singing": True,
            "style_instruction": True,
            "audio_tags": True,
            "stream": True,  # 真·低延迟流式
            "optimize_text": False,
        },
        "badges": ["预置音色", "风格指令", "音频标签", "唱歌", "流式"],
    },
    {
        "id": "mimo-v2.5-tts-voicedesign",
        "short": "音色设计",
        "name": "mimo-v2.5-tts-voicedesign",
        "desc": "用一段文字描述生成定制音色，无需任何音频样本",
        "caps": {
            "preset_voice": False,
            "voice_design": True,
            "voice_clone": False,
            "singing": False,
            "style_instruction": False,  # 此处 user 消息是音色描述，不是风格
            "audio_tags": False,
            "stream": False,  # 文档：流式降级，一次性返回
            "optimize_text": True,
        },
        "badges": ["文本设计音色", "智能润色", "不支持唱歌", "流式降级"],
    },
    {
        "id": "mimo-v2.5-tts-voiceclone",
        "short": "音色复刻",
        "name": "mimo-v2.5-tts-voiceclone",
        "desc": "上传或录制一段音频样本，精准复刻音色",
        "caps": {
            "preset_voice": False,
            "voice_design": False,
            "voice_clone": True,
            "singing": False,
            "style_instruction": True,
            "audio_tags": True,
            "stream": False,  # 文档：流式降级，一次性返回
            "optimize_text": False,
        },
        "badges": ["音色复刻", "上传/录音", "风格指令", "流式降级"],
    },
]

MODEL_IDS = [m["id"] for m in MODELS]
MODEL_MAP = {m["id"]: m for m in MODELS}

# ---------------------------------------------------------------- 预置音色

VOICES: list[dict] = [
    {"id": "mimo_default", "label": "MiMo 默认", "lang": "中/英", "gender": "默认", "note": "集群默认音色（中国集群为冰糖）"},
    {"id": "冰糖", "label": "冰糖", "lang": "中", "gender": "女", "note": "清甜自然，通用女声"},
    {"id": "茉莉", "label": "茉莉", "lang": "中", "gender": "女", "note": "温柔细腻，适合叙事"},
    {"id": "苏打", "label": "苏打", "lang": "中", "gender": "男", "note": "清爽年轻，口语化"},
    {"id": "白桦", "label": "白桦", "lang": "中", "gender": "男", "note": "沉稳低音，适合播报"},
    {"id": "Mia", "label": "Mia", "lang": "英", "gender": "女", "note": "English, bright female"},
    {"id": "Chloe", "label": "Chloe", "lang": "英", "gender": "女", "note": "English, warm female"},
    {"id": "Milo", "label": "Milo", "lang": "英", "gender": "男", "note": "English, casual male"},
    {"id": "Dean", "label": "Dean", "lang": "英", "gender": "男", "note": "English, deep male"},
]

VOICE_IDS = [v["id"] for v in VOICES]

# ---------------------------------------------------------------- 开场风格标签

OPENING_TAGS: list[dict] = [
    {"group": "基础情绪", "tags": ["开心", "悲伤", "愤怒", "恐惧", "惊讶", "兴奋", "委屈", "平静", "冷漠"]},
    {"group": "复合情绪", "tags": ["怅然", "欣慰", "无奈", "愧疚", "释然", "嫉妒", "厌倦", "忐忑", "动情"]},
    {"group": "整体语调", "tags": ["温柔", "高冷", "活泼", "严肃", "慵懒", "俏皮", "深沉", "干练", "凌厉"]},
    {"group": "音色定位", "tags": ["磁性", "醇厚", "清亮", "空灵", "稚嫩", "苍老", "甜美", "沙哑", "醇雅"]},
    {"group": "人设腔调", "tags": ["夹子音", "御姐音", "正太音", "大叔音", "台湾腔"]},
    {"group": "方言", "tags": ["东北话", "四川话", "河南话", "粤语"]},
    {"group": "角色扮演", "tags": ["孙悟空", "林黛玉"]},
]

SINGING_TAG = "唱歌"
SINGING_ALIASES = ["唱歌", "sing", "singing"]

# ---------------------------------------------------------------- 行内音频标签

INLINE_TAGS: list[dict] = [
    {"group": "语速节奏", "tags": ["吸气", "深呼吸", "叹气", "长叹一口气", "喘息", "屏息"]},
    {"group": "情绪状态", "tags": ["紧张", "害怕", "激动", "疲惫", "委屈", "撒娇", "心虚", "震惊", "不耐烦"]},
    {"group": "语音特征", "tags": ["颤抖", "声音颤抖", "变调", "破音", "鼻音", "气声", "沙哑"]},
    {"group": "哭笑表达", "tags": ["笑", "轻笑", "大笑", "冷笑", "抽泣", "呜咽", "哽咽", "嚎啕大哭"]},
]

# ---------------------------------------------------------------- 风格指令示例

STYLE_PRESETS: list[dict] = [
    {"label": "报喜", "text": "用轻快上扬的语调向领导报喜，语速稍快，带着查到成绩后压抑不住的激动与小骄傲，声音明亮有活力。"},
    {"label": "得意", "text": "看着刚解决的难题成果忍不住得意忘形地惊呼，声音高亢明亮，语速偏快，语气中带着满满的自信与难以置信。"},
    {"label": "恶作剧", "text": "用明亮活泼的青少年嗓音，带着恶作剧得逞后的得意与戏谑，语速偏快且咬字轻巧，在强调赌注时语气微微上扬。"},
    {"label": "深夜电台", "text": "深夜电台主播，声音低沉有磁性，气息松弛，语速偏慢，像在耳边轻声说话，句尾略带慵懒。"},
    {"label": "科普旁白", "text": "纪录片旁白，中低音，吐字清晰有力，节奏稳定，客观中带有克制的敬意，不做过多情绪起伏。"},
    {"label": "广告口播", "text": "高能量广告口播，节奏紧凑明快，重音落在卖点上，句末上扬收尾，带着强烈的推荐欲。"},
    {"label": "温柔哄睡", "text": "极轻柔的哄睡语气，气声多、实声少，语速非常慢，句与句之间留出明显停顿，像哄小孩一样耐心。"},
    {"label": "悬疑叙事", "text": "悬疑故事讲述者，压低嗓音，语速忽快忽慢，关键处刻意放慢并加重咬字，制造压迫感与悬念。"},
    {"label": "激情解说", "text": "体育赛事解说，情绪高涨，语速极快，音量起伏大，关键瞬间拔高音量大喊，带着难以抑制的兴奋。"},
    {"label": "冷静播报", "text": "新闻播报，标准普通话，语速中等偏慢，语调平稳，重音准确，不带个人情绪，端庄克制。"},
    {"label": "古风评书", "text": "评书先生，中老年男声，文白杂糅，讲究抑扬顿挫，关键处以惊堂木般的重音收束，余韵悠长。"},
    {"label": "ASMR 低语", "text": "贴近麦克风的耳语，气声明显，呼吸声清晰可闻，语速缓慢，字与字之间带着黏连感，让人放松。"},
]

# ---------------------------------------------------------------- 导演模式示例

DIRECTOR_EXAMPLE = {
    "role": "百年门阀岑家的现任大当家。自出生便被过继给祖庙的守门老人抚养，被塑造成一尊完美无瑕、绝情断欲的家族图腾。常年深居简出，对人有着极强的阶级疏离感。",
    "scene": "在祠堂的阴影里，看着那个不顾一切冲破保安防线来找她、企图带她私奔的男人。她要用最冷硬的阶级壁垒，绞杀对方，也绞杀自己刚刚萌芽、却足以燎原的感情。",
    "guide": (
        "冰冷、慵懒却极具威压的低音御姐。发声通道非常松弛，没有任何剑拔弩张，却有着让人骨里生寒的压迫感。\n"
        "- 语速与顿挫：极慢，每个字都像是在舌尖滚过才吐出来，带着上位者漫不经心的傲慢。句与句之间留下极长的、令人不安的空白。\n"
        "- 气声与实声：大部分时间，她的声音没有明显的声调起伏，实音重且硬，像是一条平缓却冰冷的暗河。但一定要在某些尾音处（如“真心”），加入极其轻微的气音收束，透出一丝连她自己都没察觉到的疲惫与渴望。\n"
        "- 咬字肌理：文白杂糅的用词带着旧时代的痕迹，唇齿音发得极轻但极清晰（如“冲撞”“廉价”），显得既清雅又锋利，刀刀见血。"
    ),
}

# ---------------------------------------------------------------- 音色设计维度

DESIGN_DIMENSIONS: list[dict] = [
    {
        "key": "age",
        "group": "性别与年龄",
        "required": True,
        "tags": ["幼童", "少年", "20 多岁女性", "20 多岁男性", "中年男性", "五十多岁女性", "年迈老先生"],
    },
    {
        "key": "texture",
        "group": "音色质感",
        "required": True,
        "tags": ["深沉砂砾", "丝滑醇厚", "磁性", "清亮", "空灵", "沙哑沧桑"],
    },
    {
        "key": "emotion",
        "group": "情绪语气",
        "required": True,
        "tags": ["温柔治愈", "温暖自信", "冰冷疏离", "疲惫", "一本正经"],
    },
    {
        "key": "pace",
        "group": "语速节奏",
        "required": True,
        "tags": ["语速极快", "缓慢沉稳", "一字一顿", "连珠炮"],
    },
    {
        "key": "persona",
        "group": "角色人设",
        "required": False,
        "tags": ["旁白", "播客主持", "评书先生", "午夜电台 DJ", "纪录片解说"],
    },
    {
        "key": "manner",
        "group": "说话风格",
        "required": False,
        "tags": ["像在密谋", "一本正经", "口语闲聊", "广播腔"],
    },
    {
        "key": "scene",
        "group": "场景与年代",
        "required": False,
        "tags": ["1940s 黑色电影", "八十年代译制片", "ASMR 耳边低语"],
    },
]

DESIGN_TEMPLATES: list[dict] = [
    {
        "label": "俄式口音大叔",
        "desc": "Heavy Russian accent, gruff middle-aged male, blunt and matter-of-fact.",
    },
    {
        "label": "ASMR 女声",
        "desc": "Young female, extreme close-up with a binaural, ear-to-ear ASMR feel. Audible breathing, subtle swallowing, and soft natural lip sounds. She speaks very slowly, creating a deeply relaxing and immersive experience.",
    },
    {
        "label": "北方老先生",
        "desc": "一位年迈的老先生，说带北方口音的普通话，语速缓慢而沉稳，嗓音略带沙哑和沧桑感，仿佛一位饱经风霜的老爷爷在讲故事，充满岁月的智慧。",
    },
    {
        "label": "英语播客主持",
        "desc": "Young female podcast host in her late 20s, warm and confident, conversational pace, a slight smile in the voice, crisp articulation.",
    },
]

# ---------------------------------------------------------------- 示例文本

SAMPLE_TEXTS: dict[str, list[dict]] = {
    "mimo-v2.5-tts": [
        {"label": "怅然独白", "text": "这么多年过去了，再走过那条街，心里一下子空了一块。"},
        {"label": "深夜电台", "text": "夜已经深了，城市还在呼吸。我是今晚陪你的人，欢迎收听《午夜电台》。"},
        {"label": "方言俏皮", "text": "哎呀妈呀，这天儿也忒冷了吧！你说这风，嗖嗖的，跟刀子似的，割脸啊！"},
        {"label": "标签演示", "text": "（紧张，深呼吸）呼……冷静，冷静。不就是一个面试吗……（语速加快，碎碎念）自我介绍已经背了五十遍了，应该没问题的。加油，你可以的……（小声）哎呀，领带歪没歪？"},
        {"label": "唱歌", "text": "原谅我这一生不羁放纵爱自由，也会怕有一天会跌倒。背弃了理想，谁人都可以，哪会怕有一天只你共我。"},
    ],
    "mimo-v2.5-tts-voicedesign": [
        {"label": "晚安独白", "text": "今天辛苦了。把手机放下，闭上眼睛，剩下的都交给明天。"},
        {"label": "产品介绍", "text": "全新一代降噪耳机，四麦克风阵列，主动降噪深度提升百分之四十。戴上它，世界安静下来。"},
        {"label": "故事开场", "text": "那是光绪二十六年的冬天，北京城下了入冬以来最大的一场雪。"},
    ],
    "mimo-v2.5-tts-voiceclone": [
        {"label": "自我介绍", "text": "你好，我是用你自己的声音合成的。接下来这句话，是模型在模仿我的语气和音色。"},
        {"label": "旁白练习", "text": "风从山口灌进来，草甸像被人从中间掀开，一路倒伏到视线尽头。"},
        {"label": "日常对话", "text": "今天下班早，要不要一起去楼下那家新开的面馆试试？听说牛肉面不错。"},
    ],
}

VOICE_PREVIEW_TEXT = "你好，这是音色试听。今天天气不错，适合出门走走。"
VOICE_TEST_TEXT = "你好。"

# ---------------------------------------------------------------- 语音识别 / 对话

ASR_MODEL = "mimo-v2.5-asr"
# 实时对话用 flash 档：首字延迟低、便宜，够用
CHAT_MODEL = os.environ.get("MIMO_CHAT_MODEL", "mimo-v2.6-flash")
SENSEVOICE_DIR = ROOT / "models" / "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17"

# 对话时的系统提示：口语化、短句，方便直接念出来
CHAT_SYSTEM_PROMPT = (
    "你是 MiMo，小米研发的语音助手，正在和用户进行实时语音对话。"
    "回答要像真人说话：口语化、简短（一般 1-2 句，最多 60 字），不要用 markdown、列表、表情符号、括号注释。"
    "不确定的事情就直说不知道。"
)
TALK_VOICE = "冰糖"
TALK_MAX_TURNS = 12  # 保留多少轮上下文

# ---------------------------------------------------------------- 允许的上传类型

ALLOWED_UPLOAD_EXT = {".mp3", ".wav"}
MIME_BY_EXT = {".mp3": "audio/mpeg", ".wav": "audio/wav"}
