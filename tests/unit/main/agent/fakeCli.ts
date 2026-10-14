/**
 * A fake agent CLI for tests: a small Node script installed as `agy` or `gemini` in a
 * temporary bin folder. The prompt picks its behaviour with `MODE:<name>`.
 *
 * Modes: text (default), partial, plan, badplan, auth, fail, hang, turbo (reports a permission
 * mode that runs tools without asking), noresult, apikey, silent (a command that ran and
 * printed nothing), blocked (a command headless mode
 * refused, as agy 1.3.5 reports it; the command is `$FAKE_BLOCKED_COMMAND` or `df -h`). It
 * writes its arguments, working directory, the workspace's entries, its input copies and
 * the allow rules in `$FAKE_HOME/.gemini/antigravity-cli/settings.json` to `$FAKE_ARGS_FILE`
 * when set (`$FAKE_SILENT_FIRST` adds a silent `true` that ran before it, `$FAKE_RAN_FIRST` a
 * `df -h /` that ran and printed, and `$FAKE_ACTIVE_ONLY` reports the refused step ACTIVE twice
 * and never DONE). `agy models` and
 * `agy -p /model` print a model list and the default model (`$FAKE_MODELS_HANG` makes them
 * hang, `$FAKE_MODELS_FAIL` makes `models` fail, `$FAKE_DEFAULT_MODEL` replaces the default
 * line) and append their arguments to `$FAKE_CALLS_FILE`.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const FAKE_CLI_SOURCE =
    String.raw`#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const isGemini = path.basename(process.argv[1]).startsWith('gemini');
if (args[0] === '--version') {
    process.stdout.write((isGemini ? '0.9.0' : 'agy 1.2.3') + '\n');
    process.exit(0);
}
if (process.env.FAKE_ARGS_FILE) {
    const listInputs = () => {
        try {
            return fs.readdirSync(path.join(process.cwd(), 'inputs')).flatMap((run) =>
                fs.readdirSync(path.join(process.cwd(), 'inputs', run)).map((name) => run + '/' + name)
            );
        } catch {
            return [];
        }
    };
    const readAllow = () => {
        try {
            const file = path.join(process.env.FAKE_HOME || '/nonexistent', '.gemini', 'antigravity-cli', 'settings.json');
            return JSON.parse(fs.readFileSync(file, 'utf8')).permissions.allow;
        } catch {
            return null;
        }
    };
    fs.writeFileSync(
        process.env.FAKE_ARGS_FILE,
        JSON.stringify({ args, cwd: process.cwd(), files: fs.readdirSync(process.cwd()).sort(), inputs: listInputs(), allow: readAllow() })
    );
}
if (args[0] === 'models' || (args[0] === '-p' && args[1] === '/model')) {
    if (process.env.FAKE_CALLS_FILE) {
        fs.appendFileSync(process.env.FAKE_CALLS_FILE, JSON.stringify(args) + '\n');
    }
    if (process.env.FAKE_MODELS_HANG) {
        setInterval(() => {}, 1000);
        return;
    }
    if (args[0] === 'models') {
        if (process.env.FAKE_MODELS_FAIL) {
            process.exit(2);
        }
        process.stdout.write('Fetching available models...\n');
        process.stdout.write('gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n');
        process.stdout.write('claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)\n');
    } else {
        process.stdout.write((process.env.FAKE_DEFAULT_MODEL || 'gemini-3.8-flash-high\tGemini 3.8 Flash (High)') + '\n');
    }
    process.exit(0);
}
const prompt = args[args.indexOf('-p') + 1] || '';
const mode = (prompt.match(/MODE:(\w+)/) || [])[1] || 'text';
const home = process.env.FAKE_HOME || '/nonexistent';
const out = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const plan = {
    summary: 'Sort the text file',
    actions: [
        { op: 'mkdir', to: home + '/Sorted' },
        { op: 'move', from: home + '/a.txt', to: home + '/Sorted/a.txt' },
        { op: 'trash', from: '/etc/passwd' },
    ],
};

if (mode === 'auth') {
    process.stderr.write('Error: authentication required. Run agy to sign in.\n');
    process.exit(1);
}
if (mode === 'apikey') {
    process.stderr.write('Please set an Auth method: GEMINI_API_KEY is not set\n');
    process.exit(41);
}
if (mode === 'fail') {
    process.stderr.write('line one\nsomething broke\n');
    process.exit(3);
}
if (mode === 'hang' || mode === 'turbo') {
    const init = mode === 'turbo' ? { permission_mode: 'always-proceed' } : { permission_mode: 'request-review' };
    out(isGemini ? { type: 'init', session_id: 's-hang' } : { event: 'init', conversation_id: 'c-hang', init });
    process.on('SIGINT', () => {
        if (!process.env.FAKE_IGNORE_SIGINT) process.exit(130);
    });
    setInterval(() => {
        if (process.env.FAKE_CHATTY || mode === 'turbo') {
            out({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'tick ' } });
        }
    }, 20);
    return;
}

if (isGemini) {
    out({ type: 'init', session_id: 's1', model: 'gemini-x' });
    out({ type: 'tool_use', tool_name: 'list_directory', tool_id: 't1', parameters: { dir_path: '/w' } });
    out({ type: 'tool_result', tool_id: 't1', status: 'success', output: 'x' });
    if (mode === 'plan') {
        out({ type: 'message', role: 'assistant', content: 'Here is the plan:\n` +
    '```json' +
    String.raw`\n' + JSON.stringify(plan) + '\n` +
    '```' +
    String.raw`\n', delta: true });
    } else {
        out({ type: 'message', role: 'assistant', content: 'Hello ', delta: true });
        out({ type: 'message', role: 'assistant', content: 'from Gemini', delta: true });
    }
    out({ type: 'result', status: 'success', stats: {} });
    process.exit(0);
}

out({ event: 'init', conversation_id: 'c1', init: { cwd: process.cwd(), permission_mode: 'request-review' } });
if (mode === 'partial') {
    const line = JSON.stringify({ event: 'step_update', step_update: { step_type: 'agent_response', state: 'ACTIVE', text_delta: 'Hel' } }) + '\n';
    process.stdout.write(line.slice(0, 20));
    setTimeout(() => {
        process.stdout.write(line.slice(20) + 'this is not json\n');
        out({ event: 'step_update', step_update: { step_type: 'agent_response', state: 'DONE', text_delta: 'lo' } });
        out({ event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: 'Hello' } });
    }, 50);
    return;
}
if (mode === 'plan' || mode === 'badplan') {
    out({ event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: JSON.stringify(plan), structured_output: mode === 'plan' ? plan : { nope: true } } });
    process.exit(0);
}
if (mode === 'blocked') {
    const command = process.env.FAKE_BLOCKED_COMMAND || 'df -h';
    const tool = (state, index, line) => ({ event: 'step_update', step_update: { conversation_id: 'c1', step_index: index, state, step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: line } } } });
    if (process.env.FAKE_SILENT_FIRST) {
        // A command that ran and printed nothing: agy 1.3.5 reports no output for it either.
        out(tool('ACTIVE', 2, 'true'));
        out(tool('DONE', 2, 'true'));
    }
    if (process.env.FAKE_RAN_FIRST) {
        // A command that ran and printed something.
        out(tool('ACTIVE', 1, 'df -h /'));
        const ran = tool('DONE', 1, 'df -h /');
        ran.step_update.tool_info.output = 'Filesystem Size Used Avail Use% Mounted on\r\n/dev/nvme0n1p6 400G 120G 280G 30% /\r\n';
        out(ran);
    }
    out(tool('ACTIVE', 3, command));
    if (process.env.FAKE_ACTIVE_ONLY) {
        // agy 1.3.5 refusing "cat /etc/fstab": the step is reported ACTIVE twice and never DONE.
        out(tool('ACTIVE', 3, command));
    } else {
        out(tool('DONE', 3, command));
    }
    process.stderr.write('jetski: no output produced - a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied.\n');
    out({ event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: '', duration_seconds: 4.4, num_turns: 1, usage: {}, denied_actions: [{ action: 'command', display_name: 'RunCommand' }] } });
    process.exit(0);
}
if (mode === 'silent') {
    // A command that ran and printed nothing, as agy 1.3.5 reports it: no output, no denied_actions.
    out({ event: 'step_update', step_update: { conversation_id: 'c1', step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'run_command', duration_seconds: 0.4, tool_info: { name: 'run_command', parameters: { CommandLine: 'true' } } } });
    out({ event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: 'done\n' } });
    process.exit(0);
}
if (mode === 'noresult') {
    out({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'only text' } });
    process.exit(0);
}
out({ event: 'step_update', step_update: { step_type: 'tool', state: 'ACTIVE', tool_info: { name: 'run_command', parameters: { command: 'ls -la' } } } });
out({ event: 'step_update', step_update: { step_type: 'tool', state: 'DONE', tool_info: { name: 'run_command', parameters: { command: 'ls -la' }, error: { type: 'PERMISSION_DENIED', message: 'Command needs approval' } } } });
out({ event: 'step_update', step_update: { step_type: 'agent_response', state: 'ACTIVE', text_delta: 'Hello ' } });
out({ event: 'future_event', data: 1 });
out({ event: 'step_update', step_update: { step_type: 'agent_response', state: 'DONE', text_delta: 'world' } });
out({ event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: 'Hello world', usage: {} } });
`;

export interface TempLayout {
    root: string;
    home: string;
    bin: string;
    userData: string;
    cleanup: () => void;
}

/** Create a temporary root with a home folder, a bin folder and a userData folder. */
export function createTempLayout(): TempLayout {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gd-agent-')));
    const home = path.join(root, 'home');
    const bin = path.join(root, 'bin');
    const userData = path.join(home, '.config', 'gemini-desktop');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(userData, { recursive: true });
    return { root, home, bin, userData, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** Install the fake CLI as `name` in `binDir`. */
export function installFakeCli(binDir: string, name: 'agy' | 'gemini'): string {
    const target = path.join(binDir, name);
    fs.writeFileSync(target, FAKE_CLI_SOURCE, { mode: 0o755 });
    return target;
}

/** PATH for the fake CLI: its bin folder and the folder of the running Node. */
export function fakePath(binDir: string): string {
    return [binDir, path.dirname(process.execPath)].join(path.delimiter);
}
