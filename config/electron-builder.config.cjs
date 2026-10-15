/**
 * @type {import('electron-builder').Configuration}
 * @see https://www.electron.build/configuration/configuration
 */
const path = require('path');
const { description } = require('../package.json');

// Where the deb, rpm and pacman packages install the app (electron-builder's /opt/<productName>).
const linuxExecutable = '"/opt/Gemini Desktop/gemini-desktop"';

// The "Gemini Quick Chat" launcher that can be pinned to the GNOME dash or a dock (H7). The deb, rpm and
// pacman packages install it next to the main entry; AppImage and tar.gz installs write it to
// ~/.local/share/applications at runtime instead (src/main/utils/quickChatLauncher.ts).
const quickChatDesktopFile = path.join(__dirname, '..', 'build', 'linux', 'gemini-desktop-quick-chat.desktop');

// The launcher's own icon, a speech bubble, so the app grid tells it apart from the main entry. The
// desktop file names it `gemini-desktop-quick-chat` from the hicolor theme.
const quickChatIconFile = path.join(__dirname, '..', 'build', 'icon-quick-chat.png');

// Extra fpm arguments for the deb, rpm and pacman targets (electron-builder only accepts `fpm` per
// target, not under `linux`): fpm's dir source maps <file>=<path in the package>.
const fpmExtraFiles = [
    `${quickChatDesktopFile}=/usr/share/applications/gemini-desktop-quick-chat.desktop`,
    `${quickChatIconFile}=/usr/share/icons/hicolor/512x512/apps/gemini-desktop-quick-chat.png`,
];

/**
 * The main desktop entry, with a "Quick Chat" action in its right-click menu.
 * @param {string} quickChatExec - The Exec line of the action
 */
function linuxDesktop(quickChatExec) {
    return {
        entry: {
            // Must match the window class the app sets with --class on Linux, so desktops
            // group the window with its launcher. The default is the product name.
            StartupWMClass: 'gemini-desktop',
            Actions: 'QuickChat;',
        },
        desktopActions: {
            QuickChat: {
                Name: 'Quick Chat',
                Exec: quickChatExec,
            },
        },
    };
}

const explicitBuildArch = process.env.npm_config_arch || process.env.BUILD_ARCH;
const buildArch = explicitBuildArch || process.arch;
const buildPlatform = process.env.BUILD_PLATFORM || process.platform;
const isWindowsBuild = buildPlatform === 'win32';

function getWindowsBinaryExclusions() {
    if (!isWindowsBuild) {
        return [
            '!node_modules/@node-llama-cpp/win-arm64',
            '!node_modules/@node-llama-cpp/win-x64',
            '!node_modules/@node-llama-cpp/win-x64-cuda',
            '!node_modules/@node-llama-cpp/win-x64-cuda-ext',
            '!node_modules/@node-llama-cpp/win-x64-vulkan',
        ];
    }

    if (buildArch === 'arm64') {
        return [
            '!node_modules/@node-llama-cpp/win-x64',
            '!node_modules/@node-llama-cpp/win-x64-cuda',
            '!node_modules/@node-llama-cpp/win-x64-cuda-ext',
            '!node_modules/@node-llama-cpp/win-x64-vulkan',
        ];
    }

    return ['!node_modules/@node-llama-cpp/win-arm64'];
}

const windowsBinaryExclusions = getWindowsBinaryExclusions();

module.exports = {
    appId: 'com.benwendell.gemini-desktop',
    productName: 'Gemini Desktop',
    // The app ships no native module that needs rebuilding for Electron: dbus-next's optional
    // usocket, the only one, is left out of the package below (B1).
    npmRebuild: false,

    directories: {
        output: 'release',
        buildResources: 'build',
    },
    files: [
        'dist-electron',
        'dist',
        'package.json',
        // Exclude non-current-platform node-llama-cpp native binaries to prevent
        // bundling ~677MB of unused platform-specific .node files.
        // electron-builder resolves the correct platform binary automatically.
        '!node_modules/@node-llama-cpp/linux-x64-cuda',
        '!node_modules/@node-llama-cpp/linux-x64-cuda-ext',
        '!node_modules/@node-llama-cpp/linux-x64-vulkan',
        '!node_modules/@node-llama-cpp/linux-armv7l',
        '!node_modules/@node-llama-cpp/linux-arm64',
        '!node_modules/@node-llama-cpp/linux-x64',
        '!node_modules/@node-llama-cpp/mac-arm64-metal',
        '!node_modules/@node-llama-cpp/mac-x64',
        ...windowsBinaryExclusions,
        // dbus-next's optional native transport crashes the app inside the V8 sandbox on Linux
        // kernel 7+ (B1). dbus-next connects through Node's net module instead (dbusFallback.ts).
        '!node_modules/usocket',
    ],
    // Native .node binaries must be unpacked from asar for node-llama-cpp to load them
    asarUnpack: ['node_modules/@node-llama-cpp/**/*.node', 'node_modules/node-llama-cpp/**/*'],
    extraFiles: [
        {
            from: 'build',
            to: 'resources',
            filter: ['*.png', '*.ico'],
        },
    ],
    win: {
        target: 'nsis',
        icon: 'build/icon.png',
        artifactName: 'Gemini-Desktop-${version}-${arch}.${ext}',
        ...(process.env.AZURE_SIGN_ENDPOINT &&
        process.env.AZURE_CODE_SIGNING_ACCOUNT_NAME &&
        process.env.AZURE_CERT_PROFILE_NAME &&
        process.env.AZURE_PUBLISHER_NAME
            ? {
                  azureSignOptions: {
                      endpoint: process.env.AZURE_SIGN_ENDPOINT,
                      codeSigningAccountName: process.env.AZURE_CODE_SIGNING_ACCOUNT_NAME,
                      certificateProfileName: process.env.AZURE_CERT_PROFILE_NAME,
                      publisherName: process.env.AZURE_PUBLISHER_NAME,
                  },
              }
            : {}),
    },
    nsis: {
        oneClick: false,
        allowToChangeInstallationDirectory: true,
        deleteAppDataOnUninstall: true,
        createDesktopShortcut: true,
        createStartMenuShortcut: true,
        perMachine: false,
        artifactName: 'Gemini-Desktop-${version}-${arch}-installer.${ext}',
    },
    mac: {
        target: ['dmg', 'zip'],
        icon: 'build/icon.png',
        identity: null,
        artifactName: 'Gemini-Desktop-${version}-${arch}.${ext}',
        extendInfo: {
            NSMicrophoneUsageDescription: 'Gemini Desktop needs microphone access for voice input features.',
        },
        entitlements: 'build/entitlements.mac.plist',
        entitlementsInherit: 'build/entitlements.mac.plist',
    },
    dmg: {
        sign: false,
        writeUpdateInfo: false,
    },
    linux: {
        target: [
            {
                target: 'AppImage',
                arch: ['x64'],
            },
            {
                target: 'deb',
                arch: ['x64'],
            },
            {
                target: 'rpm',
                arch: ['x64'],
            },
            {
                target: 'pacman',
                arch: ['x64'],
            },
            {
                target: 'tar.gz',
                arch: ['x64'],
            },
        ],
        // One PNG per hicolor size. Given only the 1024 px icon.png, the packages install it to
        // hicolor/1024x1024, a folder hicolor's index.theme does not list, so GNOME never finds it
        // and shows its generic application icon (L23). Regenerate the folder when icon.png changes.
        icon: 'build/icons',
        category: 'Utility',
        artifactName: 'Gemini-Desktop-${version}-${arch}.${ext}',
        executableName: 'gemini-desktop',
        // The one-line package summary. Without it the deb synopsis and pacman's pkgdesc are empty.
        synopsis: description,
        // The deb Maintainer and the pacman packager. Without it, fpm uses the upstream author.
        maintainer: 'ClickCalickClick <16350651+ClickCalickClick@users.noreply.github.com>',
        desktop: linuxDesktop(`${linuxExecutable} --quick-chat`),
    },
    // The AppImage's own entry starts AppRun; AppImage integration tools rewrite its Exec lines to
    // the AppImage's path, the action's included.
    appImage: {
        desktop: linuxDesktop('AppRun --no-sandbox --quick-chat'),
    },
    // The default AppImage runtime loads libfuse2, which CachyOS and Ubuntu 22.04 and later do not
    // install. The static type2 runtime in toolset 1.0.2 only needs fusermount3 from fuse3, which
    // xdg-desktop-portal already depends on. Windows keeps the default winCodeSign toolset.
    toolsets: {
        appimage: '1.0.2',
    },
    // A custom depends list replaces electron-builder's defaults instead of adding to them,
    // so the deb and rpm lists are the defaults plus ALSA.
    deb: {
        depends: [
            'libgtk-3-0',
            'libnotify4',
            'libnss3',
            'libxss1',
            'libxtst6',
            'xdg-utils',
            'libatspi2.0-0',
            'libuuid1',
            'libsecret-1-0',
            'libasound2',
        ],
        recommends: ['libayatana-appindicator3-1'],
        fpm: fpmExtraFiles,
    },
    rpm: {
        depends: [
            'gtk3',
            'libnotify',
            'nss',
            'libXScrnSaver',
            '(libXtst or libXtst6)',
            'xdg-utils',
            'at-spi2-core',
            '(libuuid or libuuid1)',
            'alsa-lib',
        ],
        fpm: fpmExtraFiles,
    },
    // The pacman defaults pull in all of ffmpeg (Electron bundles its own), the archived http-parser
    // and libappindicator-gtk3, which Arch only has as a provides. This list follows Arch's own
    // Electron app packages; mesa provides libgbm.
    pacman: {
        depends: [
            'gtk3',
            'nss',
            'nspr',
            'alsa-lib',
            'libxss',
            'libxtst',
            'libnotify',
            'libsecret',
            'xdg-utils',
            'hicolor-icon-theme',
            'mesa',
        ],
        fpm: fpmExtraFiles,
    },
    // Builds use --publish never. This only names the repository that AppImage and Windows
    // builds check for updates (app-update.yml); without it electron-builder guesses from .git.
    publish: {
        provider: 'github',
        owner: 'ClickCalickClick',
        repo: 'gemini-desktop',
        releaseType: 'release',
        timeout: 600000,
    },
};
