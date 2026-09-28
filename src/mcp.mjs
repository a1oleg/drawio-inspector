#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import { operations } from './inspector.mjs';

const server = new McpServer({ name: 'drawio-inspector', version: '0.2.0' });
const selector = z.object({ stableId: z.string().optional(), cellId: z.string().optional() });
const common = {
  file: z.string(),
  mode: z.enum(['xml', 'rendered']).default('xml'),
  page: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(500).default(100),
  includeContours: z.boolean().default(false),
};
const definitions = {
  inspect_element: {
    description: 'Read coordinate facts for one cellId or stableId. A repeated stableId may return several cells.',
    inputSchema: { ...common, stableId: z.string().optional(), cellId: z.string().optional() },
  },
  inspect_elements: {
    description: 'Read coordinate facts for an explicit bounded set of cellId/stableId selectors. No collision policy is applied.',
    inputSchema: { ...common, selectors: z.array(selector).min(1).max(200) },
  },
  inspect_region: {
    description: 'Discover cells intersecting an explicit coordinate rectangle or a padded rectangle around selected cells.',
    inputSchema: {
      ...common,
      selectors: z.array(selector).min(1).max(200).optional(),
      stableId: z.string().optional(), cellId: z.string().optional(),
      region: z.object({ x: z.number(), y: z.number(), width: z.number().min(0), height: z.number().min(0) }).optional(),
      padding: z.number().min(0).max(10000).default(40),
    },
  },
  compare_geometry: {
    description: 'Report coordinate deltas between stored XML and the local draw.io runtime for an optional bounded set.',
    inputSchema: {
      ...common,
      selectors: z.array(selector).min(1).max(200).optional(),
      stableId: z.string().optional(), cellId: z.string().optional(),
    },
  },
};

for (const [name, definition] of Object.entries(definitions)) {
  server.registerTool(name, {
    ...definition,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async args => {
    try {
      const result = await operations[name](args);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error.message }] };
    }
  });
}

await server.connect(new StdioServerTransport());
