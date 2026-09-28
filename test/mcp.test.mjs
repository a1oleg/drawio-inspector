import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
test('MCP exposes four read-only coordinate tools and executes batch inspection',{timeout:30000},async()=>{
  const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../src/mcp.mjs',import.meta.url))]});
  const client=new Client({name:'smoke-test',version:'1.0.0'});
  try {
    await client.connect(transport);
    const list=await client.listTools();
    assert.equal(list.tools.length,4);
    assert(list.tools.every(t=>t.annotations.readOnlyHint));
    assert(list.tools.some(t=>t.name==='inspect_elements'));
    assert(!list.tools.some(t=>t.name==='validate_geometry'));
    const result=await client.callTool({name:'inspect_elements',arguments:{file:fileURLToPath(new URL('./fixture.drawio',import.meta.url)),selectors:[{cellId:'a'},{cellId:'b'}]}});
    assert.deepEqual(result.structuredContent.elements.map(element=>element.stableId),['code:a','code:b']);
    const error=await client.callTool({name:'inspect_element',arguments:{file:'nonexistent.drawio',cellId:'a'}});
    assert.equal(error.isError,true);
  } finally { await client.close(); }
});
