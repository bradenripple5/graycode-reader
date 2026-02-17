import { defineConfig } from 'vite';
import fs from 'node:fs';

const backendOrigin = process.env.BACKEND_ORIGIN || 'https://127.0.0.1:8001';
const proxyConfig = {
  target: backendOrigin,
  changeOrigin: true,
  secure: false,
};

export default defineConfig({
  assetsInclude: ['**/*.html'],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/upload-image': proxyConfig,
      '/barcode_reconstruct_out': proxyConfig,
      '/app_config.json': proxyConfig,
      '/files': proxyConfig,
      '/last-post': proxyConfig,
      '/save': proxyConfig,
      '/save-image': proxyConfig,
      '/save-diff': proxyConfig,
      '/revert': proxyConfig,
    },
    https: {
      key: fs.readFileSync('./10.0.0.237-key.pem'),
      cert: fs.readFileSync('./10.0.0.237.pem'),
    },
  },
});
