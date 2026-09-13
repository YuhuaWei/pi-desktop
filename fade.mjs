import fs from 'node:fs';
const f = 'C:/Users/17662/pi-desktop/web/public/index.html';
let s = fs.readFileSync(f, 'utf8');
const o = `  .thinking-block::details-content, .tool-block::details-content {
    block-size: 0; overflow: hidden;
    transition: block-size .22s ease, content-visibility .22s;
    transition-behavior: allow-discrete;
  }
  .thinking-block[open]::details-content, .tool-block[open]::details-content { block-size: auto; }`;
const n = `  .thinking-block::details-content, .tool-block::details-content {
    block-size: 0; overflow: hidden; opacity: 0;
    transition: block-size .22s ease, opacity .18s ease, content-visibility .22s;
    transition-behavior: allow-discrete;
  }
  .thinking-block[open]::details-content, .tool-block[open]::details-content { block-size: auto; opacity: 1; }`;
if (s.includes(o)) { s = s.replace(o, n); fs.writeFileSync(f, s); console.log('淡入 ✔'); }
else console.log('SKIP');
