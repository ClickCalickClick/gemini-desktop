import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import {
    GITHUB_DISCLAIMER_URL,
    GITHUB_ISSUES_URL,
    GITHUB_LATEST_RELEASE_API_URL,
    GITHUB_LICENSE_URL,
    GITHUB_REPO_NAME,
    GITHUB_REPO_OWNER,
    GITHUB_REPO_URL,
} from '../../../src/shared/constants/urls';

type Repository = { owner: string; repo: string };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const repoRoot = path.resolve(__dirname, '../../..');
const packageJson = require(path.join(repoRoot, 'package.json')) as {
    homepage: string;
    repository: { url: string };
    bugs: { url: string };
};
const builderConfig = require(path.join(repoRoot, 'config/electron-builder.config.cjs')) as { publish: Repository };

function listFiles(dir: string): string[] {
    return fs
        .readdirSync(dir, { withFileTypes: true })
        .flatMap((entry) =>
            entry.isDirectory() ? listFiles(path.join(dir, entry.name)) : [path.join(dir, entry.name)]
        );
}

describe('GitHub repository URLs', () => {
    it('point at the fork', () => {
        expect(GITHUB_REPO_URL).toBe('https://github.com/ClickCalickClick/gemini-desktop');
        expect(GITHUB_ISSUES_URL).toBe(`${GITHUB_REPO_URL}/issues`);
        expect(GITHUB_LATEST_RELEASE_API_URL).toBe(
            'https://api.github.com/repos/ClickCalickClick/gemini-desktop/releases/latest'
        );
    });

    it('name the same repository as package.json, electron-builder and the dev update config', () => {
        const devUpdateConfig = parse(
            fs.readFileSync(path.join(repoRoot, 'src/main/dev-app-update.yml'), 'utf8')
        ) as Repository;
        const repository = { owner: GITHUB_REPO_OWNER, repo: GITHUB_REPO_NAME };

        expect(packageJson.homepage).toBe(GITHUB_REPO_URL);
        expect(packageJson.repository.url).toBe(`git+${GITHUB_REPO_URL}.git`);
        expect(packageJson.bugs.url).toBe(GITHUB_ISSUES_URL);
        expect(builderConfig.publish).toEqual(expect.objectContaining(repository));
        expect(devUpdateConfig).toEqual(expect.objectContaining(repository));
    });

    it('link to files that exist in the repository', () => {
        for (const url of [GITHUB_LICENSE_URL, GITHUB_DISCLAIMER_URL]) {
            const relativePath = url.replace(`${GITHUB_REPO_URL}/blob/main/`, '');
            expect(fs.existsSync(path.join(repoRoot, relativePath)), url).toBe(true);
        }
    });

    it('are not written out as strings anywhere else in src', () => {
        const repositoryUrlLiteral = /['"`]https:\/\/(api\.)?github\.com\/(repos\/)?[\w.-]+\/gemini-desktop/;
        const offenders = listFiles(path.join(repoRoot, 'src'))
            .filter((file) => /\.(ts|tsx|js|cjs|html|yml)$/.test(file))
            .filter((file) => repositoryUrlLiteral.test(fs.readFileSync(file, 'utf8')))
            .map((file) => path.relative(repoRoot, file));

        expect(offenders).toEqual([]);
    });
});
