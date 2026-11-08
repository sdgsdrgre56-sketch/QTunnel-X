'use strict';
// Шифрование сохранённого доступа к серверу.
// Windows: DPAPI (CurrentUser) — расшифровать может только эта учётная запись Windows на этом компьютере.
// Другие системы (разработка, тесты): AES-256-GCM с ключом в файле рядом с данными — слабее, об этом сказано в README.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

function ps(script, input) {
  return new Promise((resolve, reject) => {
    const p = execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 20000, maxBuffer: 1 << 20 },
      (e, out) => (e ? reject(new Error('DPAPI: ' + e.message)) : resolve(String(out).trim())));
    p.stdin.end(input);                                    // секрет идёт через stdin, не через аргументы процесса
  });
}
// Туда и обратно только base64 (ASCII): консоль PowerShell по умолчанию в cp866 и испортила бы кириллицу в пароле
const PROTECT = "Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser'))";
const UNPROTECT = "Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'))";

class Secret {
  constructor(dataDir, platform = process.platform, runner = ps) { this.keyFile = path.join(dataDir, 'access.key'); this.platform = platform; this.ps = runner; }
  get kind() { return this.platform === 'win32' ? 'dpapi' : 'aes'; }
  _key() {
    if (!fs.existsSync(this.keyFile)) fs.writeFileSync(this.keyFile, crypto.randomBytes(32), { mode: 0o600 });
    return fs.readFileSync(this.keyFile);
  }
  async protect(text) {
    if (this.kind === 'dpapi') return 'dpapi:' + (await this.ps(PROTECT, Buffer.from(text, 'utf8').toString('base64')));
    const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', this._key(), iv);
    const ct = Buffer.concat([c.update(text, 'utf8'), c.final()]);
    return 'aes:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
  }
  async unprotect(blob) {
    const [kind, b64] = String(blob).split(/:(.*)/s);
    if (kind === 'dpapi') return Buffer.from(await this.ps(UNPROTECT, b64), 'base64').toString('utf8');
    if (kind !== 'aes') throw new Error('Неизвестный формат сохранённого доступа');
    const b = Buffer.from(b64, 'base64'), d = crypto.createDecipheriv('aes-256-gcm', this._key(), b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  }
}
module.exports = { Secret };
