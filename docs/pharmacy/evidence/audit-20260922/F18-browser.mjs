import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const require = createRequire(process.cwd() + '/apps/web/package.json');
const { chromium } = require('@playwright/test');
const dir = 'docs/pharmacy/evidence/audit-20260922/';
const cases = JSON.parse(readFileSync(dir+'F18-html.json','utf8'));
const browser = await chromium.launch({headless:true});
const results=[];
try {
 for (const {url,html} of cases) {
  const context=await browser.newContext(); const page=await context.newPage();
  const attempts=[];
  await context.route('**/*',async route=>{
   if(route.request().url()==='http://redirect.test/') return route.fulfill({contentType:'text/html',body:html});
   attempts.push(route.request().url()); await route.abort();
  });
  await page.goto('http://redirect.test/').catch(()=>{});
  await page.waitForTimeout(100);
  assert.deepEqual(attempts,[new URL(url).href]);
  assert.equal(await page.evaluate(()=>globalThis.unexpected),undefined);
  results.push({url,navigation:attempts[0],unexpectedScript:false}); await context.close();
 }
} finally {await browser.close();}
writeFileSync(dir+'F18-browser-result.json',JSON.stringify({result:'PASS',externalRequestsSent:0,results},null,2));
console.log('PASS',results.length);
