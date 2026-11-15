// The document of the simulator's iframe. It is a srcdoc with its script inline: the iframe is
// sandboxed without allow-same-origin, so its origin is opaque and it could not load module
// scripts from the IDE's origin without CORS headers, which static hosting does not always send.
import frameScript from './frame.js?raw';
import { language, tr } from '../i18n/tr.ts';

const STYLE = `
  :root { color-scheme: dark; --ratio: 1024 / 600; }
  html, body { margin: 0; height: 100%; background: #101318; overflow: hidden; }
  body { display: flex; align-items: center; justify-content: center; }
  canvas {
    display: block; max-width: 100%; max-height: 100%; aspect-ratio: var(--ratio);
    background: #000; touch-action: none; image-rendering: pixelated; outline: none;
  }
  #typing { position: fixed; left: -1000px; top: 0; width: 1px; height: 1px; opacity: 0; }
`;

export function framePage(): string {
  return `<!DOCTYPE html>
<html lang="${language()}">
<head><meta charset="utf-8"><title>${tr('Simulator')}</title><style>${STYLE}</style></head>
<body>
<canvas id="canvas" width="1024" height="600" tabindex="0" oncontextmenu="event.preventDefault()"></canvas>
<textarea id="typing" autocapitalize="off" autocomplete="off" spellcheck="false" aria-label="${tr('Keyboard')}"></textarea>
<script type="module">${frameScript}</script>
</body>
</html>`;
}
