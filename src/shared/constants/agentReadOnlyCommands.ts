/**
 * Read-only command prefixes for the local agent (Antigravity CLI).
 *
 * When the user turns on "Read-only system commands" in Options → Quick Chat, the app
 * adds one `command(<prefix>)` allow rule per entry to Antigravity CLI's settings, so
 * the agent can answer questions about this computer (disk space, memory, hardware)
 * without asking. Antigravity matches a rule word by word against the start of each
 * command in a line, so `command(df)` allows `df -h` but not `rm` in `df; rm x`.
 *
 * Rules for this list:
 * - A single word only for a command that has no mode that changes anything for an
 *   unprivileged user (`df`, `free`, `lsblk`, ...).
 * - Several words for a tool that also has state-changing subcommands or flags: the
 *   prefix pins a read-only subcommand (`systemctl status`, `nmcli device status`).
 *   A flag-only prefix is not enough when the tool reads its subcommand after the flag
 *   (`systemctl --failed restart x` restarts x), so those use the subcommand form.
 * - No generic file readers (`cat`, `head`, `grep`, ...): the agent must not read the
 *   user's files. A prefix such as `cat /proc/cpuinfo` would also allow
 *   `cat /proc/cpuinfo ~/.ssh/id_ed25519`, so `/proc` and `/etc` files are left out too.
 * - No environment dumps (`env`, `printenv`, `set`), which hold secrets, no tools that
 *   can set the clock or host name (`date`, `hostname`), no `find` (it has `-delete` and
 *   `-exec`), no `journalctl` (`--vacuum-*`, `--rotate`), no tools that write their own
 *   config on first run (`neofetch`, `fastfetch`), and nothing networked: the sandbox
 *   has no network.
 *
 * Every entry is checked by tests against the app's list of state-changing commands
 * and against the engine safety check (tests/unit/main/agent/agentPermissions.test.ts).
 * Commands still run inside Antigravity's sandbox (`--sandbox`), where only the scratch
 * workspace is writable.
 *
 * @module agentReadOnlyCommands
 */

import type { ReadOnlyCommandGroup } from '../types/agent';

export const READ_ONLY_COMMAND_GROUPS: readonly ReadOnlyCommandGroup[] = [
    {
        name: 'System information',
        prefixes: [
            'uname',
            'uptime',
            'arch',
            'nproc',
            'getconf',
            'locale',
            'cal',
            'lsb_release',
            'inxi',
            'hostnamectl status',
            'timedatectl status',
            'localectl status',
            'systemd-analyze time',
            'systemd-analyze blame',
            // macOS
            'sw_vers',
            'system_profiler',
            'hostinfo',
            'sysctl -a',
            'sysctl -n',
            'csrutil status',
            'scutil --get',
            // Windows
            'systeminfo',
        ],
    },
    {
        name: 'Users and sessions',
        prefixes: ['whoami', 'id', 'groups', 'who', 'w', 'loginctl list-sessions', 'loginctl session-status'],
    },
    {
        name: 'CPU and memory',
        prefixes: [
            'free',
            'lscpu',
            'lsmem',
            'vmstat',
            'mpstat',
            'iostat',
            'swapon --show',
            'top -b',
            'vm_stat',
            'top -l',
        ],
    },
    {
        name: 'Disks and file systems',
        prefixes: [
            'df',
            'du',
            'lsblk',
            'findmnt',
            'stat',
            'file',
            'ls',
            'wc',
            'diskutil list',
            'diskutil info',
            'diskutil apfs list',
        ],
    },
    {
        name: 'Processes',
        prefixes: ['ps', 'pgrep', 'pidof', 'lsof', 'tasklist'],
    },
    {
        name: 'Hardware and power',
        prefixes: [
            'lsusb',
            'lspci',
            'lsmod',
            'modinfo',
            'sensors',
            'acpi',
            'upower -e',
            'upower -i',
            'upower --dump',
            'powerprofilesctl get',
            'powerprofilesctl list',
            'brightnessctl info',
            'brightnessctl get',
            'nvidia-smi -L',
            'nvidia-smi -q',
            'fwupdmgr get-devices',
            'pmset -g',
            'ioreg',
        ],
    },
    {
        name: 'Network (read-only)',
        prefixes: [
            'ip addr show',
            'ip -br addr show',
            'ip route show',
            'ip link show',
            'ip -br link show',
            'ss -tuln',
            'ss -s',
            'nmcli general status',
            'nmcli device status',
            'nmcli connection show',
            'networkctl status',
            'networkctl list',
            'resolvectl status',
            'networksetup -listallhardwareports',
            'ipconfig /all',
        ],
    },
    {
        name: 'Packages (query only)',
        prefixes: [
            'pacman -Q',
            'pacman -Qi',
            'pacman -Qs',
            'pacman -Qe',
            'dpkg -l',
            'dpkg -s',
            'dpkg-query -W',
            'apt list --installed',
            'rpm -qa',
            'rpm -qi',
            'flatpak list',
            'flatpak info',
            'snap list',
            'brew list',
        ],
    },
    {
        name: 'Desktop and session',
        prefixes: [
            'gsettings get',
            'gsettings list-recursively',
            'gnome-extensions list',
            'gnome-extensions info',
            'gnome-shell --version',
            'plasmashell --version',
            'xdpyinfo',
            'xdg-mime query',
            'pactl info',
            'pactl list',
            'wpctl status',
            'wpctl inspect',
            'wpctl get-volume',
            'bluetoothctl show',
            'bluetoothctl devices',
            'bluetoothctl info',
        ],
    },
    {
        name: 'Services (status only)',
        prefixes: [
            'systemctl status',
            'systemctl list-units',
            'systemctl list-unit-files',
            'systemctl list-timers',
            'systemctl is-active',
            'systemctl is-enabled',
            'systemctl is-failed',
            'systemctl --user status',
            'systemctl --user list-units',
            'systemctl --user list-timers',
            'systemctl --user is-active',
            'launchctl list',
        ],
    },
    {
        name: 'Developer tools (version and status only)',
        prefixes: [
            'which',
            'whereis',
            'git status',
            'git log',
            'git diff',
            'git --version',
            'node --version',
            'python3 --version',
            'rustc --version',
            'cargo --version',
            'go version',
            'gcc --version',
        ],
    },
];

/** Every read-only prefix, in list order. */
export const READ_ONLY_COMMAND_PREFIXES: readonly string[] = READ_ONLY_COMMAND_GROUPS.flatMap(
    (group) => group.prefixes
);

/** The allow rule Antigravity CLI uses for a command prefix or a full command line. */
export function commandRule(target: string): string {
    return `command(${target})`;
}

/** The allow rules the read-only list adds, in list order. */
export const READ_ONLY_COMMAND_RULES: readonly string[] = READ_ONLY_COMMAND_PREFIXES.map(commandRule);
