import fs from 'node:fs';
import os from 'node:os';
import { execSync } from 'node:child_process';

function detectLanIp() {
  try {
    const nets = os.networkInterfaces();
    for (const addrs of Object.values(nets)) {
      if (!addrs) continue;
      for (const addr of addrs) {
        if (!addr || addr.family !== 'IPv4' || addr.internal) continue;
        const ip = addr.address || '';
        if (isPrivateIp(ip)) return ip;
      }
    }
  } catch (err) {
    // Some restricted environments block uv_interface_addresses.
  }

  try {
    const route = execSync('ip -4 route get 1.1.1.1', { encoding: 'utf8' });
    const match = route.match(/\bsrc\s+(\d+\.\d+\.\d+\.\d+)\b/);
    if (match && isPrivateIp(match[1])) return match[1];
  } catch (err) {
    // Keep dev startup non-fatal.
  }

  try {
    const addrs = execSync('ip -4 addr show scope global', { encoding: 'utf8' });
    const matches = [...addrs.matchAll(/\binet\s+(\d+\.\d+\.\d+\.\d+)\//g)];
    const match = matches.find((m) => isPrivateIp(m[1]));
    if (match) return match[1];
  } catch (err) {
    // Keep dev startup non-fatal.
  }

  return null;
}

function isPrivateIp(ip) {
  return (
    ip.startsWith('10.') ||
    ip.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)
  );
}

const payload = {
  ip: detectLanIp(),
  port: 5173,
  protocol: 'https:',
  generatedAt: new Date().toISOString()
};

fs.writeFileSync('.dev_lan_config.json', `${JSON.stringify(payload, null, 2)}\n`);
console.log(`LAN dev config: ${payload.ip ? `${payload.protocol}//${payload.ip}:${payload.port}` : 'no LAN IP found'}`);
