'use strict';
// Раздача уже проксированного интернета с ПК, как в NekoBox: весь ПК идёт через TUN Квазара, а Windows
// раздаёт этот адаптер («Общий доступ к интернету», ICS) на точку доступа Wi-Fi или на кабель к приставке.
// На приставке ничего не настраивается: обычное подключение к Wi-Fi или по кабелю.
// Все команды — PowerShell; runner подставляется в тестах. Нужен запуск от администратора (как и для TUN).
const TUN_NAME = 'quasar-tun';
// Имена чередуются: при перезапуске туннеля Windows не успевает убрать прежний адаптер, а с другим именем новый создаётся сразу
const TUN_NAMES = ['quasar-tun', 'quasar-tun2'];
const isTun = (n) => TUN_NAMES.includes(n);

const PS_PREFIX = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; ";
const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";

const WINRT = `Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op, $type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }
[Windows.Networking.Connectivity.NetworkInformation,Windows.Networking.Connectivity,ContentType=WindowsRuntime] | Out-Null
[Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager,Windows.Networking.NetworkOperators,ContentType=WindowsRuntime] | Out-Null
$tunIds = @(); try { $tunIds = @(Get-NetAdapter -Name ${TUN_NAMES.map(q).join(',')} -ErrorAction SilentlyContinue | ForEach-Object { $_.InterfaceGuid }) } catch {}
# точку доступа поднимаем от настоящего подключения (Wi-Fi или кабель), а не от адаптера TUN
$prof = [Windows.Networking.Connectivity.NetworkInformation]::GetConnectionProfiles() | Where-Object { $_.GetNetworkConnectivityLevel() -ge 2 -and $tunIds -notcontains ("{" + $_.NetworkAdapter.NetworkAdapterId.ToString() + "}") } | Select-Object -First 1
if (-not $prof) { $prof = [Windows.Networking.Connectivity.NetworkInformation]::GetInternetConnectionProfile() }
if (-not $prof) { throw 'Нет подключения к интернету, от которого можно включить точку доступа' }
$m = [Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager]::CreateFromConnectionProfile($prof)`;

const scripts = {
  // Internet = через этот адаптер сам ПК выходит в интернет (есть шлюз по умолчанию) — на него раздавать нельзя
  adapters: () => PS_PREFIX + "$gw = @(Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -ne $null } | ForEach-Object { $_.InterfaceAlias }); @(Get-NetAdapter | ForEach-Object { [pscustomobject]@{ Name = $_.Name; InterfaceDescription = $_.InterfaceDescription; Status = [string]$_.Status; Internet = ($gw -contains $_.Name) } }) | ConvertTo-Json -Compress",
  hotspotStart: () => PS_PREFIX + WINRT + `
if ($m.TetheringOperationalState -ne 1) {
  $r = Await ($m.StartTetheringAsync()) ([Windows.Networking.NetworkOperators.NetworkOperatorTetheringOperationResult])
  if ($r.Status -ne 0) { throw ('Windows не включил точку доступа: ' + $r.Status + ' ' + $r.AdditionalErrorMessage) }
}
$c = $m.GetCurrentAccessPointConfiguration()
Start-Sleep -Seconds 2
$hs = Get-NetAdapter | Where-Object { $_.InterfaceDescription -like '*Wi-Fi Direct Virtual*' -and $_.Status -eq 'Up' } | Select-Object -First 1
@{ ssid = $c.Ssid; pass = $c.Passphrase; adapter = $hs.Name } | ConvertTo-Json -Compress`,
  hotspotStop: () => PS_PREFIX + WINRT + `
if ($m.TetheringOperationalState -eq 1) { Await ($m.StopTetheringAsync()) ([Windows.Networking.NetworkOperators.NetworkOperatorTetheringOperationResult]) | Out-Null }
'OK'`,
  // ICS: «внешнее» подключение — адаптер TUN Квазара, «домашнее» — точка доступа или кабель к приставке
  icsOn: (target, tunName = TUN_NAME) => PS_PREFIX + `
$m = New-Object -ComObject HNetCfg.HNetShare
$pub = $null; $prv = $null
foreach ($c in @($m.EnumEveryConnection)) {
  $p = $m.NetConnectionProps.Invoke($c); $cfg = $m.INetSharingConfigurationForINetConnection.Invoke($c)
  if ($p.Name -eq ${q(tunName)}) { $pub = $cfg } elseif ($p.Name -eq ${q(target)}) { $prv = $cfg } elseif ($cfg.SharingEnabled) { $cfg.DisableSharing() }
}
if (-not $pub) { throw 'Не нашёл адаптер ${tunName}: включи режим TUN и подключись к серверу' }
if (-not $prv) { throw ('Не нашёл адаптер ' + ${q(target)}) }
$pub.DisableSharing(); $prv.DisableSharing()
$pub.EnableSharing(0); $prv.EnableSharing(1)
'OK'`,
  icsOff: () => PS_PREFIX + `
$m = New-Object -ComObject HNetCfg.HNetShare
foreach ($c in @($m.EnumEveryConnection)) { $cfg = $m.INetSharingConfigurationForINetConnection.Invoke($c); if ($cfg.SharingEnabled) { $cfg.DisableSharing() } }
'OK'`,
};

class Share {
  constructor({ run, platform = process.platform }) { this.run = run; this.platform = platform; }
  get supported() { return this.platform === 'win32'; }
  _need() { if (!this.supported) throw new Error('Раздача через Windows есть только в Windows'); }
  async adapters() {
    this._need();
    const raw = JSON.parse((await this.run(scripts.adapters())) || '[]');
    return (Array.isArray(raw) ? raw : [raw]).filter((a) => a && a.Name && !isTun(a.Name) && !/Wi-Fi Direct Virtual|Loopback|Bluetooth/i.test(a.InterfaceDescription || ''))
      .map((a) => ({ name: a.Name, desc: a.InterfaceDescription || '', up: String(a.Status) === 'Up' || a.Status === 2, internet: !!a.Internet }));
  }
  async startWifi() { this._need(); const r = JSON.parse(await this.run(scripts.hotspotStart())); if (!r.adapter) throw new Error('Точка доступа включилась, но её адаптер не найден'); return r; }
  async stopWifi() { this._need(); await this.run(scripts.hotspotStop()); }
  async icsOn(target, tunName) { this._need(); if (!target) throw new Error('Не выбран адаптер для приставки'); await this.run(scripts.icsOn(target, tunName)); }
  async icsOff() { this._need(); await this.run(scripts.icsOff()); }
}

function psRunner() {
  const { execFile } = require('child_process');
  return (script) => new Promise((resolve, reject) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, timeout: 60000, maxBuffer: 1 << 20 },
      (e, out, err) => (e ? reject(new Error(String(err || e.message).split('\n').find((l) => l.trim()) || e.message)) : resolve(String(out).trim())));
  });
}

module.exports = { Share, TUN_NAME, TUN_NAMES, scripts, psRunner };
