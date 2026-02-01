import { defineConfig } from 'vite';
import fs from 'node:fs';

export default defineConfig({
  assetsInclude: ['**/*.html'],
  server: {
    host: '0.0.0.0',
    port: 5173,
    https: {
      key: fs.readFileSync('./server.key'),
      cert: fs.readFileSync('./server.crt'),
    },
  },
});
