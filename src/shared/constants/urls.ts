/**
 * Shared URL Constants
 */

export const GEMINI_APP_URL = 'https://gemini.google.com/app';

/**
 * The fork's GitHub repository. Release notes, "Report an Issue", the About links and the
 * notify-only update check all derive from it, so this is the only place to change it.
 */
export const GITHUB_REPO_OWNER = 'ClickCalickClick';
export const GITHUB_REPO_NAME = 'gemini-desktop';
export const GITHUB_REPO_URL = `https://github.com/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}` as const;
export const GITHUB_ISSUES_URL = `${GITHUB_REPO_URL}/issues` as const;
export const GITHUB_LICENSE_URL = `${GITHUB_REPO_URL}/blob/main/LICENSE` as const;
export const GITHUB_DISCLAIMER_URL = `${GITHUB_REPO_URL}/blob/main/docs/DISCLAIMER.md` as const;

/**
 * Latest published release (never a draft or prerelease), read by the notify-only update check.
 */
export const GITHUB_LATEST_RELEASE_API_URL =
    `https://api.github.com/repos/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/releases/latest` as const;
