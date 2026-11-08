'use strict';
// Mieru traffic pattern: настройка «как выглядит поток» (protobuf TrafficPattern из mieru pkg/appctl/proto/base.proto,
// закодированный в base64). mihomo принимает его в поле traffic-pattern у клиента и у сервера.
// Номера полей сверены с исходниками mieru v3.39.0:
//   TrafficPattern { seed=1 int32; unlockAll=2 bool; tcpFragment=3 msg; nonce=4 msg; padding=5 msg; lowEntropy=6 msg }
//   NoncePattern { type=1 enum; applyToAllUDPPacket=2 bool; minLen=3 int32; maxLen=4 int32 }
//   PaddingPattern { maxMiddlePaddingLen=1; maxEndPaddingLen=2 }
//   LowEntropyPattern { mode=1 enum; maskRotation=2 enum }
// Клиент и сервер настраиваются независимо: одинаковыми их делать не нужно.

const NONCE = { RANDOM: 0, PRINTABLE: 1, PRINTABLE_SUBSET: 2, FIXED: 3 };
const LOW_ENTROPY = { OFF: 0, M32: 1, M40: 2, M48: 3, M56: 4 };

function varint(n) {
  const out = [];
  let v = BigInt.asUintN(64, BigInt(n));
  do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; out.push(b); } while (v);
  return Buffer.from(out);
}
const key = (field, wire) => varint((field << 3) | wire);
const vField = (field, n) => Buffer.concat([key(field, 0), varint(n)]);
const mField = (field, buf) => Buffer.concat([key(field, 2), varint(buf.length), buf]);

/** p: { seed?, unlockAll?, tcpFragment?: {enable, maxSleepMs}, nonce?: {type, applyToAllUDPPacket, minLen, maxLen}, padding?: {maxMiddle, maxEnd}, lowEntropy?: {mode, rotation} } */
function encodeTrafficPattern(p) {
  const parts = [];
  if (p.seed != null) parts.push(vField(1, p.seed));
  if (p.unlockAll != null) parts.push(vField(2, p.unlockAll ? 1 : 0));
  if (p.tcpFragment) {
    const t = [];
    if (p.tcpFragment.enable != null) t.push(vField(1, p.tcpFragment.enable ? 1 : 0));
    if (p.tcpFragment.maxSleepMs != null) t.push(vField(2, p.tcpFragment.maxSleepMs));
    parts.push(mField(3, Buffer.concat(t)));
  }
  if (p.nonce) {
    const t = [];
    if (p.nonce.type != null) t.push(vField(1, p.nonce.type));
    if (p.nonce.applyToAllUDPPacket != null) t.push(vField(2, p.nonce.applyToAllUDPPacket ? 1 : 0));
    if (p.nonce.minLen != null) t.push(vField(3, p.nonce.minLen));
    if (p.nonce.maxLen != null) t.push(vField(4, p.nonce.maxLen));
    parts.push(mField(4, Buffer.concat(t)));
  }
  if (p.padding) {
    const t = [];
    if (p.padding.maxMiddle != null) t.push(vField(1, p.padding.maxMiddle));
    if (p.padding.maxEnd != null) t.push(vField(2, p.padding.maxEnd));
    parts.push(mField(5, Buffer.concat(t)));
  }
  if (p.lowEntropy) {
    const t = [];
    if (p.lowEntropy.mode != null) t.push(vField(1, p.lowEntropy.mode));
    if (p.lowEntropy.rotation != null) t.push(vField(2, p.lowEntropy.rotation));
    parts.push(mField(6, Buffer.concat(t)));
  }
  return Buffer.concat(parts).toString('base64');
}

// Поворот маски низкой энтропии: 0 — без поворота, 1..15 — вправо, 16·n — влево (как в enum LowEntropyMaskRotation)
const rotationFrom = (byte) => { const n = byte % 31; return n === 0 ? 0 : n <= 15 ? n : (n - 15) * 16; };

/**
 * Наш набор против обнаружения «полностью зашифрованного» трафика (метод GFW из работы USENIX Security 2023 и
 * энтропийные функции коммерческих DPI вроде Qosmos):
 *  - начало пакета — печатные символы (6–12 байт): такие потоки GFW пропускает без проверки;
 *  - низкая энтропия 48 бит из 64: в среднем 3 единичных бита на байт вместо 4 у случайных данных
 *    (около трети трафика уходит на это, зато поток не похож на «белый шум»);
 *  - паддинг в середине и в конце, своё зерно и поворот маски на каждый сервер — у разных серверов разный рисунок.
 */
function quasarPattern(rand) {
  const r = rand(6);
  return {
    seed: r.readUInt32BE(0) & 0x7fffffff,
    nonce: { type: NONCE.PRINTABLE, applyToAllUDPPacket: true, minLen: 6, maxLen: 12 },
    padding: { maxMiddle: 64 + (r[4] % 64), maxEnd: 64 + (r[5] % 128) },
    lowEntropy: { mode: LOW_ENTROPY.M48, rotation: rotationFrom(r[4] ^ r[5]) },
  };
}

module.exports = { encodeTrafficPattern, quasarPattern, NONCE, LOW_ENTROPY };
