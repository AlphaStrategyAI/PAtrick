import { defineConfig, searchForWorkspaceRoot } from 'vite';
import type { ServerOptions } from 'vite';

export function localServerConfig(target?: string): ServerOptions {
  return {
    fs: { allow: [searchForWorkspaceRoot(import.meta.dirname)] },
    // T03 accepts http://localhost, with its default HTTP port. The proxy must forward
    // the browser's actual Origin unmodified rather than synthesize one on its behalf.
    ...(target ? { host: 'localhost', port: 80, strictPort: true, proxy: { '/api': { target } } } : {}),
  };
}

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  server: localServerConfig(process.env.PATRICK_LOCAL_SERVICE),
});
