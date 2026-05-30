import { defineConfig } from 'vite';
import fs from 'node:fs';
import os from 'node:os';

const lanConfigPath = '.dev_lan_config.json';

function detectLanIp() {
  try {
    const nets = os.networkInterfaces();
    for (const addrs of Object.values(nets)) {
      if (!addrs) continue;
      for (const addr of addrs) {
        if (!addr || addr.family !== 'IPv4' || addr.internal) continue;
        const ip = addr.address || '';
        if (
          ip.startsWith('10.') ||
          ip.startsWith('192.168.') ||
          /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)
        ) {
          return ip;
        }
      }
    }
  } catch (err) {
    return null;
  }
  return null;
}

function readLanConfig() {
  try {
    return JSON.parse(fs.readFileSync(lanConfigPath, 'utf8'));
  } catch (err) {
    return null;
  }
}

function lanIpPlugin() {
  return {
    name: 'lan-ip-endpoint',
    configureServer(server) {
      server.middlewares.use('/__dev_lan_ip', (req, res) => {
        const config = readLanConfig();
        const ip = config?.ip || detectLanIp();
        const address = server.httpServer?.address();
        const actualPort = address && typeof address === 'object'
          ? address.port
          : null;
        const payload = JSON.stringify({
          ip,
          port: actualPort || config?.port || server.config.server.port,
          protocol: config?.protocol || (server.config.server.https ? 'https:' : 'http:'),
        });
        res.statusCode = ip ? 200 : 503;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(payload);
      });
    },
  };
}

export default defineConfig({
  plugins: [lanIpPlugin()],
  assetsInclude: ['**/*.html'],
  server: {
    host: '0.0.0.0',
    port: 5173,
    https: {
      key: fs.readFileSync('./10.0.0.237-key.pem'),
      cert: fs.readFileSync('./10.0.0.237.pem'),
    },
  },
});
