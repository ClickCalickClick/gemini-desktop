# Security Policy

## Supported Versions

| Version  | Supported              |
| -------- | ---------------------- |
| Latest   | ✅ Yes                 |
| < Latest | ❌ No (please upgrade) |

We only provide security updates for the latest release. Please keep your installation up to date.

---

## Reporting a Vulnerability

We take security seriously. If you discover a security vulnerability, please report it responsibly.

### 🔒 Private Disclosure (Preferred)

**Do NOT open a public issue for security vulnerabilities.**

Instead, use GitHub's private vulnerability reporting:

1. Go to the [Security tab](https://github.com/ClickCalickClick/gemini-desktop/security)
2. Click "Report a vulnerability"
3. Fill out the form

This policy covers the fork at [ClickCalickClick/gemini-desktop](https://github.com/ClickCalickClick/gemini-desktop). Report problems that also affect upstream's releases to [bwendell/gemini-desktop](https://github.com/bwendell/gemini-desktop/security) as well.

### What to Include

- **Description** of the vulnerability
- **Steps to reproduce** (proof of concept if possible)
- **Impact assessment** (what could an attacker do?)
- **Affected versions**
- **Any suggested fixes**

### Response Timeline

| Action                   | Timeframe             |
| ------------------------ | --------------------- |
| Initial response         | Within 48 hours       |
| Vulnerability assessment | Within 1 week         |
| Fix development          | Depends on severity   |
| Public disclosure        | After fix is released |

---

## Security Architecture

Gemini Desktop follows Electron security best practices:

### ✅ What We Do

| Practice              | Implementation                           |
| --------------------- | ---------------------------------------- |
| **Context Isolation** | Enabled - renderer cannot access Node.js |
| **Sandbox Mode**      | Enabled - process isolation enforced     |
| **Node Integration**  | Disabled in renderer                     |
| **Remote Module**     | Disabled                                 |
| **Web Security**      | Enabled                                  |
| **HTTPS Only**        | All network connections use HTTPS        |
| **IPC Validation**    | All IPC messages are validated           |

### 🛡️ Automated Checks

We employ automated security scanning to ensure code quality and safety:

- **OpenSSF Scorecard**: The [Scorecard workflow](https://github.com/ClickCalickClick/gemini-desktop/actions/workflows/scorecard.yml) checks the repository's supply-chain practices every week and on each push to `main`.
- **Dependabot**: Dependabot alerts and security updates flag vulnerable dependencies.
- **CI**: Every pull request runs lint and the unit tests, and builds and installs the Linux packages.

### 🔒 Data Handling

For detailed information on how we handle data, please see our [**Privacy Policy**](./PRIVACY.md).

- **No telemetry** - Zero data collection or analytics
- **No servers of our own** - The app connects to Google for Gemini, to GitHub for updates, and to Hugging Face only to download the model if you turn on text prediction
- **Local storage only** - All data stays on your machine
- **Encrypted cookies** - Standard Chromium encryption

### ⚠️ Known Limitations

As a wrapper around `gemini.google.com`, we inherit any vulnerabilities in:

- The Gemini web application (Google's responsibility)
- Chromium/Electron (we update regularly)

---

## Scope

### In Scope

- Vulnerabilities in the Electron main process
- Vulnerabilities in our custom React frontend
- IPC security issues
- Local privilege escalation
- Data leakage through our code

### Out of Scope

- Vulnerabilities in `gemini.google.com` (report to Google)
- Vulnerabilities in Electron/Chromium (report upstream)
- Social engineering attacks
- Physical access attacks
- Issues requiring user to install malicious software

---

## Recognition

We appreciate security researchers who help keep Gemini Desktop safe. With your permission, we'll acknowledge your contribution in our release notes.

---

## Updates

This security policy may be updated from time to time. Check back for the latest version.

Last updated: October 2026
