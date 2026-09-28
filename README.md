# drawio-inspector

A thin, read-only coordinate explorer for draw.io diagrams. It exposes stored and
draw.io-runtime geometry through a JavaScript API, CLI and stdio MCP server. It
does not read screenshots, classify collisions or prescribe layout fixes.

## Why

A layout pipeline can leave most placement and routing to draw.io, then inspect
the result without paying for pixel-based image analysis:

1. A caller supplies a bounded set of relevant cells or a coordinate region.
2. The inspector returns rectangles, text bounds, edge routes and sampled shape
   contours from XML or the local draw.io runtime.
3. The caller applies its own project-specific collision, clearance and layout
   rules.
4. Only the elements selected by that policy are sent back with strict placement
   or routing constraints.

This boundary is intentional. The MCP server is an observation layer, not a
collision library or an automatic repair engine. It does no unbounded all-pairs
search. Candidate generation, spatial indexes and remediation policy belong to
the orchestrating pipeline.

Every response states `inspectionBasis.kind: "coordinates"`, the coordinate
source, and `screenshotsUsed: false`.

## Coordinate sources

- `xml` reads stored `mxGeometry`, including nested parents, relative vertices,
  offsets and explicit waypoints. It is fast and needs no browser. XML waypoints
  are not claimed to be the final routed path.
- `rendered` executes a trusted local `viewer.min.js` in headless Chrome and reads
  draw.io runtime cell states: absolute bounds, final edge points, text bounds,
  visible terminals and sampled contours.
- `compare_geometry` reports factual deltas between the two sources.

No remote viewer is downloaded. The browser context blocks network requests, so
remote fonts, images, plugins and stencils are not loaded. Built-in shapes and
inline SVG images are supported.

## Setup

Requires Node.js 22+. XML mode has no browser dependency.

```powershell
npm ci
npm test
```

Rendered mode requires Google Chrome and a local draw.io `viewer.min.js`. On
Windows the installed `hediet.vscode-drawio` extension is detected automatically.
Alternatively set `DRAWIO_VIEWER_PATH` to its absolute path. Set
`DRAWIO_BROWSER_CHANNEL` to choose another installed Playwright browser channel
(default: `chrome`).

## MCP

```json
{
  "mcpServers": {
    "drawio-inspector": {
      "command": "node",
      "args": ["C:/GitHub/drawio-inspector/src/mcp.mjs"]
    }
  }
}
```

The included `.vscode/mcp.json` is an equivalent workspace example.

### Tools

- `inspect_element` returns facts for one `cellId` or `stableId`. A repeated
  stable ID may match several visual cells.
- `inspect_elements` accepts up to 200 explicit `{cellId}` / `{stableId}`
  selectors and returns one deduplicated bounded result.
- `inspect_region` discovers cells intersecting either an explicit
  `{x,y,width,height}` rectangle or a padded rectangle around supplied selectors.
- `compare_geometry` compares stored and runtime geometry for an optional bounded
  set; without selectors it compares the page.

All tools are read-only. `limit` bounds returned items. `page` is zero-based.
Sampled contour points are omitted by default; request `includeContours: true`
only for the bounded candidate set that needs shape-level precision.
The process can read files available to its OS user; MCP registration is not a
filesystem sandbox.

Example batch request:

```json
{
  "file": "C:/diagrams/example.drawio",
  "mode": "rendered",
  "selectors": [
    { "cellId": "edge-17" },
    { "stableId": "code:payment-service" }
  ]
}
```

The response contains raw evidence such as:

```json
{
  "inspectionBasis": {
    "kind": "coordinates",
    "source": "drawio-runtime-cell-state",
    "screenshotsUsed": false
  },
  "elements": [
    { "cellId": "edge-17", "route": [{ "x": 120, "y": 80 }] },
    { "cellId": "node-4", "bounds": { "x": 180, "y": 60, "width": 120, "height": 50 } }
  ]
}
```

Whether that route collides with that node is deliberately a decision for the
consumer's validation profile.

## CLI

```powershell
node src/cli.mjs inspect_element --file C:/diagrams/example.drawio --cellId n6
node src/cli.mjs inspect_elements --file C:/diagrams/example.drawio --mode rendered --selectors '[{"cellId":"e10"},{"cellId":"n6"}]'
node src/cli.mjs inspect_region --file C:/diagrams/example.drawio --region '{"x":100,"y":50,"width":500,"height":300}'
node src/cli.mjs compare_geometry --file C:/diagrams/example.drawio --cellId e10
```

All commands print JSON.

## Accuracy and limits

Runtime SVG contours are sampled at roughly two-unit intervals and capped at
1024 points. For inline SVG images, the largest closed filled path is used.
Transforms, clipping, disjoint components and holes are not resolved and carry a
caveat. Unsupported shapes expose their bounding rectangle with `bounds-only`
accuracy. Text is represented by rectangles, not glyph outlines. Edge-relative
children require rendered mode for authoritative positions.

Inputs are limited to 32 MiB and 15,000 cells per page. DTD/entity declarations,
invalid coordinates, duplicate IDs, missing parents and parent cycles fail
explicitly. Runtime geometry is cached by content hash, page and viewer mtime,
with at most three entries per process.

## Verification

`npm test` covers compressed and uncompressed pages, nested and relative
coordinates, invalid documents, bounded batch and region queries, runtime routes,
contours, XML/runtime comparison and a real MCP stdio client session. The
rendered test requires the local viewer and Chrome described above.

No project diagrams, credentials, editor profile or browser cache are committed.
