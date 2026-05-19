import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const root = fileURLToPath(new URL('../../', import.meta.url));
const apiTarget = process.env.MIDO_DEMO_API_TARGET ?? 'http://localhost:3030';

export default defineConfig({
  root: fileURLToPath(new URL('./', import.meta.url)),
  plugins: [react()],
  resolve: {
    alias: {
      '@mido/protocol-core': `${root}packages/protocol-core/src/index.ts`,
      '@mido/protocol-agui': `${root}packages/protocol-agui/src/index.ts`,
      '@mido/mcp-core': `${root}packages/mcp-core/src/index.ts`,
      '@mido/server-sdk': `${root}packages/server-sdk/src/index.ts`,
      '@mido/client-core': `${root}packages/client-core/src/index.ts`,
      '@mido/client-web': `${root}packages/client-web/src/index.tsx`,
      '@mido/conformance': `${root}packages/conformance/src/index.ts`
    }
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true
      },
      '/mcp/tencent-map': {
        target: 'https://mcp.map.qq.com',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/mcp\/tencent-map/, '/mcp')
      }
    }
  },
  build: {
    outDir: 'dist'
  }
});
