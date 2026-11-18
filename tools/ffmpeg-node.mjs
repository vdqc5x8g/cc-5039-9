// ffmpeg.wasm core is built for a browser-like global scope; these shims let it
// run under Node so test media can be generated without a system ffmpeg.
import { webcrypto } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);

globalThis.self ??= globalThis;
if (!globalThis.crypto?.getRandomValues) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true, writable: true });
}
globalThis.performance ??= (await import('node:perf_hooks')).performance;
globalThis.location ??= {
  href: pathToFileURL(process.cwd() + '/').href,
  origin: 'null',
  protocol: 'file:',
};
globalThis.document ??= { currentScript: null };

const { default: createFFmpegCore } = await import('@ffmpeg/core');

export async function createFFmpeg() {
  const core = await createFFmpegCore({
    wasmBinary: readFileSync(require.resolve('@ffmpeg/core/wasm')),
  });
  const logs = [];
  core.setLogger(({ type, message }) => {
    logs.push(message);
  });
  return {
    FS: core.FS,
    exec: (...args) => {
      const ret = core.exec(...args);
      if (ret !== 0) {
        throw new Error(`ffmpeg exited ${ret}\n${logs.slice(-12).join('\n')}`);
      }
      return ret;
    },
    logs: () => logs.slice(),
    reset: () => core.reset?.(),
  };
}
