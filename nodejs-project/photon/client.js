#!/usr/bin/env node
'use strict';
// Клиент Фотона: node client.js config.json  (локальный SOCKS5 на 127.0.0.1)
const fs = require('fs');
const { createSocks } = require('./transport');
const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
createSocks(cfg, (l) => console.log(l)).listen(cfg.listenPort, '127.0.0.1', () => console.log('Фотон-клиент: 127.0.0.1:' + cfg.listenPort));
