// ESLint 10 扁平配置（flat config）。
// 覆盖：src 下全部 .ts/.tsx；渲染进程额外启用 React 规则与浏览器全局；
// 主进程 / preload / shared 使用 Node 全局。构建产物与脚本工具不在检查范围。
import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    // 忽略构建产物、依赖、配置文件与一次性脚本工具
    ignores: [
      'out/**',
      'dist/**',
      'build/**',
      'node_modules/**',
      'coverage/**',
      '**/*.config.{js,ts,mjs,cjs}',
      'scripts/**',
    ],
  },
  // 基础层：所有 TS/TSX 走 typescript-eslint 推荐规则
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  // 渲染进程：浏览器全局 + React Hooks / Fast Refresh 规则
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
    },
  },
  // 主进程 / preload / shared：Node 全局（process、Buffer、require 等）
  {
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts', 'src/shared/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
)
