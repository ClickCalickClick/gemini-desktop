# Gemini Desktop — Native, Private AI Experience

> [!NOTE]
> This is a maintained fork of [bwendell/gemini-desktop](https://github.com/bwendell/gemini-desktop), which its author, Ben Wendell, put [on hiatus](https://github.com/bwendell/gemini-desktop/issues/389) in July 2026. The fork keeps every feature and builds its installers with GitHub Actions. It puts CachyOS and other Arch-based Linux first, then macOS, and Windows keeps building. The plan is in [TODO.md](TODO.md).

<div align="center">

[![GitHub release](https://img.shields.io/github/v/release/ClickCalickClick/gemini-desktop?style=flat-square)](https://github.com/ClickCalickClick/gemini-desktop/releases)
[![CI](https://github.com/ClickCalickClick/gemini-desktop/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/ClickCalickClick/gemini-desktop/actions/workflows/ci.yml)
[![GitHub last commit](https://img.shields.io/github/last-commit/ClickCalickClick/gemini-desktop?style=flat-square)](https://github.com/ClickCalickClick/gemini-desktop/commits/main)
[![Platform](<https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows%20(x64%2C%20ARM64)-lightgrey?style=flat-square>)](#-installation)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/ClickCalickClick/gemini-desktop/badge)](https://securityscorecards.dev/viewer/?uri=github.com/ClickCalickClick/gemini-desktop)

</div>

> **Gemini, but better.** A privacy-first desktop client for Google Gemini with native controls, global hotkeys, and zero telemetry.

<p align="center">
  <a href="#-feature-highlights">Feature Highlights</a> •
  <a href="#-installation">Installation</a> •
  <a href="#-privacy--security">Privacy</a> •
  <a href="#-whats-next">What's Next</a> •
  <a href="#-contributing">Contributing</a>
</p>

---

<div align="center">

![Gemini Desktop Main Window Interface](docs/assets/main_window.png)

</div>

## ✨ Why Gemini Desktop

- **Desktop-native workflow**: Use Gemini in a dedicated app window instead of a browser tab.
- **Fast keyboard control**: Trigger Quick Chat, hide/restore the app, and stay in flow.
- **Trust-first defaults**: No telemetry, Google auth, and clear transparency/security docs.

## 🌟 Feature Highlights

- **Multi-tab conversations** — keep multiple chat contexts open and switch instantly.
- **Launch at startup** — optionally start with your system and open minimized.
- **Quick Chat** — summon a Spotlight-style prompt from anywhere with a global hotkey.
- **Peek and Hide** — hide to tray and restore instantly when you need it.
- **Response notifications** — get notified when Gemini finishes while the app is unfocused.
- **Always On Top** — keep Gemini visible above other windows when multitasking.

## 📥 Installation

Download the latest release from [GitHub Releases](https://github.com/ClickCalickClick/gemini-desktop/releases). In the file names below, `<version>` is the release number, for example `0.13.0`. Each release also lists SHA-256 checksums in `checksums-*.txt`.

**Updates.** The AppImage and the Windows installers update themselves. The pacman, deb, rpm and tar.gz builds tell you when a new version is out; download the new package and install it the same way. A build of upstream's Gemini Desktop only looks for upstream's updates, so install this fork's build by hand once.

### Linux (x64)

| Package  | File                                       | For                                        |
| -------- | ------------------------------------------ | ------------------------------------------ |
| pacman   | `Gemini-Desktop-<version>-x64.pacman`      | CachyOS, Arch Linux and Arch-based systems |
| AppImage | `Gemini-Desktop-<version>-x86_64.AppImage` | Any distribution, without installing       |
| deb      | `Gemini-Desktop-<version>-amd64.deb`       | Debian, Ubuntu and their derivatives       |
| rpm      | `Gemini-Desktop-<version>-x86_64.rpm`      | Fedora, openSUSE                           |
| tar.gz   | `Gemini-Desktop-<version>-x64.tar.gz`      | Unpack and run `gemini-desktop`            |

**CachyOS and Arch Linux.** The pacman package is the best fit: it adds the app to the launcher, keeps Chromium's sandbox and needs no FUSE. pacman installs its dependencies from the Arch repositories.

```bash
sudo pacman -U ./Gemini-Desktop-<version>-x64.pacman
# To remove it:
sudo pacman -R gemini-desktop
```

**AppImage.** It needs FUSE 3, which most desktops already have. If it does not start, install it with `sudo pacman -S fuse3` on Arch-based systems or `sudo apt install fuse3` on Debian and Ubuntu.

```bash
chmod +x Gemini-Desktop-<version>-x86_64.AppImage
./Gemini-Desktop-<version>-x86_64.AppImage
```

**Debian, Ubuntu and Fedora.**

```bash
# Debian and Ubuntu
sudo apt install ./Gemini-Desktop-<version>-amd64.deb
# Fedora
sudo dnf install ./Gemini-Desktop-<version>-x86_64.rpm
```

### macOS

GitHub Actions does not build macOS yet ([TODO item M2](TODO.md#phase-3-macos-installers-from-github-actions-later)), so build it on your Mac with Node.js 24 and the Xcode command line tools:

```bash
git clone https://github.com/ClickCalickClick/gemini-desktop.git
cd gemini-desktop
npm ci
npm run dist:mac-arm64 # Apple Silicon; on an Intel Mac, npm run dist:mac-x64
```

Then open `release/Gemini-Desktop-<version>-arm64.dmg` (or `-x64.dmg`) and drag the app to Applications. The app is not code-signed; if macOS refuses to open it, remove the quarantine flag:

```bash
xattr -dr com.apple.quarantine "/Applications/Gemini Desktop.app"
```

### Windows

- **x64:** `Gemini-Desktop-<version>-x64-installer.exe`
- **ARM64:** `Gemini-Desktop-<version>-arm64-installer.exe`

The installers are not code-signed, so SmartScreen may warn the first time: choose **More info**, then **Run anyway**.

## 🔒 Privacy & Security

Gemini Desktop has **no telemetry**. It connects to Google for Gemini and sign-in, to GitHub to check for and download updates, and to Hugging Face only to download the model if you turn on text prediction.
Authentication is handled by Google, and sessions are stored using Chromium's standard local mechanisms.
For full details, read the [Transparency Report](docs/TRANSPARENCY.md), [Privacy Policy](docs/PRIVACY.md), and [Security Policy](docs/SECURITY.md).

## ⌨️ Keyboard Shortcuts

- `Ctrl+Shift+Alt+Space` (`Cmd+Shift+Alt+Space` on macOS) — Toggle Quick Chat
- `Ctrl+Shift+Space` (`Cmd+Shift+Space` on macOS) — Peek and Hide (toggle app visibility)
- `Ctrl+Shift+P` (`Cmd+Shift+P` on macOS) — Print current page to PDF

> 💡 You can customize hotkeys in Settings.

## 🗺️ What's Next

The fork's plan, in order, is in [TODO.md](TODO.md):

1. Linux installers built and tested by GitHub Actions.
2. Bring back the features that are off on CachyOS and macOS, such as global hotkeys on Linux kernel 7 and text prediction in installed builds.
3. macOS installers built by GitHub Actions.
4. Simplify the code and tests while keeping every feature.

Upstream's shipped history is in [docs/ROADMAP.md](docs/ROADMAP.md).

## 🤝 Contributing

Contributions are welcome. For setup, standards, and workflow expectations, see [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md).

## ⚖️ Legal

This is an unofficial, open-source project and is **not** affiliated with Google LLC.
**Gemini** and **Google** are registered trademarks of Google LLC.
Use this software at your own risk; it is provided "as is" without any warranty. See [docs/DISCLAIMER.md](docs/DISCLAIMER.md) for full terms, including user responsibility and warranty disclaimers.

## 📄 License

[MIT](LICENSE) © [Ben Wendell](https://github.com/bwendell). This fork is maintained by [ClickCalickClick](https://github.com/ClickCalickClick) under the same license.
