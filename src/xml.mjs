import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { inflateRawSync } from 'node:zlib';

export const MAX_BYTES = 32 * 1024 * 1024;
const children = (n, name) => [...n.childNodes].filter(c => c.nodeType === 1 && (!name || c.nodeName === name));
const attrs = n => n ? Object.fromEntries([...n.attributes].map(a => [a.name, a.value])) : {};
const num = (n, key, fallback = 0) => {
  const value = n?.getAttribute(key);
  const parsed = value ? Number(value) : fallback;
  if (!Number.isFinite(parsed)) throw new Error(`Invalid coordinate ${key}: ${value}`);
  return parsed;
};
export function parseDocument(xml) {
  if (Buffer.byteLength(xml) > MAX_BYTES) throw new Error('Diagram exceeds 32 MiB');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('DTD and entity declarations are not supported');
  return new DOMParser({ onError: (level, message) => { throw new Error(`Invalid XML: ${message}`); } }).parseFromString(xml, 'text/xml');
}
export function parseDiagram(xml, page = 0) {
  let doc = parseDocument(xml);
  const pages = [...doc.getElementsByTagName('diagram')];
  let pageName = null;
  if (pages.length) {
    const selected = pages[page];
    if (!selected) throw new Error(`Page ${page} does not exist; page count: ${pages.length}`);
    pageName = selected.getAttribute('name');
    const model = children(selected, 'mxGraphModel')[0];
    if (model) doc = parseDocument(new XMLSerializer().serializeToString(model));
    else {
      const body = selected.textContent.trim();
      const decoded = body.startsWith('<') ? body : decodeURIComponent(inflateRawSync(Buffer.from(body, 'base64'), { maxOutputLength: MAX_BYTES }).toString('utf8'));
      doc = parseDocument(decoded);
    }
  } else if (page !== 0) throw new Error('Only page 0 exists');
  const model = doc.getElementsByTagName('mxGraphModel')[0];
  if (!model) throw new Error('mxGraphModel not found');
  const cells = [...model.getElementsByTagName('mxCell')].map(cell => {
    const wrapper = cell.parentNode?.nodeName === 'root' ? null : cell.parentNode;
    const meta = { ...attrs(wrapper), ...attrs(cell) };
    const geometry = children(cell, 'mxGeometry')[0];
    const style = Object.fromEntries((meta.style || '').split(';').filter(Boolean).map(s => {
      const i = s.indexOf('='); return i < 0 ? [s, '1'] : [s.slice(0, i), s.slice(i + 1)];
    }));
    const point = n => ({ x: num(n, 'x'), y: num(n, 'y') });
    const points = geometry ? children(geometry, 'Array').filter(n => n.getAttribute('as') === 'points').flatMap(n => children(n, 'mxPoint').map(point)) : [];
    const terminal = name => {
      const p = geometry && children(geometry, 'mxPoint').find(n => n.getAttribute('as') === name);
      return p ? point(p) : null;
    };
    return { id: meta.id, stableId: meta.stableId || null, parent: meta.parent || null,
      source: meta.source || null, target: meta.target || null,
      kind: meta.edge === '1' ? 'edge' : meta.vertex === '1' ? 'vertex' : 'root',
      label: meta.value || meta.label || '', metadata: meta, style,
      geometry: { x: num(geometry, 'x'), y: num(geometry, 'y'), width: num(geometry, 'width'), height: num(geometry, 'height'), relative: geometry?.getAttribute('relative') === '1', offset: terminal('offset') },
      waypoints: points, sourcePoint: terminal('sourcePoint'), targetPoint: terminal('targetPoint') };
  });
  const byId = new Map(cells.map(c => [c.id, c]));
  if (byId.size !== cells.length || cells.some(c => !c.id)) throw new Error('Missing or duplicate cell ID');
  const visiting = new Set();
  const warnings = [];
  function resolve(c) {
    if (c.bounds) return c.bounds;
    if (visiting.has(c.id)) throw new Error(`Parent cycle at ${c.id}`);
    visiting.add(c.id);
    if (c.parent && !byId.has(c.parent)) throw new Error(`Missing parent ${c.parent}`);
    const parent = c.parent ? resolve(byId.get(c.parent)) : { x: 0, y: 0, width: 0, height: 0 };
    const g = c.geometry;
    if (g.relative && c.kind === 'vertex' && byId.get(c.parent)?.kind === 'edge') warnings.push({ cellId: c.id, rule: 'edge-relative-child-requires-engine' });
    c.bounds = { x: parent.x + (g.relative && c.kind === 'vertex' ? g.x * parent.width : g.x) + (g.offset?.x || 0),
      y: parent.y + (g.relative && c.kind === 'vertex' ? g.y * parent.height : g.y) + (g.offset?.y || 0), width: g.width, height: g.height };
    visiting.delete(c.id);
    return c.bounds;
  }
  cells.forEach(resolve);
  for (const c of cells.filter(c => c.kind === 'edge')) {
    const p = byId.get(c.parent)?.bounds || { x: 0, y: 0 };
    c.waypoints = c.waypoints.map(q => ({ x: q.x + p.x, y: q.y + p.y }));
    for (const key of ['sourcePoint', 'targetPoint']) if (c[key]) c[key] = { x: c[key].x + p.x, y: c[key].y + p.y };
    for (const key of ['source', 'target']) if (c[key] && !byId.has(c[key])) warnings.push({ cellId: c.id, rule: 'missing-terminal', terminal: c[key] });
  }
  return { page, pageName, pageCount: pages.length || 1, modelXml: new XMLSerializer().serializeToString(model), cells, warnings };
}
