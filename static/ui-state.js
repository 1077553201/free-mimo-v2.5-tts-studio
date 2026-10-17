/* =========================================================================
   ui-state.js — 单一状态源 + 派生值 + 小工具

   静态版：原来的 /api/bootstrap 没有了，模型表 / 音色 / 标签词库
   全部来自 static/ui-config.js（window.MIMO_CONFIG）。
   ========================================================================= */
(function () {
  'use strict';

  const CFG = window.MIMO_CONFIG;

  const LS = {
    theme: 'mimo.theme',
    key: 'mimo.key',
    state: 'mimo.state',
  };

  // 把 config 里的数组索引成 map，省得每次 find
  const MODEL_MAP = {};
  CFG.MODELS.forEach((m) => { MODEL_MAP[m.id] = m; });
  const VOICE_MAP = {};
  CFG.VOICES.forEach((v) => { VOICE_MAP[v.id] = v; });

  const S = {
    // 兼容层：以前模型表来自 /api/bootstrap，现在由 ui-config.js 组装成同形状
    boot: null,
    model: 'mimo-v2.5-tts',
    voice: 'mimo_default',
    instruction: '',
    director: { on: false, role: '', scene: '', guide: '' },
    openingTags: [],          // 开场风格，多选合并成一个括号
    singing: false,
    text: '',
    design: { desc: '', optimize: false },
    clone: { samples: [], activeId: null, urls: {} },
    stream: true,
    base: CFG.DEFAULT_BASE_URL,
    history: [],              // 内存缓存，真身在 IndexedDB
    key: localStorage.getItem(LS.key) || '',
    hasKey: false,
  };

  S.boot = {
    models: CFG.MODELS,
    voices: CFG.VOICES,
    opening_tags: CFG.OPENING_TAGS,
    inline_tags: CFG.INLINE_TAGS,
    style_presets: CFG.STYLE_PRESETS,
    design_dimensions: CFG.DESIGN_DIMENSIONS,
    design_templates: CFG.DESIGN_TEMPLATES,
    director_example: CFG.DIRECTOR_EXAMPLE,
    sample_texts: CFG.SAMPLE_TEXTS,
    voice_preview_text: CFG.VOICE_PREVIEW_TEXT,
    voice_test_text: CFG.VOICE_TEST_TEXT,
    limits: {
      base_url: CFG.DEFAULT_BASE_URL,
      soft_chars: CFG.SOFT_CHARS,
      sample_rate: CFG.SAMPLE_RATE,
      max_sample_mb: Math.round(CFG.MAX_SAMPLE_BYTES / 1024 / 1024),
    },
    key_configured: false,
  };

  /* ------------------------------------------------------------- 派生逻辑 */

  function modelMeta() {
    return MODEL_MAP[S.model] || CFG.MODELS[0];
  }

  function caps() {
    return modelMeta().caps || {};
  }

  function voiceMeta(id) {
    return VOICE_MAP[id] || null;
  }

  /* ------------------------------------------------------------- 标签处理

     约定：
     - 圆括号 ()/（）/【】 = 风格前缀，必须放在最开头
     - 方括号 [] = 行内情绪，可以插在任意位置
     坑：用户常把行内情绪也写成（大笑），它出现在开头时不能被误判成风格前缀，
         否则 (唱歌) 和开场风格标签都会被跳过。
  */

  const LEAD_GROUP = /^\s*([(（【\[])\s*([^)）】\]]{1,24})\s*([)）】\]])/;
  const ANY_GROUP = /[（(【\[][^）)】\]]{1,24}[）)】\]]/g;
  let inlineSet = null;

  function inlineTags() {
    if (inlineSet) return inlineSet;
    inlineSet = new Set();
    CFG.INLINE_TAGS.forEach((g) => (g.tags || []).forEach((t) => inlineSet.add(t)));
    return inlineSet;
  }

  /** 开头的标签是"行内情绪"还是"风格前缀"：全部词都认识才算行内 */
  function isInlineGroup(content) {
    const parts = String(content).split(/[，,、\s]+/).filter(Boolean);
    if (!parts.length) return false;
    const known = inlineTags();
    return parts.every((p) => known.has(p));
  }

  function finalAssistant() {
    if (S.model === 'mimo-v2.5-tts-voicedesign') return (S.text || '').trim();

    let body = S.text || '';
    const lead = body.match(LEAD_GROUP);
    const leadInner = lead ? lead[2].trim() : '';
    const leadIsSinging = /^(唱歌|sing|singing)$/i.test(leadInner);
    const leadIsInline = leadInner ? isInlineGroup(leadInner) : false;

    if (S.singing) {
      // 唱歌必须让 (唱歌) 待在 0 位，否则模型就按普通朗读处理
      if (lead && leadIsSinging) {
        body = '(唱歌)' + body.slice(lead[0].length);
      } else {
        body = '(唱歌)' + body;
      }
      // 唱歌模式不认行内情绪标签，留着会被当成歌词唱出来，直接去掉
      const tail = body
        .slice(4)
        .replace(ANY_GROUP, ' ')
        .replace(/\s{2,}/g, ' ')
        .trimStart();
      // 文档给的格式是 (唱歌)歌词，标签后不要留空格
      return '(唱歌)' + tail.trimEnd();
    }

    // 普通模式
    // 1) 开头的风格标签：用户手写的优先；行内情绪不算
    let prefix = '';
    let rest = body;
    const head = lead && !leadIsInline ? lead : null;
    if (head) {
      prefix = head[0].trim();
      rest = body.slice(head[0].length);
    }

    // 2) 行内情绪统一成方括号：只转换词表里认识的，避免误伤普通括号
    rest = rest.replace(ANY_GROUP, (m) => {
      const inner = m.replace(/^[（(【\[]/, '').replace(/[）)】\]]$/, '').trim();
      return isInlineGroup(inner) ? '[' + inner + ']' : m;
    });

    // 3) 没写风格前缀就用界面上选的
    if (!prefix && S.openingTags.length) {
      prefix = '(' + S.openingTags.join(' ') + ')';
    }

    body = prefix + rest;

    // 4) 连续重复的同一个标签只留一个：(唱歌)(唱歌)歌词 → (唱歌)歌词
    const dup = body.match(LEAD_GROUP);
    if (dup) {
      const tag = dup[0].trim();
      let tail = body.slice(body.indexOf(dup[0]) + dup[0].length).replace(/^\s+/, '');
      while (tail.startsWith(tag)) {
        tail = tail.slice(tag.length).replace(/^\s+/, '');
      }
      body = tag + tail;
    }
    return body;
  }

  /** 最终发给模型的 user 内容（风格指令 / 音色描述 / 导演三段式） */
  function finalUser() {
    if (S.model === 'mimo-v2.5-tts-voicedesign') return (S.design.desc || '').trim();
    if (S.director.on) {
      const chunks = [];
      const { role, scene, guide } = S.director;
      if ((role || '').trim()) chunks.push('角色：' + role.trim());
      if ((scene || '').trim()) chunks.push('场景：' + scene.trim());
      if ((guide || '').trim()) chunks.push('指导：\n' + guide.trim());
      return chunks.join('\n\n');
    }
    return (S.instruction || '').trim();
  }

  function wantsStream() {
    return !!caps().stream && S.stream;
  }

  /** 交给 MimoApi.buildPayload 的参数 */
  function requestBody() {
    const body = {
      model: S.model,
      text: finalAssistant(),
      instruction: finalUser(),
      stream: wantsStream(),
    };
    if (caps().preset_voice) body.voice = S.voice;
    if (caps().voice_clone) body.sampleId = S.clone.activeId;
    if (caps().optimize_text) body.optimize = !!S.design.optimize;
    return body;
  }

  function canGenerate() {
    if (!S.hasKey) return false;
    if (S.model === 'mimo-v2.5-tts-voicedesign') {
      if (!finalUser()) return false;
      return !!finalAssistant() || !!S.design.optimize;
    }
    if (S.model === 'mimo-v2.5-tts-voiceclone' && !S.clone.activeId) return false;
    return !!finalAssistant().trim();
  }

  /** 切换模型时清掉不兼容的字段，避免参数串味 */
  function switchModel(modelId) {
    S.model = modelId;
    const c = caps();
    S.stream = !!c.stream;
    if (!c.singing) S.singing = false;
    if (!c.audio_tags) S.openingTags = [];
  }

  /* ------------------------------------------------------------- 持久化 */

  function snapshot() {
    return {
      model: S.model,
      voice: S.voice,
      instruction: S.instruction,
      director: S.director,
      openingTags: S.openingTags,
      singing: S.singing,
      text: S.text,
      design: S.design,
      stream: S.stream,
      base: S.base,
    };
  }

  function persist() {
    try {
      localStorage.setItem(LS.state, JSON.stringify(snapshot()));
    } catch (e) { /* 隐私模式写不进去就算了 */ }
  }

  function restore() {
    try {
      const raw = localStorage.getItem(LS.state);
      if (!raw) return;
      const data = JSON.parse(raw);
      Object.keys(data).forEach((k) => {
        if (k === 'director' && data[k]) Object.assign(S.director, data[k]);
        else if (k in S) S[k] = data[k];
      });
    } catch (e) { /* 忽略损坏的存档 */ }
    if (!S.base) S.base = CFG.DEFAULT_BASE_URL;
  }

  /* ------------------------------------------------------------- 小工具 */

  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return m + ':' + String(s).padStart(2, '0');
  }

  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + 'B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + 'KB';
    return (n / 1024 / 1024).toFixed(2) + 'MB';
  }

  function fmtMs(ms) {
    if (ms == null || !isFinite(ms)) return '—';
    return ms >= 1000 ? (ms / 1000).toFixed(2) + 's' : Math.round(ms) + 'ms';
  }

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, (c) => ESC[c]);
  }

  /** 先转义再高亮，(标签) / （标签） / [标签] / 【标签】 统一标成强调色 */
  function highlightTags(str) {
    const safe = escapeHtml(str);
    return safe.replace(/([（(【\[])([^）)】\]]{1,16})([）)】\]])/g, '<mark>$1$2$3</mark>');
  }

  function debounce(fn, wait) {
    let timer = null;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), wait);
    };
  }

  window.MIMO = {
    CFG,
    LS,
    S,
    MODEL_MAP,
    VOICE_MAP,
    modelMeta,
    voiceMeta,
    caps,
    finalAssistant,
    finalUser,
    wantsStream,
    requestBody,
    canGenerate,
    switchModel,
    persist,
    restore,
    fmtTime,
    fmtBytes,
    fmtMs,
    escapeHtml,
    highlightTags,
    debounce,
  };
})();
