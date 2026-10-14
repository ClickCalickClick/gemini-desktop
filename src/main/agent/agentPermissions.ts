/**
 * Command allow rules the app writes to Antigravity CLI's settings.
 *
 * Antigravity CLI has no per-run permission flag: its rules live only in the global
 * `~/.gemini/antigravity-cli/settings.json` (`permissions.allow|deny|ask`). In headless
 * mode a terminal command without an allow rule is soft-denied, so the agent cannot
 * answer "how much disk space is left?". After an explicit user action (the approval
 * card in Quick Chat, or the lookup command list in Options) the app adds specific
 * `command(...)` allow rules there, and nothing else:
 *
 * - Only plain `command(<target>)` rules with a specific target are written: never
 *   `command(*)`, `regex:` rules, other actions, or the deny and ask lists, and never a
 *   target with control or invisible formatting characters.
 * - What each rule means: Antigravity matches a rule word by word against the start of
 *   each command in a line, so even a full-line rule also allows that line with more
 *   arguments or with its output redirected, and transparent wrappers (`env`, `nice`,
 *   `timeout`, `nohup`) are looked through, so `env LD_PRELOAD=./x.so df` matches
 *   `command(df)`. There is no documented exact-match rule. Every rule therefore lets
 *   the agent run code inside the sandbox; the lists only make accidents less likely.
 * - The app records which rules it wants and why (lasting "Always allow" rules, the
 *   lookup list, pending "Allow for this answer" rules) in its own state file, and
 *   removes a rule from the settings file only when no reason to keep it is left. Rules
 *   that were in the file before the app wanted them are recorded as the user's own and
 *   are never removed.
 * - Temporary rules are recorded as pending before they are written, so they are
 *   removed on the next start if the app stopped before removing them.
 * - The file keeps its other keys and its indentation. The result is written to a
 *   temporary file in the same folder and renamed over the original (keeping its mode,
 *   following a symbolic link). A file that is not valid JSON, or a link to a missing
 *   file, is never written. If the file changes while the app writes it (an interactive
 *   `agy` saving a rule, for example), the app reads it again and retries once; a change
 *   in the last moments before the rename can still be lost.
 *
 * Allowed commands run inside Antigravity's sandbox (`--sandbox`, Linux namespaces or
 * macOS `sandbox-exec`): per its docs they can write the workspace, temporary folders
 * and common build caches, read system folders such as `/usr` and `/etc`, cannot see
 * `~/.ssh`, `.env` files or anything not mounted (home folders included), and have no
 * network. The docs say nothing about Windows, so the app writes no rules there.
 *
 * Writes are synchronous: the files are small, and it keeps read-modify-write cycles
 * from interleaving.
 *
 * @module agent/agentPermissions
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { commandRule, LOOKUP_COMMAND_PREFIXES } from '../../shared/constants/agentLookupCommands';
import { isObject, type JsonObject } from './json';

/** A settings problem the user has to fix; its message is fit for the UI. */
export class AgentPermissionsError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'AgentPermissionsError';
    }
}

// =========================================================================
// Rules
// =========================================================================

/** Longest command line the app writes as a rule. */
export const MAX_RULE_TARGET_LENGTH = 2000;

/**
 * Characters that make a line more than one plain command: pipes, chains, redirection,
 * substitution, quoting, globbing, brace and history expansion, comments.
 */
const SHELL_METACHARACTERS = /[|&;<>()$`\\"'*?[\]{}!#\r\n]/;

/**
 * Control characters, invisible formatting characters (bidi overrides, zero-width spaces)
 * and spaces other than the plain one, which look like a space but are not one to a shell.
 */
const INVISIBLE_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/u;

/** True for a plain program name (no path, no shell syntax). */
function isPlainCommandName(word: string): boolean {
    return /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(word);
}

function tokenize(commandLine: string): string[] {
    return commandLine
        .trim()
        .split(/\s+/)
        .filter((word) => word.length > 0);
}

/** True when a command line uses shell syntax beyond one plain command. */
export function hasShellSyntax(commandLine: string): boolean {
    return SHELL_METACHARACTERS.test(commandLine);
}

/**
 * True when a command line holds control or invisible formatting characters, which
 * would make the line shown to the user differ from the rule that is written.
 */
export function hasInvisibleCharacters(commandLine: string): boolean {
    return INVISIBLE_CHARACTERS.test(commandLine);
}

/** True when the parentheses in a rule target are balanced, so `)` cannot end the rule early. */
function hasBalancedParentheses(text: string): boolean {
    let depth = 0;
    for (const char of text) {
        if (char === '(') {
            depth++;
        } else if (char === ')') {
            depth--;
            if (depth < 0) {
                return false;
            }
        }
    }
    return depth === 0;
}

/**
 * Why a rule must not be written, or null when it is a plain `command(...)` rule with a
 * specific target. Refused: other actions, an empty target, `*`, `regex:` targets,
 * control and invisible formatting characters (line breaks included) and an unbalanced
 * `)`. How Antigravity reads a target that contains a balanced `)` is not documented.
 */
export function refuseAllowRule(rule: string): string | null {
    const match = /^command\((.*)\)$/s.exec(rule);
    if (!match) {
        return 'Only command(...) rules can be added.';
    }
    const target = match[1] ?? '';
    if (target.trim().length === 0 || target !== target.trim()) {
        return 'The command is empty or has spaces around it.';
    }
    if (target.length > MAX_RULE_TARGET_LENGTH) {
        return 'The command is too long.';
    }
    if (hasInvisibleCharacters(target)) {
        return 'The command contains control or invisible characters, so what you see may not be what would run.';
    }
    if (target === '*' || /^regex:/i.test(target)) {
        return 'A rule for every command is never added.';
    }
    if (!hasBalancedParentheses(target)) {
        return 'The command has an unbalanced parenthesis.';
    }
    return null;
}

/**
 * Commands that change things (files, packages, services, users, the desktop session,
 * the network or the machine), run other code, or read files' contents. The approval
 * card warns about them, and they never get a lasting rule. The listed subcommands are
 * the exceptions the lookup list uses; a prefix matches one when the words after the
 * command are exactly that subcommand. The list cannot be complete, so lasting rules are
 * only ever offered for entries of the lookup list.
 */
const DENIED_COMMANDS: Readonly<Record<string, readonly string[]>> = {
    // Files
    rm: [],
    rmdir: [],
    unlink: [],
    mv: [],
    cp: [],
    dd: [],
    ln: [],
    install: [],
    touch: [],
    mkdir: [],
    chmod: [],
    chown: [],
    chgrp: [],
    chattr: [],
    setfacl: [],
    setcap: [],
    truncate: [],
    shred: [],
    tee: [],
    split: [],
    patch: [],
    tar: [],
    zip: [],
    unzip: [],
    gzip: [],
    gunzip: [],
    xz: [],
    zstd: [],
    '7z': [],
    sed: [],
    awk: [],
    gawk: [],
    find: [],
    xargs: [],
    // File contents and the environment (secrets)
    cat: [],
    head: [],
    tail: [],
    less: [],
    more: [],
    grep: [],
    egrep: [],
    fgrep: [],
    rg: [],
    strings: [],
    xxd: [],
    od: [],
    hexdump: [],
    base64: [],
    diff: [],
    cmp: [],
    sort: [],
    uniq: [],
    cut: [],
    jq: [],
    env: [],
    printenv: [],
    set: [],
    export: [],
    // System summaries that write their own config file on first run
    neofetch: [],
    fastfetch: [],
    // Editors and openers
    vi: [],
    vim: [],
    nvim: [],
    nano: [],
    emacs: [],
    code: [],
    open: [],
    'xdg-open': [],
    gio: [],
    // Privileges, users and the machine
    sudo: [],
    su: [],
    doas: [],
    pkexec: [],
    run0: [],
    passwd: [],
    chsh: [],
    useradd: [],
    userdel: [],
    usermod: [],
    shutdown: [],
    reboot: [],
    poweroff: [],
    halt: [],
    kill: [],
    pkill: [],
    killall: [],
    renice: [],
    ionice: [],
    taskset: [],
    chrt: [],
    nohup: [],
    nice: [],
    timeout: [],
    watch: [],
    strace: [],
    gdb: [],
    script: [],
    busybox: [],
    crontab: [],
    at: [],
    'systemd-run': [],
    machinectl: [],
    mount: [],
    umount: [],
    swapoff: [],
    swapon: ['--show'],
    sysctl: [],
    modprobe: [],
    insmod: [],
    rmmod: [],
    hwclock: [],
    date: [],
    hostname: [],
    journalctl: [],
    parted: [],
    fdisk: [],
    sfdisk: [],
    wipefs: [],
    cryptsetup: [],
    efibootmgr: [],
    // Services, sessions and system settings
    systemctl: [
        'status',
        'list-units',
        'list-unit-files',
        'list-timers',
        'is-active',
        'is-enabled',
        'is-failed',
        '--user status',
        '--user list-units',
        '--user list-timers',
        '--user is-active',
    ],
    service: [],
    loginctl: ['list-sessions', 'session-status'],
    hostnamectl: ['status'],
    timedatectl: ['status'],
    localectl: ['status'],
    'systemd-analyze': ['time', 'blame'],
    gsettings: ['get', 'list-recursively'],
    dconf: [],
    'gnome-extensions': ['list', 'info'],
    'gnome-shell': ['--version'],
    plasmashell: ['--version'],
    'xdg-mime': ['query'],
    pactl: ['info', 'list'],
    wpctl: ['status', 'inspect', 'get-volume'],
    bluetoothctl: ['show', 'devices', 'info'],
    upower: ['-e', '-i', '--dump'],
    powerprofilesctl: ['get', 'list'],
    brightnessctl: ['info', 'get'],
    'nvidia-smi': ['-L', '-q'],
    fwupdmgr: ['get-devices'],
    top: ['-b', '-l'],
    // Network
    ip: ['addr show', '-br addr show', 'route show', 'link show', '-br link show'],
    ss: [],
    nmcli: ['general status', 'device status', 'connection show'],
    networkctl: ['status', 'list'],
    resolvectl: ['status'],
    ifconfig: [],
    iptables: [],
    nft: [],
    ufw: [],
    'firewall-cmd': [],
    curl: [],
    wget: [],
    ssh: [],
    scp: [],
    sftp: [],
    rsync: [],
    nc: [],
    ncat: [],
    socat: [],
    telnet: [],
    ftp: [],
    // Packages
    pacman: ['-Q', '-Qi', '-Qs', '-Qe'],
    yay: [],
    paru: [],
    makepkg: [],
    apt: ['list --installed'],
    'apt-get': [],
    aptitude: [],
    dpkg: ['-l', '-s'],
    'dpkg-query': ['-W'],
    dnf: [],
    yum: [],
    rpm: ['-qa', '-qi'],
    zypper: [],
    flatpak: ['list', 'info'],
    snap: ['list'],
    brew: ['list'],
    port: [],
    nix: [],
    'nix-env': [],
    npm: [],
    npx: [],
    pnpm: [],
    yarn: [],
    bun: [],
    deno: [],
    gem: [],
    cargo: ['--version'],
    go: ['version'],
    // Shells, interpreters and build tools (they run any code)
    sh: [],
    bash: [],
    zsh: [],
    fish: [],
    dash: [],
    ksh: [],
    csh: [],
    tcsh: [],
    pwsh: [],
    powershell: [],
    cmd: [],
    eval: [],
    exec: [],
    source: [],
    python: [],
    python3: ['--version'],
    node: ['--version'],
    nodejs: [],
    perl: [],
    ruby: [],
    php: [],
    lua: [],
    osascript: [],
    make: [],
    cmake: [],
    gcc: ['--version'],
    'g++': [],
    cc: [],
    clang: [],
    rustc: ['--version'],
    // Version control and containers
    git: [],
    hg: [],
    svn: [],
    docker: [],
    podman: [],
    kubectl: [],
    virsh: [],
    // macOS
    diskutil: ['list', 'info', 'apfs list'],
    pmset: ['-g'],
    scutil: ['--get'],
    csrutil: ['status'],
    launchctl: ['list'],
    networksetup: ['-listallhardwareports'],
    defaults: [],
    tmutil: [],
    nvram: [],
    spctl: [],
    // Desktop sessions, input, clipboard, printing and mail
    xrandr: [],
    xset: [],
    xinput: [],
    rfkill: [],
    iwctl: [],
    wpa_cli: [],
    busctl: [],
    gdbus: [],
    'dbus-send': [],
    qdbus: [],
    'gnome-session-quit': [],
    hyprctl: [],
    swaymsg: [],
    'i3-msg': [],
    xdotool: [],
    ydotool: [],
    wtype: [],
    'wl-copy': [],
    'wl-paste': [],
    xclip: [],
    xsel: [],
    playerctl: [],
    fuser: [],
    'ssh-keygen': [],
    gpg: [],
    lp: [],
    lpr: [],
    mail: [],
    mailx: [],
    sendmail: [],
    msmtp: [],
    'xdg-email': [],
    // More file writers, runtimes and network tools
    fallocate: [],
    mkfifo: [],
    mknod: [],
    exiftool: [],
    convert: [],
    magick: [],
    ffmpeg: [],
    sqlite3: [],
    openssl: [],
    pandoc: [],
    trash: [],
    'trash-put': [],
    rename: [],
    mawk: [],
    nawk: [],
    java: [],
    dotnet: [],
    R: [],
    Rscript: [],
    julia: [],
    tclsh: [],
    uv: [],
    uvx: [],
    pipx: [],
    poetry: [],
    conda: [],
    screen: [],
    tmux: [],
    expect: [],
    toybox: [],
    bwrap: [],
    unshare: [],
    dig: [],
    nslookup: [],
    host: [],
    http: [],
    xh: [],
    aria2c: [],
    // Windows
    ipconfig: ['/all'],
    reg: [],
    sc: [],
    taskkill: [],
};

/** Families of commands denied by name: file system makers and interpreter versions. */
const DENIED_COMMAND_PATTERNS = [/^mkfs/, /^python/, /^pip/, /^perl/, /^ruby/, /^php/, /^lua/, /^node/, /^qemu/];

/** True when a prefix names a state-changing command and is not one of its listed subcommands. */
export function isDeniedPrefix(prefix: string): boolean {
    const [first = '', ...rest] = tokenize(prefix);
    const command = first.toLowerCase();
    const exceptions = Object.prototype.hasOwnProperty.call(DENIED_COMMANDS, command)
        ? DENIED_COMMANDS[command]
        : DENIED_COMMAND_PATTERNS.some((pattern) => pattern.test(command))
          ? []
          : undefined;
    if (exceptions === undefined) {
        return false;
    }
    return !exceptions.includes(rest.join(' '));
}

/**
 * True when a prefix may become a lasting allow rule: it is an entry of the lookup list
 * (and, as a second check, not a state-changing command). Anything else is only allowed
 * for one answer.
 */
export function isSafeLastingPrefix(prefix: string): boolean {
    const words = tokenize(prefix);
    if (words.length === 0 || hasShellSyntax(prefix) || hasInvisibleCharacters(prefix)) {
        return false;
    }
    return LOOKUP_COMMAND_PREFIXES.includes(words.join(' ')) && !isDeniedPrefix(prefix);
}

/**
 * The lasting rule "Always allow" offers for a blocked command, or undefined when it may
 * only be allowed for one answer: the longest lookup list entry the command starts with
 * (`systemctl status` for `systemctl status sshd`, `df` for `df -h`).
 */
export function lastingRuleFor(commandLine: string): string | undefined {
    if (hasShellSyntax(commandLine) || hasInvisibleCharacters(commandLine)) {
        return undefined;
    }
    const words = tokenize(commandLine);
    if (words.length === 0) {
        return undefined;
    }
    let best: string | undefined;
    let bestLength = 0;
    for (const candidate of LOOKUP_COMMAND_PREFIXES) {
        const candidateWords = tokenize(candidate);
        if (candidateWords.length > bestLength && candidateWords.every((word, index) => words[index] === word)) {
            best = candidate;
            bestLength = candidateWords.length;
        }
    }
    return best && isSafeLastingPrefix(best) ? commandRule(best) : undefined;
}

/**
 * Denied commands that only read (files, pipes, the environment): not allowed for good,
 * but no reason for the "can change or delete things" warning.
 */
const READING_COMMANDS = new Set([
    'cat',
    'head',
    'tail',
    'less',
    'more',
    'grep',
    'egrep',
    'fgrep',
    'rg',
    'strings',
    'xxd',
    'od',
    'hexdump',
    'base64',
    'diff',
    'cmp',
    'sort',
    'uniq',
    'cut',
    'jq',
    'env',
    'printenv',
    'journalctl',
    'date',
    'hostname',
]);

/**
 * Shell keywords and wrappers that run the word after them as the command (`if rm x`,
 * `do rm $f`, `command rm`, `env rm`, `nice -n 5 rm`, `timeout 5 rm`). Their options and
 * numeric arguments are skipped too.
 */
const COMMAND_PREFIX_WORDS = new Set([
    'if',
    'then',
    'else',
    'elif',
    'do',
    'while',
    'until',
    '!',
    '{',
    'command',
    'builtin',
    'exec',
    'time',
    'coproc',
    'env',
    'nice',
    'nohup',
    'timeout',
    'stdbuf',
    'ionice',
    'xargs',
    'setsid',
    'chroot',
    'trap',
]);

/** The word a part of a command line runs, past assignments, keywords and wrappers. */
function commandWordOf(words: string[]): string | undefined {
    let afterWrapper = false;
    for (const word of words) {
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
            continue;
        }
        if (COMMAND_PREFIX_WORDS.has(word)) {
            afterWrapper = true;
            continue;
        }
        // A wrapper's options and arguments (`-n 5`, `5s`).
        if (afterWrapper && (word.startsWith('-') || /^\d+(\.\d+)?[smhd]?$/.test(word))) {
            continue;
        }
        return word;
    }
    return undefined;
}

/**
 * True when any command in a line can change or delete things: the word it runs (in each
 * part of a pipeline or chain, past shell keywords and wrappers, and after a path) is a
 * state-changing command, the line redirects output into a file, or it substitutes a
 * command.
 */
export function needsCaution(commandLine: string): boolean {
    // Command substitution can run anything.
    if (/\$\(|`/.test(commandLine)) {
        return true;
    }
    if (/(^|[^0-9&])>{1,2}\s*[^\s&]/.test(commandLine.replace(/\d?>\s*\/dev\/null/g, ''))) {
        return true;
    }
    return commandLine
        .split(/\|\||&&|[|;&\n]/)
        .map((part) => tokenize(part))
        .some((words) => {
            const first = commandWordOf(words);
            if (!first) {
                return false;
            }
            // A command on the lookup list (`systemctl status x`, `ip -br addr show`) only looks.
            if (lastingRuleFor(words.slice(words.indexOf(first)).join(' '))) {
                return false;
            }
            const name = first.split('/').pop() ?? first;
            if (!isPlainCommandName(name)) {
                return true;
            }
            if (isDeniedPrefix(name) && !READING_COMMANDS.has(name)) {
                return true;
            }
            // Wrappers this list does not know (`setsid rm`, `flock /tmp/l rm`): any later
            // word that names a state-changing command.
            return words
                .slice(words.indexOf(first) + 1)
                .some((word) => isPlainCommandName(word) && isDeniedPrefix(word) && !READING_COMMANDS.has(word));
        });
}

// =========================================================================
// Settings file
// =========================================================================

function readText(file: string): string | null {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return null;
        }
        throw new AgentPermissionsError(`Could not read ${file}.`);
    }
}

/** Parse the settings file: missing → `{}`; anything but a JSON object → refused. */
function parseSettings(file: string, text: string | null): JsonObject {
    if (text === null || text.trim() === '') {
        return {};
    }
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        throw new AgentPermissionsError(
            `${file} is not valid JSON (comments are not supported either), so the app will not change it. Fix the file and try again.`
        );
    }
    if (!isObject(value)) {
        throw new AgentPermissionsError(`${file} does not hold a JSON object, so the app will not change it.`);
    }
    return value;
}

function allowList(file: string, settings: JsonObject): string[] {
    const permissions = settings.permissions;
    if (permissions === undefined) {
        return [];
    }
    if (!isObject(permissions)) {
        throw new AgentPermissionsError(`"permissions" in ${file} is not an object, so the app will not change it.`);
    }
    const allow = permissions.allow;
    if (allow === undefined) {
        return [];
    }
    if (!Array.isArray(allow)) {
        throw new AgentPermissionsError(`"permissions.allow" in ${file} is not a list, so the app will not change it.`);
    }
    return allow.filter((rule): rule is string => typeof rule === 'string');
}

/**
 * The file to read and write: the target of a symbolic link, or the path itself when it
 * does not exist yet. A link to a missing file is refused rather than replaced by a file.
 */
function resolveTarget(file: string): string {
    let isLink = false;
    try {
        isLink = fs.lstatSync(file).isSymbolicLink();
    } catch {
        return file;
    }
    if (!isLink) {
        return file;
    }
    try {
        return fs.realpathSync(file);
    } catch {
        throw new AgentPermissionsError(
            `${file} is a link to a file that does not exist, so the app will not change it.`
        );
    }
}

/** The allow rules currently in the settings file. Throws {@link AgentPermissionsError}. */
export function readAllowRules(file: string): string[] {
    return allowList(file, parseSettings(file, readText(resolveTarget(file))));
}

/** The indentation of a JSON text (its first indented line), or two spaces. */
export function detectIndent(text: string | null): string {
    const match = text ? /\n([ \t]+)\S/.exec(text) : null;
    return match?.[1] ?? '  ';
}

/** Write a file atomically: a temporary file in the same folder, then a rename. */
export function writeFileAtomic(file: string, content: string, mode: number, beforeRename?: () => void): void {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
    const fd = fs.openSync(temp, 'wx', mode);
    try {
        try {
            fs.writeFileSync(fd, content, 'utf8');
            fs.fchmodSync(fd, mode);
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
        beforeRename?.();
        fs.renameSync(temp, file);
    } catch (error) {
        fs.rmSync(temp, { force: true });
        throw error;
    }
}

export interface AllowRuleChange {
    /** Rules that were added (they were not in the file before). */
    added: string[];
    /** Rules that were removed (they were in the file). */
    removed: string[];
}

/** What identifies a version of the file: missing, or its inode, size and change time. */
function fingerprint(file: string): string {
    try {
        const stat = fs.statSync(file);
        return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    } catch {
        return 'missing';
    }
}

/** Thrown inside {@link updateAllowRules} when the file changed while it was being written. */
class FileChangedError extends Error {}

/**
 * Add and remove `command(...)` allow rules in Antigravity CLI's settings file. Rules
 * already there are not added twice; every other key, list and entry is kept, and so is
 * the indentation. Throws {@link AgentPermissionsError} for a rule the app must not
 * write or a file it must not change.
 */
export function updateAllowRules(
    file: string,
    change: { add?: string[]; remove?: string[] },
    /** Tests: called after each read, to change the file behind the writer's back. */
    afterRead?: () => void
): AllowRuleChange {
    const add = [...new Set(change.add ?? [])];
    for (const rule of add) {
        const refusal = refuseAllowRule(rule);
        if (refusal) {
            throw new AgentPermissionsError(refusal);
        }
    }
    try {
        return updateOnce(file, add, new Set(change.remove ?? []), afterRead);
    } catch (error) {
        if (!(error instanceof FileChangedError)) {
            throw error;
        }
    }
    // Someone else wrote the file meanwhile: start again from their version, once.
    try {
        return updateOnce(file, add, new Set(change.remove ?? []), afterRead);
    } catch (error) {
        if (error instanceof FileChangedError) {
            throw new AgentPermissionsError(`${file} kept changing while the app was writing it. Try again.`);
        }
        throw error;
    }
}

function updateOnce(file: string, add: string[], remove: Set<string>, afterRead?: () => void): AllowRuleChange {
    const target = resolveTarget(file);
    const before = fingerprint(target);
    const text = readText(target);
    afterRead?.();
    const settings = parseSettings(file, text);
    const current = allowList(file, settings);

    const removed = current.filter((rule) => remove.has(rule));
    const kept = current.filter((rule) => !remove.has(rule));
    const added = add.filter((rule) => !kept.includes(rule) && !remove.has(rule));
    if (added.length === 0 && removed.length === 0) {
        return { added, removed };
    }

    const permissions = isObject(settings.permissions) ? settings.permissions : {};
    // Keep entries that are not strings exactly where they were.
    const rawAllow: unknown[] = Array.isArray(permissions.allow) ? permissions.allow : [];
    const nextAllow = [...rawAllow.filter((rule) => typeof rule !== 'string' || !remove.has(rule)), ...added];
    const next: JsonObject = { ...settings, permissions: { ...permissions, allow: nextAllow } };
    // Removing the app's last rule takes out the keys adding it created, so a file the app
    // only borrowed goes back to what it was.
    if (nextAllow.length === 0) {
        const { allow: _allow, ...otherPermissions } = permissions;
        if (Object.keys(otherPermissions).length > 0) {
            next.permissions = otherPermissions;
        } else {
            delete next.permissions;
        }
    }

    let mode = 0o600;
    try {
        mode = fs.statSync(target).mode & 0o777;
    } catch {
        // New file.
    }
    // Keep the file's final newline, or its lack of one.
    const newline = text === null || text.endsWith('\n') ? '\n' : '';
    writeFileAtomic(target, `${JSON.stringify(next, null, detectIndent(text))}${newline}`, mode, () => {
        if (fingerprint(target) !== before) {
            throw new FileChangedError();
        }
    });
    return { added, removed };
}

// =========================================================================
// The app's record of the rules it wants
// =========================================================================

export interface PermissionRecord {
    /** Lasting rules the user chose with "Always allow". */
    lasting: string[];
    /** Rules of the lookup list, while it is on. */
    lookup: string[];
    /** True while the lookup list is turned on. */
    lookupEnabled: boolean;
    /** Rules allowed for one answer that are (or may still be) in the settings file. */
    pending: string[];
    /** Rules that were in the settings file before the app wanted them; never removed. */
    userOwned: string[];
}

function stringList(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/** Every rule the app has a reason to keep in the settings file. */
export function wantedRules(record: PermissionRecord): Set<string> {
    return new Set([...record.lasting, ...record.lookup, ...record.pending, ...record.userOwned]);
}

/** The app's own record of the rules it wants, kept in a JSON file in userData. */
export class PermissionTracker {
    /** `file` is resolved on every use, so it may depend on paths that are known late. */
    constructor(private readonly file: () => string) {}

    read(): PermissionRecord {
        let value: unknown;
        try {
            value = JSON.parse(fs.readFileSync(this.file(), 'utf8'));
        } catch {
            value = {};
        }
        const record = isObject(value) ? value : {};
        return {
            lasting: stringList(record.lasting),
            lookup: stringList(record.lookup),
            lookupEnabled: record.lookupEnabled === true,
            pending: stringList(record.pending),
            userOwned: stringList(record.userOwned),
        };
    }

    write(record: PermissionRecord): void {
        writeFileAtomic(this.file(), `${JSON.stringify({ version: 1, ...record }, null, 2)}\n`, 0o600);
    }

    update(change: (record: PermissionRecord) => PermissionRecord): PermissionRecord {
        const next = change(this.read());
        this.write(next);
        return next;
    }
}
