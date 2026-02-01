import { defineConfig } from 'vite';
import fs from 'node:fs';

export default defineConfig({
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
