import fs from 'node:fs';
const f = 'C:/Users/17662/pi-desktop/web/public/index.html';
let s = fs.readFileSync(f, 'utf8');
let n = 0;

// ===== 1. thinking-block：按下效果 + 展开动画 + 箭头旋转 =====
const o1 = `  .thinking-block summary { cursor: pointer; padding: 6px 12px; user-select: none; }
  .thinking-block .thinking-body {
    padding: 0 12px 10px; max-height: 200px; overflow-y: auto;
    white-space: pre-wrap; font-size: 12.5px; color: var(--muted); display: none;
  }
  .thinking-block[open] .thinking-body { display: block; }`;
const n1 = `  .thinking-block summary {
    cursor: pointer; padding: 6px 12px 6px 26px; user-select: none;
    position: relative; list-style: none;
    transition: background .15s ease, transform .08s ease;
  }
  .thinking-block summary::-webkit-details-marker { display: none; }
  .thinking-block summary:active { transform: scale(.985); background: rgba(127,127,127,.14); }
  .thinking-block .thinking-body {
    padding: 0 12px 10px; max-height: 200px; overflow-y: auto;
    white-space: pre-wrap; font-size: 12.5px; color: var(--muted);
  }
  /* 展开/收起过渡动画（Chrome 131+ ::details-content） */
  .thinking-block, .tool-block { interpolate-size: allow-keywords; }
  .thinking-block::details-content, .tool-block::details-content {
    block-size: 0; overflow: hidden;
    transition: block-size .22s ease, content-visibility .22s;
    transition-behavior: allow-discrete;
  }
  .thinking-block[open]::details-content, .tool-block[open]::details-content { block-size: auto; }
  /* 箭头指示（展开时旋转 90°） */
  .thinking-block summary::before, .tool-block summary::before {
    content: '▶'; position: absolute; left: 10px; top: 50%;
    transform: translateY(-50%); font-size: 9px; color: var(--muted);
    transition: transform .2s ease;
  }
  .thinking-block[open] summary::before, .tool-block[open] summary::before { transform: translateY(-50%) rotate(90deg); }`;
if (s.includes(o1)) { s = s.replace(o1, n1); n++; console.log('1. thinking-block ✔'); }
else console.log('1. SKIP');

// ===== 2. tool-block summary：按下效果 =====
const o2 = `  .tool-block summary {
    cursor: pointer; padding: 6px 12px; font-size: 12.5px;
    font-family: Consolas, monospace; color: var(--muted);
    user-select: none; list-style: none; display: flex; gap: 8px; align-items: center;
  }`;
const n2 = `  .tool-block summary {
    cursor: pointer; padding: 6px 12px 6px 26px; font-size: 12.5px;
    font-family: Consolas, monospace; color: var(--muted);
    user-select: none; list-style: none; display: flex; gap: 8px; align-items: center;
    position: relative; transition: background .15s ease, transform .08s ease;
  }
  .tool-block summary:active { transform: scale(.985); background: rgba(127,127,127,.14); }`;
if (s.includes(o2)) { s = s.replace(o2, n2); n++; console.log('2. tool-block ✔'); }
else console.log('2. SKIP');

fs.writeFileSync(f, s);
console.log('DONE', n);
