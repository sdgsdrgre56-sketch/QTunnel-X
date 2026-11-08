'use strict';
// Системный прокси Windows (реестр + уведомление WinINet) и проверка прав администратора для режима TUN.
// Предыдущие настройки сохраняются в файл и возвращаются при отключении, в том числе после аварийного закрытия.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const NOTIFY = `Add-Type -MemberDefinition '[DllImport("wininet.dll")] public static extern bool InternetSetOption(IntPtr h,int o,IntPtr b,int l);' -Name W -Namespace Q; [Q.W]::InternetSetOption([IntPtr]::Zero,39,[IntPtr]::Zero,0) | Out-Null; [Q.W]::InternetSetOption([IntPtr]::Zero,37,[IntPtr]::Zero,0) | Out-Null`;

const realRun = (cmd, args) => new Promise((resolve, reject) => {
  execFile(cmd, args, { windowsHide: true, timeout: 15000 }, (err, out, errOut) => err ? reject(Object.assign(err, { out: String(out || ''), errOut: String(errOut || '') })) : resolve(String(out)));
});

function parseReg(out, name) {
  const m = new RegExp('^\\s*' + name + '\\s+REG_(?:SZ|DWORD)\\s+(.*)$', 'mi').exec(out);
  return m ? m[1].trim() : null;
}

class SysProxy {
  constructor({ dataDir, run = realRun, platform = process.platform }) {
    this.file = path.join(dataDir, 'sysproxy-backup.json');
    this.run = run; this.platform = platform;
  }
  get supported() { return this.platform === 'win32'; }

  async isAdmin() {
    if (process.env.QUASAR_ANDROID) return true;   // TUN на Android поднимает VpnService, права не нужны
    if (!this.supported) return process.getuid ? process.getuid() === 0 : false;
    // «net session» требует службу «Сервер» и на части Windows падает и у администратора — проверяем самих себя
    try {
      const out = await this.run('powershell', ['-NoProfile', '-NonInteractive', '-Command', '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)']);
      if (/true/i.test(String(out))) return true;
      if (/false/i.test(String(out))) return false;
    } catch { /* нет powershell — пробуем fltmc */ }
    try { await this.run('fltmc', []); return true; } catch { return false; }
  }

  async _read() {
    const out = await this.run('reg', ['query', KEY]);
    return { enable: parseReg(out, 'ProxyEnable'), server: parseReg(out, 'ProxyServer'), override: parseReg(out, 'ProxyOverride') };
  }
  async _write(v) {
    const set = (name, type, val) => val === null ? this.run('reg', ['delete', KEY, '/v', name, '/f']).catch(() => {}) : this.run('reg', ['add', KEY, '/v', name, '/t', type, '/d', String(val), '/f']);
    await set('ProxyEnable', 'REG_DWORD', v.enable === null ? 0 : (String(v.enable).startsWith('0x') ? parseInt(v.enable, 16) : Number(v.enable)));
    await set('ProxyServer', 'REG_SZ', v.server);
    await set('ProxyOverride', 'REG_SZ', v.override);
    await this.run('powershell', ['-NoProfile', '-NonInteractive', '-Command', NOTIFY]).catch(() => {});
  }

  async enable(port) {
    if (!this.supported) throw new Error('Системный прокси есть только в Windows');
    if (!fs.existsSync(this.file)) {
      const prev = await this._read();
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(prev));
    }
    await this._write({ enable: 1, server: `127.0.0.1:${port}`, override: '<local>;localhost;127.*;10.*;192.168.*;172.16.*' });
  }

  // Возвращает прежние настройки; если мы ничего не меняли, ничего и не трогает.
  async restore() {
    if (!fs.existsSync(this.file)) return false;
    let prev;
    try { prev = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { fs.rmSync(this.file, { force: true }); return false; }
    await this._write(prev);
    fs.rmSync(this.file, { force: true });
    return true;
  }
  get active() { return fs.existsSync(this.file); }
}

module.exports = { SysProxy, parseReg };
