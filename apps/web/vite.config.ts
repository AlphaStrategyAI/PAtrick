import { defineConfig, searchForWorkspaceRoot } from 'vite';
import type { ServerOptions } from 'vite';

export function localServerConfig(target?: string): ServerOptions {
  return {
    fs: { allow: [searchForWorkspaceRoot(import.meta.dirname)] },
    // T03 accepts http://localhost, with its default HTTP port. The proxy must forward
    // the browser's actual Origin unmodified rather than synthesize one on its behalf.
    ...(target ? { host: 'localhost', port: 80, strictPort: true, proxy: { '/api': {
      target,
      configure(proxy) {
        proxy.on('proxyRes', (upstream, _request, downstream) => {
          const stop = () => { if (!downstream.destroyed && !downstream.writableEnded) downstream.destroy(); };
          upstream.once('aborted', stop);
          upstream.once('error', stop);
          upstream.once('close', () => { if (!upstream.complete) stop(); });
          if (upstream.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() === 'text/event-stream') {
            // Vite copies status and headers after this event; flush only after those passes run.
            queueMicrotask(() => { if (!downstream.headersSent && !downstream.destroyed && !downstream.writableEnded) downstream.flushHeaders(); });
          }
        });
      },
    } } } : {}),
  };
}

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  server: localServerConfig(process.env.PATRICK_LOCAL_SERVICE),
});
