// Отдельная точка входа без firebase — для CLI и скриптов сборки
export { generateRules, injectRules } from './rules.ts';
export { defineConfig, resolveConfig, type FileStoreConfig, type FileStoreRules } from './config.ts';
