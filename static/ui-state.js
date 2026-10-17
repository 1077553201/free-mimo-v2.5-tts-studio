/* =========================================================================
   ui-state.js — 单一状态源 + 派生值 + 小工具
   页面所有控件的真值都从这里读写，避免各处 DOM 各存一份。
   ========================================================================= */
(function () {
  'use strict';

  const LS = {
    theme: 'mimo.theme',
    key: 'mimo.key',
    persist: 'mimo.persist',
    state: 'mimo.state',
    history: 'mimo.history',
  };

  const S = {
    boot: null,
    model: 'mimo-v2.5-tts',
    voice: 'mimo_default',
    instruction: '',
    director: { on: false, role: '', scene: '', guide: '' },
    openingTags: [],          // 开场风格，多选合并成一个括号
    singing: false,
    text: '',
    design: { desc: '', optimize: false },
    clone: { samples: [], activeId: null },
    stream: true,
    history: [],
    key: localStorage.getItem(LS.key) || '',
    hasKey: false,            // 浏览器里有 key，或后端 .env 里配了
  };

  /* ------------------------------------------------------------- 派生逻辑 */

  function modelMeta() {
    if (S.model === 'talk') {
      return {
        id: 'talk',
        short: '实时对话',
        name: 'mimo-v2.5-tts · 流式',
        desc: '说完就答，边生成边播报',
        caps: {},
        badges: [],
      };
    }
    const list = (S.boot && S.boot.models) || [];
    return list.find((m) => m.id === S.model) || list[0] || { caps: {}, badges: [] };
  }

  function caps() {
    return modelMeta().caps || {};
  }

  /** 最终发给模型的 assistant 内容（目标合成文本 + 标签前缀） */
  function finalAssistant() {
    if (S.model === 'mimo-v2.5-tts-voicedesign') return (S.text || '').trim();
    let prefix = '';
    if (S.singing) {
      prefix = '(唱歌)';
    } else if (S.openingTags.length) {
      prefix = '(' + S.openingTags.join(' ') + ')';
    }
    return prefix + (S.text || '');
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

  /** 与后端 TTSRequest 完全对齐的请求体 */
  function requestBody() {
    const body = {
      model: S.model,
      text: finalAssistant(),
      instruction: finalUser(),
      stream: wantsStream(),
    };
    if (caps().preset_voice) body.voice = S.voice;
    if (caps().voice_clone) body.sample_id = S.clone.activeId;
    if (caps().optimize_text) body.optimize_text_preview = !!S.design.optimize;
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
      cloneActiveId: S.clone.activeId,
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
        if (k === 'cloneActiveId') return;
        if (k === 'director' && data[k]) Object.assign(S.director, data[k]);
        else if (k in S) S[k] = data[k];
      });
    } catch (e) { /* 忽略损坏的存档 */ }
  }

  function loadHistory() {
    try {
      const raw = localStorage.getItem(LS.history);
      S.history = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(S.history)) S.history = [];
    } catch (e) {
      S.history = [];
    }
  }

  function saveHistory() {
    try {
      localStorage.setItem(LS.history, JSON.stringify(S.history.slice(0, 20)));
    } catch (e) { /* 超配额时静默 */ }
  }

  function addHistory(item) {
    S.history.unshift(item);
    S.history = S.history.slice(0, 20);
    saveHistory();
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
    LS,
    S,
    modelMeta,
    caps,
    finalAssistant,
    finalUser,
    wantsStream,
    requestBody,
    canGenerate,
    switchModel,
    persist,
    restore,
    loadHistory,
    saveHistory,
    addHistory,
    fmtTime,
    fmtBytes,
    fmtMs,
    escapeHtml,
    highlightTags,
    debounce,
  };
})();
