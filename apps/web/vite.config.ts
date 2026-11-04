import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '../..', '');
  // Vite escucha en un solo host: el primero de HUB_HOST que no sea loopback,
  // así se ve por tailnet. Nunca todas las interfaces.
  const hosts = (env.HUB_HOST ?? '127.0.0.1').split(',').map((h) => h.trim());
  const host = hosts.find((h) => h !== '127.0.0.1') ?? '127.0.0.1';
  if (['0.0.0.0', '::', '[::]', ''].includes(host)) throw new Error(`refusing to bind "${host}"`);
  return {
    plugins: [vue()],
    envDir: '../..',
    envPrefix: 'SENTINEL_PUBLIC_',
    define: { __API_PORT__: JSON.stringify(env.SENTINEL_API_PORT ?? '4710') },
    server: {
      host,
      port: Number(env.SENTINEL_WEB_PORT ?? 4711),
      strictPort: true,
      // Nombres extra por los que se entra (ej. un DNS interno); IPs y localhost ya valen.
      allowedHosts: (env.SENTINEL_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean),
    },
  };
});
