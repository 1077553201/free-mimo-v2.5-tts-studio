/* =========================================================================
   talk.js — 实时对话：录音 → ASR → 流式 LLM → 分句流式 TTS → 连续播放

   为什么要分句送 TTS：
   整段等 LLM 说完再合成，首字延迟 = 生成时间 + 合成时间；
   边生成边按句切、句子一出来就送去合成，播放和生成就能并行，体感快一倍以上。
   ========================================================================= */
(function () {
  'use strict';

  const M = window.MIMO;
  const S = M.S;
  const $ = (sel) => document.querySelector(sel);

  const T = {
    voice: '冰糖',
    auto: false,
    busy: false,
    history: [],
    rec: null,
    abort: null,
    ttsChain: Promise.resolve(),
    audioStarted: false,
    metrics: {},
    lines: [],       // 本轮字幕时间轴 [{el, duration}]
    box: null,       // 本轮字幕容器
    inited: false,
    session: '',     // SQLite 里的会话 id
    lastUser: '',    // 本轮用户原话，落库用
    interrupted: false,
  };

  let ui = null;

  /* ------------------------------------------------------------- DOM */

  function grab() {
    ui = {
      card: $('#talkCard'),
      stage: $('#talkStage'),
      empty: $('#talkEmpty'),
      mic: $('#micBtn'),
      stop: $('#talkStopBtn'),
      log: $('#talkLogBtn'),
      state: $('#talkState'),
      sub: $('#talkSub'),
      metrics: $('#talkMetrics'),
      config: $('#talkConfig'),
      autoBtn: $('#autoTalkBtn'),
      extend: $('#recExtendBtn'),
      reset: $('#talkReset'),
      voiceBtn: $('#talkVoiceBtn'),
      voiceLabel: $('#talkVoiceLabel'),
      voiceMenu: $('#talkVoiceMenu'),
      engineTag: $('#talkEngineTag'),
    };
  }

  /* ------------------------------------------------------------- 状态显示 */

  function setState(text, sub, isError) {
    ui.state.textContent = text;
    ui.state.classList.toggle('is-error', !!isError);
    if (sub != null) ui.sub.textContent = sub;
  }

  function setMetrics(parts) {
    if (!parts) { ui.metrics.innerHTML = ''; return; }
    ui.metrics.innerHTML = parts
      .filter(Boolean)
      .map(
        (p) =>
          '<div class="mrow"><span>' + M.escapeHtml(p[0]) + '</span><b>' +
          M.escapeHtml(String(p[1])) + '</b></div>'
      )
      .join('');
  }

  function idleMetrics() {
    setMetrics([['识别', '—'], ['首字', '—'], ['出声', '—'], ['整轮', '—']]);
  }

  /**
   * 回答中：麦克风必须保持可点（点一下就是打断），
   * 同时露出「打断」按钮。之前这里用的是 is-busy，
   * 而 .mic-btn.is-busy 带 pointer-events:none，结果回答期间根本点不动。
   */
  function setAnswering(on) {
    if (!ui.mic) return;
    ui.mic.classList.remove('is-busy');
    ui.mic.classList.toggle('is-answering', !!on);
    ui.mic.title = on ? '点一下打断回答' : '点一下开始说话';
    if (ui.stop) ui.stop.hidden = !on;
  }

  function shortHost(url) {
    if (!url) return '—';
    try {
      return new URL(url).host.replace(/^www\./, '');
    } catch (e) {
      return String(url).replace(/^https?:\/\//, '').slice(0, 22);
    }
  }

  let cfgSig = '';
  function renderConfig() {
    const asr = (S.boot && S.boot.talk && S.boot.talk.asr) || {};
    const fallback = (S.boot && S.boot.talk && S.boot.talk.llm) || {};
    const llm = (M.ui.llmConfig && M.ui.llmConfig()) || {};
    const turns = T.history.filter((m) => m.role === 'assistant').length;
    const think = llm.thinking === 'off' ? '已关闭' : llm.thinking === 'on' ? '开启' : '服务端默认';
    const memChars = T.metrics.memory || 0;
    const rows = [
      ['音色', T.voice],
      ['识别', asr.available === false ? '未安装' : (asr.label || 'SenseVoice')],
      ['对话模型', llm.model || fallback.model || '—'],
      ['接口', shortHost(llm.base_url || fallback.base_url)],
      ['思考', think],
      ['记忆', memChars ? memChars + ' 字' : '无'],
      ['轮次', String(turns)],
    ];
    const html = rows
      .map(([k, v]) => '<div class="mrow"><span>' + M.escapeHtml(k) + '</span><b>' + M.escapeHtml(String(v)) + '</b></div>')
      .join('');
    if (html !== cfgSig) {
      ui.config.innerHTML = html;
      cfgSig = html;
    }
  }

  /* ------------------------------------------------------------- 字幕 */

  function clearEmpty() {
    if (ui.empty) { ui.empty.remove(); ui.empty = null; }
  }

  function addErrorLine(msg) {
    const box = T.box || addTurn('');
    const el = addSubLine(box, msg);
    el.classList.remove('is-pending');
    el.classList.add('is-error');
  }

  /** 开一轮：用户那句用小字放在上面，下面挂逐句字幕 */
  function addTurn(text) {
    clearEmpty();
    const turn = document.createElement('div');
    turn.className = 'sub-turn';
    const user = document.createElement('div');
    user.className = 'sub-user';
    const span = document.createElement('span');
    span.textContent = text;
    user.appendChild(span);
    const lines = document.createElement('div');
    lines.className = 'sub-lines';
    turn.append(user, lines);
    ui.stage.appendChild(turn);
    scrollBottom();
    return lines;
  }

  function addSubLine(box, text) {
    const node = document.createElement('div');
    node.className = 'sub-line is-pending';
    node.textContent = text || '';
    box.appendChild(node);
    scrollBottom();
    return node;
  }

  /** 句子定稿：写进字幕行并登记到本轮的播放时间轴 */
  function markLine(text, el) {
    el.textContent = text;
    el.classList.remove('is-pending');
    const entry = { el, duration: null };
    T.lines.push(entry);
    return entry;
  }

  /* 字幕跟着语音走：用每句的音频时长累加，比对当前播放位置 */
  let hlTimer = null;
  function startHighlight() {
    if (hlTimer) return;
    hlTimer = setInterval(() => {
      const st = window.AudioEngine.state();
      if (st.mode !== 'stream') return;
      let acc = 0;
      let active = -1;
      for (let i = 0; i < T.lines.length; i += 1) {
        const d = T.lines[i].duration;
        if (d == null) break;
        if (st.position < acc + d - 0.03) { active = i; break; }
        acc += d;
      }
      T.lines.forEach((l, i) => {
        l.el.classList.toggle('is-active', i === active);
        l.el.classList.toggle('is-past', i < active);
      });
    }, 90);
  }

  function stopHighlight() {
    clearInterval(hlTimer);
    hlTimer = null;
    T.lines.forEach((l) => l.el.classList.remove('is-active'));
  }

  function scrollBottom() {
    requestAnimationFrame(() => { ui.stage.scrollTop = ui.stage.scrollHeight; });
  }

  /* ------------------------------------------------------------- 录音

     两种收尾方式，别搞混：

     普通模式（连续对话关）：
       点一下开始 → 再点一下结束并发送，中途绝不自动停。
       但有 15 秒上限：快到点会问「还要继续吗」并给一个「继续录音」按钮，
       点了就再续 15 秒，没点就到点自动结束，并把已经录到的音频送去做识别。

     连续对话（开）：
       说完之后的静音超过阈值就自动结束、自动接着答。

     不管走哪条路，收尾都必须经过 finishRec()，
     它会 await stopRec() 拿到 Blob 再去 /api/asr——
     之前自动停止时直接调 stopRec() 不接返回值，音频就被丢了，
     识别只拿到空音频，于是只回一个句号给大模型。 */

  const REC_LIMIT = 15000;        // 普通模式单次录音上限
  const REC_EXTEND = 15000;       // 点一次「继续录音」延长多少
  const REC_WARN_BEFORE = 5000;   // 距上限还剩多少毫秒开始提示
  const REC_AUTO_LIMIT = 20000;   // 连续对话模式的兜底上限
  const REC_AUTO_SILENCE = 900;   // 连续对话：静音多久算说完了
  const VAD_RMS = 0.015;          // 判定「有声音」的能量阈值

  function fmtSec(ms) { return (Math.max(0, ms) / 1000).toFixed(1) + 's'; }

  function pickMime() {
    const list = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm'];
    return list.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
  }

  async function startRec() {
    if (T.busy) stopTurn();
    if (T.rec) return;
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      M.ui.toast('当前浏览器不支持录音', { type: 'error' });
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const ctx = window.AudioEngine.ensure();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);

      const mime = pickMime();
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 64000 } : undefined);
      const chunks = [];
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };

      const auto = !!T.auto;
      T.rec = {
        stream, src, analyser, data, rec, chunks,
        mode: auto ? 'auto' : 'manual',
        startedAt: performance.now(),
        limitMs: auto ? REC_AUTO_LIMIT : REC_LIMIT,
        warned: false,
        finishing: false,
        spoke: false,
        silenceSince: 0,
        tick: null,
        maxTimer: null,
      };

      rec.start();
      ui.mic.classList.add('is-recording');
      if (auto) setState('正在听…', '说完停一下，我会自动接上');
      else setState('正在录音…', '再点一下麦克风就结束并发送');

      T.rec.tick = setInterval(tickRec, 100);
    } catch (e) {
      cleanupRec();
      setState('无法打开麦克风', e.message || '', true);
      M.ui.toast('麦克风不可用：' + (e.message || '请检查权限'), { type: 'error' });
    }
  }

  /** 每 100ms 跑一次：算音量、更新计时、决定要不要收尾 */
  function tickRec() {
    const r = T.rec;
    if (!r || r.finishing) return;
    const now = performance.now();
    const elapsed = now - r.startedAt;

    // 音量还是要看：连续对话靠它判断说完没，普通模式拿它确认有没有出声
    r.analyser.getByteTimeDomainData(r.data);
    let sum = 0;
    for (let i = 0; i < r.data.length; i += 1) {
      const v = (r.data[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / r.data.length);
    if (rms > VAD_RMS) {
      r.spoke = true;
      r.silenceSince = 0;
    } else if (!r.silenceSince) {
      r.silenceSince = now;
    }

    /* ---- 连续对话：静音自动收尾 ---- */
    if (r.mode === 'auto') {
      if (r.spoke && r.silenceSince && now - r.silenceSince > REC_AUTO_SILENCE) {
        finishRec('silence');
        return;
      }
      if (elapsed >= r.limitMs) finishRec('limit');
      return;
    }

    /* ---- 普通模式：只报时，绝不自动停 ---- */
    const left = r.limitMs - elapsed;
    if (!r.warned && left <= REC_WARN_BEFORE) {
      r.warned = true;
      showExtend();
    }
    if (r.warned) {
      const count = ui.extend && ui.extend.querySelector('.extend-count');
      if (count) count.textContent = Math.ceil(Math.max(0, left) / 1000) + 's';
    } else {
      ui.sub.textContent =
        '已录 ' + fmtSec(elapsed) + ' / ' + fmtSec(r.limitMs) + ' · 再点麦克风结束并发送';
    }
    if (left <= 0) finishRec('limit');
  }

  function showExtend() {
    if (!ui.extend) return;
    ui.extend.hidden = false;
    const count = ui.extend.querySelector('.extend-count');
    if (count) count.textContent = Math.ceil(REC_WARN_BEFORE / 1000) + 's';
    setState('快到录音上限了', '还要继续说吗？点「继续录音」再续 ' + REC_EXTEND / 1000 + ' 秒');
  }

  function hideExtend() {
    if (ui.extend) ui.extend.hidden = true;
  }

  /** 点「继续录音」：把上限往后推，继续录 */
  function extendRec() {
    const r = T.rec;
    if (!r || r.finishing) return;
    r.limitMs += REC_EXTEND;
    r.warned = false;
    hideExtend();
    setState('继续录音…', '还是点麦克风结束并发送');
    M.ui.toast('已延长 ' + REC_EXTEND / 1000 + ' 秒', { type: 'ok', timeout: 1200 });
  }

  function cleanupRec() {
    if (!T.rec) return;
    clearInterval(T.rec.tick);
    clearTimeout(T.rec.maxTimer);
    try { T.rec.src.disconnect(); } catch (e) {}
    if (T.rec.stream) T.rec.stream.getTracks().forEach((t) => t.stop());
    ui.mic.classList.remove('is-recording');
    hideExtend();
    T.rec = null;
  }

  function stopRec() {
    return new Promise((resolve) => {
      const cur = T.rec;
      if (!cur || !cur.rec || cur.rec.state === 'inactive') {
        cleanupRec();
        return resolve(null);
      }
      const rec = cur.rec;
      rec.onstop = () => {
        const type = rec.mimeType || 'audio/webm';
        const blob = new Blob(cur.chunks, { type });
        const duration = performance.now() - cur.startedAt;
        cleanupRec();
        if (blob.size < 1200 || duration < 400) return resolve(null);
        // 连续对话靠 VAD 确认出过声；普通模式是用户自己按的，录到东西就发
        if (cur.mode !== 'manual' && !cur.spoke) return resolve(null);
        resolve({ blob, duration });
      };
      try { rec.stop(); } catch (e) { cleanupRec(); resolve(null); }
    });
  }

  /**
   * 唯一的收尾出口：手动点停、静音自动停、到上限停，全都走这里。
   * 关键就是 await stopRec() —— 拿到音频立刻送去识别，别再把 Blob 丢了。
   */
  async function finishRec(reason) {
    const r = T.rec;
    if (!r || r.finishing) return;
    r.finishing = true;
    clearInterval(r.tick);
    r.tick = null;
    hideExtend();

    ui.mic.classList.remove('is-recording');
    ui.mic.classList.add('is-busy');
    setState('正在收尾…', '准备送去识别');
    let captured = null;
    try {
      captured = await stopRec();
    } catch (e) {
      captured = null;
    }
    ui.mic.classList.remove('is-busy');

    if (captured) {
      await runTurn(captured.blob);
      return;
    }
    if (T.auto) {
      // 连续对话里没听到声音很正常，悄悄继续听，别弹提示打断
      setState('还在听…', '说完停一下，我会自动接上');
      setTimeout(() => { if (T.auto && !T.rec && !T.busy) startRec(); }, 250);
    } else if (reason === 'limit') {
      setState('已到录音上限', '这段没听到声音，再点一次重录');
    } else {
      setState('没听到声音', '离麦克风近一点再试一次');
    }
  }

  /* ------------------------------------------------------------- 一轮对话 */

  async function onMicClick() {
    if (T.rec) {
      await finishRec('manual');
      return;
    }
    if (T.busy) {
      // 打断正在进行的回答，直接开始听
      stopTurn();
    }
    if (!M.ui.llmReady()) {
      M.ui.toast('还没有可用的对话模型，先在右上角齿轮里配置', { type: 'warn' });
      M.ui.openDrawer();
      return;
    }
    await startRec();
  }

  /* ------------------------------------------------------------- 落库 */

  function newSessionId() {
    return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  /** 一轮问答写进 SQLite + 当天的对话记忆文件。失败不打扰用户。 */
  function logTurn(user, assistant) {
    const body = {
      session_id: T.session || newSessionId(),
      user: user || '',
      assistant: assistant || '',
      voice: T.voice,
      asr_ms: T.metrics.asr || null,
      first_audio_ms: T.metrics.firstAudio || null,
    };
    T.session = body.session_id;
    fetch('/api/chat/log', {
      method: 'POST',
      headers: M.ui.keyHeaders(true),
      body: JSON.stringify(body),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d && d.session_id) T.session = d.session_id; })
      .catch(() => { /* 落库失败不影响继续说话 */ });
  }

  async function runTurn(blob) {
    T.busy = true;
    T.turnStart = performance.now();
    setAnswering(true);
    const turnStart = T.turnStart;
    const ctl = new AbortController();
    T.abort = ctl;

    try {
      // 1) 识别
      setState('正在识别…', '本地/云端 ASR', false);
      const fd = new FormData();
      fd.append('file', blob, 'speech.webm');

      const asrRes = await fetch('/api/asr', { method: 'POST', headers: M.ui.keyHeaders(), body: fd, signal: ctl.signal });
      if (!asrRes.ok) {
        const err = await M.ui.readError(asrRes);
        throw new Error(err.message);
      }
      const asr = await asrRes.json();
      const text = (asr.text || '').trim();
      if (!text) {
        setState('没听清', '换个说法再说一次试试');
        endTurn();
        return;
      }

      T.lines = [];
      T.box = addTurn(text);
      T.history.push({ role: 'user', content: text });
      T.lastUser = text;
      T.metrics.asr = asr.ms;
      renderConfig();

      // 2) 生成 + 3) 分句合成
      await respond(ctl, turnStart);
    } catch (e) {
      if (T.interrupted || (e && e.name === 'AbortError')) {
        setState('已打断', '点麦克风继续说');
      } else {
        const msg = e && e.message ? e.message : '这一轮失败了';
        setState('出错了', msg, true);
        addErrorLine(msg);
      }
      endTurn();
    }
  }

  async function respond(ctl, turnStart) {
    setState('正在思考…', '模型生成中，句子一到就会开口');
    const box = T.box || addTurn('');
    T.audioStarted = false;
    T.ttsChain = Promise.resolve();

    let pending = addSubLine(box, '');
    pending.innerHTML = '<span class="typing-dots"><i></i><i></i><i></i></span>';
    let sentenceBuf = '';
    let reply = '';
    let firstTokenAt = 0;
    let speaking = false;

    const ensurePending = () => {
      if (!pending) pending = addSubLine(box, '');
      return pending;
    };

    // 一句定稿：写字幕 + 立刻送合成
    const commit = (text) => {
      const el = ensurePending();
      const entry = markLine(text, el);
      pending = null;
      queueSpeech(text, entry);
    };

    const flushSentences = (force) => {
      // 到标点就切一句；没有标点但太长，就在逗号处先切，避免憋着不出声
      let m;
      while ((m = sentenceBuf.match(/^([\s\S]*?[。！？!?…\n])/))) {
        const sentence = m[1].trim();
        sentenceBuf = sentenceBuf.slice(m[1].length);
        if (sentence) commit(sentence);
      }
      if (sentenceBuf.length > 46) {
        const cut = Math.max(sentenceBuf.lastIndexOf('，'), sentenceBuf.lastIndexOf('、'), sentenceBuf.lastIndexOf(','));
        if (cut > 12) {
          const head = sentenceBuf.slice(0, cut + 1);
          sentenceBuf = sentenceBuf.slice(cut + 1);
          commit(head);
        }
      }
      if (force && sentenceBuf.trim()) {
        const rest = sentenceBuf.trim();
        sentenceBuf = '';
        commit(rest);
      }
    };

    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: M.ui.keyHeaders(true),
      body: JSON.stringify({ messages: T.history.slice(-20), llm: M.ui.llmConfig() }),
      signal: ctl.signal,
    });
    if (!res.ok) {
      const err = await M.ui.readError(res);
      throw new Error(err.message);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of raw.split('\n')) {
          if (!line.startsWith('data:')) continue;
          let evt;
          try { evt = JSON.parse(line.slice(5).trim()); } catch (e) { continue; }
          if (evt.type === 'meta') {
            // 后端把「这轮带了多少记忆 / 是否思考」回传，侧栏好显示
            T.metrics.memory = Number(evt.memory_chars) || 0;
            T.metrics.thinking = evt.thinking;
            renderConfig();
          } else if (evt.type === 'delta') {
            if (!firstTokenAt) firstTokenAt = performance.now();
            reply += evt.text;
            sentenceBuf += evt.text;
            const cur = ensurePending();
            if (cur.querySelector('.typing-dots')) cur.textContent = '';
            cur.textContent = sentenceBuf;
            scrollBottom();
            flushSentences(false);
            if (!speaking) {
              speaking = true;
              setState('正在回答…', '边生成边播报，点「打断」或麦克风可以立刻停下');
            }
          } else if (evt.type === 'error') {
            const cur = ensurePending();
            cur.textContent = evt.message || '生成失败';
            cur.classList.remove('is-pending');
            cur.classList.add('is-error');
            endTurn();
            return;
          }
        }
      }
    }

    flushSentences(true);
    if (pending && !pending.textContent.trim()) pending.remove();
    pending = null;

    if (reply.trim()) {
      T.history.push({ role: 'assistant', content: reply.trim() });
      // 文本一完整就落库（同时写进当天的对话记忆），后面被打断也不影响记录
      logTurn(T.lastUser, reply.trim());
    } else {
      const el = addSubLine(box, '（模型没有返回内容）');
      el.classList.remove('is-pending');
      el.classList.add('is-error');
    }

    await T.ttsChain;

    const firstVoice = T.metrics.firstAudio || 0;
    const total = Math.round(performance.now() - turnStart);
    setMetrics([
      ['识别', (T.metrics.asr || 0) + 'ms'],
      firstTokenAt ? ['首字', Math.round(firstTokenAt - turnStart) + 'ms'] : null,
      firstVoice ? ['出声', firstVoice + 'ms'] : null,
      ['整轮', total + 'ms'],
    ]);
    renderConfig();

    if (T.audioStarted) {
      window.AudioEngine.endStream();
      // 播放结束由 beginStream 的回调 endTurn 收尾
    } else {
      endTurn();
    }
  }

  function queueSpeech(text, entry) {
    const ctl = T.abort;
    T.ttsChain = T.ttsChain
      .then(() => streamTTS(text, ctl, entry))
      .catch((e) => {
        if (e && e.name === 'AbortError') return;
        console.warn('[talk] tts failed', e);
      });
  }

  async function streamTTS(text, ctl, entry) {
    if (ctl && ctl.signal.aborted) return;
    const res = await fetch('/api/tts/stream', {
      method: 'POST',
      headers: M.ui.keyHeaders(true),
      body: JSON.stringify({
        model: 'mimo-v2.5-tts',
        text,
        voice: T.voice,
        instruction: '自然口语，语气亲切，语速适中，像面对面聊天。',
        stream: true,
      }),
      signal: ctl ? ctl.signal : undefined,
    });
    if (!res.ok) {
      const err = await M.ui.readError(res);
      throw new Error(err.message);
    }

    if (!T.audioStarted) {
      // 第一句才建立播放队列，后续句子直接续在游标后面
      window.AudioEngine.beginStream(() => {
        endTurn();
      });
      T.audioStarted = true;
      startHighlight();
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of raw.split('\n')) {
          if (!line.startsWith('data:')) continue;
          let evt;
          try { evt = JSON.parse(line.slice(5).trim()); } catch (e) { continue; }
          if (evt.type === 'audio') {
            if (!T.metrics.firstAudio) {
              T.metrics.firstAudio = Math.round(performance.now() - (T.turnStart || performance.now()));
            }
            window.AudioEngine.appendPCM(evt.data);
          } else if (evt.type === 'meta') {
            // 记下这句音频时长，字幕靠它做时间轴
            if (entry) entry.duration = Number(evt.duration) || 0;
          } else if (evt.type === 'error') {
            throw new Error(evt.message || '语音合成失败');
          }
        }
      }
    }
  }

  function endTurn() {
    stopHighlight();
    T.busy = false;
    T.audioStarted = false;
    T.ttsChain = Promise.resolve();
    T.abort = null;
    setAnswering(false);
    // 用户主动打断时保留「已打断」提示，别被 endTurn 覆盖成「待机」
    if (!T.rec && !T.interrupted) setState('待机', '点麦克风继续，或打开连续对话');
    T.interrupted = false;
    if (T.auto && !T.rec) {
      setTimeout(() => {
        if (T.auto && !T.rec && !T.busy) startRec();
      }, 350);
    }
  }

  function stopTurn() {
    stopHighlight();
    T.interrupted = true;
    if (T.abort) {
      try { T.abort.abort(); } catch (e) {}
      T.abort = null;
    }
    window.AudioEngine.reset();
    T.busy = false;
    T.audioStarted = false;
    T.ttsChain = Promise.resolve();
    setAnswering(false);
    setState('已打断', '点麦克风继续说');
  }

  /* ------------------------------------------------------------- 菜单 */

  function buildVoiceMenu() {
    const voices = (S.boot && S.boot.voices) || [];
    ui.voiceMenu.innerHTML = voices
      .map(
        (v) =>
          '<button class="menu-item" data-voice="' + M.escapeHtml(v.id) + '">' +
          '<b>' + M.escapeHtml(v.label) + '</b><span>' + M.escapeHtml(v.lang + ' · ' + v.gender + ' · ' + (v.note || '')) + '</span></button>'
      )
      .join('');
  }

  function applyAsrTag() {
    const asr = (S.boot && S.boot.talk && S.boot.talk.asr) || {};
    const name = asr.label || 'SenseVoice-Small';
    if (asr.available === false) {
      ui.engineTag.classList.add('is-off');
      ui.engineTag.textContent = '识别：未安装';
      ui.engineTag.title = '运行 scripts/download_asr.py 下载本地识别模型';
    } else {
      ui.engineTag.classList.remove('is-off');
      ui.engineTag.innerHTML = '<span class="engine-dot"></span>识别：' + name;
      ui.engineTag.title = asr.desc || '';
    }
  }

  function bindMenu(btn, menu, onPick) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = menu.hidden;
      menu.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
    });
    menu.addEventListener('click', (e) => {
      const item = e.target.closest('[data-voice],[data-engine]');
      if (!item || item.disabled) return;
      menu.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
      onPick(item);
    });
  }

  /* ------------------------------------------------------------- 初始化 */

  function init() {
    if (T.inited) return;
    grab();
    T.inited = true;

    T.voice = (S.boot && S.boot.talk && S.boot.talk.default_voice) || '冰糖';
    ui.voiceLabel.textContent = T.voice;
    T.session = newSessionId();

    buildVoiceMenu();
    applyAsrTag();
    renderConfig();
    idleMetrics();

    bindMenu(ui.voiceBtn, ui.voiceMenu, (item) => {
      T.voice = item.dataset.voice;
      ui.voiceLabel.textContent = T.voice;
      renderConfig();
      M.ui.toast('对话音色切换为「' + T.voice + '」', { type: 'ok', timeout: 1600 });
    });

    document.addEventListener('click', () => {
      if (!ui.voiceMenu.hidden) { ui.voiceMenu.hidden = true; ui.voiceBtn.setAttribute('aria-expanded', 'false'); }
    });

    ui.mic.addEventListener('click', onMicClick);
    if (ui.extend) ui.extend.addEventListener('click', (e) => { e.stopPropagation(); extendRec(); });
    if (ui.stop) ui.stop.addEventListener('click', (e) => { e.stopPropagation(); stopTurn(); });
    if (ui.log) ui.log.addEventListener('click', () => M.ui.openChatLog && M.ui.openChatLog());
    setAnswering(false);

    ui.autoBtn.addEventListener('click', () => {
      T.auto = !T.auto;
      ui.autoBtn.setAttribute('aria-checked', String(T.auto));
      const want = T.auto ? 'auto' : 'manual';
      if (T.rec && T.rec.mode !== want) {
        // 正在录的时候切换模式，这段按新规矩接着来：重新给一个完整的时长窗口
        const elapsed = performance.now() - T.rec.startedAt;
        T.rec.mode = want;
        T.rec.limitMs = elapsed + (T.auto ? REC_AUTO_LIMIT : REC_LIMIT);
        T.rec.warned = false;
        hideExtend();
        if (T.auto) setState('正在听…', '说完停一下，我会自动接上');
        else setState('正在录音…', '再点一下麦克风就结束并发送');
      }
      if (T.auto && !T.rec && !T.busy) startRec();
      M.ui.toast(
        T.auto ? '已开启连续对话：说完停一下就自动接上' : '已关闭连续对话：点开始、点结束',
        { type: 'ok', timeout: 1800 }
      );
    });

    ui.reset.addEventListener('click', () => {
      stopTurn();
      T.history = [];
      T.session = newSessionId();
      T.lastUser = '';
      T.metrics = {};
      ui.stage.innerHTML = '';
      const empty = document.createElement('div');
      empty.className = 'talk-empty';
      empty.id = 'talkEmpty';
      empty.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none"><path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Z" stroke="currentColor" stroke-width="1.6"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>' +
        '<b>按麦克风说一句话</b><span>先说一句 → 自动识别 → 模型边想边答 → 语音和字幕一起出来</span>';
      ui.stage.appendChild(empty);
      ui.empty = empty;
      T.lines = [];
      T.box = null;
      idleMetrics();
      cfgSig = '';
      renderConfig();
      setState('待机', '点麦克风开始说话，再点一下结束并发送（最长 15 秒）');
    });
  }

  /** 切到实时对话页签时调用 */
  function onEnter() {
    init();
    cfgSig = '';
    renderConfig();
    const asr = (S.boot && S.boot.talk && S.boot.talk.asr) || {};
    if (asr.available === false) {
      setState('本地识别模型未安装', '运行 scripts/download_asr.py 下载 SenseVoice-Small 后重启服务', true);
      return;
    }
    if (!M.ui.llmReady()) {
      setState('还差对话模型配置', '点右上角齿轮，填 Base URL / Key / 模型 ID', true);
    } else if (!T.rec && !T.busy) {
      setState('待机', T.auto
        ? '连续对话已开：说完停一下自动接上'
        : '点麦克风开始说话，再点一下结束并发送（最长 15 秒）');
    }
  }

  function onLeave() {
    if (T.rec) {
      // 离场就别再送去识别了；stopRec 内部的 cleanupRec 会把麦克风关掉
      T.rec.finishing = true;
      clearInterval(T.rec.tick);
      T.rec.tick = null;
      stopRec();
    }
    stopTurn();
    if (T.auto) {
      T.auto = false;
      ui.autoBtn.setAttribute('aria-checked', 'false');
    }
  }

  // 调试用：跳过录音直接走一轮「对话 → 流式语音」，方便没有麦克风时验证链路
  async function devSay(text) {
    init();
    T.busy = true;
    T.turnStart = performance.now();
    setAnswering(true);
    const ctl = new AbortController();
    T.abort = ctl;
    T.lines = [];
    T.box = addTurn(text);
    T.history.push({ role: 'user', content: text });
    T.lastUser = text;
    try {
      await respond(ctl, T.turnStart);
    } catch (e) {
      if (T.interrupted || (e && e.name === 'AbortError')) setState('已打断', '点麦克风继续说');
      else setState('出错了', e.message || '', true);
      endTurn();
    }
  }

  window.Talk = { init, onEnter, onLeave, state: T, _devSay: devSay };
})();
