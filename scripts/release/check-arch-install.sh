#!/usr/bin/env bash
# Install the pacman package on a clean Arch Linux system and check the result.
# CI runs this as root in an Arch Linux container (.github/actions/linux-packages/action.yml):
#   docker run --rm -v "$PWD/release:/pkgs:ro" -v "$PWD/scripts/release:/scripts:ro" \
#       ghcr.io/archlinux/archlinux:latest bash /scripts/check-arch-install.sh /pkgs
# Do not run it on your own machine: it upgrades the whole system, then installs and removes the app.
set -euo pipefail

pkg_dir="${1:?usage: check-arch-install.sh <directory containing the .pacman file>}"
shopt -s nullglob
packages=("$pkg_dir"/*.pacman)
if [ "${#packages[@]}" -ne 1 ]; then
    echo "Expected one .pacman file in $pkg_dir, found ${#packages[@]}." >&2
    exit 1
fi

# Refresh the keyring first, so an older image can still verify today's packages.
pacman -Sy --noconfirm --needed archlinux-keyring
pacman -Su --noconfirm

# Installing from a file resolves every dependency from the Arch repositories,
# so this fails if a name in the pacman.depends list no longer exists.
pacman -U --noconfirm "${packages[0]}"
pacman -Qi gemini-desktop

grep -qx 'StartupWMClass=gemini-desktop' /usr/share/applications/gemini-desktop.desktop
test -x /usr/bin/gemini-desktop
# Quick Chat from the dash (H7): the main entry's right-click action and the separate launcher.
grep -qx 'Actions=QuickChat;' /usr/share/applications/gemini-desktop.desktop
grep -qx '\[Desktop Action QuickChat\]' /usr/share/applications/gemini-desktop.desktop
grep -qx 'Exec="/opt/Gemini Desktop/gemini-desktop" --quick-chat' /usr/share/applications/gemini-desktop.desktop
quick_chat_desktop=/usr/share/applications/gemini-desktop-quick-chat.desktop
grep -qx 'Name=Gemini Quick Chat' "$quick_chat_desktop"
grep -qx 'Exec="/opt/Gemini Desktop/gemini-desktop" --quick-chat' "$quick_chat_desktop"
pacman -Qo "$quick_chat_desktop"
# The launcher has its own icon, so the app grid tells it apart from the main entry.
grep -qx 'Icon=gemini-desktop-quick-chat' "$quick_chat_desktop"
pacman -Qo /usr/share/icons/hicolor/512x512/apps/gemini-desktop-quick-chat.png
# The main icon must sit in sizes hicolor's index.theme lists; a 1024x1024 folder alone leaves GNOME
# showing its generic application icon (L23).
for size in 48x48 256x256 512x512; do
    pacman -Qo "/usr/share/icons/hicolor/$size/apps/gemini-desktop.png"
done
# The update notice reads this to tell pacman installs to install the new package (src/main/utils/packageType.ts).
grep -qx 'pacman' '/opt/Gemini Desktop/resources/package-type'

missing=$(ldd '/opt/Gemini Desktop/gemini-desktop' | grep 'not found' || true)
if [ -n "$missing" ]; then
    echo "Missing shared libraries:" >&2
    echo "$missing" >&2
    exit 1
fi

# The /usr/bin link comes from the package's install script, so pacman does not track it.
pacman -R --noconfirm gemini-desktop
if [ -e /usr/bin/gemini-desktop ]; then
    echo "pacman -R left /usr/bin/gemini-desktop behind." >&2
    exit 1
fi
if [ -e "$quick_chat_desktop" ]; then
    echo "pacman -R left $quick_chat_desktop behind." >&2
    exit 1
fi

echo "The pacman package installs, finds all its libraries and uninstalls cleanly."
