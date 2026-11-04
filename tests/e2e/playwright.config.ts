import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

// Evidencias del e2e aparte de las del dev (gitignoreado).
export const E2E_EVIDENCE_DIR = fileURLToPath(new URL('../../test-results/e2e-evidence', import.meta.url));

// Puertos propios del e2e para no chocar con un dev server abierto.
const API_PORT = 4720;
const WEB_PORT = 4721;
const HOST = process.env.E2E_HOST ?? '127.0.0.1';
const env = {
  HUB_HOST: HOST === '127.0.0.1' ? HOST : `127.0.0.1,${HOST}`,
  SENTINEL_API_PORT: String(API_PORT),
  SENTINEL_WEB_PORT: String(WEB_PORT),
  META_API_ENABLED: 'false',
  EVIDENCE_DIR: E2E_EVIDENCE_DIR,
  // Sin GPU (SwiftShader) leer un frame de CAM-01 tarda ~12 s; con GPU, ms.
  FRAME_TIMEOUT_MS: '60000',
};

export default defineConfig({
  testDir: '.',
  timeout: 180_000,
  outputDir: '../../test-results',
  use: {
    baseURL: `http://${HOST}:${WEB_PORT}`,
    viewport: { width: 1440, height: 860 },
    launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
  },
  webServer: [
    {
      command: 'pnpm --filter @sentinel/api exec node src/main.ts',
      url: `http://127.0.0.1:${API_PORT}/health`,
      env,
      reuseExistingServer: false,
      cwd: '../..',
    },
    {
      command: 'pnpm --filter @sentinel/web exec vite',
      url: `http://${HOST}:${WEB_PORT}`,
      env,
      reuseExistingServer: false,
      cwd: '../..',
    },
  ],
});
