// Drive the page in headless Chrome: inject clips, wait, save outputs.
// usage: node dev/drive.mjs http://127.0.0.1:8811/ <outDir> <clip name...>
// Serve the repo root; clip names are fetched from dev/clips/ (gitignored). Chrome must run with --remote-debugging-port=9333.
import fs from 'node:fs';
const [url, outDir, ...files] = process.argv.slice(2);
const tabs = await (await fetch('http://127.0.0.1:9333/json/new?about:blank', { method: 'PUT' })).json();
const ws = new WebSocket(tabs.webSocketDebuggerUrl);
await new Promise((r) => ws.onopen = r);
ws.onclose = (e) => { console.log('ws closed', e.code); process.exit(3); };
const keep = setInterval(() => {}, 1000);
let id = 0; const wait = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); } else if (m.method === 'Runtime.consoleAPICalled') console.log('[page]', m.params.args.map(a => a.value ?? a.description).join(' ')); else if (m.method === 'Inspector.targetCrashed') console.log('[crash]'); else if (m.method === 'Runtime.exceptionThrown') console.log('[exc]', JSON.stringify(m.params.exceptionDetails).slice(0, 500)); };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.result.value;
await send('Runtime.enable'); await send('DOM.enable'); await send('Page.enable');
await send('Network.enable'); await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Page.navigate', { url });
await new Promise((r) => setTimeout(r, 1500));
await ev(`(async () => { const dt = new DataTransfer(); for (const n of ${JSON.stringify(files)}) { const b = await (await fetch('dev/clips/' + n)).blob(); dt.items.add(new File([b], n, { type: 'video/quicktime' })); } const inp = document.getElementById('pick'); inp.files = dt.files; inp.dispatchEvent(new Event('change')); return [...dt.files].map(f => f.name + ':' + f.size); })()`).then((v) => console.log('injected', v));
const t0 = Date.now();
while (true) {
  await new Promise((r) => setTimeout(r, 1000));
  const st = await ev(`[...document.querySelectorAll('.tape')].map(t => t.querySelector('.state').textContent + ' | ' + t.querySelector('.meta').textContent)`);
  if (st.every((s) => /^(Fixed|Failed)/.test(s))) { console.log(st.join('\n')); break; }
  if (Date.now() - t0 > 180000) { console.log('timeout', st); break; }
}
fs.mkdirSync(outDir, { recursive: true });
const n = await ev('window.__results.length');
for (let i = 0; i < n; i++) {
  const r = await ev(`(async () => { const r = window.__results[${i}]; const b = new Uint8Array(await r.blob.arrayBuffer()); let s = ''; for (let k = 0; k < b.length; k += 0x8000) s += String.fromCharCode(...b.subarray(k, k + 0x8000)); return { name: r.name, b64: btoa(s) }; })()`);
  fs.writeFileSync(`${outDir}/${r.name}`, Buffer.from(r.b64, 'base64'));
}
console.log('saved', n, 'files in', (Date.now() - t0) / 1000, 's');
await fetch('http://127.0.0.1:9333/json/close/' + tabs.id);
ws.onclose = null; ws.close(); clearInterval(keep);
