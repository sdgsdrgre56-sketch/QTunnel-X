'use strict';
// Данные приложения в одном файле JSON: серверы, настройки, сайты для пинга, счётчик трафика.
// Пароль SSH сюда не попадает никогда. Ссылки серверов содержат ключи, поэтому файл создаётся с правами только для владельца.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_HOSTS = 20;
const SKINS = ['blue', 'night', 'graphite', 'emerald', 'sunset', 'sakura', 'lavender', 'ocean', 'gold', 'light'];
const DEFAULTS = () => ({
  v: 1,
  servers: [],
  settings: { skin: 'blue', lan: false, adblock: true, tun: false, sysproxy: false, bigAds: false, limitGb: 0, rules: [], mixedPort: 10808, apiPort: 10809, lanPort: 10810, lanAuth: true, lanDevice: '', share: { on: false, via: 'wifi', adapter: '' }, lanPass: crypto.randomBytes(9).toString('base64url') },
  sites: ['google.com', 'youtube.com', 'discord.com', 'api.telegram.org', 'github.com'],
  usage: {},   // { 'YYYY-MM-DD': { down, up } }
  access: {},  // host -> { port, username, secret (зашифровано), fingerprint, at } — только если пользователь разрешил
  maskSites: [],   // свои сайты для маскировки
});

const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

class Store {
  constructor(dir) {
    this.dir = dir; this.file = path.join(dir, 'quasar.json');
    fs.mkdirSync(dir, { recursive: true });
    this.data = DEFAULTS();
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && raw.v === 1) this.data = { ...this.data, ...raw, settings: { ...this.data.settings, ...raw.settings } };
    } catch { /* первого запуска файла ещё нет */ }
    this._timer = null;
  }
  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
  saveSoon() { if (!this._timer) this._timer = setTimeout(() => { this._timer = null; this.save(); }, 1500); this._timer.unref && this._timer.unref(); }

  // id не зависит от ключей: при переустановке сервера запись обновляется, а не дублируется
  static idOf(it) { return crypto.createHash('sha1').update(`${it.proto}|${it.host}|${it.port}`).digest('hex').slice(0, 12); }

  hosts() { return [...new Set(this.data.servers.map((s) => s.host))]; }

  addServers(items, group) {
    const hosts = new Set(this.hosts());
    for (const it of items) hosts.add(it.host);
    if (hosts.size > MAX_HOSTS) throw new Error(`Слишком много серверов (максимум ${MAX_HOSTS}). Удали ненужные`);
    const oneHost = new Set(items.map((x) => x.host)).size === 1;
    let added = 0;
    for (const it of items) {
      const id = Store.idOf(it);
      const rec = { ...it, id, group: (oneHost && group) || it.group || it.host };
      const i = this.data.servers.findIndex((s) => s.id === id);
      if (i >= 0 && this.data.servers[i].customName) { rec.name = this.data.servers[i].name; rec.customName = true; }   // имя, которое дал сам человек, повторный импорт не затирает
      if (i >= 0 && this.data.servers[i].customGroup) { rec.group = this.data.servers[i].group; rec.customGroup = true; }
      if (i >= 0) this.data.servers[i] = rec; else { this.data.servers.push(rec); added++; }
    }
    this.save();
    return added;
  }
  // Заменить все протоколы сервера (после переустановки ключи и порты новые)
  // Имена, которые дал сам человек, переходят к новым профилям того же протокола (порт и ключи при этом могли смениться)
  replaceHost(host, items, group) {
    const old = this.data.servers.filter((x) => x.host === host);
    const key = (x) => x.proto + '|' + (x.transport || '');
    const carry = new Map(old.map((x) => [key(x), x]));
    const customGroup = old.find((x) => x.customGroup);
    const keep = this.data.servers.filter((x) => x.host !== host);
    const prev = this.data.servers; this.data.servers = keep;
    try {
      const added = this.addServers(items, customGroup ? customGroup.group : group);
      for (const n of this.data.servers.filter((x) => x.host === host)) {
        const o = carry.get(key(n));
        if (o && o.customName && !n.customName) { n.name = o.name; n.customName = true; }
        if (customGroup) { n.group = customGroup.group; n.customGroup = true; }
      }
      this.save();
      return added;
    } catch (e) { this.data.servers = prev; throw e; }
  }
  // Новый порт профиля (после смены порта на сервере): id считается от протокола, адреса и порта, поэтому меняется вместе с ним
  changePort(id, port) {
    const it = this.server(id); if (!it) throw new Error('Сервер не найден');
    const n = Number(port); if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('Порт: число от 1 до 65535');
    const old = it.port, nid = Store.idOf({ ...it, port: n });
    if (nid !== id && this.server(nid)) throw new Error('Профиль с таким портом уже есть');
    it.port = n; it.id = nid;
    if (it.uri) it.uri = it.uri.replace(new RegExp(':' + old + '(?=[/?#]|$)'), ':' + n);
    if (this.data.traffic && this.data.traffic[id] && nid !== id) { this.data.traffic[nid] = this.data.traffic[id]; delete this.data.traffic[id]; }
    this.save(); return it;
  }
  static cleanName(n) { const v = String(n || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 60); if (!v) throw new Error('Имя не может быть пустым'); return v; }
  renameServer(id, name) { const it = this.server(id); if (!it) throw new Error('Сервер не найден'); it.name = Store.cleanName(name); it.customName = true; this.save(); return it; }
  renameHost(host, name) {
    const list = this.data.servers.filter((s) => s.host === host); if (!list.length) throw new Error('Сервер не найден');
    const v = Store.cleanName(name); for (const s of list) { s.group = v; s.customGroup = true; } this.save();
  }
  updateServer(id, patch) {
    const it = this.server(id); if (!it) throw new Error('Сервер не найден');
    if (patch.x) it.x = { ...(it.x || {}), ...patch.x };
    if (patch.sni !== undefined) {
      it.sni = patch.sni;
      if (it.uri) { try { const u = new URL(it.uri); u.searchParams.set('sni', patch.sni); it.uri = u.toString(); } catch { it.uri = undefined; } }
    }
    this.save(); return it;
  }
  addMaskSite(h) {
    const v = String(h || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/:].*$/, '');
    if (!HOST_RE.test(v)) throw new Error('Неверный адрес сайта');
    if (!this.data.maskSites.includes(v)) { if (this.data.maskSites.length >= 50) throw new Error('Сайтов слишком много (максимум 50)'); this.data.maskSites.push(v); }
    this.save(); return this.data.maskSites;
  }
  removeMaskSite(h) { this.data.maskSites = this.data.maskSites.filter((x) => x !== h); this.save(); return this.data.maskSites; }
  removeHost(host) { const n = this.data.servers.length; this.data.servers = this.data.servers.filter((s) => s.host !== host); delete this.data.access[host]; this.save(); return n - this.data.servers.length; }
  removeServer(id) { const n = this.data.servers.length; this.data.servers = this.data.servers.filter((s) => s.id !== id); this.save(); return n !== this.data.servers.length; }
  server(id) { return this.data.servers.find((s) => s.id === id) || null; }

  setSettings(p) {
    const s = this.data.settings;
    if (p.skin !== undefined) { if (!SKINS.includes(p.skin)) throw new Error('Нет такого скина'); s.skin = p.skin; }
    if (p.trayKeep !== undefined) s.trayKeep = !!p.trayKeep;   // крестик окна сворачивает Квазар в трей, а не выключает
    if (p.lan !== undefined) s.lan = !!p.lan;
    if (p.lanAuth !== undefined) s.lanAuth = !!p.lanAuth;
    if (p.lanDevice !== undefined) {
      const d = String(p.lanDevice || '').trim();
      if (d && !(/^\d{1,3}(\.\d{1,3}){3}$/.test(d) && d.split('.').every((n) => Number(n) <= 255)) && !require('net').isIPv6(d)) throw new Error('IP приставки: например 192.168.1.50 или пусто');
      s.lanDevice = d;
    }
    if (p.lanPort !== undefined) {
      const n = Number(p.lanPort);
      if (!Number.isInteger(n) || n < 1024 || n > 65535 || n === s.mixedPort || n === s.apiPort) throw new Error('Порт раздачи: от 1024 до 65535 и не 10808/10809');
      s.lanPort = n;
    }
    if (p.adblock !== undefined) s.adblock = !!p.adblock;
    if (p.tun !== undefined) s.tun = !!p.tun;
    if (p.sysproxy !== undefined) s.sysproxy = !!p.sysproxy;
    if (p.bigAds !== undefined) s.bigAds = !!p.bigAds;
    if (p.autoFallback !== undefined) s.autoFallback = !!p.autoFallback;
    if (p.limitGb !== undefined) { const n = Number(p.limitGb); if (!Number.isFinite(n) || n < 0 || n > 100000) throw new Error('Лимит: число гигабайт от 0 (без лимита)'); s.limitGb = n; }
    this.save();
    return s;
  }
  addRule(r) {
    const kind = ['domain', 'suffix', 'keyword'].includes(r.kind) ? r.kind : 'suffix';
    const action = ['proxy', 'direct', 'block'].includes(r.action) ? r.action : null;
    const value = String(r.value || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!action) throw new Error('Действие: через сервер, напрямую или блок');
    if (!/^[a-z0-9._-]{1,253}$/.test(value)) throw new Error('Неверный домен');
    const rules = this.data.settings.rules || (this.data.settings.rules = []);
    if (rules.length >= 100) throw new Error('Правил слишком много (максимум 100)');
    const i = rules.findIndex((x) => x.kind === kind && x.value === value);
    if (i >= 0) rules[i] = { kind, value, action }; else rules.push({ kind, value, action });
    this.save();
  }
  removeRule(kind, value) { const s = this.data.settings; s.rules = (s.rules || []).filter((x) => !(x.kind === kind && x.value === value)); this.save(); }
  addSite(h) {
    const host = String(h || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!HOST_RE.test(host)) throw new Error('Это не похоже на адрес сайта (пример: example.com)');
    if (this.data.sites.length >= 120) throw new Error('Слишком много сайтов (не больше 120)');
    if (!this.data.sites.includes(host)) this.data.sites.push(host);
    this.save();
    return host;
  }
  removeSite(host) { this.data.sites = this.data.sites.filter((s) => s !== host); this.save(); }

  addServerUsage(id, down, up) {
    if (!id || !(down > 0 || up > 0)) return;
    const t = this.data.traffic || (this.data.traffic = {});
    const d = t[id] || (t[id] = { down: 0, up: 0 });
    d.down += Math.max(0, down); d.up += Math.max(0, up);
  }

  addUsage(down, up, when = new Date()) {
    if (!(down > 0 || up > 0)) return;
    const k = dayKey(when);
    const d = this.data.usage[k] || (this.data.usage[k] = { down: 0, up: 0 });
    d.down += Math.max(0, down); d.up += Math.max(0, up);
    const keys = Object.keys(this.data.usage).sort();
    while (keys.length > 400) delete this.data.usage[keys.shift()];
    this.saveSoon();
  }
  usageSummary(now = new Date()) {
    const today = this.data.usage[dayKey(now)] || { down: 0, up: 0 };
    const mk = dayKey(now).slice(0, 7);
    let md = 0, mu = 0;
    for (const [k, v] of Object.entries(this.data.usage)) if (k.startsWith(mk)) { md += v.down; mu += v.up; }
    return { today, month: { down: md, up: mu } };
  }
}

module.exports = { Store, SKINS, dayKey };
