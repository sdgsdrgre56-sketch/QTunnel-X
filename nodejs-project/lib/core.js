'use strict';
// Запуск и остановка ядра sing-box. Ядро — отдельный процесс; приложение только пишет ему конфиг и следит, что порт открылся.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { tcpPing } = require('./net');

function findSingbox(appDir) {
  const exe = process.platform === 'win32' ? 'sing-box.exe' : 'sing-box';
  const cands = [process.env.QUASAR_SINGBOX, process.env.QUASAR_NATIVE_DIR && path.join(process.env.QUASAR_NATIVE_DIR, 'libsingbox.so'), path.join(appDir, 'bin', exe)].filter(Boolean);
  for (const c of cands) if (fs.existsSync(c)) return c;
  for (const d of (process.env.PATH || '').split(path.delimiter)) { const f = path.join(d, exe); if (d && fs.existsSync(f)) return f; }
  return null;
}

class Core extends EventEmitter {
  constructor({ dataDir, appDir, exe }) {
    super();
    this.dataDir = dataDir; this.appDir = appDir; this.exe = exe || null;
    this.proc = null; this.state = { running: false, itemId: null, mixedPort: null, apiPort: null, secret: '', since: 0 };
    this.logs = [];
  }
  get running() { return !!this.proc; }
  get respawning() { return !!this._respawnTimer; }   // ядро ждёт перезапуска из-за занятого TUN-адаптера
  status() { return { ...this.state, secret: undefined, logs: this.logs.slice(-40) }; }
  log(line) {
    const l = String(line).trim(); if (!l) return;
    // Протокол без UDP (Фотон, Antohin): sing-box пишет ошибку на каждый UDP-запрос, сотни строк в минуту, и за ними
    // не видно настоящих ошибок. Сводим их в одну строку раз в минуту.
    if (/request rejected, code=7/.test(l)) {
      this._udpRej = (this._udpRej || 0) + 1;
      if (this._udpAt && Date.now() - this._udpAt < 60000) return;
      this._udpAt = Date.now();
      const n = this._udpRej; this._udpRej = 0;
      return this._push(`Этот протокол не передаёт UDP: запросы по UDP отклоняются (с прошлой сводки — ${n}). Сайты работают по TCP; игры и звонки по UDP через него не пойдут`);
    }
    this._push(l);
  }
  _push(l) { this.logs.push(`${new Date().toLocaleTimeString('ru-RU')}  ${l}`); if (this.logs.length > 300) this.logs.splice(0, 100); this.emit('log', l); }

  // Windows: прежний TUN-адаптер ещё не убран (ядро прошлого подключения было снято принудительно) — новое ядро падает так:
  // «configure tun interface: (create adapter: Cannot create a file when that file already exists. | open existing adapter: Element not found.)»
  static isTunBusy(text) { return /configure tun interface|create adapter|open existing adapter/i.test(String(text || '')); }

  async start(itemId, config, { mixedPort, apiPort, secret }) {
    if (this.proc || this._respawnTimer) await this.stop();
    const exe = this.exe || findSingbox(this.appDir);
    if (!exe) throw new Error('Не найден sing-box: перезапусти start.bat или нажми «Скачать» у sing-box на вкладке «Ядра»');
    fs.mkdirSync(this.dataDir, { recursive: true });
    const cfg = path.join(this.dataDir, 'run.json');
    fs.writeFileSync(cfg, JSON.stringify(config, null, 2), { mode: 0o600 });
    this.configJson = JSON.stringify(config);   // по нему видно, нужен ли перезапуск при смене протокола
    this._tun = Array.isArray(config && config.inbounds) && config.inbounds.some((i) => i && i.type === 'tun');
    this._stopping = false; this._fail = null; this._respawns = 0; this._startedAt = Date.now();
    this._run(exe, cfg);
    // Ждём, пока откроется локальный порт (до 10 секунд; пока ядро перезапускается из-за занятого TUN — дольше)
    const t0 = Date.now();
    for (;;) {
      if (this._fail) { const tail = this.logs.slice(-3).join(' | '); const f = this._fail; this._reset(); throw new Error('Ядро не запустилось: ' + f + (tail ? ' — ' + tail : '')); }
      if (this.proc && (await tcpPing('127.0.0.1', mixedPort, 400)) !== null) break;
      if (Date.now() - t0 > (this._respawns ? 30000 : 10000)) { await this.stop(); throw new Error('Ядро запустилось, но порт ' + mixedPort + ' так и не открылся'); }
      await new Promise((r) => setTimeout(r, 150));
    }
    this.state = { running: true, itemId, mixedPort, apiPort, secret, since: Date.now() };
    this.emit('started', this.state);
    return this.status();
  }

  _run(exe, cfg) {
    const p = spawn(exe, ['run', '-c', cfg], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.proc = p;
    const onData = (d) => String(d).split(/\r?\n/).forEach((l) => this.log(l));
    p.stdout.on('data', onData); p.stderr.on('data', onData);
    p.once('error', (e) => { this.log('Ошибка запуска: ' + e.message); if (this.proc === p) this._fail = e.message; });
    p.once('exit', (code) => {
      this.log('Ядро остановилось (код ' + code + ')');
      if (this.proc !== p) return;   // это ядро уже заменили или остановили
      // Занятый TUN-адаптер: ждём, пока Windows его освободит, и запускаем то же ядро ещё раз (до 3 раз, только сразу после запуска)
      if (!this._stopping && this._tun && Core.isTunBusy(this.logs.slice(-6).join(' ')) && this._respawns < 3 && Date.now() - this._startedAt < 120000) {
        this._respawns++;
        this.log(`Windows ещё не убрал прежний TUN-адаптер — запускаю ядро снова через 3 с (попытка ${this._respawns} из 3)`);
        this.proc = null;
        this._respawnTimer = setTimeout(() => { this._respawnTimer = null; if (!this._stopping) this._run(exe, cfg); }, 3000);
        return;
      }
      this._fail = 'код ' + code;
      this._reset(); this.emit('exit', code);
    });
  }

  /** Ядро уже работает с тем же конфигом (постоянный туннель): меняется только то, какой профиль считается подключённым */
  setItem(itemId) { if (this.state.running) this.state = { ...this.state, itemId }; }

  _reset() { this.configJson = null; this.proc = null; this.state = { running: false, itemId: null, mixedPort: null, apiPort: null, secret: '', since: 0 }; }

  async stop() {
    this._stopping = true;
    if (this._respawnTimer) {   // ядро ждёт перезапуска: процесса нет, просто отменяем
      clearTimeout(this._respawnTimer); this._respawnTimer = null;
      const was = this.state.running; this._reset(); if (was) this.emit('exit', null);
      return;
    }
    const p = this.proc;
    if (!p) return;
    await new Promise((resolve) => {
      if (p.exitCode !== null || p.signalCode !== null) return resolve();
      const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* уже завершён */ } setTimeout(resolve, 1000); }, 3000);
      p.once('exit', () => { clearTimeout(t); resolve(); });
      try { p.kill(); } catch { clearTimeout(t); resolve(); }
    });
    this._reset();
    // Windows убирает TUN-адаптер снятого ядра не сразу: короткая пауза, чтобы следующее ядро не упало на «create adapter»
    if (this._tun && process.platform === 'win32') await new Promise((r) => setTimeout(r, 1500));
  }
}

module.exports = { Core, findSingbox };
