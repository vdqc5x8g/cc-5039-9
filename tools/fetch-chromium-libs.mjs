// Fetches the arm64 .deb packages needed by headless Chromium and extracts
// them into a user-writable prefix, since this container has no root for apt.
import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const PREFIX = process.env.HOME + '/.local/chromium-libs';
const DEB_DIR = PREFIX + '/debs';
const MIRROR = 'http://deb.debian.org/debian/pool/main';

// package -> { pool path, pinned bookworm filename } so nothing from trixie
// (which requires glibc 2.38) can slip in on this bookworm (glibc 2.36) host.
const PACKAGES = {
  'libnspr4': { pool: 'n/nspr', pin: 'libnspr4_4.35-1_arm64.deb' },
  'libnss3': { pool: 'n/nss', pin: 'libnss3_3.87.1-1+deb12u2_arm64.deb' },
  'libatk1.0-0': { pool: 'a/atk1.0', pin: 'libatk1.0-0_2.36.0-2_arm64.deb' },
  'libatk-bridge2.0-0': { pool: 'a/at-spi2-core', pin: 'libatk-bridge2.0-0_2.46.0-5_arm64.deb' },
  'libatspi2.0-0': { pool: 'a/at-spi2-core', pin: 'libatspi2.0-0_2.46.0-5_arm64.deb' },
  'libdbus-1-3': { pool: 'd/dbus', pin: 'libdbus-1-3_1.14.10-1~deb12u1_arm64.deb' },
  'libdrm2': { pool: 'libd/libdrm', pin: 'libdrm2_2.4.114-1+b1_arm64.deb' },
  'libgbm1': { pool: 'm/mesa', pin: 'libgbm1_22.3.6-1+deb12u2_arm64.deb' },
  'libxcomposite1': { pool: 'libx/libxcomposite', pin: null },
  'libxdamage1': { pool: 'libx/libxdamage', pin: null },
  'libxfixes3': { pool: 'libx/libxfixes', pin: null },
  'libxrandr2': { pool: 'libx/libxrandr', pin: null },
  'libxkbcommon0': { pool: 'libx/libxkbcommon', pin: 'libxkbcommon0_1.5.0-1_arm64.deb' },
  'libasound2': { pool: 'a/alsa-lib', pin: null },
  'libcups2': { pool: 'c/cups', pin: null },
  'libxi6': { pool: 'libx/libxi', pin: null },
  // transitive deps of the mesa/at-spi stack on a minimal image
  'libxext6': { pool: 'libx/libxext', pin: null },
  'libxcb1': { pool: 'libx/libxcb', pin: 'libxcb1_1.15-1_arm64.deb' },
  'libx11-6': { pool: 'libx/libx11', pin: 'libx11-6_1.8.4-2+deb12u2_arm64.deb' },
  'libexpat1': { pool: 'e/expat', pin: 'libexpat1_2.5.0-1+deb12u2_arm64.deb' },
  'libwayland-server0': { pool: 'w/wayland', pin: 'libwayland-server0_1.21.0-1_arm64.deb' },
};

async function findDeb(name, poolPath, pin) {
  if (pin) return pin;
  const dirUrl = `${MIRROR}/${poolPath}/`;
  const html = await (await fetch(dirUrl)).text();
  const matches = [...html.matchAll(new RegExp(`href="(${name}_[^"]+_arm64\\.deb)"`, 'g'))].map((m) => m[1]);
  if (!matches.length) throw new Error(`no arm64 deb found for ${name} at ${dirUrl}`);
  // Only plain bookworm packages are glibc-2.36 compatible here.
  const stable = matches.filter((f) => !/(deb13|bpo|trixie)/.test(f));
  if (!stable.length) throw new Error(`no bookworm-compatible deb for ${name}`);
  return stable[stable.length - 1];
}

await mkdir(DEB_DIR, { recursive: true });
for (const [name, { pool: poolPath, pin }] of Object.entries(PACKAGES)) {
  const debName = await findDeb(name, poolPath, pin);
  const out = join(DEB_DIR, debName);
  if (!existsSync(out)) {
    const res = await fetch(`${MIRROR}/${poolPath}/${debName}`);
    if (!res.ok) throw new Error(`download ${debName}: ${res.status}`);
    await writeFile(out, Buffer.from(await res.arrayBuffer()));
    console.log('downloaded', debName);
  }
}
console.log('extracting into', PREFIX);
for (const f of await readdir(DEB_DIR)) {
  if (!f.endsWith('.deb')) continue;
  execSync(`dpkg-deb -x "${join(DEB_DIR, f)}" "${PREFIX}/root"`, { stdio: 'inherit' });
}
console.log('done');
