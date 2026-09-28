#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { operations } from './inspector.mjs';

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      file: { type: 'string' }, mode: { type: 'string', default: 'xml' },
      stableId: { type: 'string' }, cellId: { type: 'string' },
      selectors: { type: 'string' }, region: { type: 'string' },
      includeContours: { type: 'boolean', default: false },
      page: { type: 'string' }, limit: { type: 'string' }, padding: { type: 'string' },
    },
  });
  const operation = operations[positionals[0]];
  if (!operation || !values.file) {
    throw new Error('Usage: node src/cli.mjs inspect_element|inspect_elements|inspect_region|compare_geometry --file PATH [--mode rendered] [--stableId ID | --cellId ID | --selectors JSON]');
  }
  for (const key of ['page', 'limit', 'padding']) if (values[key] !== undefined) {
    values[key] = Number(values[key]);
    if (!Number.isFinite(values[key]) || values[key] < 0) throw new Error(`Invalid ${key}`);
  }
  for (const key of ['selectors', 'region']) if (values[key] !== undefined) {
    try { values[key] = JSON.parse(values[key]); }
    catch { throw new Error(`Invalid JSON in --${key}`); }
  }
  console.log(JSON.stringify(await operation(values), null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
