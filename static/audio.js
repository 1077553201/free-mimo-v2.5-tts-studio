/* =========================================================================
   audio.js — 流式 PCM 无缝排播 + 频谱可视化

   两条播放路径：
   A. 流式：上游 PCM16/24k 分块 → 每块建一个 AudioBufferSourceNode，
      用「调度游标 cursor」把下一块接在上一块结尾，做到无接缝连播。
   B. 非流式：直接 <audio src="/media/x.wav">，但通过 createMediaElementSource
      接进同一个 analyser，可视化与音量控制保持统一。

   三个必踩的坑（都已处理）：
   1. ctx.resume() 必须在点击的同步栈里调用，否则 iOS/Safari 不出声；
   2. 源 buffer 声明 24000Hz，让浏览器自动重采样到设备采样率，不要手写插值；
   3. 取消时必须 stop 掉所有已排期的 source 并重置游标，否则下一轮会重叠。
   ========================================================================= */
(function () {
  'use strict';

  const SR = 24000;
  const LEAD = 0.08;        // 80ms 预排，吸收网络抖动
  const LATE_RESET = 0.15;  // 落后超过 150ms 就重置游标，避免声音堆积

  let ctx = null;
  let gain = null;
  let analyser = null;
  let freq = null;

  const sources = new Set();
  const elSources = new WeakMap();

  let carry = new Uint8Array(0);
  let cursor = 0;
  let startAt = 0;
  let receivedFrames = 0;
  let streaming = false;
  let mode = 'idle';        // idle | stream | element
  let rafId = null;
  let onFinish = null;
  let el = null;            // 非流式时挂载的 <audio>
  const stats = { appends: 0, frames: 0, started: 0, ended: 0, finished: 0 };

  /* ------------------------------------------------------------- 初始化 */

  function ensure() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      ctx = new AC();
      gain = ctx.createGain();
      gain.gain.value = 0.85;
      analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.82;
      freq = new Uint8Array(analyser.frequencyBinCount);
      gain.connect(analyser);
      analyser.connect(ctx.destination);
      startDrawLoop();
    }
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
    return ctx;
  }

  function context() { return ctx; }

  /* ------------------------------------------------------------- 流式排播 */

  function decode(b64) {
    try {
      const bin = atob(String(b64).replace(/\s+/g, ''));
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch (e) {
      return null;
    }
  }

  function appendPCM(b64) {
    if (!ctx) return;
    const bytes = decode(b64);
    if (!bytes || !bytes.length) return;

    let all;
    if (carry.length) {
      all = new Uint8Array(carry.length + bytes.length);
      all.set(carry, 0);
      all.set(bytes, carry.length);
    } else {
      all = bytes;
    }

    const n = all.length >> 1;          // 只取完整的 16bit 帧
    carry = all.slice(n * 2);           // 多出来的 1 字节留到下一块
    if (!n) return;

    const pcm = new Int16Array(all.buffer, all.byteOffset, n);
    const buf = ctx.createBuffer(1, n, SR);   // 声明 24k，浏览器自动重采样
    const ch = buf.getChannelData(0);
    for (let i = 0; i < n; i++) ch[i] = pcm[i] / 32768;

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(gain);

    const now = ctx.currentTime;
    let t = Math.max(now + LEAD, cursor);
    if (cursor && t < now + LEAD - LATE_RESET) t = now + LEAD; // 严重落后，整段重排

    src.start(t);
    if (!startAt) startAt = t;
    cursor = t + buf.duration;
    receivedFrames += n;
    sources.add(src);
    stats.appends += 1;
    stats.frames += n;
    stats.started += 1;

    src.onended = () => {
      sources.delete(src);
      stats.ended += 1;
      try { src.disconnect(); } catch (e) {}
      if (!streaming && sources.size === 0) finish();
    };
  }

  function finish() {
    mode = 'idle';
    streaming = false;
    stats.finished += 1;
    const cb = onFinish;
    onFinish = null;
    if (cb) cb();
  }

  /* ------------------------------------------------------------- 生命周期 */

  function beginStream(cb) {
    ensure();
    stopAll();
    mode = 'stream';
    streaming = true;
    onFinish = cb || null;
  }

  function endStream() {
    streaming = false;
    // 没有在途的 source（例如空音频）就直接收尾
    if (sources.size === 0) finish();
  }

  function stopAll() {
    sources.forEach((s) => {
      try { s.stop(); } catch (e) {}
      try { s.disconnect(); } catch (e) {}
    });
    sources.clear();
    carry = new Uint8Array(0);
    cursor = 0;
    startAt = 0;
    receivedFrames = 0;
    streaming = false;
    if (mode === 'stream') mode = 'idle';
    onFinish = null;
  }

  function reset() { stopAll(); }

  /* ------------------------------------------------------------- <audio> */

  function attachElement(node) {
    ensure();
    if (!node) return;
    el = node;
    let src = elSources.get(node);
    if (!src) {
      try {
        src = ctx.createMediaElementSource(node);
        src.connect(gain);
        elSources.set(node, src);
      } catch (e) {
        return; // 已经连过或浏览器不支持
      }
    }
    mode = 'element';
  }

  /* ------------------------------------------------------------- 状态 */

  function state() {
    if (mode === 'stream') {
      const duration = receivedFrames / SR;
      const pos = startAt && ctx ? Math.max(0, ctx.currentTime - startAt) : 0;
      return {
        mode,
        duration,
        position: duration ? Math.min(pos, duration) : 0,
        playing: streaming || sources.size > 0,
        progress: duration ? Math.min(pos / duration, 1) : 0,
      };
    }
    if (mode === 'element' && el) {
      const duration = isFinite(el.duration) ? el.duration : 0;
      const position = el.currentTime || 0;
      return {
        mode,
        duration,
        position,
        playing: !el.paused && !el.ended,
        progress: duration ? Math.min(position / duration, 1) : 0,
      };
    }
    return { mode, duration: 0, position: 0, playing: false, progress: 0 };
  }

  let volumeBeforeMute = 0.85;

  function setVolume(v) {
    if (!gain || !ctx) return;
    const level = Math.max(0, Math.min(1, v));
    volumeBeforeMute = level;
    gain.gain.setTargetAtTime(level, ctx.currentTime, 0.02);
  }

  function setMuted(muted) {
    if (!gain || !ctx) return;
    gain.gain.setTargetAtTime(muted ? 0 : volumeBeforeMute, ctx.currentTime, 0.02);
  }

  /* ------------------------------------------------------------- 可视化 */

  const canvas = () => document.getElementById('waveCanvas');
  const BAR_COUNT = 56;

  function paintIdle(g, w, h) {
    const barW = w / BAR_COUNT;
    const mid = h / 2;
    for (let i = 0; i < BAR_COUNT; i++) {
      const wave = Math.sin(i * 0.55) * Math.cos(i * 0.21);
      const bh = Math.max(2, Math.abs(wave) * h * 0.26 + 2);
      const x = i * barW + barW * 0.22;
      const bw = barW * 0.56;
      g.fillStyle = 'rgba(150,150,175,0.22)';
      roundRect(g, x, mid - bh / 2, bw, bh, Math.min(bw / 2, 2));
      g.fill();
    }
  }

  function roundRect(g, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  function startDrawLoop() {
    if (rafId) return;
    const loop = () => {
      rafId = requestAnimationFrame(loop);
      if (document.hidden) return;
      const cv = canvas();
      if (!cv) return;

      const dpr = window.devicePixelRatio || 1;
      const w = cv.clientWidth;
      const h = cv.clientHeight;
      if (!w || !h) return;
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
        cv.width = Math.round(w * dpr);
        cv.height = Math.round(h * dpr);
      }
      const g = cv.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);

      // 完全没有音频时只画一条基准线，避免和「生成的语音会在这里播放」这行字打架
      const hasAudio = mode !== 'idle' || (el && el.getAttribute('src'));
      if (!hasAudio) {
        g.strokeStyle = 'rgba(150,150,175,0.18)';
        g.lineWidth = 1.5;
        g.beginPath();
        g.moveTo(w * 0.1, h / 2);
        g.lineTo(w * 0.34, h / 2);
        g.moveTo(w * 0.66, h / 2);
        g.lineTo(w * 0.9, h / 2);
        g.stroke();
        return;
      }

      if (!analyser) { paintIdle(g, w, h); return; }

      analyser.getByteFrequencyData(freq);
      const st = state();
      const activeBars = Math.max(1, Math.round(st.progress * BAR_COUNT));
      const playing = st.playing;

      const barW = w / BAR_COUNT;
      const mid = h / 2;
      const showBars = playing || st.duration > 0;

      for (let i = 0; i < BAR_COUNT; i++) {
        // 低频少取一点，避免整排贴着顶
        const idx = Math.floor(Math.pow(i / BAR_COUNT, 1.4) * (freq.length * 0.55));
        const v = playing ? freq[idx] / 255 : 0;
        const idle = Math.abs(Math.sin(i * 0.55) * Math.cos(i * 0.21)) * 0.26;
        const level = playing ? Math.max(v, 0.02) : idle;
        const bh = Math.max(2, level * h * 0.92);
        const x = i * barW + barW * 0.22;
        const bw = Math.max(1.5, barW * 0.56);
        const y = mid - bh / 2;

        const playedThrough = i < activeBars || !st.duration;
        if (showBars && playedThrough) {
          const grad = g.createLinearGradient(0, y, 0, y + bh);
          grad.addColorStop(0, 'rgba(139,123,255,0.95)');
          grad.addColorStop(1, 'rgba(255,95,158,0.62)');
          g.fillStyle = grad;
        } else {
          g.fillStyle = 'rgba(150,150,175,0.2)';
        }
        roundRect(g, x, y, bw, bh, Math.min(bw / 2, 3));
        g.fill();
      }
    };
    loop();
  }

  window.AudioEngine = {
    ensure,
    context,
    reset,
    stop: stopAll,
    beginStream,
    appendPCM,
    endStream,
    attachElement,
    state,
    setVolume,
    setMuted,
    startDrawLoop,
    stats: () => ({ ...stats, sources: sources.size, streaming, mode, cursor: +cursor.toFixed(2), startAt: +startAt.toFixed(2), ctxTime: ctx ? +ctx.currentTime.toFixed(2) : -1 }),
  };
})();
