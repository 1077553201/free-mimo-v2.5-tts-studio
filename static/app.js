/* =========================================================================
   app.js — 控件绑定、请求编排、播放器、历史、设置
   ========================================================================= */
(function () {
  'use strict';

  const { S, LS } = window.MIMO;
  const M = window.MIMO;
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const el = {
    banner: $('#keyBanner'),
    tabs: $('#modelTabs'),
    introTitle: $('#introTitle'),
    introModel: $('#introModel'),
    introDesc: $('#introDesc'),
    introBadges: $('#introBadges'),
    voiceHint: $('#voiceHint'),
    voiceGrid: $('#voiceGrid'),
    designDesc: $('#designDesc'),
    designChips: $('#designChips'),
    designTemplates: $('#designTemplates'),
    optimizeToggle: $('#optimizeToggle'),
    dropZone: $('#dropZone'),
    fileInput: $('#fileInput'),
    dzSub: $('#dzSub'),
    recordBtn: $('#recordBtn'),
    recordLabel: $('#recordLabel'),
    recMeter: $('#recMeter'),
    recTime: $('#recTime'),
    sampleList: $('#sampleList'),
    sampleCount: $('#sampleCount'),
    instruction: $('#instruction'),
    stylePresets: $('#stylePresets'),
    directorToggle: $('#directorToggle'),
    directorFields: $('#directorFields'),
    directorRole: $('#directorRole'),
    directorScene: $('#directorScene'),
    directorGuide: $('#directorGuide'),
    directorExample: $('#directorExample'),
    openingTagGroups: $('#openingTagGroups'),
    openingClear: $('#openingClear'),
    openingFoldValue: $('#openingFoldValue'),
    inlineTagGroups: $('#inlineTagGroups'),
    singingToggle: $('#singingToggle'),
    sampleWrap: $('#sampleWrap'),
    sampleBtn: $('#sampleBtn'),
    sampleMenu: $('#sampleMenu'),
    clearText: $('#clearText'),
    mainText: $('#mainText'),
    charCount: $('#charCount'),
    textHint: $('#textHint'),
    finalPreview: $('#finalPreview'),
    copyFinal: $('#copyFinal'),
    streamToggle: $('#streamToggle'),
    streamNote: $('#streamNote'),
    reqToggle: $('#reqToggle'),
    reqPreview: $('#reqPreview'),
    generateBtn: $('#generateBtn'),
    generateLabel: $('#generateLabel'),
    stopBtn: $('#stopBtn'),
    genStatus: $('#genStatus'),
    audioEl: $('#audioEl'),
    playBtn: $('#playBtn'),
    seekBar: $('#seekBar'),
    curTime: $('#curTime'),
    durTime: $('#durTime'),
    loopBtn: $('#loopBtn'),
    muteBtn: $('#muteBtn'),
    volBar: $('#volBar'),
    downloadBtn: $('#downloadBtn'),
    playerEmpty: $('#playerEmpty'),
    metaFirst: $('#metaFirst'),
    metaTotal: $('#metaTotal'),
    metaDur: $('#metaDur'),
    metaSize: $('#metaSize'),
    historyList: $('#historyList'),
    clearHistory: $('#clearHistory'),
    themeToggle: $('#themeToggle'),
    settingsBtn: $('#settingsBtn'),
    drawer: $('#drawer'),
    drawerMask: $('#drawerMask'),
    drawerClose: $('#drawerClose'),
    keyInput: $('#keyInput'),
    persistKey: $('#persistKey'),
    saveKey: $('#saveKey'),
    clearKey: $('#clearKey'),
    keyResult: $('#keyResult'),
    keySource: $('#keySource'),
    baseUrl: $('#baseUrl'),
    ffmpegState: $('#ffmpegState'),
    toasts: $('#toasts'),
    bannerKeyBtn: $('#bannerKeyBtn'),
  };

  const player = { kind: 'none', url: '', loop: false, muted: false, streamBytes: 0 };
  let abortCtl = null;
  let generating = false;
  const previewCache = new Map();
  let previewAudio = null;
  let rec = { recorder: null, stream: null, chunks: [], startedAt: 0, timer: null, meter: null, nodes: null, autoStop: null };

  /* =====================================================================
     基础工具
     ===================================================================== */

  function headers(json) {
    const h = {};
    if (json) h['Content-Type'] = 'application/json';
    if (S.key) h['X-API-Key'] = S.key;
    return h;
  }

  function toast(title, opts) {
    opts = opts || {};
    const node = document.createElement('div');
    node.className = 'toast ' + (opts.type || '');
    node.innerHTML =
      '<span class="t-dot"></span><div class="toast-body"><div class="toast-title">' +
      M.escapeHtml(title) +
      '</div>' +
      (opts.raw ? '<div class="toast-raw">' + M.escapeHtml(opts.raw) + '</div>' : '') +
      '</div>';
    el.toasts.appendChild(node);
    const life = opts.timeout || (opts.type === 'error' ? 7000 : 3200);
    setTimeout(() => {
      node.classList.add('is-leaving');
      setTimeout(() => node.remove(), 240);
    }, life);
  }

  async function readError(res) {
    let message = '请求失败（' + res.status + '）';
    let raw = '';
    try {
      const data = await res.json();
      if (data && data.detail) {
        if (typeof data.detail === 'string') message = data.detail;
        else if (data.detail.message) {
          message = data.detail.message;
          raw = data.detail.raw || '';
        }
      } else if (data && data.message) {
        message = data.message;
      }
    } catch (e) {
      raw = await res.text().catch(() => '');
    }
    return { message, raw, status: res.status };
  }

  function setStatus(text, type) {
    el.genStatus.textContent = text || '';
    el.genStatus.className = 'gen-status' + (type ? ' is-' + type : '');
  }

  function setBusy(on) {
    generating = on;
    el.generateBtn.classList.toggle('is-busy', on);
    el.generateBtn.disabled = on || !M.canGenerate();
    el.generateLabel.textContent = on ? '生成中…' : '生成语音';
    el.stopBtn.hidden = !on;
  }

  /* =====================================================================
     主题
     ===================================================================== */

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem(LS.theme, theme); } catch (e) {}
  }

  function initTheme() {
    let saved = null;
    try { saved = localStorage.getItem(LS.theme); } catch (e) {}
    if (!saved) {
      saved = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }
    applyTheme(saved);
    el.themeToggle.addEventListener('click', () => {
      applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
    });
  }

  /* =====================================================================
     模型切换
     ===================================================================== */

  function updateThumb() {
    const active = el.tabs.querySelector('.seg.is-active');
    const thumb = el.tabs.querySelector('.seg-thumb');
    if (!active || !thumb) return;
    thumb.style.width = active.offsetWidth + 'px';
    thumb.style.transform = 'translateX(' + (active.offsetLeft - 4) + 'px)';
  }

  function renderIntro() {
    const meta = M.modelMeta();
    el.introTitle.textContent = meta.short || '预置音色';
    el.introModel.textContent = meta.name || '';
    el.introDesc.textContent = meta.desc || '';
    el.introBadges.innerHTML = (meta.badges || [])
      .map((b, i) => '<span class="badge' + (i > 2 ? ' dim' : '') + '">' + M.escapeHtml(b) + '</span>')
      .join('');
  }

  function applyCaps() {
    const caps = M.caps();
    $$('.cap[data-cap]').forEach((node) => {
      const key = node.dataset.cap;
      node.hidden = !caps[key];
    });

    // 整张卡片的子区块全被关掉时，连卡片一起隐藏（例如音色设计页没有风格/标签区）
    $$('[data-card-caps]').forEach((card) => {
      const keys = card.dataset.cardCaps.split(/\s+/);
      card.hidden = !keys.some((k) => caps[k]);
    });

    // 流式开关
    const streamable = !!caps.stream;
    el.streamToggle.disabled = !streamable;
    el.streamToggle.setAttribute('aria-checked', String(streamable && S.stream));
    el.streamNote.textContent = streamable
      ? '边生成边播放，首包更快'
      : '该模型的流式为兼容模式，一次性返回';

    // 唱歌
    const sing = !!caps.singing;
    el.singingToggle.hidden = !sing;
    el.singingToggle.setAttribute('aria-checked', String(sing && S.singing));

    // 音色提示
    el.voiceHint.textContent = caps.preset_voice
      ? '点卡片选中，点 ▶ 试听'
      : caps.voice_design
      ? '描述越具体，音色越贴近预期'
      : '上传或录制一段 3–20 秒的清晰人声';

    // 设计页文案
    if (caps.voice_design) {
      el.mainText.placeholder = S.design.optimize
        ? '可留空：开启智能润色后，模型会自动生成并润色播报文本。'
        : '输入想让这个音色说的话。';
    } else if (caps.singing && S.singing) {
      el.mainText.placeholder = '输入中文歌词，可获得更好的唱歌效果。';
    } else {
      el.mainText.placeholder = '输入要合成的文本，可夹杂（叹气）（轻笑）这类行内标签。';
    }
  }

  function selectModel(modelId) {
    M.switchModel(modelId);
    $$('.seg', el.tabs).forEach((b) => b.classList.toggle('is-active', b.dataset.model === modelId));
    updateThumb();
    renderIntro();
    applyCaps();
    renderSamples();
    renderSampleMenu();
    closeSampleMenu();
    renderFinalPreview();
    updateGenerateState();
    scheduleRequestPreview();
    M.persist();
  }

  /* =====================================================================
     音色网格
     ===================================================================== */

  function renderVoices() {
    const voices = (S.boot && S.boot.voices) || [];
    el.voiceGrid.innerHTML = voices
      .map(
        (v) =>
          '<div class="voice-card' + (v.id === S.voice ? ' is-active' : '') + '" data-voice="' + M.escapeHtml(v.id) + '" role="button" tabindex="0">' +
          '<div class="voice-top"><span class="voice-name">' + M.escapeHtml(v.label) + '</span>' +
          '<button class="voice-play" data-preview="' + M.escapeHtml(v.id) + '" title="试听">▶</button></div>' +
          '<div class="voice-tags"><span class="mini-tag">' + M.escapeHtml(v.lang) + '</span><span class="mini-tag">' + M.escapeHtml(v.gender) + '</span></div>' +
          '<div class="voice-note">' + M.escapeHtml(v.note || '') + '</div>' +
          '</div>'
      )
      .join('');

    el.voiceGrid.addEventListener('click', (e) => {
      const play = e.target.closest('[data-preview]');
      if (play) {
        e.stopPropagation();
        previewVoice(play.dataset.preview, play);
        return;
      }
      const card = e.target.closest('[data-voice]');
      if (!card) return;
      S.voice = card.dataset.voice;
      $$('.voice-card', el.voiceGrid).forEach((c) => c.classList.toggle('is-active', c === card));
      M.persist();
      scheduleRequestPreview();
      updateGenerateState();
    });

    el.voiceGrid.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const card = e.target.closest('[data-voice]');
      if (!card) return;
      e.preventDefault();
      card.click();
    });
  }

  async function previewVoice(voiceId, btn) {
    if (!S.hasKey) {
      toast('先填写 API Key 才能试听', { type: 'warn' });
      openDrawer();
      return;
    }
    const cached = previewCache.get(voiceId);
    if (cached) {
      playPreview(cached);
      return;
    }
    btn.classList.add('is-busy');
    btn.textContent = '…';
    try {
      const res = await fetch('/api/voice/preview', {
        method: 'POST',
        headers: headers(true),
        body: JSON.stringify({ voice: voiceId }),
      });
      if (!res.ok) {
        const err = await readError(res);
        toast(err.message, { type: 'error', raw: err.raw });
        return;
      }
      const data = await res.json();
      previewCache.set(voiceId, data.url);
      playPreview(data.url);
    } catch (e) {
      toast('试听失败：' + e.message, { type: 'error' });
    } finally {
      btn.classList.remove('is-busy');
      btn.textContent = '▶';
    }
  }

  function playPreview(url) {
    if (!previewAudio) previewAudio = new Audio();
    previewAudio.pause();
    previewAudio.src = url;
    previewAudio.volume = 0.9;
    previewAudio.play().catch(() => toast('浏览器拦截了播放，请再点一次', { type: 'warn' }));
  }

  /* =====================================================================
     音色设计
     ===================================================================== */

  function renderDesign() {
    const dims = (S.boot && S.boot.design_dimensions) || [];
    const groupHtml = (d) =>
      '<div class="chip-group"><span class="chip-group-label">' + M.escapeHtml(d.group) + '</span>' +
      d.tags
        .map((t) => '<button class="chip chip-insert" data-design-tag="' + M.escapeHtml(t) + '">' + M.escapeHtml(t) + '</button>')
        .join('') +
      '</div>';

    const required = dims.filter((d) => d.required);
    const optional = dims.filter((d) => !d.required);

    el.designChips.innerHTML =
      required.map(groupHtml).join('') +
      (optional.length
        ? '<button class="more-toggle" id="moreDimsBtn" aria-expanded="false">' +
          '<span>＋ 更多维度</span><em>角色人设 / 说话风格 / 场景年代</em></button>' +
          '<div class="chip-groups more-body" id="moreDimsBody" hidden>' + optional.map(groupHtml).join('') + '</div>'
        : '');

    const moreBtn = $('#moreDimsBtn');
    if (moreBtn) {
      moreBtn.addEventListener('click', () => {
        const body = $('#moreDimsBody');
        const open = body.hidden;
        body.hidden = !open;
        moreBtn.setAttribute('aria-expanded', String(open));
        moreBtn.querySelector('span').textContent = open ? '－ 收起更多维度' : '＋ 更多维度';
      });
    }

    el.designChips.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-design-tag]');
      if (!chip) return;
      const tag = chip.dataset.designTag;
      const current = el.designDesc.value.trim();
      if (current.includes(tag)) {
        toast('描述里已有「' + tag + '」', { type: 'warn' });
        return;
      }
      el.designDesc.value = current ? current.replace(/[，,]\s*$/, '') + '，' + tag : tag;
      S.design.desc = el.designDesc.value;
      chip.classList.add('is-on');
      M.persist();
      refreshEditor();
    });

    el.designTemplates.innerHTML = ((S.boot && S.boot.design_templates) || [])
      .map(
        (t) =>
          '<button class="template-card" data-template="' + M.escapeHtml(t.desc) + '"><b>' +
          M.escapeHtml(t.label) + '</b><span>' + M.escapeHtml(t.desc) + '</span></button>'
      )
      .join('');

    el.designTemplates.addEventListener('click', (e) => {
      const card = e.target.closest('[data-template]');
      if (!card) return;
      el.designDesc.value = card.dataset.template;
      S.design.desc = el.designDesc.value;
      M.persist();
      refreshEditor();
      toast('已填入模板：「' + card.querySelector('b').textContent + '」', { type: 'ok' });
    });

    el.optimizeToggle.addEventListener('click', () => {
      S.design.optimize = !S.design.optimize;
      el.optimizeToggle.setAttribute('aria-checked', String(S.design.optimize));
      M.persist();
      applyCaps();
      updateGenerateState();
      scheduleRequestPreview();
    });
  }

  /* =====================================================================
     风格指令 / 导演模式
     ===================================================================== */

  function renderStylePresets() {
    el.stylePresets.innerHTML =
      '<div class="chip-group"><span class="chip-group-label">示例</span>' +
      ((S.boot && S.boot.style_presets) || [])
        .map((p) => '<button class="chip" data-style="' + M.escapeHtml(p.text) + '">' + M.escapeHtml(p.label) + '</button>')
        .join('') +
      '</div>';

    el.stylePresets.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-style]');
      if (!chip) return;
      el.instruction.value = chip.dataset.style;
      S.instruction = el.instruction.value;
      $$('.chip', el.stylePresets).forEach((c) => c.classList.toggle('is-on', c === chip));
      M.persist();
      scheduleRequestPreview();
      updateGenerateState();
    });
  }

  function syncDirectorUi() {
    el.directorToggle.setAttribute('aria-checked', String(S.director.on));
    el.directorFields.hidden = !S.director.on;
    // 导演模式开启时，普通指令框不参与拼装，置灰避免误以为同时在生效
    el.instruction.disabled = S.director.on;
    el.instruction.placeholder = S.director.on
      ? '导演模式已开启，风格由下方三段式决定'
      : '例如：用轻快上扬的语调，语速稍快，带着压抑不住的激动。';
  }

  function initDirector() {
    el.directorToggle.addEventListener('click', () => {
      S.director.on = !S.director.on;
      syncDirectorUi();
      M.persist();
      scheduleRequestPreview();
      updateGenerateState();
    });

    ['role', 'scene', 'guide'].forEach((key) => {
      const box = key === 'role' ? el.directorRole : key === 'scene' ? el.directorScene : el.directorGuide;
      box.addEventListener('input', () => {
        S.director[key] = box.value;
        M.persist();
        scheduleRequestPreview();
        updateGenerateState();
      });
    });

    el.directorExample.addEventListener('click', () => {
      const ex = (S.boot && S.boot.director_example) || {};
      el.directorRole.value = ex.role || '';
      el.directorScene.value = ex.scene || '';
      el.directorGuide.value = ex.guide || '';
      S.director.role = el.directorRole.value;
      S.director.scene = el.directorScene.value;
      S.director.guide = el.directorGuide.value;
      M.persist();
      scheduleRequestPreview();
      toast('已填入文档里的导演模式示例', { type: 'ok' });
    });
  }

  /* =====================================================================
     标签
     ===================================================================== */

  function renderTagGroups() {
    el.openingTagGroups.innerHTML = ((S.boot && S.boot.opening_tags) || [])
      .map(
        (g) =>
          '<div class="chip-group"><span class="chip-group-label">' + M.escapeHtml(g.group) + '</span>' +
          g.tags
            .map(
              (t) =>
                '<button class="chip" data-open-tag="' + M.escapeHtml(t) + '"' +
                (S.openingTags.includes(t) ? ' aria-pressed="true"' : '') + '>' + M.escapeHtml(t) + '</button>'
            )
            .join('') +
          '</div>'
      )
      .join('');

    el.inlineTagGroups.innerHTML = ((S.boot && S.boot.inline_tags) || [])
      .map(
        (g) =>
          '<div class="chip-group"><span class="chip-group-label">' + M.escapeHtml(g.group) + '</span>' +
          g.tags
            .map(
              (t) =>
                '<button class="chip chip-insert" data-inline-tag="' + M.escapeHtml(t) + '">' + M.escapeHtml(t) + '</button>'
            )
            .join('') +
          '</div>'
      )
      .join('');

    el.openingTagGroups.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-open-tag]');
      if (!chip) return;
      const tag = chip.dataset.openTag;
      if (S.singing) {
        S.singing = false;
        el.singingToggle.setAttribute('aria-checked', 'false');
        applyCaps();
      }
      const idx = S.openingTags.indexOf(tag);
      if (idx >= 0) S.openingTags.splice(idx, 1);
      else S.openingTags.push(tag);
      syncOpeningTags();
      M.persist();
      refreshEditor();
    });

    el.inlineTagGroups.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-inline-tag]');
      if (!chip) return;
      insertInlineTag(chip.dataset.inlineTag);
    });

    el.openingClear.addEventListener('click', (e) => {
      e.stopPropagation(); // 别让点击冒泡到折叠头而收起面板
      clearOpening();
    });
  }

  function syncOpeningTags() {
    $$('[data-open-tag]', el.openingTagGroups).forEach((c) => {
      const on = S.openingTags.includes(c.dataset.openTag);
      c.classList.toggle('is-on', on);
      c.setAttribute('aria-pressed', String(on));
    });
    renderOpeningState();
  }

  function renderOpeningState() {
    const value = el.openingFoldValue;
    const clear = el.openingClear;

    if (S.singing) {
      value.textContent = '(唱歌)';
      value.classList.add('is-on');
      clear.hidden = false;
      clear.textContent = '关闭唱歌';
      return;
    }
    if (!S.openingTags.length) {
      value.textContent = '未选择';
      value.classList.remove('is-on');
      clear.hidden = true;
      return;
    }
    value.textContent = '(' + S.openingTags.join(' ') + ')';
    value.classList.add('is-on');
    clear.hidden = false;
    clear.textContent = '清除';
  }

  function clearOpening() {
    if (S.singing) {
      S.singing = false;
      el.singingToggle.setAttribute('aria-checked', 'false');
      applyCaps();
    } else {
      S.openingTags = [];
    }
    syncOpeningTags();
    M.persist();
    refreshEditor();
  }

  function insertInlineTag(tag) {
    const box = el.mainText;
    const start = box.selectionStart != null ? box.selectionStart : box.value.length;
    const end = box.selectionEnd != null ? box.selectionEnd : box.value.length;
    const text = '（' + tag + '）';
    box.value = box.value.slice(0, start) + text + box.value.slice(end);
    S.text = box.value;
    box.focus();
    const pos = start + text.length;
    box.setSelectionRange(pos, pos);
    M.persist();
    refreshEditor();
  }

  /* =====================================================================
     文本编辑区
     ===================================================================== */

  function refreshEditor() {
    el.charCount.textContent = (S.text || '').length + ' 字';
    el.textHint.className = (S.text || '').length > 500 ? 'warn' : 'muted';
    el.textHint.textContent = (S.text || '').length > 500 ? '超过 500 字，流式可能变慢' : '建议 500 字以内，流式播放效果最好';
    renderFinalPreview();
    updateGenerateState();
    scheduleRequestPreview();
  }

  function renderFinalPreview() {
    const text = M.finalAssistant();
    if (!text) {
      el.finalPreview.innerHTML = '<span style="opacity:.5">（还没有输入文本）</span>';
      return;
    }
    el.finalPreview.innerHTML = M.highlightTags(text);
  }

  function initEditor() {
    el.mainText.addEventListener('input', () => {
      S.text = el.mainText.value;
      M.persist();
      refreshEditor();
    });

    el.designDesc.addEventListener('input', () => {
      S.design.desc = el.designDesc.value;
      M.persist();
      updateGenerateState();
      scheduleRequestPreview();
    });

    el.instruction.addEventListener('input', () => {
      S.instruction = el.instruction.value;
      M.persist();
      scheduleRequestPreview();
      updateGenerateState();
    });

    el.clearText.addEventListener('click', () => {
      el.mainText.value = '';
      S.text = '';
      M.persist();
      refreshEditor();
    });

    el.copyFinal.addEventListener('click', async () => {
      const text = M.finalAssistant();
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
        toast('已复制最终内容', { type: 'ok' });
      } catch (e) {
        toast('复制失败，请手动选择文本', { type: 'warn' });
      }
    });

    el.singingToggle.addEventListener('click', () => {
      S.singing = !S.singing;
      el.singingToggle.setAttribute('aria-checked', String(S.singing));
      if (S.singing) S.openingTags = [];
      syncOpeningTags();
      applyCaps();
      M.persist();
      refreshEditor();
    });

    el.streamToggle.addEventListener('click', () => {
      if (!M.caps().stream) return;
      S.stream = !S.stream;
      el.streamToggle.setAttribute('aria-checked', String(S.stream));
      M.persist();
      applyCaps();
      scheduleRequestPreview();
    });
  }

  /* ---- 示例下拉（原生 select 的弹层在深色主题下不可控，这里自己做 ---- */

  function renderSampleMenu() {
    const list = ((S.boot && S.boot.sample_texts) || {})[S.model] || [];
    el.sampleMenu.innerHTML = list.length
      ? list
          .map(
            (t, i) =>
              '<button class="menu-item" role="option" data-idx="' + i + '">' +
              '<b>' + M.escapeHtml(t.label) + '</b>' +
              '<span>' + M.escapeHtml(t.text) + '</span></button>'
          )
          .join('')
      : '<div class="menu-empty">该模型没有示例文本</div>';
  }

  function closeSampleMenu() {
    el.sampleMenu.hidden = true;
    el.sampleBtn.setAttribute('aria-expanded', 'false');
  }

  function toggleSampleMenu() {
    if (!el.sampleMenu.hidden) {
      closeSampleMenu();
      return;
    }
    renderSampleMenu();
    el.sampleMenu.hidden = false;
    el.sampleBtn.setAttribute('aria-expanded', 'true');
  }

  function applySample(idx) {
    const list = ((S.boot && S.boot.sample_texts) || {})[S.model] || [];
    const item = list[idx];
    if (!item) return;
    el.mainText.value = item.text;
    S.text = item.text;
    if (item.label === '唱歌' && M.caps().singing && !S.singing) {
      S.singing = true;
      el.singingToggle.setAttribute('aria-checked', 'true');
      syncOpeningTags();
      applyCaps();
    }
    M.persist();
    refreshEditor();
  }

  function initSampleMenu() {
    el.sampleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleSampleMenu();
    });
    el.sampleMenu.addEventListener('click', (e) => {
      const item = e.target.closest('[data-idx]');
      if (!item) return;
      applySample(Number(item.dataset.idx));
      closeSampleMenu();
    });
    document.addEventListener('click', (e) => {
      if (el.sampleMenu.hidden) return;
      if (!e.target.closest('#sampleWrap')) closeSampleMenu();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !el.sampleMenu.hidden) closeSampleMenu();
    });
  }

  /* ---- 折叠面板 ---- */

  function initFolds() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('mimo.folds') || '{}') || {}; } catch (e) { saved = {}; }

    $$('.fold-head').forEach((head) => {
      const fold = head.closest('.fold');
      const toggle = () => {
        const open = !fold.classList.contains('is-open');
        fold.classList.toggle('is-open', open);
        head.setAttribute('aria-expanded', String(open));
        saved[head.id] = open;
        try { localStorage.setItem('mimo.folds', JSON.stringify(saved)); } catch (e) { /* 忽略 */ }
      };

      if (saved[head.id]) {
        fold.classList.add('is-open');
        head.setAttribute('aria-expanded', 'true');
      }
      head.addEventListener('click', toggle);
      head.addEventListener('keydown', (e) => {
        if (e.target !== head) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggle();
        }
      });
    });
  }

  /* =====================================================================
     请求预览
     ===================================================================== */

  const scheduleRequestPreview = M.debounce(async function () {
    if (el.reqPreview.hidden) return;
    try {
      const res = await fetch('/api/payload', {
        method: 'POST',
        headers: headers(true),
        body: JSON.stringify(M.requestBody()),
      });
      const data = await res.json();
      if (data.error) {
        el.reqPreview.textContent = '// 还差一点参数：' + data.error;
        return;
      }
      el.reqPreview.textContent = JSON.stringify(data.payload, null, 2);
    } catch (e) {
      el.reqPreview.textContent = '// 预览生成失败';
    }
  }, 320);

  function initRequestPreview() {
    el.reqToggle.addEventListener('click', () => {
      el.reqPreview.hidden = !el.reqPreview.hidden;
      el.reqToggle.textContent = el.reqPreview.hidden ? '查看请求' : '收起请求';
      if (!el.reqPreview.hidden) scheduleRequestPreview();
    });
  }

  /* =====================================================================
     音色复刻：上传 / 录音 / 样本库
     ===================================================================== */

  function initClone() {
    el.dropZone.addEventListener('click', () => el.fileInput.click());
    el.dropZone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.fileInput.click(); }
    });

    ['dragenter', 'dragover'].forEach((t) =>
      el.dropZone.addEventListener(t, (e) => {
        e.preventDefault();
        el.dropZone.classList.add('is-drag');
      })
    );
    ['dragleave', 'drop'].forEach((t) =>
      el.dropZone.addEventListener(t, (e) => {
        e.preventDefault();
        el.dropZone.classList.remove('is-drag');
      })
    );
    el.dropZone.addEventListener('drop', (e) => {
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) uploadSample(file, 'upload');
    });

    el.fileInput.addEventListener('change', () => {
      const file = el.fileInput.files && el.fileInput.files[0];
      if (file) uploadSample(file, 'upload');
      el.fileInput.value = '';
    });

    el.recordBtn.addEventListener('click', toggleRecord);
  }

  async function uploadSample(file, kind) {
    const maxBytes = ((S.boot && S.boot.limits && S.boot.limits.max_upload_mb) || 8) * 1024 * 1024;
    if (file.size > maxBytes) {
      el.dzSub.textContent = '文件 ' + M.fmtBytes(file.size) + '，超过 ' + (maxBytes / 1024 / 1024) + 'MB 上限';
      el.dzSub.classList.add('is-error');
      toast('文件过大，请压缩或剪短后重试', { type: 'error' });
      return;
    }
    el.dzSub.classList.remove('is-error');
    el.dzSub.textContent = '正在处理样本…';

    const fd = new FormData();
    fd.append('file', file);
    fd.append('kind', kind);
    try {
      const res = await fetch('/api/clone/prepare', { method: 'POST', body: fd });
      if (!res.ok) {
        const err = await readError(res);
        throw new Error(err.message);
      }
      const sample = await res.json();
      S.clone.samples.unshift(sample);
      S.clone.activeId = sample.id;
      renderSamples();
      updateGenerateState();
      scheduleRequestPreview();
      el.dzSub.textContent = '已就绪：' + sample.name + '（' + M.fmtBytes(sample.bytes) + '，约 ' + Math.round(sample.duration || 0) + ' 秒）';
      toast('样本已加入样本库，并设为当前音色', { type: 'ok' });
    } catch (e) {
      el.dzSub.textContent = '处理失败：' + e.message;
      el.dzSub.classList.add('is-error');
      toast('样本处理失败：' + e.message, { type: 'error' });
    }
  }

  function renderSamples() {
    const samples = S.clone.samples || [];
    el.sampleCount.textContent = samples.length ? '(' + samples.length + ')' : '';
    if (!samples.length) {
      el.sampleList.innerHTML = '<div class="empty-tip">还没有样本，上传或录一段 3–20 秒的清晰人声</div>';
      return;
    }
    el.sampleList.innerHTML = samples
      .map(
        (s) =>
          '<div class="sample-item' + (s.id === S.clone.activeId ? ' is-active' : '') + '" data-sample="' + s.id + '">' +
          '<div class="sample-main"><div class="sample-name">' + M.escapeHtml(s.name) + '</div>' +
          '<div class="sample-meta">' + M.fmtBytes(s.bytes) + ' · ' + Math.round(s.duration || 0) + 's · ' + (s.kind === 'record' ? '录音' : '上传') + '</div></div>' +
          '<div class="sample-actions">' +
          '<button class="mini-btn" data-play="' + M.escapeHtml(s.url) + '" title="试听">▶</button>' +
          '<button class="mini-btn danger" data-del="' + s.id + '" title="删除">✕</button>' +
          '</div></div>'
      )
      .join('');

    el.sampleList.querySelectorAll('.sample-item').forEach((node) => {
      node.addEventListener('click', (e) => {
        if (e.target.closest('[data-play]') || e.target.closest('[data-del]')) return;
        S.clone.activeId = node.dataset.sample;
        renderSamples();
        updateGenerateState();
        scheduleRequestPreview();
      });
    });
    el.sampleList.querySelectorAll('[data-play]').forEach((btn) =>
      btn.addEventListener('click', () => playPreview(btn.dataset.play))
    );
    el.sampleList.querySelectorAll('[data-del]').forEach((btn) =>
      btn.addEventListener('click', async () => {
        const id = btn.dataset.del;
        try {
          await fetch('/api/clone/samples/' + id, { method: 'DELETE' });
          S.clone.samples = S.clone.samples.filter((s) => s.id !== id);
          if (S.clone.activeId === id) S.clone.activeId = (S.clone.samples[0] || {}).id || null;
          renderSamples();
          updateGenerateState();
          scheduleRequestPreview();
        } catch (e) {
          toast('删除失败：' + e.message, { type: 'error' });
        }
      })
    );
  }

  async function loadSamples() {
    try {
      const res = await fetch('/api/clone/samples');
      const data = await res.json();
      S.clone.samples = data.samples || [];
      if (!S.clone.activeId && S.clone.samples[0]) S.clone.activeId = S.clone.samples[0].id;
      renderSamples();
      updateGenerateState();
    } catch (e) { /* 忽略 */ }
  }

  async function toggleRecord() {
    if (rec.recorder && rec.recorder.state === 'recording') {
      stopRecord();
      return;
    }
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      toast('当前浏览器不支持录音，请改为上传 mp3 / wav', { type: 'error' });
      return;
    }
    const mime = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm']
      .find((t) => MediaRecorder.isTypeSupported(t));
    try {
      window.AudioEngine.ensure(); // 电平表要用到 AudioContext
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      rec.stream = stream;
      rec.chunks = [];
      rec.recorder = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 64000 } : undefined);
      rec.recorder.ondataavailable = (e) => { if (e.data && e.data.size) rec.chunks.push(e.data); };
      rec.recorder.onstop = () => {
        const type = (rec.recorder && rec.recorder.mimeType) || 'audio/webm';
        const blob = new Blob(rec.chunks, { type });
        const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
        const file = new File([blob], 'recording.' + ext, { type });
        uploadSample(file, 'record');
        cleanupRecord();
      };
      rec.recorder.start();
      rec.startedAt = Date.now();
      el.recordBtn.classList.add('is-recording');
      el.recordLabel.textContent = '停止录音';
      el.recMeter.classList.add('is-live');
      startMeter(stream);
      rec.autoStop = setTimeout(stopRecord, 30000);
      rec.timer = setInterval(() => {
        const sec = (Date.now() - rec.startedAt) / 1000;
        el.recTime.textContent = M.fmtTime(sec);
      }, 200);
      toast('开始录音，最长 30 秒', { type: 'ok', timeout: 2000 });
    } catch (e) {
      toast('无法访问麦克风：' + e.message, { type: 'error' });
      cleanupRecord();
    }
  }

  function startMeter(stream) {
    try {
      const ctx = window.AudioEngine.context();
      if (!ctx) return;
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 256;
      src.connect(an);
      const data = new Uint8Array(an.frequencyBinCount);
      const bars = $$('#recMeter i');
      rec.nodes = { src, an };
      rec.meter = setInterval(() => {
        an.getByteFrequencyData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i];
        const level = Math.min(1, sum / data.length / 90);
        bars.forEach((b, i) => {
          const h = Math.max(14, Math.min(100, (level * 100) * (0.55 + 0.45 * Math.sin((Date.now() / 120) + i))));
          b.style.height = h + '%';
        });
      }, 90);
    } catch (e) { /* 可视化失败不影响录音 */ }
  }

  function stopRecord() {
    if (rec.recorder && rec.recorder.state === 'recording') {
      try { rec.recorder.stop(); } catch (e) {}
    }
  }

  function cleanupRecord() {
    clearTimeout(rec.autoStop);
    clearInterval(rec.timer);
    clearInterval(rec.meter);
    if (rec.nodes) {
      try { rec.nodes.src.disconnect(); } catch (e) {}
      rec.nodes = null;
    }
    if (rec.stream) {
      rec.stream.getTracks().forEach((t) => t.stop()); // 不关掉麦克风指示灯会一直亮
      rec.stream = null;
    }
    el.recordBtn.classList.remove('is-recording');
    el.recordLabel.textContent = '录一段（最长 30 秒）';
    el.recMeter.classList.remove('is-live');
    $$('#recMeter i').forEach((b) => { b.style.height = '30%'; });
    el.recTime.textContent = '00:00';
  }

  /* =====================================================================
     生成
     ===================================================================== */

  function updateGenerateState() {
    const ok = M.canGenerate();
    el.generateBtn.disabled = generating || !ok;

    if (!S.hasKey) {
      el.generateBtn.title = '请先填写 API Key';
    } else if (S.model === 'mimo-v2.5-tts-voiceclone' && !S.clone.activeId) {
      el.generateBtn.title = '请先上传或录制一段音频样本';
    } else if (!M.finalAssistant().trim() && !(M.caps().optimize_text && S.design.optimize)) {
      el.generateBtn.title = '请先输入要合成的文本';
    } else if (S.model === 'mimo-v2.5-tts-voicedesign' && !M.finalUser()) {
      el.generateBtn.title = '请先填写音色描述';
    } else {
      el.generateBtn.title = 'Ctrl + Enter 快捷键生成';
    }
    el.banner.hidden = !!S.hasKey;
  }

  function setMeta(data) {
    el.metaFirst.textContent = data.first_audio_ms != null ? M.fmtMs(data.first_audio_ms) : (data.latency_ms != null ? M.fmtMs(data.latency_ms) : '—');
    el.metaTotal.textContent = data.total_ms != null ? M.fmtMs(data.total_ms) : (data.latency_ms != null ? M.fmtMs(data.latency_ms) : '—');
    el.metaDur.textContent = data.duration ? data.duration.toFixed(2) + 's' : '—';
    el.metaSize.textContent = data.bytes ? M.fmtBytes(data.bytes) : '—';
  }

  function loadPlayer(url, opts) {
    opts = opts || {};
    player.url = url;
    player.lastUrl = url;
    player.lastDuration = opts.duration || 0;
    player.kind = 'element';
    el.audioEl.src = url;
    el.audioEl.loop = player.loop;
    el.downloadBtn.href = url;
    el.downloadBtn.setAttribute('download', (opts.filename || 'mimo-tts.wav'));
    el.downloadBtn.setAttribute('aria-disabled', 'false');
    el.playerEmpty.classList.add('is-hidden');
    el.playBtn.disabled = false;
    el.seekBar.value = 0;
    el.curTime.textContent = '0:00';
    if (opts.duration) el.durTime.textContent = M.fmtTime(opts.duration);
    window.AudioEngine.attachElement(el.audioEl);
  }

  async function startPlay() {
    if (player.kind !== 'element' || !el.audioEl.src) return;
    try {
      await el.audioEl.play();
    } catch (e) {
      toast('浏览器阻止了自动播放，请点一下播放键', { type: 'warn' });
    }
  }

  function stopPlayback(silent) {
    if (abortCtl) {
      try { abortCtl.abort(); } catch (e) {}
      abortCtl = null;
    }
    window.AudioEngine.reset();
    try { el.audioEl.pause(); } catch (e) {}
    el.playBtn.classList.remove('is-playing');
    setBusy(false);
    updateGenerateState();
    if (!silent) {
      if (player.lastUrl) {
        loadPlayer(player.lastUrl, { duration: player.lastDuration });
        setStatus('已停止，可点播放键重听已生成的部分');
      } else {
        setStatus('已停止');
      }
    }
  }

  async function generate() {
    if (generating) return;
    if (!S.hasKey) { openDrawer(); return; }
    if (!M.canGenerate()) return;

    // 必须在点击的同步栈内解锁 AudioContext，否则流式播放会被静音
    window.AudioEngine.ensure();

    stopPlayback(true);
    setBusy(true);
    setStatus('正在请求…');

    const body = M.requestBody();
    const useStream = body.stream;

    if (useStream) {
      await runStream(body);
    } else {
      await runOnce(body);
    }
  }

  async function runOnce(body) {
    player.streamBytes = 0;
    try {
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: headers(true),
        body: JSON.stringify({ ...body, stream: false }),
      });
      if (!res.ok) {
        const err = await readError(res);
        throw err;
      }
      const data = await res.json();
      setMeta({ latency_ms: data.latency_ms, total_ms: data.latency_ms, duration: data.duration, bytes: data.bytes });
      loadPlayer(data.url, { filename: data.filename, duration: data.duration });
      await startPlay();
      setStatus('完成 · 整段生成 ' + M.fmtMs(data.latency_ms), 'ok');
      pushHistory(body, data);
    } catch (e) {
      const message = e && e.message ? e.message : '生成失败';
      setStatus(message, 'error');
      toast(message, { type: 'error', raw: e && e.raw });
    } finally {
      setBusy(false);
      updateGenerateState();
    }
  }

  async function runStream(body) {
    player.streamBytes = 0;
    player.kind = 'stream';
    el.playerEmpty.classList.add('is-hidden');
    el.playBtn.disabled = false;
    el.downloadBtn.setAttribute('aria-disabled', 'true');
    abortCtl = new AbortController();
    let meta = null;
    let generatedText = '';
    let settled = false;

    // 收尾只做一次：等最后一块 PCM 播完，才把 <audio> 挂上去。
    // 提前挂会读 element 的 0 进度，波形与进度条会瞬间归零。
    function settle() {
      if (settled) return;
      settled = true;
      el.playBtn.classList.remove('is-playing');
      if (meta) {
        loadPlayer(meta.url, { filename: meta.filename, duration: meta.duration });
        setStatus(
          '完成 · 首包 ' + M.fmtMs(meta.first_audio_ms) + ' · 总耗时 ' + M.fmtMs(meta.total_ms),
          'ok'
        );
      } else {
        setStatus('流式播放结束', 'ok');
      }
      setBusy(false);
      updateGenerateState();
    }

    window.AudioEngine.beginStream(settle);
    el.playBtn.classList.add('is-playing');

    try {
      const res = await fetch('/api/tts/stream', {
        method: 'POST',
        headers: headers(true),
        body: JSON.stringify({ ...body, stream: true }),
        signal: abortCtl.signal,
      });
      if (!res.ok) {
        const err = await readError(res);
        throw err;
      }
      if (!res.body) throw new Error('当前浏览器不支持流式读取');

      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let firstChunk = true;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let idx;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const lines = raw.split('\n');
          for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            let evt;
            try { evt = JSON.parse(line.slice(5).trim()); } catch (e) { continue; }
            if (evt.type === 'ack') {
              setStatus('模型正在合成…');
            } else if (evt.type === 'audio') {
              if (firstChunk) {
                firstChunk = false;
                setStatus('正在流式播放…');
              }
              player.streamBytes += Math.floor((evt.data.length * 3) / 4);
              window.AudioEngine.appendPCM(evt.data);
              el.metaSize.textContent = M.fmtBytes(player.streamBytes);
              el.metaDur.textContent = (player.streamBytes / 2 / 24000).toFixed(2) + 's';
            } else if (evt.type === 'text') {
              generatedText += evt.text;
              setStatus('模型润色：' + generatedText.slice(-40));
            } else if (evt.type === 'meta') {
              meta = evt;
              player.lastUrl = evt.url;
              player.lastDuration = evt.duration;
              setMeta(evt);
            } else if (evt.type === 'error') {
              throw new Error(evt.message || '生成失败');
            }
          }
        }
      }

      window.AudioEngine.endStream();
      if (!meta) {
        if (!player.streamBytes) throw new Error('没有收到音频数据');
        return;
      }

      if (meta.generated_text) generatedText = meta.generated_text;
      pushHistory(body, meta, generatedText);

      // 短音频可能在 meta 到达前就播完了，这里补一次收尾
      if (!window.AudioEngine.state().playing) settle();
      else setStatus('生成完成，正在播放…（点停止按钮可打断）', 'ok');
    } catch (e) {
      const aborted = e && (e.name === 'AbortError');
      window.AudioEngine.reset();
      el.playBtn.classList.remove('is-playing');
      if (aborted) {
        setStatus('已停止');
      } else {
        const message = e && e.message ? e.message : '流式生成失败';
        setStatus(message, 'error');
        toast(message, { type: 'error', raw: e && e.raw });
      }
    } finally {
      abortCtl = null;
      setBusy(false);
      updateGenerateState();
    }
  }

  function initPlayer() {
    el.playBtn.addEventListener('click', () => {
      if (player.kind === 'stream' && window.AudioEngine.state().playing) {
        stopPlayback();
        return;
      }
      if (player.kind !== 'element' || !el.audioEl.src) return;
      window.AudioEngine.ensure();
      if (el.audioEl.paused) {
        window.AudioEngine.attachElement(el.audioEl);
        el.audioEl.play().catch(() => {});
      } else {
        el.audioEl.pause();
      }
    });

    el.audioEl.addEventListener('play', () => el.playBtn.classList.add('is-playing'));
    el.audioEl.addEventListener('pause', () => el.playBtn.classList.remove('is-playing'));
    el.audioEl.addEventListener('ended', () => el.playBtn.classList.remove('is-playing'));
    el.audioEl.addEventListener('loadedmetadata', () => {
      if (isFinite(el.audioEl.duration)) el.durTime.textContent = M.fmtTime(el.audioEl.duration);
    });

    el.seekBar.addEventListener('input', () => {
      if (player.kind !== 'element' || !isFinite(el.audioEl.duration)) return;
      const ratio = Number(el.seekBar.value) / 1000;
      el.audioEl.currentTime = ratio * el.audioEl.duration;
    });

    el.loopBtn.addEventListener('click', () => {
      player.loop = !player.loop;
      el.audioEl.loop = player.loop;
      el.loopBtn.classList.toggle('is-on', player.loop);
    });

    let lastVolume = 0.85;
    el.volBar.addEventListener('input', () => {
      const v = Number(el.volBar.value) / 100;
      lastVolume = v;
      window.AudioEngine.setVolume(v);
      el.audioEl.volume = v;
      if (v > 0) { player.muted = false; el.muteBtn.textContent = '🔊'; }
    });

    el.muteBtn.addEventListener('click', () => {
      player.muted = !player.muted;
      el.muteBtn.textContent = player.muted ? '🔈' : '🔊';
      window.AudioEngine.setMuted(player.muted);
      el.audioEl.volume = player.muted ? 0 : lastVolume;
    });

    // 统一的进度刷新
    function tick() {
      requestAnimationFrame(tick);
      const st = window.AudioEngine.state();
      let position = 0;
      let duration = 0;

      if (player.kind === 'stream') {
        position = st.position;
        duration = st.duration;
      } else if (player.kind === 'element') {
        position = el.audioEl.currentTime || 0;
        duration = isFinite(el.audioEl.duration) ? el.audioEl.duration : 0;
      }

      if (duration > 0) {
        el.seekBar.value = String(Math.round((position / duration) * 1000));
        el.curTime.textContent = M.fmtTime(position);
        el.durTime.textContent = M.fmtTime(duration);
      }
    }
    tick();
  }

  /* =====================================================================
     历史
     ===================================================================== */

  function pushHistory(body, meta, generatedText) {
    const item = {
      id: Date.now().toString(36),
      url: meta.url,
      filename: meta.filename,
      model: body.model,
      short: (M.modelMeta().short || '').slice(0, 4),
      text: (M.finalAssistant() || generatedText || M.finalUser() || '').slice(0, 90),
      duration: meta.duration || 0,
      bytes: meta.bytes || 0,
      first: meta.first_audio_ms != null ? meta.first_audio_ms : meta.latency_ms,
      total: meta.total_ms != null ? meta.total_ms : meta.latency_ms,
      streamed: !!meta.streamed,
      createdAt: Date.now(),
      params: {
        model: body.model,
        voice: body.voice || null,
        instruction: body.instruction || '',
        text: M.finalAssistant(),
        openingTags: S.openingTags.slice(),
        singing: S.singing,
        design: { desc: S.design.desc, optimize: S.design.optimize },
        director: { ...S.director },
        stream: S.stream,
        sampleId: body.sample_id || null,
      },
    };
    M.addHistory(item);
    renderHistory();
  }

  function renderHistory() {
    const list = S.history || [];
    if (!list.length) {
      el.historyList.innerHTML = '<div class="empty-tip">还没有生成记录</div>';
      return;
    }
    el.historyList.innerHTML = list
      .map(
        (h) =>
          '<div class="history-item" data-id="' + h.id + '">' +
          '<span class="h-badge">' + M.escapeHtml(h.short || '') + '</span>' +
          '<div class="h-main"><div class="h-text">' + M.escapeHtml(h.text || '') + '</div>' +
          '<div class="h-meta">' + M.fmtTime(h.duration || 0) + ' · ' + (h.streamed ? '流式' : '整段') +
          (h.first ? ' · 首包 ' + M.fmtMs(h.first) : '') + '</div></div>' +
          '<div class="h-actions">' +
          '<button class="mini-btn" data-h-play="' + M.escapeHtml(h.url) + '" data-h-dur="' + (h.duration || 0) + '" title="播放">▶</button>' +
          '<button class="mini-btn" data-h-reuse="' + h.id + '" title="复用参数">↺</button>' +
          '<a class="mini-btn" href="' + M.escapeHtml(h.url) + '" download="' + M.escapeHtml(h.filename || 'mimo.wav') + '" title="下载">⬇</a>' +
          '</div></div>'
      )
      .join('');

    el.historyList.querySelectorAll('[data-h-play]').forEach((btn) =>
      btn.addEventListener('click', async () => {
        window.AudioEngine.reset();
        loadPlayer(btn.dataset.hPlay, { duration: Number(btn.dataset.hDur) });
        setMeta({ duration: Number(btn.dataset.hDur) });
        await startPlay();
      })
    );

    el.historyList.querySelectorAll('[data-h-reuse]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const item = S.history.find((h) => h.id === btn.dataset.hReuse);
        if (!item || !item.params) return;
        applyParams(item.params);
        toast('已回填当时的参数', { type: 'ok' });
      })
    );
  }

  function applyParams(p) {
    selectModel(p.model);
    if (p.voice) S.voice = p.voice;
    S.openingTags = Array.isArray(p.openingTags) ? p.openingTags.slice() : [];
    S.singing = !!p.singing;
    S.instruction = p.instruction || '';
    S.text = p.text || '';
    if (p.design) S.design = { desc: p.design.desc || '', optimize: !!p.design.optimize };
    if (p.director) S.director = { on: !!p.director.on, role: p.director.role || '', scene: p.director.scene || '', guide: p.director.guide || '' };
    if (p.sampleId) S.clone.activeId = p.sampleId;
    S.stream = p.stream !== false;

    el.instruction.value = S.instruction;
    el.mainText.value = S.text;
    el.designDesc.value = S.design.desc;
    el.directorRole.value = S.director.role;
    el.directorScene.value = S.director.scene;
    el.directorGuide.value = S.director.guide;
    syncDirectorUi();
    el.optimizeToggle.setAttribute('aria-checked', String(S.design.optimize));
    el.singingToggle.setAttribute('aria-checked', String(S.singing));
    $$('.voice-card', el.voiceGrid).forEach((c) => c.classList.toggle('is-active', c.dataset.voice === S.voice));
    renderSamples();
    applyCaps();
    syncOpeningTags();
    refreshEditor();
    M.persist();
  }

  /* =====================================================================
     设置抽屉
     ===================================================================== */

  function openDrawer() {
    el.drawer.hidden = false;
    el.drawerMask.hidden = false;
    el.keyInput.value = S.key || '';
    el.keyInput.focus();
  }

  function closeDrawer() {
    el.drawer.hidden = true;
    el.drawerMask.hidden = true;
  }

  function initSettings() {
    el.settingsBtn.addEventListener('click', openDrawer);
    el.bannerKeyBtn.addEventListener('click', openDrawer);
    el.drawerClose.addEventListener('click', closeDrawer);
    el.drawerMask.addEventListener('click', closeDrawer);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !el.drawer.hidden) closeDrawer();
    });

    el.saveKey.addEventListener('click', async () => {
      const key = el.keyInput.value.trim();
      if (!key) {
        el.keyResult.textContent = '请输入 Key';
        el.keyResult.className = 'drawer-result is-error';
        return;
      }
      S.key = key;
      try { localStorage.setItem(LS.key, key); } catch (e) {}
      el.keyResult.textContent = '正在验证…';
      el.keyResult.className = 'drawer-result';

      try {
        await fetch('/api/settings', {
          method: 'POST',
          headers: headers(true),
          body: JSON.stringify({ api_key: key, persist: el.persistKey.checked }),
        });
        const res = await fetch('/api/settings/test', { headers: headers(false) });
        const data = await res.json();
        if (data.ok) {
          S.hasKey = true;
          el.keyResult.textContent = '连接成功 · 试合成 ' + M.fmtMs(data.latency_ms) + ' · ' + M.fmtBytes(data.bytes);
          el.keyResult.className = 'drawer-result is-ok';
          el.settingsBtn.classList.remove('is-alert');
          updateGenerateState();
          toast('API Key 可用，开始合成吧', { type: 'ok' });
          setTimeout(closeDrawer, 900);
        } else {
          el.keyResult.textContent = data.error || '验证失败';
          el.keyResult.className = 'drawer-result is-error';
          el.settingsBtn.classList.add('is-alert');
        }
      } catch (e) {
        el.keyResult.textContent = '验证请求失败：' + e.message;
        el.keyResult.className = 'drawer-result is-error';
      }
    });

    el.clearKey.addEventListener('click', async () => {
      S.key = '';
      try { localStorage.removeItem(LS.key); } catch (e) {}
      el.keyInput.value = '';
      await fetch('/api/settings', {
        method: 'POST',
        headers: headers(true),
        body: JSON.stringify({ api_key: '', persist: false }),
      }).catch(() => {});
      try {
        const res = await fetch('/api/bootstrap', { headers: headers(false) });
        const data = await res.json();
        S.hasKey = !!data.key_configured;
      } catch (e) {
        S.hasKey = false;
      }
      el.keyResult.textContent = '已清除本机保存的 Key';
      el.keyResult.className = 'drawer-result';
      updateGenerateState();
    });
  }

  /* =====================================================================
     启动
     ===================================================================== */

  async function boot() {
    initTheme();
    M.restore();
    M.loadHistory();

    let boot = null;
    try {
      const res = await fetch('/api/bootstrap', { headers: headers(false) });
      boot = await res.json();
    } catch (e) {
      toast('无法连接本地服务，请确认后端已启动', { type: 'error' });
      return;
    }
    S.boot = boot;
    S.hasKey = !!S.key || !!boot.key_configured;

    el.baseUrl.textContent = (boot.limits && boot.limits.base_url) || '—';
    el.ffmpegState.textContent = boot.ffmpeg_available ? '可用（支持录音）' : '未检测到（仅支持上传）';
    el.keySource.textContent = S.key ? '已填写' : boot.key_configured ? '来自 .env' : '未配置';
    if (!boot.ffmpeg_available) {
      el.recordBtn.disabled = true;
      el.recordBtn.title = '本机未检测到 ffmpeg，录音后无法转码，请改为上传 mp3 / wav';
      el.dzSub.textContent = '本机未检测到 ffmpeg，仅支持上传 mp3 / wav';
    }

    renderIntro();
    renderVoices();
    renderDesign();
    renderStylePresets();
    renderTagGroups();
    initDirector();
    initEditor();
    initClone();
    initPlayer();
    initSettings();
    initRequestPreview();
    initSampleMenu();
    initFolds();
    renderSampleMenu();
    renderHistory();
    loadSamples();

    // 恢复上次状态到控件
    el.instruction.value = S.instruction;
    el.mainText.value = S.text;
    el.designDesc.value = S.design.desc;
    el.directorRole.value = S.director.role;
    el.directorScene.value = S.director.scene;
    el.directorGuide.value = S.director.guide;
    syncDirectorUi();
    el.optimizeToggle.setAttribute('aria-checked', String(S.design.optimize));

    $$('.seg', el.tabs).forEach((b) => b.classList.toggle('is-active', b.dataset.model === S.model));
    if (!S.boot.models.some((m) => m.id === S.model)) S.model = S.boot.models[0].id;

    el.tabs.addEventListener('click', (e) => {
      const btn = e.target.closest('.seg');
      if (!btn || btn.classList.contains('is-active')) return;
      selectModel(btn.dataset.model);
    });
    window.addEventListener('resize', updateThumb);

    updateThumb();
    selectModel(S.model);
    syncOpeningTags();
    refreshEditor();
    setMeta({});
    updateGenerateState();
    window.AudioEngine.startDrawLoop(); // 空态波形先画出来
    setTimeout(updateThumb, 80);

    el.generateBtn.addEventListener('click', generate);
    el.stopBtn.addEventListener('click', () => stopPlayback());

    el.clearHistory.addEventListener('click', () => {
      S.history = [];
      M.saveHistory();
      renderHistory();
    });

    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        generate();
      }
      if (e.key === 'Escape' && player.kind === 'stream') stopPlayback();
    });

    if (!S.key && !boot.key_configured) {
      el.settingsBtn.classList.add('is-alert');
      setTimeout(() => toast('先在右上角齿轮里填入 API Key', { type: 'warn', timeout: 5200 }), 700);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
