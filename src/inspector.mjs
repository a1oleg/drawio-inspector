import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseDiagram, MAX_BYTES } from './xml.mjs';
import { renderDiagram, resolveViewer } from './render.mjs';
import { overlaps, distance } from './geometry.mjs';

const cache = new Map();

export async function loadDiagram(file, { mode = 'xml', page = 0 } = {}) {
  const absolute = path.resolve(file);
  const stat = await fs.stat(absolute);
  if (stat.size > MAX_BYTES) throw new Error('Diagram exceeds 32 MiB');
  const xml = await fs.readFile(absolute, 'utf8');
  const parsed = parseDiagram(xml, page);
  if (parsed.cells.length > 15_000) throw new Error('Diagram exceeds 15000 cells; split it into pages');
  const digest = createHash('sha256').update(xml).digest('hex');
  let engine = null;
  if (mode === 'rendered') {
    const viewer = await resolveViewer();
    const key = `${digest}:${page}:${viewer}:${(await fs.stat(viewer)).mtimeMs}`;
    engine = cache.get(key);
    if (!engine) {
      engine = await renderDiagram(parsed.modelXml, viewer);
      cache.set(key, engine);
      while (cache.size > 3) cache.delete(cache.keys().next().value);
    }
  } else if (mode !== 'xml') throw new Error(`Unknown mode: ${mode}`);
  const states = new Map(engine?.cells.map(c => [c.id, c]) || []);
  return {
    file: absolute, digest, mode, page, pageName: parsed.pageName, pageCount: parsed.pageCount,
    engineVersion: engine?.engineVersion || null, warnings: parsed.warnings,
    cells: parsed.cells.map(c => ({ ...c, rendered: states.get(c.id) || null })),
  };
}

const bounds = c => c.rendered?.bounds || c.bounds;
const head = d => ({
  file: d.file, digest: d.digest, mode: d.mode, page: d.page, pageName: d.pageName,
  engineVersion: d.engineVersion,
  inspectionBasis: {
    kind: 'coordinates',
    source: d.mode === 'rendered' ? 'drawio-runtime-cell-state' : 'stored-mxgeometry',
    screenshotsUsed: false,
  },
  warnings: d.warnings,
});

function selectorList(args, required = true) {
  const selectors = args.selectors || (args.stableId || args.cellId ? [{ stableId: args.stableId, cellId: args.cellId }] : []);
  if (required && !selectors.length) throw new Error('Provide selectors, stableId or cellId');
  for (const selector of selectors) {
    if ((!selector.stableId && !selector.cellId) || (selector.stableId && selector.cellId)) {
      throw new Error('Each selector must provide exactly one of stableId or cellId');
    }
  }
  return selectors;
}

function select(diagram, selector) {
  const cells = diagram.cells.filter(c => selector.cellId ? c.id === selector.cellId : c.stableId === selector.stableId);
  if (!cells.length) throw new Error(`Element not found: ${selector.cellId || selector.stableId}`);
  return cells;
}

function selectMany(diagram, args, required = true) {
  const selectors = selectorList(args, required);
  const matches = selectors.map(selector => ({ selector, cells: select(diagram, selector) }));
  const unique = new Map(matches.flatMap(match => match.cells).map(cell => [cell.id, cell]));
  return { matches, cells: [...unique.values()] };
}

function describe(c, includeContours = false) {
  return {
    cellId: c.id, stableId: c.stableId, kind: c.kind, label: c.label.slice(0, 500), parent: c.parent,
    source: c.source, target: c.target, edgeType: c.metadata.edgeType || null,
    visibleSource: c.rendered?.visibleSource || null, visibleTarget: c.rendered?.visibleTarget || null,
    bounds: bounds(c), xmlBounds: c.bounds, textBounds: c.rendered?.textBounds || null,
    renderedVisible: !!c.rendered, route: c.rendered?.points || null, xmlWaypoints: c.waypoints,
    portStyle: Object.fromEntries(Object.entries(c.style).filter(([key]) => /^(entry|exit)/.test(key))),
    contour: c.rendered?.contour ? {
      accuracy: c.rendered.contour.accuracy,
      pointCount: c.rendered.contour.points.length,
      ...(includeContours ? { points: c.rendered.contour.points } : {}),
      caveat: c.rendered.contour.caveat || null,
    } : null,
  };
}

function bounded(elements, limit = 100, includeContours = false) {
  return { total: elements.length, truncated: elements.length > limit, elements: elements.slice(0, limit).map(cell => describe(cell, includeContours)) };
}

export async function inspectElement(args) {
  const diagram = await loadDiagram(args.file, args);
  return { ...head(diagram), ...bounded(selectMany(diagram, args).cells, args.limit || 100, args.includeContours) };
}

export async function inspectElements(args) {
  const diagram = await loadDiagram(args.file, args);
  const selected = selectMany(diagram, args);
  return {
    ...head(diagram),
    requestedSelectors: selected.matches.map(match => ({ selector: match.selector, matchedCellIds: match.cells.map(cell => cell.id) })),
    ...bounded(selected.cells, args.limit || 100, args.includeContours),
  };
}

export async function inspectRegion(args) {
  const diagram = await loadDiagram(args.file, args);
  const padding = args.padding ?? 40;
  let region = args.region;
  if (region) {
    if (['x', 'y', 'width', 'height'].some(key => !Number.isFinite(region[key])) || region.width < 0 || region.height < 0) {
      throw new Error('region must contain finite x, y, width and height; width and height cannot be negative');
    }
  } else {
    const selected = selectMany(diagram, args).cells.map(bounds);
    const x = Math.min(...selected.map(b => b.x)) - padding;
    const y = Math.min(...selected.map(b => b.y)) - padding;
    region = {
      x, y,
      width: Math.max(...selected.map(b => b.x + b.width)) + padding - x,
      height: Math.max(...selected.map(b => b.y + b.height)) + padding - y,
    };
  }
  const cells = diagram.cells.filter(c => c.kind !== 'root' && overlaps(bounds(c), region));
  return { ...head(diagram), region, ...bounded(cells, args.limit || 100, args.includeContours) };
}

export async function compareGeometry(args) {
  const diagram = await loadDiagram(args.file, { ...args, mode: 'rendered' });
  const selected = selectorList(args, false).length ? selectMany(diagram, args).cells : diagram.cells.filter(c => c.kind !== 'root');
  const changes = selected.flatMap(c => {
    if (!c.rendered) return [{ cellId: c.id, stableId: c.stableId, change: 'not-rendered' }];
    if (c.kind === 'edge') return [{
      cellId: c.id, stableId: c.stableId,
      change: c.waypoints.length ? 'route-comparison' : 'engine-generated-route',
      xmlWaypoints: c.waypoints, renderedPoints: c.rendered.points,
      missingWaypoints: c.waypoints.filter(p => !c.rendered.points.some(q => distance(p, q) < 1)),
    }];
    const delta = Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, c.rendered.bounds[key] - c.bounds[key]]));
    return Object.values(delta).some(value => Math.abs(value) > 0.01) ? [{ cellId: c.id, stableId: c.stableId, delta }] : [];
  });
  const limit = args.limit || 100;
  return { ...head(diagram), total: changes.length, truncated: changes.length > limit, changes: changes.slice(0, limit) };
}

export const operations = {
  inspect_element: inspectElement,
  inspect_elements: inspectElements,
  inspect_region: inspectRegion,
  compare_geometry: compareGeometry,
};
