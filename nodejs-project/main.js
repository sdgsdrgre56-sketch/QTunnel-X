'use strict';
// Точка входа на Android (nodejs-mobile). Переменные QUASAR_DATA, QUASAR_NATIVE_DIR, QUASAR_CTL, QUASAR_PORT задаёт приложение.
process.env.QUASAR_ANDROID = '1';
process.argv.push('--no-open');
require('./server.js');
