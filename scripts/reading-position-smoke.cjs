// Runs only against a dedicated test Chrome profile; resets its local book library.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const JSZip = require('jszip');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const port = process.env.READTAYLOR_CDP_PORT || '9235';
const origin = process.env.READTAYLOR_TEST_URL || 'http://127.0.0.1:5178/';
const [width, height] = (process.env.READTAYLOR_MOBILE_VIEWPORT || '1440x1000').split('x').map(Number);
const viewport = {width,height,deviceScaleFactor:1,mobile:width<600};
let socket;
let command;
async function connect(target) {
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(resolve => socket.addEventListener('open', resolve, {once:true}));
  let id = 0;
  const pending = new Map();
  socket.addEventListener('message', ({data}) => {
    const msg = JSON.parse(String(data));
    if (!pending.has(msg.id)) return;
    const {resolve, reject} = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  });
  command = (method, params={}) => new Promise((resolve,reject) => {
    pending.set(++id, {resolve,reject});
    socket.send(JSON.stringify({id,method,params}));
  });
  await command('Runtime.enable');
  await command('Page.enable');
}
async function evaluate(expression) {
  const result = await command('Runtime.evaluate', {expression, returnByValue:true, awaitPromise:true});
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function waitFor(expression) {
  for (let i=0; i<200; i++) {
    const value = await evaluate(expression);
    if (value) return value;
    await delay(100);
  }
  throw new Error(`Timed out: ${expression}\n${await evaluate('document.body.innerText')}`);
}
const snapshot = `(() => {
  const frame = document.querySelector('iframe:not([aria-hidden])');
  const match = document.body.innerText.match(/(?:^|\\n)(\\d+) \\/ (\\d+)(?:\\n|$)/);
  if (!frame?.contentDocument?.body || !match || document.body.innerText.includes('正在渲染原版排版')) return null;
  const doc = frame.contentDocument;
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  let text = '', node;
  while (node = walker.nextNode()) {
    if (!node.textContent.trim()) continue;
    const range = doc.createRange(); range.selectNodeContents(node);
    if ([...range.getClientRects()].some(r => r.right > 1 && r.left < frame.clientWidth && r.bottom > 0 && r.top < frame.clientHeight)) {
      text = node.textContent.trim(); break;
    }
  }
  return {page:Number(match[1]), total:Number(match[2]), text, x:frame.contentWindow.scrollX};
})()`;
async function stable() {
  await waitFor(snapshot);
  await delay(450);
  return evaluate(snapshot);
}
async function openBook() {
  await waitFor(`(() => {const b=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Position regression')); if(!b)return false; b.click(); return true})()`);
  return stable();
}
async function expectSame(expected, label) {
  const actual = await stable();
  assert.equal(actual.page, expected.page, `${label}: wrong page ${JSON.stringify(actual)}`);
  assert.equal(actual.total, expected.total, `${label}: total pages changed`);
  assert.equal(actual.text, expected.text, `${label}: visible content changed`);
  assert.equal(actual.x, expected.x, `${label}: horizontal position changed`);
  console.log(`${label}: ${actual.page} / ${actual.total}, content and scroll position match`);
}
async function main() {
  const zip = new JSZip();
  zip.file('mimetype','application/epub+zip');
  zip.file('META-INF/container.xml','<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  zip.file('book.opf',`<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">position-regression</dc:identifier><dc:title>Position regression</dc:title><dc:language>en</dc:language></metadata><manifest>${[0,1,2].map(i=>`<item id="c${i}" href="c${i}.xhtml" media-type="application/xhtml+xml"/>`).join('')}</manifest><spine>${[0,1,2].map(i=>`<itemref idref="c${i}"/>`).join('')}</spine></package>`);
  for(let c=0;c<3;c++) zip.file(`c${c}.xhtml`,`<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter ${c+1}</title></head><body><h1>Chapter ${c+1}</h1>${Array.from({length:c===0?60:100},(_,p)=>`<p>Chapter ${c+1}, paragraph ${p+1}. ${'Reading positions must survive asynchronous chapter loading and pagination. '.repeat(24)}</p>`).join('')}</body></html>`);
  const fixture = path.resolve('test-assets/position-regression.epub');
  await fs.writeFile(fixture,await zip.generateAsync({type:'nodebuffer'}));
  const targets=await fetch(`http://127.0.0.1:${port}/json`).then(r=>r.json());
  await connect(targets.find(t=>t.type==='page' && t.url.startsWith(origin)));
  await command('Emulation.setDeviceMetricsOverride',viewport);
  await evaluate(`localStorage.clear(); indexedDB.deleteDatabase('readtaylor');`);
  await command('Page.reload');
  await waitFor(`!!document.querySelector('input[type=file]')`);
  const doc=await command('DOM.getDocument');
  const input=await command('DOM.querySelector',{nodeId:doc.root.nodeId,selector:'input[type=file]'});
  await command('DOM.setFileInputFiles',{nodeId:input.nodeId,files:[fixture]});
  await evaluate(`document.querySelector('input[type=file]').dispatchEvent(new Event('change',{bubbles:true}))`);
  await openBook();
  for(let n=1;n<50;n++) {
    await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='下一页').click()`);
    await waitFor(`(${snapshot})?.page === ${n+1}`);
  }
  const expected=await stable();
  assert.equal(expected.page,50);
  console.log(`Reached page 50 / ${expected.total}`);
  const slowRead = `(() => {
    const get = IDBObjectStore.prototype.get;
    const success = Object.getOwnPropertyDescriptor(IDBRequest.prototype, 'onsuccess');
    IDBObjectStore.prototype.get = function(...args) {
      const request = get.apply(this,args);
      Object.defineProperty(request,'onsuccess',{set(fn) {
        success.set.call(request,event => setTimeout(() => fn.call(request,event),700));
      }});
      return request;
    };
  })()`;
  for(let i=0;i<3;i++) {
    await command('Page.reload');
    await waitFor(`!!document.querySelector('input[type=file]')`);
    await evaluate(slowRead);
    await openBook(); await expectSame(expected,`slow reload ${i+1}`);
  }
  await evaluate(`document.querySelector('[aria-label="返回书架"]').click()`);
  await openBook(); await expectSame(expected,'shelf reopen');
  // Removing the new exact-page field exercises existing users' percentage bookmarks.
  await evaluate(`document.querySelector('[aria-label="返回书架"]').click()`);
  await evaluate(`(() => {const p=JSON.parse(localStorage.getItem('readtaylor.reading-positions.v1')); for(const v of Object.values(p)) delete v.lastPage; localStorage.setItem('readtaylor.reading-positions.v1',JSON.stringify(p));})()`);
  await command('Page.reload'); await openBook(); await expectSame(expected,'legacy bookmark');
  // Exiting before a slow chapter has appeared must not overwrite the saved page.
  await command('Page.reload');
  await waitFor(`!!document.querySelector('input[type=file]')`);
  await evaluate(slowRead);
  await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Position regression')).click()`);
  await waitFor(`!!document.querySelector('[aria-label="返回书架"]')`);
  await evaluate(`document.querySelector('[aria-label="返回书架"]').click()`);
  await openBook(); await expectSame(expected,'exit during loading');
  // Real tab closure must flush a page turn even before the debounce expires.
  await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='下一页').click()`);
  await waitFor(`(${snapshot})?.page === 51`);
  const next=await evaluate(snapshot);
  const target=await fetch(`http://127.0.0.1:${port}/json/new?about:blank`,{method:'PUT'}).then(r=>r.json());
  await command('Page.close'); socket.close();
  await connect(target); await command('Emulation.setDeviceMetricsOverride',viewport);
  await command('Page.navigate',{url:origin});
  await openBook(); await expectSame(next,'tab close before debounce');
  const screen=await command('Page.captureScreenshot',{format:'png'});
  await fs.writeFile(path.resolve(`../position-regression-${width}.png`),Buffer.from(screen.data,'base64'));
}
main().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>socket?.close());
