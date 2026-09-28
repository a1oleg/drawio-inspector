import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
import { parseDiagram } from '../src/xml.mjs';
import { inspectElement,inspectElements,inspectRegion,compareGeometry } from '../src/inspector.mjs';
const file=new URL('./fixture.drawio',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1');
const xml=await fs.readFile(file,'utf8');

test('XML absolute geometry respects groups and parent-relative waypoints',()=>{
  const d=parseDiagram(xml);
  assert.deepEqual(d.cells.find(c=>c.id==='a').bounds,{x:100,y:90,width:40,height:40});
  assert.equal(d.pageName,'Test');
  const updated=xml.replace('<mxGeometry relative="1" as="geometry"/>','<mxGeometry relative="1" as="geometry"><Array as="points"><mxPoint x="70" y="20"/></Array></mxGeometry>');
  assert.deepEqual(parseDiagram(updated).cells.find(c=>c.id==='edge').waypoints,[{x:170,y:70}]);
});
test('compressed pages and wrapped metadata',()=>{
  const model='<mxGraphModel><root><mxCell id="0"/><object id="v" stableId="code:v" label="Variable"><mxCell vertex="1" parent="0"><mxGeometry x="5" y="6" width="10" height="20"/></mxCell></object></root></mxGraphModel>';
  const compressed=deflateRawSync(Buffer.from(encodeURIComponent(model))).toString('base64');
  const d=parseDiagram(`<mxfile><diagram>${compressed}</diagram></mxfile>`);
  assert.equal(d.cells[1].stableId,'code:v');
  assert.equal(d.cells[1].label,'Variable');
});
test('relative vertices include parent size and offset',()=>{
  const d=parseDiagram('<mxGraphModel><root><mxCell id="p"><mxGeometry x="10" y="20" width="100" height="200"/></mxCell><mxCell id="v" parent="p" vertex="1"><mxGeometry relative="1" x="0.5" y="0.5" width="4" height="6"><mxPoint as="offset" x="-2" y="-3"/></mxGeometry></mxCell></root></mxGraphModel>');
  assert.deepEqual(d.cells[1].bounds,{x:58,y:117,width:4,height:6});
});
test('invalid XML, cycles, duplicate IDs and missing pages fail explicitly',()=>{
  assert.throws(()=>parseDiagram('<!DOCTYPE a><a/>'),/DTD/);
  assert.throws(()=>parseDiagram('<mxGraphModel><root><mxCell id="a" parent="a"/></root></mxGraphModel>'),/cycle/);
  assert.throws(()=>parseDiagram('<mxGraphModel><root><mxCell id="a"/><mxCell id="a"/></root></mxGraphModel>'),/duplicate/);
  assert.throws(()=>parseDiagram(xml,1),/does not exist/);
});
test('bounded XML tools return explicit sets and coordinate regions',async()=>{
  assert.equal((await inspectElement({file,stableId:'code:a'})).elements[0].cellId,'a');
  const set=await inspectElements({file,selectors:[{cellId:'a'},{stableId:'code:obstacle'}]});
  assert.deepEqual(set.elements.map(element=>element.cellId),['a','obstacle']);
  assert.equal(set.inspectionBasis.screenshotsUsed,false);
  const region=await inspectRegion({file,cellId:'a',limit:1,padding:200});
  assert.equal(region.elements.length,1);assert(region.truncated);
  const explicit=await inspectRegion({file,region:{x:175,y:85,width:50,height:50}});
  assert(explicit.elements.some(element=>element.cellId==='obstacle'));
});
test('rendered engine exposes route, contours and text coordinates without policy',{timeout:30000},async()=>{
  const result=await inspectElements({file,mode:'rendered',includeContours:true,selectors:[{cellId:'edge'},{cellId:'obstacle'}]});
  const edge=result.elements.find(element=>element.cellId==='edge');
  const obstacle=result.elements.find(element=>element.cellId==='obstacle');
  assert(edge.route.length>=2); assert(edge.route[0].x>=139 && edge.route[0].x<=141);
  assert(obstacle.contour.points.length>=4);
  assert.equal(result.inspectionBasis.source,'drawio-runtime-cell-state');
  const comparison=await compareGeometry({file,cellId:'edge'});
  assert.equal(comparison.changes[0].change,'engine-generated-route');
});
