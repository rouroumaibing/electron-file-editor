import { defineConfig } from 'electron-vite';
import { resolve } from 'node:path';

// @shared 别名在 tsconfig.paths 与 vite/rollup alias 两处都要配，
// 否则 main/preload（rollup）或 renderer（vite）构建时解析不到共享契约类型。
const sharedAlias = { '@shared': resolve(__dirname, 'src/shared') };

export default defineConfig({
  main: {
    resolve: { alias: sharedAlias },
  },
  preload: {
    resolve: { alias: sharedAlias },
  },
  renderer: {
    resolve: {
      alias: sharedAlias,
    },
  },
});
