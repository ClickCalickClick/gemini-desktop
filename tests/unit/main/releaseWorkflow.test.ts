import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type Step = {
    name?: string;
    if?: string;
    uses?: string;
    run?: string;
    with?: Record<string, unknown>;
};

type Job = {
    needs?: string | string[];
    if?: string;
    permissions?: Record<string, string>;
    strategy?: { matrix?: { include?: Array<Record<string, string>> } };
    steps?: Step[];
};

type Workflow = {
    on: Record<string, unknown>;
    permissions?: Record<string, string>;
    jobs: Record<string, Job>;
};

type CompositeAction = {
    runs: { steps: Step[] };
};

type TargetConfig = string | { target: string };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const repoRoot = path.resolve(__dirname, '../../..');
const workflowsDir = path.join(repoRoot, '.github/workflows');

function readYaml<T>(relativePath: string): T {
    return parse(fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')) as T;
}

const release = readYaml<Workflow>('.github/workflows/release.yml');
const ci = readYaml<Workflow>('.github/workflows/ci.yml');
const linuxPackages = readYaml<CompositeAction>('.github/actions/linux-packages/action.yml');
const builderConfig = require(path.join(repoRoot, 'config/electron-builder.config.cjs')) as {
    mac?: { target?: TargetConfig[] };
};

function scripts(steps: Step[] = []): string {
    return steps.map((step) => step.run ?? '').join('\n');
}

function uploadedPaths(job: Job): string[] {
    return (job.steps ?? [])
        .filter((step) => step.uses?.startsWith('actions/upload-artifact@') && step.if !== 'failure()')
        .flatMap((step) => String(step.with?.path ?? '').split('\n'))
        .map((line) => line.trim())
        .filter(Boolean);
}

function needs(job: Job): string[] {
    return job.needs === undefined ? [] : ([] as string[]).concat(job.needs);
}

describe('release workflow', () => {
    it('runs on v* tags and stops when the tag does not match package.json', () => {
        expect((release.on.push as { tags: string[] }).tags).toEqual(['v*']);
        expect(scripts(release.jobs.verify.steps)).toContain(
            `expected="v$(node -p "require('./package.json').version")"`
        );
        expect(needs(release.jobs.linux)).toContain('verify');
        expect(needs(release.jobs.windows)).toContain('verify');
    });

    it('only ever creates a draft release, and only for a tag', () => {
        const publish = release.jobs.publish;

        expect(needs(publish)).toEqual(expect.arrayContaining(['linux', 'windows']));
        expect(publish.if).toBe("github.event_name == 'push' || inputs.tag != ''");
        expect(scripts(publish.steps)).toContain('gh release create "$TAG" dist/* --repo "$GITHUB_REPOSITORY" --draft');
        expect(scripts(publish.steps)).not.toContain('--draft=false');
    });

    it('gives write access to the publish job only', () => {
        expect(release.permissions).toEqual({});
        for (const [name, job] of Object.entries(release.jobs)) {
            expect(job.permissions, name).toEqual({ contents: name === 'publish' ? 'write' : 'read' });
        }
    });

    it('builds, tests and installs the Linux packages, then uploads every format', () => {
        const linuxScripts = scripts(linuxPackages.runs.steps);

        expect(release.jobs.linux.steps?.map((step) => step.uses)).toContain('./.github/actions/linux-packages');
        expect(linuxScripts).toContain('npm run dist:linux');
        expect(linuxScripts).toContain('npm run test:e2e:release');
        expect(linuxScripts).toContain('bash /scripts/check-arch-install.sh /pkgs');
        expect(uploadedPaths(release.jobs.linux)).toEqual([
            'release/*.AppImage',
            'release/*.deb',
            'release/*.rpm',
            'release/*.pacman',
            'release/*.tar.gz',
            'release/latest-linux.yml',
            'release/checksums-linux.txt',
        ]);
    });

    it('keeps the Windows update feeds and checksum files that installed apps and the docs use', () => {
        const windows = release.jobs.windows;
        const windowsScripts = scripts(windows.steps);
        const updateManagerSource = fs.readFileSync(path.join(repoRoot, 'src/main/managers/updateManager.ts'), 'utf8');

        expect(windows.strategy?.matrix?.include).toEqual([
            { arch: 'x64', checksums: 'checksums-windows.txt' },
            { arch: 'arm64', checksums: 'checksums-windows-arm64.txt' },
        ]);
        expect(windowsScripts).toContain('npm run dist:win-${{ matrix.arch }}');
        // The app asks for latest-x64.yml or latest-arm64.yml.
        expect(updateManagerSource).toContain(
            "updater.channel = process.arch === 'arm64' ? 'latest-arm64' : 'latest-x64';"
        );
        expect(windowsScripts).toContain(
            "Copy-Item -Path latest.yml -Destination 'latest-${{ matrix.arch }}.yml' -Force"
        );
        expect(windowsScripts).toContain("Copy-Item -Path latest.yml -Destination '${{ matrix.arch }}.yml' -Force");
        expect(windowsScripts).toContain(
            "if ('${{ matrix.arch }}' -eq 'arm64') { Remove-Item -Path latest.yml -Force }"
        );
        expect(uploadedPaths(windows)).toEqual([
            'release/*-installer.exe',
            'release/*-installer.exe.blockmap',
            'release/latest*.yml',
            'release/${{ matrix.arch }}.yml',
            'release/${{ matrix.checksums }}',
        ]);
    });

    it('launches the packaged and installed Windows app on x64, where the runner can run it', () => {
        const x64Steps = (release.jobs.windows.steps ?? []).filter((step) => step.if === "matrix.arch == 'x64'");

        expect(scripts(x64Steps)).toContain('npm run test:e2e:release');
        expect(scripts(x64Steps)).toContain(
            'npm run test:e2e:release:installer -- --spec=tests/e2e/release/windows-installer-smoke.spec.ts'
        );
    });
});

describe('CI workflow', () => {
    it('runs the checks and the Linux packages on pushes and pull requests to main', () => {
        expect(ci.on).toEqual(
            expect.objectContaining({ push: { branches: ['main'] }, pull_request: { branches: ['main'] } })
        );

        const checkScripts = scripts(ci.jobs.checks.steps);
        for (const command of ['npm run lint', 'npm run test', 'npm run test:electron', 'npm run test:coordinated']) {
            expect(checkScripts).toContain(command);
        }

        expect(ci.jobs.linux.steps?.map((step) => step.uses)).toContain('./.github/actions/linux-packages');
        expect(uploadedPaths(ci.jobs.linux)).toEqual(['release/*.AppImage', 'release/*.pacman']);
    });
});

describe('all workflows', () => {
    const files = [
        ...fs.readdirSync(workflowsDir).map((file) => `.github/workflows/${file}`),
        '.github/actions/linux-packages/action.yml',
    ];

    it('pin third-party actions to a full commit SHA', () => {
        for (const file of files) {
            const references = [...fs.readFileSync(path.join(repoRoot, file), 'utf8').matchAll(/uses:\s*(\S+)/g)];
            for (const [, reference] of references) {
                if (!reference.startsWith('./')) {
                    expect(reference, file).toMatch(/@[0-9a-f]{40}$/);
                }
            }
        }
    });

    it('take the Node.js version from .nvmrc', () => {
        for (const file of files) {
            const source = fs.readFileSync(path.join(repoRoot, file), 'utf8');
            expect(source, file).not.toMatch(/node-version:/);
        }
        expect(fs.readFileSync(path.join(repoRoot, '.nvmrc'), 'utf8').trim()).toMatch(/^\d+$/);
    });
});

describe('electron-builder macOS release artifacts', () => {
    it('builds macOS ZIP artifacts for update metadata', () => {
        const macTargetNames =
            builderConfig.mac?.target?.map((target) => (typeof target === 'string' ? target : target.target)) ?? [];

        expect(macTargetNames).toContain('dmg');
        expect(macTargetNames).toContain('zip');
    });
});
