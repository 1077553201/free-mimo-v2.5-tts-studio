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
    finalNote: $('#finalNote'),
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
    historyCount: $('#historyCount'),
    clearHistory: $('#clearHistory'),
    themeToggle: $('#themeToggle'),
    settingsBtn: $('#settingsBtn'),
    drawer: $('#drawer'),
    drawerMask: $('#drawerMask'),
    drawerClose: $('#drawerClose'),
    baseInput: $('#baseInput'),
    basePresets: $('#basePresets'),
    keyInput: $('#keyInput'),
    saveKey: $('#saveKey'),
    clearKey: $('#clearKey'),
    keyResult: $('#keyResult'),
    keySource: $('#keySource'),
    storeState: $('#storeState'),
    storeCount: $('#storeCount'),
    toasts: $('#toasts'),
    bannerKeyBtn: $('#bannerKeyBtn'),
  };


  const player = { kind: 'none', url: '', loop: false, muted: false, streamBytes: 0 };
  let abortCtl = null;
  let generating = false;
  const previewCache = new Map();
  // 试听/样本播放：同一个播放器，key 用来判断「是不是同一段」
  const preview = { audio: null, url: '', btn: null, key: '' };
  let rec = { recorder: null, stream: null, chunks: [], startedAt: 0, timer: null, meter: null, nodes: null, autoStop: null };

  /* =====================================================================
     基础工具
     ===================================================================== */


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
    const talkMode = S.model === 'talk';
    $$('.model-card').forEach((card) => { card.hidden = talkMode; });
    if (el.talkCard) el.talkCard.hidden = !talkMode;
    // 对话页占满整行：播放器与历史记录只服务 TTS 页
    document.body.classList.toggle('is-talk', talkMode);
    const rightCol = document.querySelector('.col-right');
    if (rightCol) rightCol.hidden = talkMode;
    if (talkMode) return;          // 对话页不参与模型能力门控

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
      el.mainText.placeholder = '输入要合成的文本，行内情绪用方括号，例如 [叹气] [轻笑]。';
    }
  }

  function selectModel(modelId) {
    const wasTalk = S.model === 'talk';
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

    if (modelId === 'talk') {
      if (window.Talk) window.Talk.onEnter();   // 深链直接进对话页时也要初始化
    } else if (wasTalk && window.Talk) {
      window.Talk.onLeave();
    }
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
          '<button class="voice-play" data-preview="' + M.escapeHtml(v.id) + '" data-preview-key="voice:' + M.escapeHtml(v.id) + '" title="试听">▶</button></div>' +
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

    syncPreviewBtns('.voice-play');
  }

  let voiceAbort = null;

  async function previewVoice(voiceId, btn) {
    if (!S.hasKey) {
      toast('先填写 API Key 才能试听', { type: 'warn' });
      openDrawer();
      return;
    }
    // 还在请求中：再点一次就是取消
    if (btn.classList.contains('is-busy')) {
      if (voiceAbort) {
        try { voiceAbort.abort(); } catch (e) {}
        voiceAbort = null;
      }
      return;
    }
    const key = 'voice:' + voiceId;
    // 同一段还在响：再点就是停止
    if (preview.key === key && preview.audio && !preview.audio.paused) {
      stopPreview();
      return;
    }
    const cached = previewCache.get(voiceId);
    if (cached) {
      togglePreview(cached, btn, key);
      return;
    }
    const oldLabel = btn.textContent;
    btn.classList.add('is-busy');
    btn.textContent = '…';
    voiceAbort = new AbortController();
    try {
      // 先看本地缓存（24 小时），省一次请求
      const row = await MimoStore.cacheGet('preview:' + voiceId, 24 * 3600 * 1000).catch(() => null);
      if (row && row.value instanceof Blob) {
        const cachedUrl = MimoStore.objectUrl(row.value);
        previewCache.set(voiceId, cachedUrl);
        togglePreview(cachedUrl, btn, key);
        return;
      }
      const result = await MimoApi.synthesize({
        model: 'mimo-v2.5-tts',
        text: (S.boot && S.boot.voice_preview_text) || '你好，这是音色试听。',
        instruction: '自然、亲和，像和朋友随口聊天。',
        voice: voiceId,
        key: S.key,
        baseUrl: S.base,
        signal: voiceAbort.signal,
      });
      MimoStore.cachePut('preview:' + voiceId, result.blob).catch(() => {});
      const url = MimoStore.objectUrl(result.blob);
      previewCache.set(voiceId, url);
      togglePreview(url, btn, key);
    } catch (e) {
      if (e && e.name === 'AbortError') {
        toast('已取消试听', { type: 'ok', timeout: 1200 });
      } else {
        toast('试听失败：' + (e && e.message ? e.message : '未知错误'), { type: 'error' });
      }
      btn.textContent = oldLabel;
    } finally {
      voiceAbort = null;
      btn.classList.remove('is-busy');
      if (preview.key !== key) btn.textContent = oldLabel || '▶';
    }
  }

  function setPreviewBtn(btn, playing) {
    if (!btn) return;
    btn.textContent = playing ? '■' : '▶';
    btn.classList.toggle('is-playing', playing);
    btn.title = playing ? '停止' : '试听';
  }

  /** 停止一切试听（样本 / 音色），并把按钮图标复位 */
  function stopPreview() {
    if (preview.audio) {
      try { preview.audio.pause(); } catch (e) {}
      try { preview.audio.currentTime = 0; } catch (e) {}
    }
    setPreviewBtn(preview.btn, false);
    preview.key = '';
    preview.url = '';
    preview.btn = null;
  }

  /** 播放 / 停止同一段音频。key 相同且正在响 → 停；否则换源播放 */
  function togglePreview(url, btn, key) {
    const k = key || url;
    if (preview.audio && preview.key === k && !preview.audio.paused) {
      stopPreview();
      return;
    }
    stopPreview();
    if (!preview.audio) {
      preview.audio = new Audio();
      preview.audio.addEventListener('ended', () => {
        setPreviewBtn(preview.btn, false);
        preview.key = '';
        preview.url = '';
      });
    }
    preview.url = url;
    preview.key = k;
    preview.btn = btn;
    preview.audio.src = url;
    preview.audio.volume = 0.9;
    setPreviewBtn(btn, true);
    preview.audio.play().catch(() => {
      toast('浏览器拦截了播放，请再点一次', { type: 'warn' });
      setPreviewBtn(btn, false);
      preview.key = '';
    });
  }

  /** 列表重绘后，把正在播放的那一条的按钮重新标成「停止」 */
  function syncPreviewBtns(selector) {
    if (!preview.key || !preview.audio || preview.audio.paused) return;
    const hit = $$(selector).find((n) => n.dataset.previewKey === preview.key);
    if (hit) {
      preview.btn = hit;
      setPreviewBtn(hit, true);
    }
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
    const text = '[' + tag + ']';
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
    if (el.finalNote) el.finalNote.hidden = !S.singing;
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
      const body = M.requestBody();
      const sampleDataUrl = body.sampleId ? await sampleDataUrlFor(body.sampleId) : null;
      const payload = MimoApi.buildPayload({
        model: body.model,
        text: body.text,
        instruction: body.instruction,
        voice: body.voice,
        stream: body.stream,
        optimize: body.optimize,
        sampleDataUrl,
      });
      el.reqPreview.textContent = JSON.stringify(MimoApi.redactPayload(payload), null, 2);
    } catch (e) {
      el.reqPreview.textContent = '// 还差一点参数：' + (e && e.message ? e.message : '参数不完整');
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

  function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /** 样本的 data URL（发给接口用），从本地库里现取，避免把大块 Base64 常驻内存 */
  async function sampleDataUrlFor(id) {
    const row = await MimoStore.getSample(id);
    if (!row || !row.blob) return null;
    return MimoApi.blobToDataUrl(row.blob);
  }

  async function uploadSample(file, kind) {
    const maxBytes = ((S.boot && S.boot.limits && S.boot.limits.max_sample_mb) || 8) * 1024 * 1024;
    if (file.size > maxBytes) {
      el.dzSub.textContent = '文件 ' + M.fmtBytes(file.size) + '，超过 ' + (maxBytes / 1024 / 1024) + 'MB 上限';
      el.dzSub.classList.add('is-error');
      toast('文件过大，请压缩或剪短后重试', { type: 'error' });
      return;
    }
    el.dzSub.classList.remove('is-error');
    el.dzSub.textContent = '正在处理样本…';

    try {
      // mp3 体积小、接口原生支持，直接用；其它格式（webm/ogg/m4a/wav）
      // 在本地解码成单声道 WAV —— 替代后端那一步 ffmpeg。
      const isMp3 = /\.mp3$/i.test(file.name) || file.type === 'audio/mpeg';
      const blob = isMp3 ? file : await MimoApi.toWavBlob(file);
      const duration = await MimoApi.probeDuration(blob);
      if (blob.size > 10 * 1024 * 1024) {
        throw new Error('转换后超过 10MB，请剪短一点');
      }

      const sample = {
        id: newId(),
        name: (file.name || '').replace(/\.[^.]+$/, '').slice(0, 40) || (kind === 'record' ? '录音样本' : '上传样本'),
        kind: kind || 'upload',
        mime: blob.type || 'audio/wav',
        bytes: blob.size,
        duration: Math.round((duration || 0) * 10) / 10,
        created: Date.now(),
        blob,
      };
      await MimoStore.addSample(sample);
      S.clone.urls[sample.id] = MimoStore.objectUrl(blob);
      const meta = { ...sample, url: S.clone.urls[sample.id] };
      delete meta.blob;
      S.clone.samples.unshift(meta);
      S.clone.activeId = sample.id;
      renderSamples();
      updateGenerateState();
      scheduleRequestPreview();
      el.dzSub.textContent = '已就绪：' + sample.name + '（' + M.fmtBytes(sample.bytes) + '，约 ' + Math.round(sample.duration || 0) + ' 秒）';
      toast('样本已保存到本机，并设为当前音色', { type: 'ok' });
    } catch (e) {
      el.dzSub.textContent = '处理失败：' + (e && e.message ? e.message : '未知错误');
      el.dzSub.classList.add('is-error');
      toast('样本处理失败：' + (e && e.message ? e.message : '未知错误'), { type: 'error' });
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
          '<button class="mini-btn" data-play="' + M.escapeHtml(s.url || '') + '" data-preview-key="sample:' + M.escapeHtml(s.url || '') + '" title="试听">▶</button>' +
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
      btn.addEventListener('click', () => {
        const url = btn.dataset.play;
        if (url) togglePreview(url, btn, 'sample:' + url);
      })
    );
    el.sampleList.querySelectorAll('[data-del]').forEach((btn) =>
      btn.addEventListener('click', async () => {
        const id = btn.dataset.del;
        try {
          await MimoStore.deleteSample(id);
          const gone = S.clone.samples.find((s) => s.id === id);
          if (gone && gone.url) {
            if (preview.key === 'sample:' + gone.url) stopPreview();
            MimoStore.revoke(gone.url);
          }
          delete S.clone.urls[id];
          S.clone.samples = S.clone.samples.filter((s) => s.id !== id);
          if (S.clone.activeId === id) S.clone.activeId = (S.clone.samples[0] || {}).id || null;
          renderSamples();
          updateGenerateState();
          scheduleRequestPreview();
        } catch (e) {
          toast('删除失败：' + (e && e.message ? e.message : '未知错误'), { type: 'error' });
        }
      })
    );

    syncPreviewBtns('[data-play]');
  }

  async function loadSamples() {
    try {
      const rows = await MimoStore.listSamples();
      S.clone.samples = rows.map((r) => {
        if (!S.clone.urls[r.id]) S.clone.urls[r.id] = MimoStore.objectUrl(r.blob);
        return {
          id: r.id,
          name: r.name,
          kind: r.kind,
          mime: r.mime,
          bytes: r.bytes,
          duration: r.duration,
          created: r.created,
          url: S.clone.urls[r.id],
        };
      });
      if (!S.clone.activeId && S.clone.samples[0]) S.clone.activeId = S.clone.samples[0].id;
      if (S.clone.activeId && !S.clone.samples.some((s) => s.id === S.clone.activeId)) {
        S.clone.activeId = (S.clone.samples[0] || {}).id || null;
      }
      renderSamples();
      updateGenerateState();
    } catch (e) { /* 本地库不可用时静默 */ }
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
    abortCtl = new AbortController();
    try {
      const sampleDataUrl = body.sampleId ? await sampleDataUrlFor(body.sampleId) : null;
      const result = await MimoApi.synthesize({
        model: body.model,
        text: body.text,
        instruction: body.instruction,
        voice: body.voice,
        optimize: body.optimize,
        sampleDataUrl,
        key: S.key,
        baseUrl: S.base,
        signal: abortCtl.signal,
      });
      const duration = await MimoApi.probeDuration(result.blob);
      const url = MimoStore.objectUrl(result.blob);
      const filename = 'mimo-' + Date.now().toString(36) + '.wav';
      setMeta({ latency_ms: result.latencyMs, total_ms: result.latencyMs, duration, bytes: result.bytes });
      loadPlayer(url, { filename, duration });
      await startPlay();
      setStatus('完成 · 整段生成 ' + M.fmtMs(result.latencyMs), 'ok');
      pushHistory(
        body,
        {
          blob: result.blob,
          url,
          filename,
          duration,
          bytes: result.bytes,
          first_audio_ms: result.latencyMs,
          total_ms: result.latencyMs,
          streamed: false,
        },
        ''
      );
    } catch (e) {
      const message = e && e.message ? e.message : '生成失败';
      setStatus(message, 'error');
      toast(message, { type: 'error', raw: e && e.raw });
    } finally {
      abortCtl = null;
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
      const sampleDataUrl = body.sampleId ? await sampleDataUrlFor(body.sampleId) : null;
      setStatus('模型正在合成…');
      const result = await MimoApi.streamSynthesize({
        model: body.model,
        text: body.text,
        instruction: body.instruction,
        voice: body.voice,
        optimize: body.optimize,
        sampleDataUrl,
        key: S.key,
        baseUrl: S.base,
        signal: abortCtl.signal,
        onAudio(base64, bytes) {
          if (!player.streamBytes) setStatus('正在流式播放…');
          player.streamBytes += bytes.length;
          window.AudioEngine.appendPCM(base64);
          el.metaSize.textContent = M.fmtBytes(player.streamBytes);
          el.metaDur.textContent = (player.streamBytes / 2 / 24000).toFixed(2) + 's';
        },
        onText(text) {
          generatedText += text;
          setStatus('模型润色：' + generatedText.slice(-40));
        },
      });

      window.AudioEngine.endStream();
      if (!player.streamBytes) throw new Error('没有收到音频数据');

      // 边播边收，结束后在本地拼一份完整 WAV，供下载与历史回放
      const blob = MimoApi.pcmToWavBlob(result.pcm, 24000);
      const duration = blob.size > 44 ? (blob.size - 44) / 2 / 24000 : 0;
      const url = MimoStore.objectUrl(blob);
      const filename = 'mimo-' + Date.now().toString(36) + '.wav';
      meta = {
        blob,
        url,
        filename,
        duration,
        bytes: blob.size,
        first_audio_ms: result.firstAudioMs,
        total_ms: result.totalMs,
        streamed: true,
        generated_text: result.text || generatedText,
      };
      player.lastUrl = url;
      player.lastDuration = duration;
      setMeta(meta);
      pushHistory(body, meta, meta.generated_text);

      // 短音频可能在收尾前就播完了，这里补一次
      if (!window.AudioEngine.state().playing) settle();
      else setStatus('生成完成，正在播放…（点停止按钮可打断）', 'ok');
    } catch (e) {
      const aborted = e && e.name === 'AbortError';
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

  /** 历史存在本机 IndexedDB：记录 + 音频 Blob + 完整参数，点一条就能复原。 */
  const histUrls = new Map();

  function historyUrl(row) {
    if (!row || !row.blob) return '';
    let url = histUrls.get(row.id);
    if (!url) {
      url = MimoStore.objectUrl(row.blob);
      histUrls.set(row.id, url);
    }
    return url;
  }

  async function loadHistory() {
    try {
      const rows = await MimoStore.listRecords(MimoStore.MAX_RECORDS);
      S.history = rows.map((r) => ({
        id: r.id,
        createdAt: r.createdAt,
        model: r.model,
        short: r.short,
        text: r.text,
        url: historyUrl(r),
        filename: r.filename,
        duration: r.duration,
        bytes: r.bytes,
        first: r.first,
        total: r.total,
        streamed: !!r.streamed,
        generatedText: r.generatedText,
        params: r.params || {},
      }));
      renderHistory(S.history.length);
    } catch (e) {
      renderHistory();
    }
  }

  /** 写一条历史。存不下也不影响播放，只是这条不会留在列表里。 */
  async function pushHistory(body, meta, generatedText) {
    const params = {
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
    };
    const record = {
      id: newId(),
      createdAt: Date.now(),
      model: body.model,
      short: (M.modelMeta().short || '').slice(0, 4),
      text: (M.finalAssistant() || generatedText || M.finalUser() || '').slice(0, 500),
      userText: (M.finalUser() || '').slice(0, 2000),
      filename: meta.filename || '',
      duration: meta.duration || 0,
      bytes: meta.bytes || 0,
      first: meta.first_audio_ms != null ? meta.first_audio_ms : meta.latency_ms,
      total: meta.total_ms != null ? meta.total_ms : meta.latency_ms,
      streamed: !!meta.streamed,
      generatedText: (generatedText || '').slice(0, 2000),
      params,
      blob: meta.blob || null,
    };
    try {
      await MimoStore.addRecord(record);
      await loadHistory();
    } catch (e) {
      // 配额满了之类：先把这条塞进内存列表，至少本次能看到
      S.history.unshift({ ...record, url: meta.url || '' });
      renderHistory(S.history.length);
      toast('这条记录没能写入本机存储（可能空间不足）', { type: 'warn' });
    }
  }

  function renderHistory(total) {
    const list = S.history || [];
    if (el.historyCount) el.historyCount.textContent = total ? '(' + total + ')' : '';
    if (!list.length) {
      el.historyList.innerHTML = '<div class="empty-tip">还没有生成记录</div>';
      return;
    }
    el.historyList.innerHTML = list
      .map(
        (h) =>
          '<div class="history-item" data-id="' + M.escapeHtml(h.id) + '" title="点一下复原当时的参数">' +
          '<span class="h-badge">' + M.escapeHtml(h.short || '') + '</span>' +
          '<div class="h-main"><div class="h-text">' + M.escapeHtml(h.text || '') + '</div>' +
          '<div class="h-meta">' + M.fmtTime(h.duration || 0) + ' · ' + (h.streamed ? '流式' : '整段') +
          (h.first ? ' · 首包 ' + M.fmtMs(h.first) : '') + '</div></div>' +
          '<div class="h-actions">' +
          '<button class="mini-btn" data-h-play="' + M.escapeHtml(h.url || '') + '" data-h-dur="' + (h.duration || 0) +
          '" data-h-file="' + M.escapeHtml(h.filename || '') + '" title="播放">▶</button>' +
          '<button class="mini-btn" data-h-reuse="' + M.escapeHtml(h.id) + '" title="还原参数">↺</button>' +
          '<a class="mini-btn" href="' + M.escapeHtml(h.url || '#') + '" download="' + M.escapeHtml(h.filename || 'mimo.wav') + '" title="下载">⬇</a>' +
          '<button class="mini-btn danger" data-h-del="' + M.escapeHtml(h.id) + '" title="删除">✕</button>' +
          '</div></div>'
      )
      .join('');

    el.historyList.querySelectorAll('[data-h-play]').forEach((btn) =>
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!btn.dataset.hPlay) return;
        window.AudioEngine.reset();
        loadPlayer(btn.dataset.hPlay, { duration: Number(btn.dataset.hDur), filename: btn.dataset.hFile });
        setMeta({ duration: Number(btn.dataset.hDur) });
        await startPlay();
      })
    );

    el.historyList.querySelectorAll('[data-h-reuse]').forEach((btn) =>
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const item = S.history.find((h) => h.id === btn.dataset.hReuse);
        if (!item) return;
        applyParams(item.params || {});
        toast('已回填当时的参数', { type: 'ok' });
      })
    );

    el.historyList.querySelectorAll('[data-h-del]').forEach((btn) =>
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.dataset.hDel;
        try {
          await MimoStore.deleteRecord(id);
          const url = histUrls.get(id);
          if (url) {
            MimoStore.revoke(url);
            histUrls.delete(id);
          }
          S.history = S.history.filter((h) => h.id !== id);
          renderHistory(S.history.length);
        } catch (err) {
          toast('删除失败：' + (err && err.message ? err.message : '未知错误'), { type: 'error' });
        }
      })
    );

    // 点条目本身：参数复原 + 把音频挂到播放器（不自动播，避免吓人）
    el.historyList.querySelectorAll('.history-item').forEach((node) => {
      node.addEventListener('click', (e) => {
        if (e.target.closest('.h-actions')) return;
        const item = S.history.find((h) => h.id === node.dataset.id);
        if (!item) return;
        const params = { ...(item.params || {}) };
        if (!params.text) params.text = item.text || '';
        applyParams(params);
        if (item.url) {
          loadPlayer(item.url, { duration: item.duration, filename: item.filename });
          setMeta({ duration: item.duration, bytes: item.bytes, first_audio_ms: item.first, total_ms: item.total });
          setStatus('已复原这条记录，点播放键试听');
        }
        toast('已复原当时的参数', { type: 'ok', timeout: 1600 });
      });
    });
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
     设置抽屉（接口地址 + Key，全部存本机）
     ===================================================================== */

  function openDrawer() {
    el.drawer.hidden = false;
    el.drawerMask.hidden = false;
    if (el.baseInput) el.baseInput.value = S.base || M.CFG.DEFAULT_BASE_URL;
    el.keyInput.value = S.key || '';
    refreshStoreInfo();
    if (S.key) el.baseInput.focus();
    else el.keyInput.focus();
  }

  function closeDrawer() {
    el.drawer.hidden = true;
    el.drawerMask.hidden = true;
  }

  async function refreshStoreInfo() {
    try {
      const count = await MimoStore.countRecords();
      const est = await MimoStore.estimate();
      if (el.storeCount) el.storeCount.textContent = count + ' 条';
      if (el.storeState) {
        el.storeState.textContent = est.quota
          ? M.fmtBytes(est.usage) + ' / ' + M.fmtBytes(est.quota)
          : M.fmtBytes(est.usage);
      }
    } catch (e) { /* 本地库不可用时忽略 */ }
  }

  function initSettings() {
    el.settingsBtn.addEventListener('click', openDrawer);
    el.bannerKeyBtn.addEventListener('click', openDrawer);
    el.drawerClose.addEventListener('click', closeDrawer);
    el.drawerMask.addEventListener('click', closeDrawer);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !el.drawer.hidden) closeDrawer();
    });

    if (el.basePresets) {
      el.basePresets.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-base]');
        if (!btn) return;
        el.baseInput.value = btn.dataset.base;
        toast('已填入地址，记得点保存', { type: 'ok', timeout: 1600 });
      });
    }

    el.saveKey.addEventListener('click', async () => {
      const base = (el.baseInput.value || '').trim() || M.CFG.DEFAULT_BASE_URL;
      const key = el.keyInput.value.trim();

      if (!/^https?:\/\//i.test(base)) {
        el.keyResult.textContent = '接口地址要以 http(s):// 开头';
        el.keyResult.className = 'drawer-result is-error';
        return;
      }
      if (!key) {
        el.keyResult.textContent = '请输入 API Key';
        el.keyResult.className = 'drawer-result is-error';
        return;
      }

      S.base = MimoApi.normalizeBase(base);
      S.key = key;
      try { localStorage.setItem(LS.key, key); } catch (e) { /* 隐私模式 */ }
      M.persist();

      el.keyResult.textContent = '正在验证…';
      el.keyResult.className = 'drawer-result';

      try {
        const result = await MimoApi.synthesize({
          model: 'mimo-v2.5-tts',
          text: (S.boot && S.boot.voice_test_text) || '你好。',
          instruction: '',
          voice: 'mimo_default',
          key: S.key,
          baseUrl: S.base,
        });
        S.hasKey = true;
        el.keyResult.textContent =
          '连接成功 · 试合成 ' + M.fmtMs(result.latencyMs) + ' · ' + M.fmtBytes(result.bytes);
        el.keyResult.className = 'drawer-result is-ok';
        el.settingsBtn.classList.remove('is-alert');
        el.keySource.textContent = '已保存在本机';
        updateGenerateState();
        refreshStoreInfo();
        toast('接口可用，开始合成吧', { type: 'ok' });
        setTimeout(closeDrawer, 900);
      } catch (e) {
        el.keyResult.textContent = (e && e.message) || '验证失败';
        el.keyResult.className = 'drawer-result is-error';
        el.settingsBtn.classList.add('is-alert');
      }
    });

    el.clearKey.addEventListener('click', () => {
      S.key = '';
      try { localStorage.removeItem(LS.key); } catch (e) { /* 忽略 */ }
      el.keyInput.value = '';
      S.hasKey = false;
      el.keyResult.textContent = '已清除本机保存的 Key';
      el.keyResult.className = 'drawer-result';
      el.keySource.textContent = '未配置';
      updateGenerateState();
    });
  }

  /* =====================================================================
     启动
     ===================================================================== */

  async function boot() {
    initTheme();
    M.restore();
    S.hasKey = !!S.key;

    if (el.baseInput) el.baseInput.value = S.base || M.CFG.DEFAULT_BASE_URL;
    el.keyInput.value = S.key || '';
    el.keySource.textContent = S.key ? '已保存在本机' : '未配置';

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
    loadSamples();
    await loadHistory();

    // 恢复上次状态到控件
    el.instruction.value = S.instruction;
    el.mainText.value = S.text;
    el.designDesc.value = S.design.desc;
    el.directorRole.value = S.director.role;
    el.directorScene.value = S.director.scene;
    el.directorGuide.value = S.director.guide;
    syncDirectorUi();
    el.optimizeToggle.setAttribute('aria-checked', String(S.design.optimize));

    // 支持 ?model=xxx 深链
    const wanted = new URLSearchParams(location.search).get('model');
    if (wanted && S.boot.models.some((m) => m.id === wanted)) S.model = wanted;
    else if (!S.boot.models.some((m) => m.id === S.model)) S.model = S.boot.models[0].id;

    $$('.seg', el.tabs).forEach((b) => b.classList.toggle('is-active', b.dataset.model === S.model));

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
    window.AudioEngine.startDrawLoop();
    setTimeout(updateThumb, 80);

    el.generateBtn.addEventListener('click', generate);
    el.stopBtn.addEventListener('click', () => stopPlayback());

    el.clearHistory.addEventListener('click', async () => {
      try {
        await MimoStore.clearRecords();
        histUrls.forEach((url) => MimoStore.revoke(url));
        histUrls.clear();
        S.history = [];
        renderHistory(0);
        refreshStoreInfo();
        toast('历史记录已清空', { type: 'ok' });
      } catch (e) {
        toast('清空失败：' + (e && e.message ? e.message : '未知错误'), { type: 'error' });
      }
    });

    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        generate();
      }
      if (e.key === 'Escape' && player.kind === 'stream') stopPlayback();
    });

    if (!S.hasKey) {
      el.settingsBtn.classList.add('is-alert');
      setTimeout(() => toast('先在右上角齿轮里填接口地址和 API Key', { type: 'warn', timeout: 5200 }), 700);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
