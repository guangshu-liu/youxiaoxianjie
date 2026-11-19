/* tts_texts.js — 导出「所有需要朗读的唯一题干文本」
 *
 * 给 tools/gen_tts_audio.py 用。规则本身在 src/js/22-tts-text.js，这里只做
 * 「把 600 道题过一遍规则、去重、排序」，绝不重写一遍归一化逻辑 —— 否则
 * 网页版念的和小程序预生成的音频迟早会漂移。
 *
 *   node tools/tts_texts.js        → stdout 是 JSON 数组
 */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const sandbox = { window: {} };
sandbox.window.G = {};
vm.createContext(sandbox);
vm.runInContext(
  fs.readFileSync(path.join(ROOT, 'src/js/22-tts-text.js'), 'utf8'),
  sandbox
);
const TTSText = sandbox.window.G.TTSText;

const texts = new Set();
for (const subject of ['chinese', 'math', 'english']) {
  const questions = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'src/data/' + subject + '.json'), 'utf8')
  );
  for (const q of questions) {
    const r = TTSText.forQuestion(q);
    if (!r.skip && r.text) texts.add(r.text);
    // 听音题的固定中文指令也是要预生成音频的文本，不能漏。
    const ins = TTSText.instructionFor(q);
    if (ins) texts.add(ins);
  }
}

process.stdout.write(JSON.stringify(Array.from(texts).sort()));
