/**
 * Command allow rules the app writes to Antigravity CLI's settings.
 *
 * Antigravity CLI has no per-run permission flag: its rules live only in the global
 * `~/.gemini/antigravity-cli/settings.json` (`permissions.allow|deny|ask`). In headless
 * mode a terminal command without an allow rule is soft-denied, so the agent cannot
 * answer "how much disk space is left?". After an explicit user action (the approval
 * card in Quick Chat, or the read-only list in Options) the app adds specific
 * `command(...)` allow rules there, and nothing else:
 *
 * - Only plain `command(<target>)` rules with a specific target are written: never
 *   `command(*)`, `regex:` rules, other actions, or the deny and ask lists.
 * - Every rule the app adds is recorded in its own state file, and the app only ever
 *   removes rules it recorded. Rules the user had before are left alone.
 * - Temporary rules ("Allow once") are recorded as pending before they are written, so
 *   they are removed on the next start if the app stopped before removing them.
 * - The file is changed in place: other keys are kept, the result is written to a
 *   temporary file in the same folder and renamed over the original (keeping its mode),
 *   and a file that is not valid JSON is never overwritten.
 *
 * Commands that are allowed still run inside Antigravity's sandbox (`--sandbox`), where
 * only the scratch workspace is writable.
 *
 * Writes are synchronous: the files are small, and it keeps read-modify-write cycles
 * from interleaving.
 *
 * @module agent/agentPermissions
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { commandRule, READ_ONLY_COMMAND_PREFIXES } from '../../shared/constants/agentReadOnlyCommands';
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
 * substitution, quoting, globbing, brace and history expansion, comments. Antigravity
 * only prefix-matches plain commands, so these lines are only ever allowed once, as a
 * full-line rule.
 */
const SHELL_METACHARACTERS = /[|&;<>()$`\\"'*?[\]{}!#\r\n]/;

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
 * specific target. Refused: other actions, an empty target, `*`, `regex:` targets, line
 * breaks and an unbalanced `)`.
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
    if (/[\r\n\0]/.test(target)) {
        return 'The command spans several lines.';
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
 * Commands that change things (files, packages, services, users, the network or the
 * machine), run other code, or read files' contents. A lasting "Always allow" rule is
 * never offered for them. The listed subcommands are the read-only exceptions; a rule
 * matches one when the words after the command are exactly that subcommand.
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
    sysctl: ['-a', '-n'],
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
    ss: ['-tuln', '-s'],
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
    git: ['status', 'log', 'diff', '--version'],
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
    // Windows
    ipconfig: ['/all'],
    reg: [],
    sc: [],
    taskkill: [],
};

/** Families of commands denied by name: file system makers and interpreter versions. */
const DENIED_COMMAND_PATTERNS = [/^mkfs/, /^python/, /^pip/, /^perl/, /^ruby/, /^php/, /^lua/, /^node/, /^qemu/];

/** True when a prefix names a state-changing command and is not one of its read-only subcommands. */
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

/** Commands that the read-only list only allows with a subcommand. */
const COMMANDS_WITH_SUBCOMMAND_RULES = new Set(
    READ_ONLY_COMMAND_PREFIXES.map(tokenize)
        .filter((words) => words.length > 1)
        .map((words) => words[0] ?? '')
);

/**
 * True when a prefix may become a lasting allow rule: plain words, not a state-changing
 * command, and for a single word, not a tool that the read-only list only allows with a
 * subcommand.
 */
export function isSafeLastingPrefix(prefix: string): boolean {
    const words = tokenize(prefix);
    const first = words[0];
    if (!first || hasShellSyntax(prefix) || !isPlainCommandName(first)) {
        return false;
    }
    if (READ_ONLY_COMMAND_PREFIXES.includes(words.join(' '))) {
        return !isDeniedPrefix(prefix);
    }
    if (words.length > 1) {
        return false;
    }
    return !isDeniedPrefix(first) && !COMMANDS_WITH_SUBCOMMAND_RULES.has(first);
}

/**
 * The lasting rule "Always allow" offers for a blocked command, or undefined when only
 * "Allow once" is safe. The prefix is the longest read-only list entry the command starts
 * with (`systemctl status` for `systemctl status sshd`), otherwise its first word.
 */
export function lastingRuleFor(commandLine: string): string | undefined {
    if (hasShellSyntax(commandLine)) {
        return undefined;
    }
    const words = tokenize(commandLine);
    const first = words[0];
    if (!first || !isPlainCommandName(first)) {
        return undefined;
    }
    let prefix = first;
    for (const candidate of READ_ONLY_COMMAND_PREFIXES) {
        const candidateWords = tokenize(candidate);
        if (
            candidateWords.length > tokenize(prefix).length &&
            candidateWords.every((word, index) => words[index] === word)
        ) {
            prefix = candidate;
        }
    }
    return isSafeLastingPrefix(prefix) ? commandRule(prefix) : undefined;
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

/** The allow rules currently in the settings file. Throws {@link AgentPermissionsError}. */
export function readAllowRules(file: string): string[] {
    return allowList(file, parseSettings(file, readText(file)));
}

/** Write a file atomically: a temporary file in the same folder, then a rename. */
export function writeFileAtomic(file: string, content: string, mode: number): void {
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

/**
 * Add and remove `command(...)` allow rules in Antigravity CLI's settings file. Rules
 * already there are not added twice; every other key and list is kept as it is. Throws
 * {@link AgentPermissionsError} for a rule the app must not write or a file it must not
 * change. A symbolic link to the file is followed, so dotfile managers keep working.
 */
export function updateAllowRules(file: string, change: { add?: string[]; remove?: string[] }): AllowRuleChange {
    const add = [...new Set(change.add ?? [])];
    const remove = new Set(change.remove ?? []);
    for (const rule of add) {
        const refusal = refuseAllowRule(rule);
        if (refusal) {
            throw new AgentPermissionsError(refusal);
        }
    }

    let target = file;
    try {
        target = fs.realpathSync(file);
    } catch {
        // Missing: it is created.
    }
    const text = readText(target);
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

    let mode = 0o600;
    try {
        mode = fs.statSync(target).mode & 0o777;
    } catch {
        // New file.
    }
    writeFileAtomic(target, `${JSON.stringify(next, null, 2)}\n`, mode);
    return { added, removed };
}

// =========================================================================
// The app's record of the rules it added
// =========================================================================

export interface PermissionRecord {
    /** Lasting rules added with "Always allow". */
    lasting: string[];
    /** Rules added by the read-only list. */
    readOnly: string[];
    /** True while the read-only list is turned on. */
    readOnlyEnabled: boolean;
    /** Temporary "Allow once" rules that are (or may still be) in the settings file. */
    pending: string[];
}

const EMPTY_RECORD: PermissionRecord = { lasting: [], readOnly: [], readOnlyEnabled: false, pending: [] };

function stringList(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/** The app's own record of the rules it added, kept in a JSON file in userData. */
export class PermissionTracker {
    /** `file` is resolved on every use, so it may depend on paths that are known late. */
    constructor(private readonly file: () => string) {}

    read(): PermissionRecord {
        let value: unknown;
        try {
            value = JSON.parse(fs.readFileSync(this.file(), 'utf8'));
        } catch {
            return { ...EMPTY_RECORD, lasting: [], readOnly: [], pending: [] };
        }
        const record = isObject(value) ? value : {};
        return {
            lasting: stringList(record.lasting),
            readOnly: stringList(record.readOnly),
            readOnlyEnabled: record.readOnlyEnabled === true,
            pending: stringList(record.pending),
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
