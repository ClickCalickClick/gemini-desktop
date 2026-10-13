# TODO

The working plan for this fork of Gemini Desktop: what to do next, in what order, and what is already done.
This file is how progress is remembered between sessions, for people and AI agents alike.
The evidence behind each item is in [docs/CODEBASE_OVERVIEW.md](docs/CODEBASE_OVERVIEW.md); bug IDs such as B1 point there.

## How to use this file

- Read it before starting work. Unless asked for something else, take the first open item in the current focus.
- Every item has an ID. Use it in the branch name, the commit message and the PR title, for example `L2: add pacman target`.
- In the PR that does the work, tick the item, link the PR, and add a line to the [Done log](#done-log). Mark work in flight as `[~]` with its PR link.
- New problems become new items in the right section, not notes in a chat.
- Items marked **(owner)** need Jared: an account, a secret, a repository setting, or a test on real hardware.
- Keep every feature and keep Windows building. An item that would drop a feature needs the owner's OK first.

Legend: `[ ]` open, `[~]` in progress, `[x]` done, `[!]` blocked (say on what).

## Decisions

- **2026-10-13:** The main platforms are CachyOS (Arch-based, KDE Plasma on Wayland, kernel 7.x) and macOS. Windows stays supported but secondary.
- **2026-10-13:** GitHub Actions builds the installers. Linux comes first. macOS CI comes later; until then the owner builds macOS locally.
- **2026-10-13 (proposed, confirm):** Keep the app id `com.benwendell.gemini-desktop`. It ties together the macOS bundle and microphone permission, the Windows notification identity and existing installs' settings, so changing it would break upgrades.

## Current focus: Phase 1, Linux installers from GitHub Actions

_To be completed from the build and release review._

## Done log

- **2026-10-13:** Codebase overview and this TODO list added (`docs/CODEBASE_OVERVIEW.md`, `TODO.md`).
