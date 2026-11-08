'use strict';
// Скачивание ядер с GitHub (последний релиз) и распаковка в bin/. Сеть и распаковка подставляются в тестах.
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFile } = require('child_process');
const { CORES, binDir, exeName } = require('./cores');

function httpsGet(url, { json = false, max = 300 * 1024 * 1024, hops = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Quasar', Accept: json ? 'application/vnd.github+json' : '*/*' }, timeout: 30000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); if (hops <= 0) return reject(new Error('Слишком много перенаправлений'));
        return resolve(httpsGet(new URL(res.headers.location, url).toString(), { json, max, hops: hops - 1 }));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('GitHub ответил ' + res.statusCode)); }
      const chunks = []; let n = 0;
      res.on('data', (c) => { n += c.length; if (n > max) req.destroy(new Error('Файл слишком большой')); else chunks.push(c); });
      res.on('end', () => { const b = Buffer.concat(chunks); try { resolve(json ? JSON.parse(b.toString('utf8')) : b); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('Нет ответа от GitHub')));
  });
}

function realExtract(zip, dest) {
  return new Promise((resolve, reject) => {
    const [cmd, args] = process.platform === 'win32'
      ? ['powershell', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dest}' -Force`]]
      : ['unzip', ['-o', '-q', zip, '-d', dest]];
    execFile(cmd, args, { windowsHide: true, timeout: 120000 }, (e) => (e ? reject(new Error('Не удалось распаковать архив: ' + e.message)) : resolve()));
  });
}

function findFile(dir, want) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { const r = findFile(p, want); if (r) return r; }
    else if (want.test(e.name)) return p;
  }
  return null;
}

async function installCore(id, { appDir, getJson = (u) => httpsGet(u, { json: true }), getFile = (u) => httpsGet(u), extract = realExtract } = {}) {
  const c = CORES[id];
  if (!c || !c.repo) throw new Error('Это ядро нельзя скачать автоматически');
  const rel = await getJson(`https://api.github.com/repos/${c.repo}/releases/latest`);
  const asset = (rel.assets || []).find((a) => c.asset.test(a.name) && !(c.notAsset && c.notAsset.test(a.name)));
  if (!asset) throw new Error(`В последнем релизе ${c.title} нет архива для Windows`);
  if (!/^https:\/\//.test(asset.browser_download_url)) throw new Error('Странный адрес загрузки');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quasar-core-'));
  try {
    const data = await getFile(asset.browser_download_url);
    const out = path.join(tmp, 'x'); fs.mkdirSync(out);
    if (c.raw) fs.writeFileSync(path.join(out, exeName(c.exe)), data);           // релиз — сразу exe, без архива
    else { const zip = path.join(tmp, 'a.zip'); fs.writeFileSync(zip, data); await extract(zip, out); }
    const exe = findFile(out, new RegExp('^' + c.exe.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '.*\\.exe$|^' + c.exe + '$', 'i'));
    if (!exe) throw new Error('В архиве нет ' + exeName(c.exe));
    const dest = binDir(appDir, id); fs.mkdirSync(dest, { recursive: true });
    fs.copyFileSync(exe, path.join(dest, exeName(c.exe)));
    if (process.platform !== 'win32') fs.chmodSync(path.join(dest, exeName(c.exe)), 0o755);
    return { version: rel.tag_name || '', path: path.join(dest, exeName(c.exe)) };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

module.exports = { installCore, httpsGet };
