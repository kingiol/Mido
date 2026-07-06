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
      '@mido-agent/protocol-core': `${root}packages/protocol-core/src/index.ts`,
      '@mido-agent/protocol-agui': `${root}packages/protocol-agui/src/index.ts`,
      '@mido-agent/mcp-core': `${root}packages/mcp-core/src/index.ts`,
      '@mido-agent/server-sdk': `${root}packages/server-sdk/src/index.ts`,
      '@mido-agent/client-core': `${root}packages/client-core/src/index.ts`,
      '@mido-agent/client-web': `${root}packages/client-web/src/index.tsx`,
      '@mido-agent/conformance': `${root}packages/conformance/src/index.ts`
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
