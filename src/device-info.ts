import os from 'node:os';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const DEVICE_INFO_PROTOCOL = 'dreammate.device.v1';
export interface InterfaceAddress { family: 'IPv4' | 'IPv6'; address: string; netmask: string }
export interface DeviceInterface { name: string; mac: string | null; addresses: InterfaceAddress[] }
export interface DeviceInfo {
  protocol: typeof DEVICE_INFO_PROTOCOL; node_id: string; collected_at: string;
  hostname: string; model: string | null; system: { name: string; version: string; arch: string };
  interfaces: DeviceInterface[];
}

const runFile = promisify(execFile);
async function localCommand(file: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await runFile(file, args, { timeout: 1500, killSignal: 'SIGKILL', maxBuffer: 16 * 1024, encoding: 'utf8', windowsHide: true });
    return stdout.trim();
  } catch { return ''; }
}
function localFile(file: string): string {
  try { return fs.readFileSync(file, 'utf8').replace(/\0/g, '').trim(); } catch { return ''; }
}

async function systemInfo(): Promise<Pick<DeviceInfo, 'model' | 'system'>> {
  let model = '', name: string = os.type(), version = os.release();
  if (process.platform === 'darwin') {
    const [hardware, productVersion] = await Promise.all([
      localCommand('/usr/sbin/sysctl', ['-n', 'hw.model']), localCommand('/usr/bin/sw_vers', ['-productVersion']),
    ]);
    model = hardware; name = 'macOS'; version = productVersion || version;
  } else if (process.platform === 'linux') {
    model = localFile('/sys/devices/virtual/dmi/id/product_name') || localFile('/sys/firmware/devicetree/base/model');
    const release = localFile('/etc/os-release');
    const field = (key: string) => new RegExp(`^${key}=(.*)$`, 'm').exec(release)?.[1]?.replace(/^["']|["']$/g, '') || '';
    name = field('NAME') || name; version = field('VERSION_ID') || version;
  } else if (process.platform === 'win32') {
    const raw = await localCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '$c = Get-CimInstance Win32_ComputerSystem; $s = Get-CimInstance Win32_OperatingSystem; @{model=$c.Model;name=$s.Caption;version=$s.Version} | ConvertTo-Json -Compress']);
    try {
      const value = JSON.parse(raw);
      if (typeof value.model === 'string') model = value.model;
      if (typeof value.name === 'string') name = value.name;
      if (typeof value.version === 'string') version = value.version;
    } catch { /* Missing local system information stays unknown. */ }
  }
  return { model: model || null, system: { name, version, arch: os.arch() } };
}

/** Local OS data only; no peer requests, route checks or network scans. */
export function localInterfaces(raw = os.networkInterfaces()): DeviceInterface[] {
  return Object.entries(raw).flatMap(([name, entries]) => {
    const addresses = entries?.filter(entry => !entry.internal) ?? [];
    if (!addresses.length) return [];
    return [{ name, mac: addresses.find(entry => entry.mac && entry.mac !== '00:00:00:00:00:00')?.mac ?? null,
      addresses: addresses.map(entry => ({ family: entry.family, address: entry.address, netmask: entry.netmask })) }];
  });
}

let cache: { at: number; value: Omit<DeviceInfo, 'node_id'> } | undefined;
let pending: Promise<Omit<DeviceInfo, 'node_id'>> | undefined;
export async function deviceInfo(nodeId: string): Promise<DeviceInfo> {
  if (!cache || Date.now() - cache.at >= 30_000) {
    pending ??= (async () => {
      const system = await systemInfo();
      let interfaces: DeviceInterface[] = [];
      try { interfaces = localInterfaces(); } catch { /* Interface data is optional. */ }
      const value: Omit<DeviceInfo, 'node_id'> = { protocol: DEVICE_INFO_PROTOCOL, collected_at: new Date().toISOString(), hostname: os.hostname(), ...system, interfaces };
      cache = { at: Date.now(), value }; return value;
    })().finally(() => { pending = undefined; });
    return { ...await pending, node_id: nodeId };
  }
  return { ...cache.value, node_id: nodeId };
}

export function parseDeviceInfo(value: unknown, nodeId: string): DeviceInfo {
  const raw = value as DeviceInfo;
  if (!raw || raw.protocol !== DEVICE_INFO_PROTOCOL || raw.node_id !== nodeId || typeof raw.hostname !== 'string'
    || (raw.model !== null && typeof raw.model !== 'string') || !raw.system || typeof raw.system.name !== 'string'
    || typeof raw.system.version !== 'string' || typeof raw.system.arch !== 'string' || !Array.isArray(raw.interfaces)) {
    throw new Error('invalid_device_info');
  }
  return raw;
}
