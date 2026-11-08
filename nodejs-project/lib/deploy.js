'use strict';
// Установка «в один ход»: IP, пользователь, порт SSH, пароль (или ключ) -> сервер со всеми протоколами -> одна ссылка.
// Пароль живёт только в памяти на время подключения и никуда не записывается и не логируется.
const { buildServerPlan, buildItems } = require('./serverconf');
const { installScript } = require('./script');
const { packBundle, toSubscription } = require('./links');

// Транспорт по SSH. ssh2 подключается лениво: в проекте Маяк Браузер он уже есть (lib/server-setup.js его использует).
function sshTransport({ host, port = 22, username = 'root', password, privateKey, passphrase, expectedFingerprint, onHostKey, sock }) {
  const { Client } = require('ssh2');
  const conn = new Client();
  let ready = null;
  const connect = () => ready || (ready = new Promise((resolve, reject) => {
    conn.on('ready', resolve).on('error', (e) => reject(new Error(friendly(e))));
    conn.connect({
      host, port, username, password, privateKey, passphrase, readyTimeout: 20000, ...(sock ? { sock } : {}),   // sock: путь через прокси (например WARP), если IP напрямую недоступен
      keepaliveInterval: 10000,
      hostHash: 'sha256',
      // Отпечаток ключа сервера: при первом подключении показываем его пользователю, при повторном сверяем.
      hostVerifier: (hash) => {
        if (onHostKey) onHostKey(hash);
        return !expectedFingerprint || String(expectedFingerprint).toLowerCase() === String(hash).toLowerCase();
      },
    });
  }));
  return {
    async run(script, onLine) {
      await connect();
      return new Promise((resolve, reject) => {
        conn.exec('bash -s', (err, stream) => {
          if (err) return reject(err);
          let buf = '';
          const feed = (d) => { buf += d.toString('utf8'); let i; while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i).replace(/\r$/, '')); buf = buf.slice(i + 1); } };
          stream.on('data', feed);
          stream.stderr.on('data', () => {});          // stderr скрипта не нужен: нужные сообщения идут через QUASAR_*
          stream.on('close', (code) => { if (buf) onLine(buf); resolve(code); });
          stream.end(script);
        });
      });
    },
    close() { try { conn.end(); } catch { /* уже закрыто */ } },
  };
}

function friendly(e) {
  const m = String((e && e.message) || e);
  if (/All configured authentication methods failed/i.test(m)) return 'Неверный пароль или ключ (или вход root по паролю выключен на сервере)';
  if (/ECONNREFUSED/.test(m)) return 'Сервер отказал в подключении: проверь адрес и порт SSH';
  if (/ETIMEDOUT|Timed out|ENETUNREACH|EHOSTUNREACH/i.test(m)) return 'Сервер не отвечает: проверь адрес, порт SSH и брандмауэр';
  if (/ENOTFOUND/.test(m)) return 'Не нашёл такой адрес сервера';
  return m;
}

/**
 * params: { host, port, username, password | privateKey, name?, domain?, email?, ports?, expectedFingerprint? }
 * deps (для тестов): { transport, onLog, onHostKey }
 * Возвращает { link (quasar://), subscription (base64), items, certSha256, plan }
 */
async function deployServer(params, deps = {}) {
  const onLog = deps.onLog || (() => {});
  const plan = buildServerPlan({ host: params.host, name: params.name, domain: params.domain, email: params.email, ports: params.ports, hy2Obfs: params.hy2Obfs, realitySni: params.realitySni, realityCandidates: params.realityCandidates, realityForce: params.realityForce, realityTimings: params.realityTimings, shadowtlsSni: params.shadowtlsSni, shadowquicSni: params.shadowquicSni, certSni: params.certSni });
  const script = installScript(plan);
  const transport = deps.transport || sshTransport({ ...params, onHostKey: deps.onHostKey });
  let xrayOk = false, naiveOk = false, sudokuOk = false, sqOk = false, mieruOk = false, restlsOk = false, snellOk = false, tlsmirrorOk = false, jcPin = '', brookCa = '', naiveDomain = '', realitySni = '', pin = '', phPin = '', anPin = '', error = '', done = false;
  const onLine = (line) => {
    const m = /^QUASAR_(LOG|ERROR|CERT_SHA256|PHOTON_CERT_SHA256|ANTOHIN_CERT_SHA256|JUICITY_CERT_SHA256|BROOK_CA|MIERU|JUICITY|BROOK|RESTLS|SNELL|TLSMIRROR|XRAY|NAIVE|SUDOKU|SHADOWQUIC|NAIVE_DOMAIN|REALITY_SNI|DONE)=(.*)$/.exec(line);
    if (!m) return;
    if (m[1] === 'LOG') onLog(m[2]);
    else if (m[1] === 'ERROR') error = m[2];
    else if (m[1] === 'CERT_SHA256') pin = m[2].trim();
    else if (m[1] === 'XRAY') xrayOk = m[2].trim() === '1';
    else if (m[1] === 'REALITY_SNI') realitySni = plan.realityCandidates.includes(m[2].trim()) ? m[2].trim() : '';
    else if (m[1] === 'NAIVE_DOMAIN') naiveDomain = /^[A-Za-z0-9.-]{1,253}$/.test(m[2].trim()) ? m[2].trim() : '';
    else if (m[1] === 'SHADOWQUIC') sqOk = m[2].trim() === '1';
    else if (m[1] === 'SUDOKU') sudokuOk = m[2].trim() === '1';
    else if (m[1] === 'NAIVE') naiveOk = m[2].trim() === '1';
    else if (m[1] === 'PHOTON_CERT_SHA256') phPin = m[2].trim();
    else if (m[1] === 'ANTOHIN_CERT_SHA256') anPin = m[2].trim();
    else if (m[1] === 'JUICITY_CERT_SHA256') jcPin = m[2].trim();
    else if (m[1] === 'BROOK_CA') brookCa = m[2].trim();
    else if (m[1] === 'MIERU') mieruOk = m[2].trim() === '1';
    else if (m[1] === 'RESTLS') restlsOk = m[2].trim() === '1';
    else if (m[1] === 'SNELL') snellOk = m[2].trim() === '1';
    else if (m[1] === 'TLSMIRROR') tlsmirrorOk = m[2].trim() === '1';
    else if (m[1] === 'JUICITY' || m[1] === 'BROOK') { /* итог виден по отпечатку/сертификату */ }
    else done = true;
  };
  try {
    onLog('Подключаюсь к ' + params.host + ':' + (params.port || 22));
    const code = await transport.run(script, onLine);
    if (error) throw new Error(error);
    if (!done) throw new Error('Установка прервалась до конца' + (code ? ' (код ' + code + ')' : '') + ': проверь журнал и повтори');
  } finally {
    if (transport.close) transport.close();
  }
  if (plan.insecure && !/^[0-9A-Fa-f]{64}$/.test(pin)) throw new Error('Сервер не вернул отпечаток сертификата');
  const items = buildItems(plan, plan.insecure ? pin : undefined, /^[0-9A-Fa-f]{64}$/.test(phPin) ? phPin : undefined, { antohinPin: /^[0-9A-Fa-f]{64}$/.test(anPin) ? anPin : undefined, xray: xrayOk, naive: naiveOk, sudoku: sudokuOk, shadowquic: sqOk, mieru: mieruOk, juicityPin: /^[0-9A-Fa-f]{64}$/.test(jcPin) ? jcPin : undefined, brookCa: brookCaPem(brookCa), restls: restlsOk, snell: snellOk, tlsmirror: tlsmirrorOk, naiveDomain, realitySni: realitySni || undefined });
  const link = packBundle({ name: plan.name, host: plan.host, items });
  return { link, subscription: toSubscription(items), items, certSha256: pin || null, plan };
}

// Сертификат Brook приходит в base64; принимаем только похожее на один PEM-сертификат
function brookCaPem(b64) {
  if (!/^[A-Za-z0-9+/=]{100,8000}$/.test(b64 || '')) return undefined;
  const pem = Buffer.from(b64, 'base64').toString('utf8').trim();
  return /^-----BEGIN CERTIFICATE-----\n[A-Za-z0-9+/=\n]+\n-----END CERTIFICATE-----$/.test(pem) ? pem + '\n' : undefined;
}

module.exports = { deployServer, sshTransport };
