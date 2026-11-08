'use strict';
// Android: запуск скрипта в потоке (worker) так, чтобы он выглядел как дочерний процесс (stdout, stderr, exit, kill).
const { Worker } = require('worker_threads');
const { EventEmitter } = require('events');

function spawnWorker(script, argv) {
  const p = new EventEmitter();
  p.stdout = new EventEmitter(); p.stderr = new EventEmitter();
  p.exitCode = null; p.signalCode = null;
  const w = new Worker(script, { argv, stdout: true, stderr: true });
  w.stdout.on('data', (d) => p.stdout.emit('data', d));
  w.stderr.on('data', (d) => p.stderr.emit('data', d));
  w.on('error', (e) => { p.stderr.emit('data', 'Ошибка: ' + (e && e.message || e)); });
  w.on('exit', (c) => { p.exitCode = c; p.emit('exit', c); });
  p.kill = () => { w.terminate().catch(() => {}); };
  return p;
}
module.exports = { spawnWorker };
