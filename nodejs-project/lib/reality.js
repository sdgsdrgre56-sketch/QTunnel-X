'use strict';
// Сайт для маскировки VLESS Reality / XHTTP. Список кандидатов — как в 3x-ui (крупные зарубежные сайты),
// плюс dl.google.com, который README Reality приводит в пример. Российские сайты не берём: SNI российского сервиса
// на зарубежный IP — заметная странность для провайдера.
const REALITY_CANDIDATES = [
  // были раньше
  'www.apple.com', 'www.icloud.com', 'www.amazon.com', 'aws.amazon.com', 'www.oracle.com', 'www.nvidia.com', 'www.amd.com', 'www.intel.com', 'www.tesla.com', 'www.sony.com', 'dl.google.com', 'cloudflare.com',
  // крупные компании и облака
  'www.microsoft.com', 'azure.microsoft.com', 'www.office.com', 'www.bing.com', 'www.samsung.com', 'www.cisco.com', 'www.ibm.com', 'www.hp.com', 'www.dell.com', 'www.lenovo.com', 'www.asus.com',
  'www.qualcomm.com', 'www.broadcom.com', 'www.vmware.com', 'www.redhat.com', 'www.sap.com', 'www.siemens.com', 'www.adobe.com', 'www.salesforce.com', 'www.atlassian.com',
  // платежи и сервисы (обычный фон для зашифрованного трафика)
  'www.paypal.com', 'www.visa.com', 'www.mastercard.com', 'www.stripe.com', 'www.ebay.com', 'www.booking.com', 'www.spotify.com', 'www.netflix.com', 'www.zoom.us', 'www.dropbox.com',
  // софт и открытые проекты
  'www.mozilla.org', 'www.github.com', 'www.docker.com', 'www.python.org', 'www.nginx.com', 'www.ubuntu.com', 'www.debian.org', 'www.wikipedia.org', 'www.bbc.com', 'www.nytimes.com',
  // производители
  'www.bmw.com', 'www.toyota.com', 'www.nike.com', 'www.ikea.com', 'www.nokia.com'];
const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

function cleanList(list) { return [...new Set((list || []).map((x) => String(x).trim().toLowerCase()).filter((x) => HOST_RE.test(x)))]; }

/**
 * Проверка с компьютера пользователя: открывается ли сайт напрямую, без VPN (если провайдер его режет —
 * маскироваться под него опасно). Возвращает доступные, от быстрых к медленным, и недоступные.
 */
async function probeFromClient(cands, { probe, timeout = 4000 } = {}) {
  const list = cleanList(cands);
  const res = await Promise.all(list.map(async (host) => { try { return { host, ms: await probe({ host, timeout }) }; } catch { return { host, ms: null }; } }));
  const ok = res.filter((r) => r.ms !== null).sort((a, b) => a.ms - b.ms);
  return { ok: ok.map((r) => r.host), blocked: res.filter((r) => r.ms === null).map((r) => r.host), timings: res };
}

module.exports = { REALITY_CANDIDATES, HOST_RE, cleanList, probeFromClient };
