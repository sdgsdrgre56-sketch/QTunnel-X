#!/usr/bin/env node
'use strict';
// Сервер Фотона: node server.js /etc/quasar/photon.json
const fs = require('fs');
const { createServer } = require('./transport');
const cfg = JSON.parse(fs.readFileSync(process.argv[2] || '/etc/quasar/photon.json', 'utf8'));
const srv = createServer({ cert: fs.readFileSync(cfg.cert), key: fs.readFileSync(cfg.key), priv: cfg.priv, tokens: cfg.tokens, pq: cfg.pq, log: (l) => console.log(new Date().toISOString(), l) });
srv.listen(cfg.port, cfg.listen || '0.0.0.0', () => console.log('Фотон слушает порт ' + cfg.port));
