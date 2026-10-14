/**
 * Unit tests for the command allow rules the app writes to Antigravity CLI's settings,
 * and for the read-only command list. Only temporary folders are used.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    AgentPermissionsError,
    hasShellSyntax,
    isDeniedPrefix,
    isSafeLastingPrefix,
    lastingRuleFor,
    PermissionTracker,
    readAllowRules,
    refuseAllowRule,
    updateAllowRules,
} from '../../../../src/main/agent/agentPermissions';
import { findRiskySettings } from '../../../../src/main/agent/workspace';
import {
    commandRule,
    READ_ONLY_COMMAND_GROUPS,
    READ_ONLY_COMMAND_PREFIXES,
    READ_ONLY_COMMAND_RULES,
} from '../../../../src/shared/constants/agentReadOnlyCommands';
import { createTempLayout, type TempLayout } from './fakeCli';

describe('agentPermissions', () => {
    let layout: TempLayout;
    let settingsFile: string;

    beforeEach(() => {
        layout = createTempLayout();
        settingsFile = path.join(layout.home, '.gemini', 'antigravity-cli', 'settings.json');
    });

    afterEach(() => {
        layout.cleanup();
    });

    const writeSettings = (content: string, mode = 0o644) => {
        fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
        fs.writeFileSync(settingsFile, content, { mode });
        fs.chmodSync(settingsFile, mode);
    };
    const readSettings = () => JSON.parse(fs.readFileSync(settingsFile, 'utf8'));

    describe('refuseAllowRule', () => {
        it('accepts specific command rules, full lines with spaces included', () => {
            for (const rule of [
                'command(df)',
                'command(systemctl status)',
                'command(df -h /home)',
                'command(du -sh ~/Downloads)',
                'command(echo $(date))',
                'command(ls *.txt)',
            ]) {
                expect(refuseAllowRule(rule)).toBeNull();
            }
        });

        it('refuses everything else', () => {
            for (const rule of [
                'command()',
                'command(   )',
                'command( df)',
                'command(*)',
                'command(regex:.*)',
                'command(REGEX:rm)',
                'command(df\nrm -rf ~)',
                'command(df) ',
                'command(df))',
                'command(echo ) (x)',
                'command(a(b)',
                'write_file(*)',
                'unsandboxed(df)',
                'mcp(server)',
                'df',
                `command(${'x'.repeat(2001)})`,
            ]) {
                expect(refuseAllowRule(rule)).not.toBeNull();
            }
        });
    });

    describe('updateAllowRules', () => {
        it('creates a missing file with the rules, readable only by the user', () => {
            const change = updateAllowRules(settingsFile, { add: ['command(df)', 'command(df)', 'command(free)'] });
            expect(change).toEqual({ added: ['command(df)', 'command(free)'], removed: [] });
            expect(readSettings()).toEqual({ permissions: { allow: ['command(df)', 'command(free)'] } });
            expect(fs.statSync(settingsFile).mode & 0o777).toBe(0o600);
            expect(fs.readFileSync(settingsFile, 'utf8')).toBe(
                '{\n  "permissions": {\n    "allow": [\n      "command(df)",\n      "command(free)"\n    ]\n  }\n}\n'
            );
        });

        it('keeps every other key, the deny and ask lists, and entries it does not know', () => {
            writeSettings(
                JSON.stringify({
                    model: 'gemini-x',
                    ui: { theme: 'dark' },
                    permissions: {
                        allow: ['command(ls)', { odd: true }, 'command(df)'],
                        deny: ['command(rm)'],
                        ask: ['command(git push)'],
                        preset: 'request-review',
                    },
                }),
                0o640
            );
            const change = updateAllowRules(settingsFile, {
                add: ['command(df)', 'command(free)'],
                remove: ['command(git push)', 'command(nope)'],
            });
            expect(change).toEqual({ added: ['command(free)'], removed: [] });
            expect(readSettings()).toEqual({
                model: 'gemini-x',
                ui: { theme: 'dark' },
                permissions: {
                    allow: ['command(ls)', { odd: true }, 'command(df)', 'command(free)'],
                    deny: ['command(rm)'],
                    ask: ['command(git push)'],
                    preset: 'request-review',
                },
            });
            // The file mode is kept and no temporary file is left behind.
            expect(fs.statSync(settingsFile).mode & 0o777).toBe(0o640);
            expect(fs.readdirSync(path.dirname(settingsFile))).toEqual(['settings.json']);
        });

        it('removes only the rules it is asked to remove', () => {
            writeSettings(JSON.stringify({ permissions: { allow: ['command(ls)', 'command(df)', 'command(free)'] } }));
            expect(updateAllowRules(settingsFile, { remove: ['command(df)'] })).toEqual({
                added: [],
                removed: ['command(df)'],
            });
            expect(readAllowRules(settingsFile)).toEqual(['command(ls)', 'command(free)']);
        });

        it('does not write when nothing changes', () => {
            writeSettings('{"permissions":{"allow":["command(df)"]}}');
            const before = fs.statSync(settingsFile).mtimeMs;
            const inode = fs.statSync(settingsFile).ino;
            expect(updateAllowRules(settingsFile, { add: ['command(df)'] })).toEqual({ added: [], removed: [] });
            expect(fs.readFileSync(settingsFile, 'utf8')).toBe('{"permissions":{"allow":["command(df)"]}}');
            expect(fs.statSync(settingsFile).ino).toBe(inode);
            expect(fs.statSync(settingsFile).mtimeMs).toBe(before);
        });

        it('replaces the file atomically (a new file renamed over the old one)', () => {
            writeSettings('{}');
            const inode = fs.statSync(settingsFile).ino;
            updateAllowRules(settingsFile, { add: ['command(df)'] });
            expect(fs.statSync(settingsFile).ino).not.toBe(inode);
        });

        it('follows a symbolic link to the settings file and keeps the link', () => {
            const real = path.join(layout.root, 'dotfiles', 'settings.json');
            fs.mkdirSync(path.dirname(real), { recursive: true });
            fs.writeFileSync(real, '{"keep":1}');
            fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
            fs.symlinkSync(real, settingsFile);
            updateAllowRules(settingsFile, { add: ['command(df)'] });
            expect(fs.lstatSync(settingsFile).isSymbolicLink()).toBe(true);
            expect(JSON.parse(fs.readFileSync(real, 'utf8'))).toEqual({
                keep: 1,
                permissions: { allow: ['command(df)'] },
            });
        });

        it('refuses a file that is not valid JSON and leaves it unchanged', () => {
            for (const content of ['{ "permissions": { // comment\n } }', '{"a":', '[1, 2]', '"text"']) {
                writeSettings(content);
                expect(() => updateAllowRules(settingsFile, { add: ['command(df)'] })).toThrow(AgentPermissionsError);
                expect(() => readAllowRules(settingsFile)).toThrow(AgentPermissionsError);
                expect(fs.readFileSync(settingsFile, 'utf8')).toBe(content);
            }
            writeSettings('{"permissions": "all"}');
            expect(() => updateAllowRules(settingsFile, { add: ['command(df)'] })).toThrow('not an object');
            writeSettings('{"permissions": {"allow": "command(df)"}}');
            expect(() => updateAllowRules(settingsFile, { add: ['command(df)'] })).toThrow('not a list');
        });

        it('treats an empty file as empty settings', () => {
            writeSettings('  \n');
            updateAllowRules(settingsFile, { add: ['command(df)'] });
            expect(readSettings()).toEqual({ permissions: { allow: ['command(df)'] } });
        });

        it('refuses rules the app must never write, before touching the file', () => {
            writeSettings('{}');
            for (const rule of ['command(*)', 'command(regex:.*)', 'write_file(/)', 'command(a\nb)', 'command(a))']) {
                expect(() => updateAllowRules(settingsFile, { add: ['command(df)', rule] })).toThrow(
                    AgentPermissionsError
                );
            }
            expect(fs.readFileSync(settingsFile, 'utf8')).toBe('{}');
        });

        it('writes rules the engine safety check accepts, full lines included', async () => {
            updateAllowRules(settingsFile, {
                add: ['command(df -h /home)', 'command(du -sh ~/Downloads)', 'command(echo $(date))', 'command(df)'],
            });
            expect(await findRiskySettings('antigravity', [settingsFile])).toEqual([]);
        });
    });

    describe('lasting rules', () => {
        it('offers the read-only list entry or the first word for safe commands', () => {
            expect(lastingRuleFor('df -h')).toBe('command(df)');
            expect(lastingRuleFor('  lsblk -f ')).toBe('command(lsblk)');
            expect(lastingRuleFor('systemctl status sshd')).toBe('command(systemctl status)');
            expect(lastingRuleFor('systemctl --user status pipewire')).toBe('command(systemctl --user status)');
            expect(lastingRuleFor('ip -br addr show')).toBe('command(ip -br addr show)');
            expect(lastingRuleFor('git status --short')).toBe('command(git status)');
            expect(lastingRuleFor('python3 --version')).toBe('command(python3 --version)');
            expect(lastingRuleFor('pacman -Qi linux')).toBe('command(pacman -Qi)');
            // Not in the list and not a state-changing command.
            expect(lastingRuleFor('dmidecode-like-tool --summary')).toBe('command(dmidecode-like-tool)');
        });

        it('offers nothing for state-changing commands, readers, shells and shell syntax', () => {
            for (const command of [
                'rm -rf ~/x',
                'sudo df',
                'systemctl restart sshd',
                'systemctl --failed restart sshd',
                'systemctl',
                'mkfs.ext4 /dev/sda1',
                'python3 -c "print(1)"',
                'python3.12 script.py',
                'pip3 install x',
                'git push',
                'git',
                'gsettings set org.gnome.x y z',
                'nmcli general hostname evil',
                'ip addr add 10.0.0.1 dev eth0',
                'swapon /swapfile',
                'sysctl -w vm.swappiness=10',
                'cat /etc/os-release',
                'cat /proc/cpuinfo',
                'grep -r password ~',
                'find / -delete',
                'sed -i s/a/b/ f',
                'curl https://example.com',
                'env',
                'date -s 2020-01-01',
                'journalctl --vacuum-size=1M',
                'df -h | grep sda',
                'df -h; rm -rf ~',
                'du -sh $(pwd)',
                'echo `id`',
                'ls *.txt',
                'df > out.txt',
                'du -sh "My Files"',
                '/usr/bin/df -h',
                './script',
                'neofetch',
                '',
            ]) {
                expect(lastingRuleFor(command)).toBeUndefined();
            }
        });

        it('treats a read-only subcommand of a denied command as allowed only when it matches exactly', () => {
            expect(isDeniedPrefix('systemctl status')).toBe(false);
            expect(isDeniedPrefix('systemctl')).toBe(true);
            expect(isDeniedPrefix('systemctl stop')).toBe(true);
            expect(isDeniedPrefix('mkfs.btrfs')).toBe(true);
            expect(isDeniedPrefix('df')).toBe(false);
            expect(isSafeLastingPrefix('top')).toBe(false);
            expect(isSafeLastingPrefix('top -b')).toBe(true);
            expect(isSafeLastingPrefix('df -h')).toBe(false);
            expect(hasShellSyntax('df -h')).toBe(false);
            expect(hasShellSyntax('df -h && ls')).toBe(true);
        });
    });

    describe('read-only command list', () => {
        it('has no duplicates and no empty groups', () => {
            expect(new Set(READ_ONLY_COMMAND_PREFIXES).size).toBe(READ_ONLY_COMMAND_PREFIXES.length);
            expect(READ_ONLY_COMMAND_RULES).toEqual(READ_ONLY_COMMAND_PREFIXES.map(commandRule));
            for (const group of READ_ONLY_COMMAND_GROUPS) {
                expect(group.prefixes.length).toBeGreaterThan(0);
            }
        });

        it.each(READ_ONLY_COMMAND_PREFIXES.map((prefix) => [prefix]))(
            '%s passes the denylist and is a rule the app may write',
            (prefix) => {
                expect(prefix).toBe(prefix.trim());
                expect(hasShellSyntax(prefix)).toBe(false);
                expect(isDeniedPrefix(prefix)).toBe(false);
                expect(isSafeLastingPrefix(prefix)).toBe(true);
                expect(refuseAllowRule(commandRule(prefix))).toBeNull();
                const words = prefix.split(' ');
                if (words.length > 1) {
                    // A tool that needs a subcommand rule is one the denylist knows about.
                    expect(isDeniedPrefix(words[0] ?? '')).toBe(true);
                } else {
                    // A single word never has state-changing subcommands in the list.
                    expect(READ_ONLY_COMMAND_PREFIXES.some((other) => other.startsWith(`${prefix} `))).toBe(false);
                }
            }
        );

        it('leaves out file readers, environment dumps, find, journalctl, date and hostname', () => {
            for (const word of [
                'cat',
                'head',
                'tail',
                'less',
                'grep',
                'env',
                'printenv',
                'set',
                'find',
                'journalctl',
                'date',
                'hostname',
                'ping',
                'curl',
                'dig',
            ]) {
                expect(READ_ONLY_COMMAND_PREFIXES.some((prefix) => prefix.split(' ')[0] === word)).toBe(false);
            }
        });

        it('passes the engine safety check as a whole', async () => {
            updateAllowRules(settingsFile, { add: [...READ_ONLY_COMMAND_RULES] });
            expect(readAllowRules(settingsFile)).toEqual(READ_ONLY_COMMAND_RULES);
            expect(await findRiskySettings('antigravity', [settingsFile])).toEqual([]);
        });
    });

    describe('PermissionTracker', () => {
        it('reads an empty record from a missing or broken file and writes it back', () => {
            const file = path.join(layout.userData, 'agent-permissions.json');
            const tracker = new PermissionTracker(() => file);
            expect(tracker.read()).toEqual({ lasting: [], readOnly: [], readOnlyEnabled: false, pending: [] });
            fs.writeFileSync(file, 'not json');
            expect(tracker.read().pending).toEqual([]);
            fs.writeFileSync(file, JSON.stringify({ lasting: ['command(df)', 3], pending: 'x', readOnlyEnabled: 1 }));
            expect(tracker.read()).toEqual({
                lasting: ['command(df)'],
                readOnly: [],
                readOnlyEnabled: false,
                pending: [],
            });
            tracker.update((record) => ({ ...record, pending: ['command(df -h)'] }));
            expect(tracker.read().pending).toEqual(['command(df -h)']);
            expect(fs.statSync(file).mode & 0o777).toBe(0o600);
        });
    });
});
