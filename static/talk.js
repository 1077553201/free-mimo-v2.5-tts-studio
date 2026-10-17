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
    inited: false,
  };

  let ui = null;

  /* ------------------------------------------------------------- DOM */

  function grab() {
    ui = {
      card: $('#talkCard'),
      stage: $('#talkStage'),
      empty: $('#talkEmpty'),
      mic: $('#micBtn'),
      state: $('#talkState'),
      sub: $('#talkSub'),
      metrics: $('#talkMetrics'),
      autoBtn: $('#autoTalkBtn'),
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
      .map((p) => '<b>' + M.escapeHtml(p[0]) + '</b> ' + M.escapeHtml(p[1]))
      .join(' · ');
  }

  function addBubble(role, text, opts) {
    opts = opts || {};
    if (ui.empty) { ui.empty.remove(); ui.empty = null; }
    const node = document.createElement('div');
    node.className = 'bubble ' + role + (opts.error ? ' is-error' : '');
    const body = document.createElement('div');
    body.className = 'bubble-body';
    if (opts.typing) {
      body.innerHTML = '<span class="typing-dots"><i></i><i></i><i></i></span>';
    } else {
      body.textContent = text;
    }
    node.appendChild(body);
    if (opts.meta) {
      const meta = document.createElement('div');
      meta.className = 'bubble-meta';
      meta.textContent = opts.meta;
      node.appendChild(meta);
    }
    ui.stage.appendChild(node);
    scrollBottom();
    return { node, body };
  }

  function scrollBottom() {
    requestAnimationFrame(() => { ui.stage.scrollTop = ui.stage.scrollHeight; });
  }

  /* ------------------------------------------------------------- 录音 */

  function pickMime() {
    const list = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm'];
    return list.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
  }

  async function startRec() {
    if (T.busy) { stopTurn(); }
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

      T.rec = {
        stream, src, analyser, data, rec, chunks,
        startedAt: performance.now(),
        spoke: false,
        silenceSince: 0,
        tick: null,
        maxTimer: null,
      };

      rec.start();
      ui.mic.classList.add('is-recording');
      setState('正在听…', '说话吧，停顿约 1 秒自动结束');

      // 能量 VAD：说话后静音 900ms 自动收尾，避免用户还要再点一次
      T.rec.tick = setInterval(() => {
        if (!T.rec) return;
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / data.length);
        const now = performance.now();
        if (rms > 0.015) {
          T.rec.spoke = true;
          T.rec.silenceSince = 0;
        } else if (T.rec.spoke) {
          if (!T.rec.silenceSince) T.rec.silenceSince = now;
          else if (now - T.rec.silenceSince > 900) stopRec();
        }
        if (now - T.rec.startedAt > 15000) stopRec();
      }, 100);
    } catch (e) {
      cleanupRec();
      setState('无法打开麦克风', e.message || '', true);
      M.ui.toast('麦克风不可用：' + (e.message || '请检查权限'), { type: 'error' });
    }
  }

  function cleanupRec() {
    if (!T.rec) return;
    clearInterval(T.rec.tick);
    clearTimeout(T.rec.maxTimer);
    try { T.rec.src.disconnect(); } catch (e) {}
    if (T.rec.stream) T.rec.stream.getTracks().forEach((t) => t.stop());
    ui.mic.classList.remove('is-recording');
    T.rec = null;
  }

  function stopRec() {
    return new Promise((resolve) => {
      const cur = T.rec;
      if (!cur || !cur.rec || cur.rec.state === 'inactive') {
        cleanupRec();
        return resolve(null);
      }
      const duration = performance.now() - cur.startedAt;
      const rec = cur.rec;
      rec.onstop = () => {
        const type = rec.mimeType || 'audio/webm';
        const blob = new Blob(cur.chunks, { type });
        const spoke = cur.spoke;
        cleanupRec();
        if (!spoke || duration < 450 || blob.size < 1200) return resolve(null);
        resolve({ blob, duration });
      };
      try { rec.stop(); } catch (e) { cleanupRec(); resolve(null); }
    });
  }

  /* ------------------------------------------------------------- 一轮对话 */

  async function onMicClick() {
    if (T.rec) {
      ui.mic.classList.add('is-busy');
      const captured = await stopRec();
      ui.mic.classList.remove('is-busy');
      if (captured) await runTurn(captured.blob);
      else setState('待机', '没听到声音，再试一次');
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

  async function runTurn(blob) {
    T.busy = true;
    T.turnStart = performance.now();
    ui.mic.classList.add('is-busy');
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

      addBubble('user', text, { meta: '识别 ' + asr.ms + 'ms · ' + (asr.engine_label || asr.engine) });
      T.history.push({ role: 'user', content: text });
      T.metrics.asr = asr.ms;

      // 2) 生成 + 3) 分句合成
      await respond(ctl, turnStart);
    } catch (e) {
      if (e && e.name === 'AbortError') {
        setState('已打断', '点麦克风继续说');
      } else {
        const msg = e && e.message ? e.message : '这一轮失败了';
        setState('出错了', msg, true);
        addBubble('assistant', msg, { error: true });
      }
      endTurn();
    }
  }

  async function respond(ctl, turnStart) {
    setState('正在思考…', '模型生成中，句子一到就会开口');
    const bubble = addBubble('assistant', '', { typing: true });
    T.audioStarted = false;
    T.ttsChain = Promise.resolve();

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
    let reply = '';
    let sentenceBuf = '';
    let firstTokenAt = 0;
    let firstAudioAt = 0;
    let speaking = false;

    const flushSentences = (force) => {
      // 到标点就切一句送合成；没有标点但太长，就在逗号处切开，避免憋太久
      let m;
      while ((m = sentenceBuf.match(/^([\s\S]*?[。！？!?…\n])/))) {
        const sentence = m[1].trim();
        sentenceBuf = sentenceBuf.slice(m[1].length);
        if (sentence) queueSpeech(sentence);
      }
      if (sentenceBuf.length > 46) {
        const cut = Math.max(sentenceBuf.lastIndexOf('，'), sentenceBuf.lastIndexOf('、'), sentenceBuf.lastIndexOf(','));
        if (cut > 12) {
          queueSpeech(sentenceBuf.slice(0, cut + 1));
          sentenceBuf = sentenceBuf.slice(cut + 1);
        }
      }
      if (force && sentenceBuf.trim()) {
        queueSpeech(sentenceBuf.trim());
        sentenceBuf = '';
      }
    };

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
          if (evt.type === 'delta') {
            if (!firstTokenAt) {
              firstTokenAt = performance.now();
              bubble.body.textContent = '';
            }
            reply += evt.text;
            bubble.body.textContent = reply;
            sentenceBuf += evt.text;
            scrollBottom();
            flushSentences(false);
            if (!speaking) {
              speaking = true;
              setState('正在回答…', '边生成边播报');
            }
          } else if (evt.type === 'error') {
            bubble.node.classList.add('is-error');
            bubble.body.textContent = evt.message || '生成失败';
            endTurn();
            return;
          }
        }
      }
    }

    flushSentences(true);
    if (reply.trim()) {
      T.history.push({ role: 'assistant', content: reply.trim() });
      if (!bubble.body.textContent) bubble.body.textContent = reply;
      bubble.body.textContent = reply;
    } else {
      bubble.body.textContent = '（模型没有返回内容）';
      bubble.node.classList.add('is-error');
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

    if (T.audioStarted) {
      window.AudioEngine.endStream();
      // 播放结束由 beginStream 的回调 endTurn 收尾
    } else {
      endTurn();
    }
  }

  function queueSpeech(text) {
    const ctl = T.abort;
    T.ttsChain = T.ttsChain
      .then(() => streamTTS(text, ctl))
      .catch((e) => {
        if (e && e.name === 'AbortError') return;
        console.warn('[talk] tts failed', e);
      });
  }

  async function streamTTS(text, ctl) {
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
        ui.mic.classList.remove('is-busy');
        endTurn();
      });
      T.audioStarted = true;
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
          } else if (evt.type === 'error') {
            throw new Error(evt.message || '语音合成失败');
          }
        }
      }
    }
  }

  function endTurn() {
    T.busy = false;
    T.audioStarted = false;
    T.ttsChain = Promise.resolve();
    T.abort = null;
    ui.mic.classList.remove('is-busy');
    if (!T.rec) setState('待机', '点麦克风继续，或打开连续对话');
    if (T.auto && !T.rec) {
      setTimeout(() => {
        if (T.auto && !T.rec && !T.busy) startRec();
      }, 350);
    }
  }

  function stopTurn() {
    if (T.abort) {
      try { T.abort.abort(); } catch (e) {}
      T.abort = null;
    }
    window.AudioEngine.reset();
    T.busy = false;
    T.audioStarted = false;
    T.ttsChain = Promise.resolve();
    ui.mic.classList.remove('is-busy');
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

    buildVoiceMenu();
    applyAsrTag();

    bindMenu(ui.voiceBtn, ui.voiceMenu, (item) => {
      T.voice = item.dataset.voice;
      ui.voiceLabel.textContent = T.voice;
      M.ui.toast('对话音色切换为「' + T.voice + '」', { type: 'ok', timeout: 1600 });
    });

    document.addEventListener('click', () => {
      if (!ui.voiceMenu.hidden) { ui.voiceMenu.hidden = true; ui.voiceBtn.setAttribute('aria-expanded', 'false'); }
    });

    ui.mic.addEventListener('click', onMicClick);

    ui.autoBtn.addEventListener('click', () => {
      T.auto = !T.auto;
      ui.autoBtn.setAttribute('aria-checked', String(T.auto));
      if (T.auto && !T.rec && !T.busy) startRec();
      M.ui.toast(T.auto ? '已开启连续对话：答完自动继续听' : '已关闭连续对话', { type: 'ok', timeout: 1800 });
    });

    ui.reset.addEventListener('click', () => {
      stopTurn();
      T.history = [];
      ui.stage.innerHTML = '';
      const empty = document.createElement('div');
      empty.className = 'talk-empty';
      empty.id = 'talkEmpty';
      empty.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none"><path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Z" stroke="currentColor" stroke-width="1.6"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>' +
        '<b>按麦克风说一句话</b><span>先说一句 → 自动识别 → 模型边想边答 → 流式语音回你</span>';
      ui.stage.appendChild(empty);
      ui.empty = empty;
      setMetrics(null);
      setState('待机', '点一下开始说话，停顿自动结束（最长 15 秒）');
    });
  }

  /** 切到实时对话页签时调用 */
  function onEnter() {
    init();
    const asr = (S.boot && S.boot.talk && S.boot.talk.asr) || {};
    if (asr.available === false) {
      setState('本地识别模型未安装', '运行 scripts/download_asr.py 下载 SenseVoice-Small 后重启服务', true);
      return;
    }
    if (!M.ui.llmReady()) {
      setState('还差对话模型配置', '点右上角齿轮，填 Base URL / Key / 模型 ID', true);
    } else if (!T.rec && !T.busy) {
      setState('待机', '点一下开始说话，停顿自动结束（最长 15 秒）');
    }
  }

  function onLeave() {
    if (T.rec) stopRec();
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
    ui.mic.classList.add('is-busy');
    const ctl = new AbortController();
    T.abort = ctl;
    addBubble('user', text, { meta: 'dev 注入' });
    T.history.push({ role: 'user', content: text });
    try {
      await respond(ctl, T.turnStart);
    } catch (e) {
      setState('出错了', e.message || '', true);
      endTurn();
    }
  }

  window.Talk = { init, onEnter, onLeave, state: T, _devSay: devSay };
})();
