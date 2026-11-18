import { homedir } from 'node:os';
import { join } from 'node:path';

// This container has no root for system packages, so Chromium's shared
// libraries live in a user-writable prefix populated by tools/fetch-chromium-libs.mjs.
const libPrefix = join(homedir(), '.local/chromium-libs/root');
const ldLibraryPath = [
  join(libPrefix, 'usr/lib/aarch64-linux-gnu'),
  join(libPrefix, 'lib/aarch64-linux-gnu'),
  process.env.LD_LIBRARY_PATH,
].filter(Boolean).join(':');

export default {
  testDir: './test/e2e',
  timeout: 30000,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    headless: true,
    launchOptions: {
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
      env: { ...process.env, LD_LIBRARY_PATH: ldLibraryPath },
    },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
};
