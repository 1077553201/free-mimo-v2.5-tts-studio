#!/usr/bin/env node
/**
 * 从站点 static/ui-config.js 重新导出 assets/catalog.json。
 *
 * 站点改词表后跑一次，保证 skill 里的音色/标签/预设与网页一致：
 *   node skills/mimo-tts/scripts/gen_catalog.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..', '..');
const source = path.join(root, 'static', 'ui-config.js');

global.window = {};
require(source);
const c = global.window.MIMO_CONFIG;
if (!c) {
  console.error('未能从 ui-config.js 读到 window.MIMO_CONFIG：' + source);
  process.exit(1);
}

const out = {
  meta: {
    source: 'static/ui-config.js',
    generated_by: 'scripts/gen_catalog.js',
    note: '词表快照；与站点保持一致时以 static/ui-config.js 为准',
  },
  default_base_url: c.DEFAULT_BASE_URL,
  chat_path: c.CHAT_PATH,
  sample_rate: c.SAMPLE_RATE,
  max_sample_bytes: c.MAX_SAMPLE_BYTES,
  models: c.MODELS,
  voices: c.VOICES,
  opening_tags: c.OPENING_TAGS,
  inline_tags: c.INLINE_TAGS,
  style_presets: c.STYLE_PRESETS,
  design_dimensions: c.DESIGN_DIMENSIONS,
  design_templates: c.DESIGN_TEMPLATES,
};

const target = path.join(__dirname, '..', 'assets', 'catalog.json');
fs.writeFileSync(target, JSON.stringify(out, null, 2) + '\n', 'utf8');

console.log(
  'catalog.json 已更新：models=%d voices=%d presets=%d opening=%d inline=%d dims=%d templates=%d',
  out.models.length,
  out.voices.length,
  out.style_presets.length,
  out.opening_tags.reduce((n, g) => n + g.tags.length, 0),
  out.inline_tags.reduce((n, g) => n + g.tags.length, 0),
  out.design_dimensions.length,
  out.design_templates.length
);
