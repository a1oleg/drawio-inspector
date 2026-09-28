import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';

export async function resolveViewer(explicit = process.env.DRAWIO_VIEWER_PATH) {
  if (explicit) { await fs.access(explicit); return path.resolve(explicit); }
  const extensions = path.join(os.homedir(), '.vscode', 'extensions');
  const names = (await fs.readdir(extensions)).filter(n => n.startsWith('hediet.vscode-drawio-')).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const name of names) {
    const candidate = path.join(extensions, name, 'drawio/src/main/webapp/js/viewer.min.js');
    try { await fs.access(candidate); return candidate; } catch { /* Try the next installation. */ }
  }
  throw new Error('Set DRAWIO_VIEWER_PATH to a local draw.io viewer.min.js');
}

export async function renderDiagram(modelXml, viewerPath) {
  const browser = await chromium.launch({ channel: process.env.DRAWIO_BROWSER_CHANNEL || 'chrome', headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: 'block' });
    await context.route('**/*', route => route.abort());
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.setContent('<!doctype html><html><body style="margin:0"><div id="graph" style="width:1600px;height:1000px"></div></body></html>');
    await page.addScriptTag({ path: viewerPath });
    return await page.evaluate(async xml => {
      const host = document.getElementById('graph');
      const graph = new Graph(host);
      graph.setEnabled(false);
      const doc = mxUtils.parseXml(xml);
      new mxCodec(doc).decode(doc.documentElement, graph.getModel());
      graph.getView().scaleAndTranslate(1, 0, 0);
      graph.getView().validate();
      await document.fonts.ready;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const rect = r => r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
      const area = p => Math.abs(p.reduce((a, q, i) => {
        const n = p[(i + 1) % p.length]; return a + q.x * n.y - n.x * q.y;
      }, 0) / 2);
      const sample = (el, transform) => {
        const length = el.getTotalLength();
        const count = Math.min(1024, Math.max(16, Math.ceil(length / 2)));
        return Array.from({ length: count }, (_, i) => transform(el.getPointAtLength(length * i / count)));
      };
      function contour(state) {
        const b = rect(state);
        const rectangle = [{x:b.x,y:b.y},{x:b.x+b.width,y:b.y},{x:b.x+b.width,y:b.y+b.height},{x:b.x,y:b.y+b.height}];
        const image = String(state.style.image || '');
        if (image.startsWith('data:image/svg+xml')) {
          const comma = image.indexOf(',');
          let svgText = image.slice(comma + 1);
          try {
            svgText = image.slice(0, comma).includes(';base64') ? atob(svgText) : svgText.trim().startsWith('<') ? svgText : decodeURIComponent(svgText);
            const svgDoc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
            // Inspect geometry only; never mount scripts, external resources or foreignObject.
            const source = svgDoc.documentElement;
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('viewBox', source.getAttribute('viewBox') || `0 0 ${b.width} ${b.height}`);
            svg.style.cssText = 'position:absolute;left:-10000px;top:-10000px';
            document.body.append(svg);
            try {
              const vb = svg.viewBox.baseVal;
              const polys = [...source.querySelectorAll('path')].filter(p => /z\s*$/i.test(p.getAttribute('d') || '') && p.getAttribute('fill') !== 'none').map(p => {
                const clean = document.createElementNS(svg.namespaceURI, 'path');
                clean.setAttribute('d', p.getAttribute('d'));
                svg.append(clean);
                return sample(clean, q => ({ x: b.x + (q.x-vb.x)*b.width/vb.width, y: b.y + (q.y-vb.y)*b.height/vb.height }));
              });
              if (polys.length) return { points: polys.sort((a,c) => area(c)-area(a))[0], accuracy: 'sampled-svg', caveat: 'Largest closed filled path; transforms, clipping and holes are not resolved.' };
            } finally { svg.remove(); }
          } catch { /* Report a conservative fallback below. */ }
        }
        const paths = [...(state.shape?.node?.querySelectorAll('path,polygon,rect,ellipse') || [])].filter(p => p.getAttribute('fill') !== 'none' && typeof p.getTotalLength === 'function');
        const hostRect = host.getBoundingClientRect();
        const polys = paths.map(p => {
          const matrix = p.getScreenCTM();
          return matrix ? sample(p, q => { const v = new DOMPoint(q.x,q.y).matrixTransform(matrix); return {x:v.x-hostRect.x,y:v.y-hostRect.y}; }) : [];
        }).filter(p => p.length);
        return polys.length ? { points: polys.sort((a,c) => area(c)-area(a))[0], accuracy: 'sampled-engine' }
          : { points: rectangle, accuracy: 'bounds-only', caveat: 'No supported closed contour; bounding rectangle only.' };
      }
      const result = Object.values(graph.getModel().cells).flatMap(cell => {
        const s = graph.getView().getState(cell);
        if (!s || (!cell.vertex && !cell.edge)) return [];
        const points = cell.edge ? (s.absolutePoints || []).filter(Boolean).map(p => ({ x:p.x, y:p.y })) : null;
        return [{ id: cell.id, bounds: rect(s), textBounds: rect(s.text?.boundingBox), points,
          contour: cell.vertex ? contour(s) : null,
          visibleSource: cell.edge ? s.getVisibleTerminal(true)?.id || null : null,
          visibleTarget: cell.edge ? s.getVisibleTerminal(false)?.id || null : null }];
      });
      graph.destroy();
      return { engineVersion: typeof Editor !== 'undefined' ? Editor.version : null, cells: result };
    }, modelXml);
  } finally { await browser.close(); }
}
