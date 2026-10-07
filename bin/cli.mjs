#!/usr/bin/env node
// firestore-files rules [--config firestore-files.config.mjs] [--write firestore.rules] [--check]
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { generateRules, injectRules } from '../dist/rules-entry.js';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};

if (args[0] !== 'rules' || args.includes('--help')) {
  console.log(`Usage:
  firestore-files rules [--config <file>]                print the rules block
  firestore-files rules --write firestore.rules          insert between the markers
  firestore-files rules --write firestore.rules --check  verify the rules are up to date (for CI)

The default config is firestore-files.config.mjs (export default defineConfig({...}) or an array).`);
  process.exit(args[0] === 'rules' || args.includes('--help') ? 0 : 1);
}

try {
  const configPath = resolve(opt('--config', 'firestore-files.config.mjs'));
  const mod = await import(pathToFileURL(configPath).href);
  const config = mod.default ?? mod.config;
  if (!config) throw new Error(`${configPath}: no default export`);
  const target = opt('--write');
  if (!target) {
    for (const c of Array.isArray(config) ? config : [config]) console.log(generateRules(c), '\n');
  } else {
    const source = await readFile(target, 'utf8');
    const next = injectRules(source, config);
    if (args.includes('--check')) {
      if (next !== source) {
        console.error(`${target} is out of date — run: firestore-files rules --write ${target}`);
        process.exit(1);
      }
      console.log(`${target} is up to date`);
    } else if (next === source) console.log(`${target} unchanged`);
    else {
      await writeFile(target, next);
      console.log(`${target} updated`);
    }
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
