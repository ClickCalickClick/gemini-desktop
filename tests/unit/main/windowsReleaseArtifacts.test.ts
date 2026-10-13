import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const configPath = path.resolve(__dirname, '../../..', 'config/electron-builder.config.cjs');
const builderConfig = require(configPath);
const builderConfigSource = fs.readFileSync(configPath, 'utf8');

describe('Windows release artifacts', () => {
    it('keeps NSIS and removes MSI from Windows builder targets', () => {
        expect(builderConfig.win.target).toBe('nsis');
        expect(builderConfigSource).not.toContain("arch: ['x64', 'arm64']");
        expect(builderConfigSource).not.toContain('msi');
    });

    it('removes unified Windows binary exclusions from builder config', () => {
        expect(builderConfig.files).toContain('!node_modules/@node-llama-cpp/linux-x64');
        expect(builderConfig.files).toContain('!node_modules/@node-llama-cpp/mac-arm64-metal');
        expect(builderConfigSource).toContain('function getWindowsBinaryExclusions()');
        expect(builderConfigSource).not.toContain('if (isUnifiedWindowsBuild)');
    });
});
