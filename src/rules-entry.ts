// Separate entry point without firebase — for the CLI and build scripts
export { generateRules, injectRules } from './rules.ts';
export { defineConfig, resolveConfig, type FileStoreConfig, type FileStoreRules } from './config.ts';
