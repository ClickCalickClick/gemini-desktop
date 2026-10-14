#!/usr/bin/env node
/**
 * Live check: drives the real app over the Chrome DevTools Protocol and records what it loads.
 *
 * It can start the app with its own profile folder, so a test copy runs beside the installed app,
 * reload the main window, click Gemini's Sign in button with a real mouse click and close the
 * sign-in window as a person would. It records every page load in every window and tab, with
 * redirects and HTTP status codes, saves screenshots of the app's windows, and fails when Google's
 * sign-in page loads inside a tab, which Google answers with a 401. At the end it stops the app it
 * started with SIGTERM and fails when the app does not quit within 10 seconds or crashes on the way.
 *
 * Usage:
 *   node scripts/live-check.mjs --launch release/linux-unpacked/gemini-desktop \
 *       --copy-profile ~/.config/gemini-desktop --reload --sign-in --close-auth-after 20
 *   node scripts/live-check.mjs --port 9333     # attach to an app started with --remote-debugging-port=9333
 *
 * Options:
 *   --launch <binary>        Start this app binary. Arguments after -- go to the app.
 *   --profile <dir>          Profile folder for the started app (--user-data-dir). Default: <out>/profile.
 *   --copy-profile <dir>     Copy this profile into --profile first, without caches and lock files.
 *   --port <n>               DevTools port. Default: 9333.
 *   --seconds <n>            How long to record once the main window is found. Default: 40.
 *   --reload                 Reload the main window first, to record the tabs loading from scratch.
 *   --sign-in                Click Gemini's Sign in button in the visible tab.
 *   --close-auth-after <n>   Close the sign-in window n seconds after it opens.
 *   --navigate-tab <url>     Send the visible tab to this URL as a link in it would, to test the
 *                            app's handling of a URL without Gemini (for example a sign-in page).
 *   --out <dir>              Where to write trace.jsonl, summary.txt, app.log and screenshots.
 *   --stop-all               Stop the started app as a logout does, with SIGTERM to all of its
 *                            processes at once rather than to its main process only.
 *   --keep-open              Leave the started app running.
 *
 * Exit code: 0 when every check passed, 1 when one failed, 2 when the script itself failed.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const TAB_FRAME_PREFIX = 'gemini-tab-';
const PROFILE_MARKER = '.live-check-profile';
const SKIPPED_PROFILE_ENTRIES = new Set([
    'Cache',
    'Code Cache',
    'GPUCache',
    'DawnGraphiteCache',
    'DawnWebGPUCache',
    'GrShaderCache',
    'ShaderCache',
    'crashes',
    'SingletonLock',
    'SingletonSocket',
    'SingletonCookie',
    'DevToolsActivePort',
]);
const SEND_TIMEOUT_MS = 15000;

const { values: opts, positionals: appArgs } = parseArgs({
    allowPositionals: true,
    options: {
        launch: { type: 'string' },
        profile: { type: 'string' },
        'copy-profile': { type: 'string' },
        port: { type: 'string', default: '9333' },
        seconds: { type: 'string', default: '40' },
        reload: { type: 'boolean', default: false },
        'sign-in': { type: 'boolean', default: false },
        'close-auth-after': { type: 'string' },
        'navigate-tab': { type: 'string' },
        out: { type: 'string' },
        'stop-all': { type: 'boolean', default: false },
        'keep-open': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
    },
});

if (opts.help) {
    const source = fs.readFileSync(new URL(import.meta.url), 'utf8');
    console.log(source.slice(source.indexOf('/**') + 4, source.indexOf('*/')).replace(/^ \* ?/gm, ''));
    process.exit(0);
}

const port = Number(opts.port);
const recordSeconds = Number(opts.seconds);
const closeAuthAfter = opts['close-auth-after'] === undefined ? null : Number(opts['close-auth-after']);
const outDir = path.resolve(expandHome(opts.out ?? `live-check-${new Date().toISOString().replace(/[:.]/g, '-')}`));
fs.mkdirSync(outDir, { recursive: true });

const startedAt = Date.now();
const traceFile = fs.createWriteStream(path.join(outDir, 'trace.jsonl'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const short = (id) => (id ? id.slice(0, 8) : id);

function expandHome(value) {
    return value?.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
}

/** Shortens long query values, such as sign-in transaction tokens, so logs stay readable. */
function tidyUrl(raw) {
    if (!raw) return raw;
    try {
        const url = new URL(raw);
        for (const [key, value] of [...url.searchParams]) {
            if (value.length > 80) url.searchParams.set(key, `${value.slice(0, 12)}...`);
        }
        return url.toString();
    } catch {
        return raw.slice(0, 300);
    }
}

function record(kind, data = {}) {
    const entry = { t: Number(((Date.now() - startedAt) / 1000).toFixed(2)), kind, ...data };
    traceFile.write(`${JSON.stringify(entry)}\n`);
    const details = Object.entries(data)
        .filter(([, value]) => value !== undefined && value !== null && value !== '')
        .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
        .join(' ');
    console.log(`[${entry.t.toFixed(1).padStart(6)}s] ${kind.padEnd(14)} ${details}`);
}

/** A DevTools protocol connection with flattened sessions. */
class Cdp {
    constructor(url) {
        this.ws = new WebSocket(url);
        this.nextId = 1;
        this.pending = new Map();
        this.handlers = new Map();
        this.opened = new Promise((resolve, reject) => {
            this.ws.addEventListener('open', resolve, { once: true });
            this.ws.addEventListener('error', () => reject(new Error(`Cannot connect to ${url}`)), { once: true });
        });
        this.ws.addEventListener('close', () => {
            for (const { reject, method } of this.pending.values()) reject(new Error(`${method}: connection closed`));
            this.pending.clear();
        });
        this.ws.addEventListener('message', (event) => {
            const message = JSON.parse(event.data);
            if (message.id !== undefined) {
                const pending = this.pending.get(message.id);
                if (!pending) return;
                this.pending.delete(message.id);
                clearTimeout(pending.timer);
                if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
                else pending.resolve(message.result);
                return;
            }
            for (const handler of this.handlers.get(message.method) ?? []) {
                Promise.resolve()
                    .then(() => handler(message.params, message.sessionId))
                    .catch((error) => record('script-error', { during: message.method, message: error.message }));
            }
        });
    }

    async send(method, params = {}, sessionId) {
        await this.opened;
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`${method}: no answer after ${SEND_TIMEOUT_MS / 1000}s`));
            }, SEND_TIMEOUT_MS);
            this.pending.set(id, { resolve, reject, method, timer });
            this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
        });
    }

    on(method, handler) {
        if (!this.handlers.has(method)) this.handlers.set(method, []);
        this.handlers.get(method).push(handler);
    }

    close() {
        this.ws.close();
    }
}

function copyProfile(from, to) {
    if (!fs.existsSync(from)) throw new Error(`Profile to copy not found: ${from}`);
    if (path.resolve(from) === path.resolve(to)) throw new Error('--profile must differ from --copy-profile');
    if (fs.existsSync(to) && fs.readdirSync(to).length > 0 && !fs.existsSync(path.join(to, PROFILE_MARKER))) {
        throw new Error(`Refusing to replace ${to}: it is not a profile this script copied`);
    }
    fs.rmSync(to, { recursive: true, force: true });
    fs.cpSync(from, to, {
        recursive: true,
        verbatimSymlinks: true,
        filter: (source) => !SKIPPED_PROFILE_ENTRIES.has(path.basename(source)),
    });
    fs.writeFileSync(path.join(to, PROFILE_MARKER), `Copied from ${from} by scripts/live-check.mjs\n`);
    record('profile-copied', { from, to });
}

let app = null;
function launchApp() {
    const profile = path.resolve(expandHome(opts.profile ?? path.join(outDir, 'profile')));
    if (opts['copy-profile']) copyProfile(path.resolve(expandHome(opts['copy-profile'])), profile);
    const log = fs.openSync(path.join(outDir, 'app.log'), 'w');
    const args = [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, ...appArgs];
    app = spawn(expandHome(opts.launch), args, { stdio: ['ignore', log, log], detached: true });
    app.exitedAt = null;
    app.on('exit', (code, signal) => {
        app.exitedAt = Date.now();
        app.exitStatus = { code, signal };
        record('app-exited', { code, signal });
    });
    app.on('error', (error) => record('app-error', { message: error.message }));
    record('app-started', { binary: opts.launch, profile, pid: app.pid });
}

async function waitForDevTools(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (app?.exitedAt) throw new Error('The app exited before DevTools was up; see app.log');
        try {
            const response = await fetch(`http://127.0.0.1:${port}/json/version`);
            if (response.ok) return response.json();
        } catch {
            // Not listening yet
        }
        await sleep(500);
    }
    throw new Error(`Nothing answered on DevTools port ${port} within ${timeoutMs / 1000}s`);
}

/** Signals that end a process when it crashes */
const CRASH_SIGNALS = new Set(['SIGABRT', 'SIGBUS', 'SIGFPE', 'SIGILL', 'SIGSEGV', 'SIGTRAP']);

/**
 * Stops the started app with SIGTERM, then with SIGKILL if it is still running after 10 seconds.
 * Returns how it went, or null when there is no app to stop.
 */
async function stopApp() {
    if (!app || app.exitedAt || opts['keep-open']) return null;
    // The app is the leader of its own process group, as it was started detached
    const target = opts['stop-all'] ? 'all of its processes' : 'its main process';
    const sentAt = Date.now();
    try {
        if (opts['stop-all']) process.kill(-app.pid, 'SIGTERM');
        else app.kill('SIGTERM');
    } catch (error) {
        // The app exited a moment ago
        record('app-quit', { target, result: `SIGTERM not sent: ${error.message}` });
    }
    while (!app.exitedAt && Date.now() - sentAt < 10000) await sleep(100);
    if (!app.exitedAt) {
        record('app-quit', { target, result: 'still running after 10s; sending SIGKILL to its process group' });
        try {
            process.kill(-app.pid, 'SIGKILL');
        } catch {
            app.kill('SIGKILL');
        }
        return { target, quit: false };
    }
    const seconds = ((app.exitedAt - sentAt) / 1000).toFixed(1);
    const appLog = fs.readFileSync(path.join(outDir, 'app.log'), 'utf8');
    const crashed = CRASH_SIGNALS.has(app.exitStatus.signal) || /GPU process isn't usable/.test(appLog);
    record('app-quit', { target, seconds, code: app.exitStatus.code, signal: app.exitStatus.signal, crashed });
    return {
        target,
        quit: true,
        seconds,
        crashed,
        how: app.exitStatus.signal ? `ended by ${app.exitStatus.signal}` : `exit code ${app.exitStatus.code}`,
    };
}

// --- Recording state ---------------------------------------------------------------------------

const targets = new Map(); // targetId -> { type, url, sessionId, openedAt, closedAt }
const sessions = new Map(); // sessionId -> targetId
const frameNames = new Map(); // frameId -> frame name
const frameUrls = new Map(); // frameId -> last committed URL
const frameErrors = new Map(); // frameId -> last failed document load
const requestFrames = new Map(); // requestId -> frameId
const documentResponses = []; // { frameId, url, status, topLevel, t }
const authWindows = []; // { targetId, openedAt, closedAt, closedBy, screenshots }
const mainLoads = []; // times the main window finished loading
const seen = new Set();
let mainTargetId = null;
let lastDocumentEventAt = Date.now();
let shotCount = 0;
let signInClickedAt = null;

function nameFrame(frameId, name) {
    if (!name || frameNames.get(frameId) === name) return;
    // A tab keeps its frame name across reloads, so the newest frame with a name wins.
    for (const [otherId, otherName] of frameNames) if (otherName === name) frameNames.delete(otherId);
    frameNames.set(frameId, name);
    record('frame-named', { id: `frame:${short(frameId)}`, is: frameLabel(frameId) });
}

function frameLabel(frameId) {
    if (!frameId) return undefined;
    if (frameId === mainTargetId) return 'main-window';
    if (targets.get(frameId)?.type === 'page') return `window:${short(frameId)}`;
    const name = frameNames.get(frameId);
    if (name?.startsWith(TAB_FRAME_PREFIX)) return `tab:${short(name.slice(TAB_FRAME_PREFIX.length))}`;
    return name ? `frame:${name.slice(0, 24)}` : `frame:${short(frameId)}`;
}

function isGoogleAccounts(url) {
    try {
        return new URL(url).hostname === 'accounts.google.com';
    } catch {
        return false;
    }
}

async function evaluate(sessionId, expression) {
    const result = await cdp.send(
        'Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise: true },
        sessionId
    );
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'evaluation failed');
    return result.result.value;
}

async function screenshot(sessionId, label) {
    try {
        const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
        const file = `${String(++shotCount).padStart(2, '0')}-${label}.png`;
        fs.writeFileSync(path.join(outDir, file), Buffer.from(data, 'base64'));
        record('screenshot', { file });
        return file;
    } catch (error) {
        record('screenshot-failed', { label, message: error.message });
        return null;
    }
}

const PAGE_TEXT_CHECK = `(() => {
    const text = document.body ? document.body.innerText : '';
    const problem = /401\\.|malformed|may not be secure|couldn.t sign you in|something went wrong/i.exec(text);
    return { title: document.title, problem: problem ? problem[0] : null };
})()`;

const SIGN_IN_FINDER = `(() => {
    const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const byText = [...document.querySelectorAll('a, button')].filter(
        (el) => /^\\s*sign in\\s*$/i.test(el.textContent || '') && visible(el));
    // A link to a sign-in page, by its path: when signed in, the account button links to accounts.google.com too
    const signInPage = (href) => {
        try {
            const url = new URL(href);
            return (url.hostname === 'accounts.google.com' && /^\\/(ServiceLogin|(v3\\/)?signin)/i.test(url.pathname)) ||
                (url.hostname === 'gemini.google.com' && url.pathname === '/signin');
        } catch {
            return false;
        }
    };
    const byLink = [...document.querySelectorAll('a[href]')].filter((el) => signInPage(el.href) && visible(el));
    const el = byText[0] || byLink[0];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { text: (el.textContent || '').trim().slice(0, 40), href: el.href || null, target: el.target || null,
        x: r.x + r.width / 2, y: r.y + r.height / 2 };
})()`;

// --- Main ----------------------------------------------------------------------------------------

let cdp;
let exitCode = 2;
try {
    if (opts.launch) launchApp();
    const version = await waitForDevTools(opts.launch ? 60000 : 5000);
    record('connected', { browser: version.Browser, port });
    cdp = new Cdp(version.webSocketDebuggerUrl);
    listen();
    await cdp.send('Target.setDiscoverTargets', { discover: true });
    await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });

    const mainSession = await waitForMainWindow(30000);
    const recordUntil = Date.now() + recordSeconds * 1000;
    if (opts.reload) {
        record('action', { do: 'reload the main window' });
        await cdp.send('Page.reload', {}, mainSession);
    }
    await waitForTabs(30000);
    await waitForQuiet(4000, 30000);
    await screenshot(mainSession, 'main-window');
    if (opts['sign-in']) await clickSignIn(mainSession);
    if (opts['navigate-tab']) await navigateTab(mainSession, opts['navigate-tab']);
    while (Date.now() < recordUntil) await sleep(250);
    await waitForQuiet(3000, 15000);
    await screenshot(mainSession, 'main-window-end');
    await reportTabState(mainSession);
    const stop = await stopApp();
    exitCode = summarize(stop) ? 0 : 1;
} catch (error) {
    record('script-failed', { message: error.message });
    exitCode = 2;
} finally {
    await stopApp();
    cdp?.close();
    traceFile.end();
    console.log(`\nResults are in ${outDir}`);
    // Let the trace file flush before exiting.
    setTimeout(() => process.exit(exitCode), 200);
}

function listen() {
    cdp.on('Target.targetCreated', ({ targetInfo }) => {
        if (targetInfo.type !== 'page' && targetInfo.type !== 'iframe') return;
        targets.set(targetInfo.targetId, {
            ...targets.get(targetInfo.targetId),
            type: targetInfo.type,
            url: targetInfo.url,
            openedAt: Date.now(),
        });
        if (targetInfo.type === 'page') {
            record('window-open', { target: short(targetInfo.targetId), url: tidyUrl(targetInfo.url) });
            if (mainTargetId && !isAppPage(targetInfo.url)) {
                authWindows.push({ targetId: targetInfo.targetId, openedAt: Date.now(), screenshots: 0 });
            }
        }
    });

    cdp.on('Target.targetInfoChanged', ({ targetInfo }) => {
        const known = targets.get(targetInfo.targetId);
        if (known) known.url = targetInfo.url;
    });

    cdp.on('Target.targetDestroyed', ({ targetId }) => {
        const known = targets.get(targetId);
        if (!known || known.closedAt) return;
        known.closedAt = Date.now();
        if (known.type !== 'page') return;
        record('window-closed', { target: short(targetId), url: tidyUrl(known.url) });
        const auth = authWindows.find((window) => window.targetId === targetId);
        if (auth) {
            auth.closedAt = Date.now();
            auth.closedBy ??= 'the app';
        }
    });

    cdp.on('Target.attachedToTarget', async ({ sessionId, targetInfo, waitingForDebugger }) => {
        sessions.set(sessionId, targetInfo.targetId);
        const commands = [];
        if (targetInfo.type === 'page' || targetInfo.type === 'iframe') {
            const known = targets.get(targetInfo.targetId) ?? { type: targetInfo.type, url: targetInfo.url };
            known.sessionId = sessionId;
            targets.set(targetInfo.targetId, known);
            commands.push(
                cdp.send('Network.enable', {}, sessionId),
                cdp.send('Page.enable', {}, sessionId),
                cdp.send(
                    'Target.setAutoAttach',
                    { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
                    sessionId
                )
            );
        }
        // A target paused at start answers only once it runs, so resume it alongside the commands above.
        if (waitingForDebugger) commands.push(cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId));
        try {
            await Promise.all(commands);
        } catch (error) {
            record('attach-failed', { type: targetInfo.type, message: error.message });
        }
        if (targetInfo.type === 'iframe') {
            nameFrame(targetInfo.targetId, await evaluate(sessionId, 'window.name').catch(() => null));
        }
    });

    cdp.on('Target.detachedFromTarget', ({ sessionId }) => sessions.delete(sessionId));

    cdp.on('Network.requestWillBeSent', (params) => {
        if (params.type !== 'Document') return;
        const key = `${params.requestId}|${params.request.url}|${Boolean(params.redirectResponse)}`;
        if (seen.has(key)) return;
        seen.add(key);
        lastDocumentEventAt = Date.now();
        requestFrames.set(params.requestId, params.frameId);
        const frame = frameLabel(params.frameId);
        if (params.redirectResponse) {
            record('redirect', {
                status: params.redirectResponse.status,
                from: tidyUrl(params.redirectResponse.url),
                to: tidyUrl(params.request.url),
                frame,
            });
        } else {
            record('request', { url: tidyUrl(params.request.url), frame });
        }
    });

    cdp.on('Network.responseReceived', (params) => {
        if (params.type !== 'Document') return;
        const key = `${params.requestId}|response`;
        if (seen.has(key)) return;
        seen.add(key);
        lastDocumentEventAt = Date.now();
        const topLevel = targets.get(params.frameId)?.type === 'page';
        documentResponses.push({
            frameId: params.frameId,
            url: params.response.url,
            status: params.response.status,
            topLevel,
            t: Date.now(),
        });
        record('response', {
            status: params.response.status,
            url: tidyUrl(params.response.url),
            frame: frameLabel(params.frameId),
        });
    });

    cdp.on('Network.loadingFailed', (params) => {
        if (params.type !== 'Document') return;
        const key = `${params.requestId}|failed`;
        if (seen.has(key)) return;
        seen.add(key);
        lastDocumentEventAt = Date.now();
        const frameId = requestFrames.get(params.requestId);
        if (!params.canceled) frameErrors.set(frameId, params.errorText);
        record('load-failed', {
            error: params.errorText,
            canceled: params.canceled || undefined,
            blocked: params.blockedReason,
            frame: frameLabel(frameId),
        });
    });

    cdp.on('Page.frameRequestedNavigation', ({ frameId, reason, url, disposition }) => {
        record('nav-requested', { url: tidyUrl(url), reason, disposition, frame: frameLabel(frameId) });
    });

    cdp.on('Page.frameNavigated', ({ frame }) => {
        nameFrame(frame.id, frame.name);
        frameUrls.set(frame.id, frame.url);
        if (!frame.url.startsWith('chrome-error:')) frameErrors.delete(frame.id);
        lastDocumentEventAt = Date.now();
        record('navigated', { url: tidyUrl(frame.url), frame: frameLabel(frame.id) });
    });

    cdp.on('Page.loadEventFired', async (_params, sessionId) => {
        const targetId = sessions.get(sessionId);
        if (!targetId) return;
        if (targetId === mainTargetId) {
            mainLoads.push(Date.now());
            record('main-loaded', {});
            return;
        }
        const auth = authWindows.find((window) => window.targetId === targetId);
        if (!auth || auth.screenshots >= 3) return;
        auth.screenshots++;
        const page = await evaluate(sessionId, PAGE_TEXT_CHECK).catch(() => null);
        record('auth-window', { title: page?.title, problem: page?.problem, url: tidyUrl(targets.get(targetId)?.url) });
        await screenshot(sessionId, 'sign-in-window');
        if (closeAuthAfter !== null && !auth.closeScheduled) {
            auth.closeScheduled = true;
            setTimeout(async () => {
                if (auth.closedAt) return;
                auth.closedBy = 'the script';
                record('action', { do: 'close the sign-in window' });
                await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
            }, closeAuthAfter * 1000);
        }
    });
}

function isAppPage(url) {
    return /^(file:|https?:\/\/localhost)/.test(url ?? '');
}

async function waitForMainWindow(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        for (const [targetId, target] of targets) {
            if (target.type === 'page' && target.sessionId && /\/index\.html/.test(target.url ?? '')) {
                mainTargetId = targetId;
                record('main-window', { target: short(targetId), url: tidyUrl(target.url) });
                return target.sessionId;
            }
        }
        await sleep(250);
    }
    throw new Error('The main window did not appear');
}

function tabTargets() {
    return [...targets.entries()].filter(
        ([targetId, target]) =>
            target.type === 'iframe' &&
            !target.closedAt &&
            (frameNames.get(targetId) ?? '').startsWith(TAB_FRAME_PREFIX)
    );
}

async function waitForTabs(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && tabTargets().length === 0) await sleep(250);
    if (tabTargets().length === 0) record('note', { message: 'no tab frame loaded a web page' });
}

async function waitForQuiet(quietMs, maxMs) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline && Date.now() - lastDocumentEventAt < quietMs) await sleep(250);
}

/** The visible tab: its frame name, where it sits in the main window and its DevTools session. */
async function visibleTab(mainSession) {
    const tab = await evaluate(
        mainSession,
        `(() => {
            const frame = [...document.querySelectorAll('iframe')].find((f) => f.offsetParent !== null);
            if (!frame) return null;
            const r = frame.getBoundingClientRect();
            return { name: frame.name, x: r.x, y: r.y };
        })()`
    );
    if (!tab) return null;
    const target = tabTargets().find(([targetId]) => frameNames.get(targetId) === tab.name);
    return { ...tab, sessionId: target?.[1].sessionId };
}

async function navigateTab(mainSession, url) {
    const tab = await visibleTab(mainSession);
    if (!tab?.sessionId) return record('navigate-tab', { result: 'the visible tab has no web page' });
    record('action', { do: 'send the visible tab to a URL', url: tidyUrl(url) });
    await evaluate(tab.sessionId, `location.href = ${JSON.stringify(url)}`).catch((error) =>
        record('navigate-tab', { result: error.message })
    );
    signInClickedAt ??= Date.now();
}

async function clickSignIn(mainSession) {
    const tab = await visibleTab(mainSession);
    if (!tab) return record('sign-in', { result: 'no visible tab' });
    if (!tab.sessionId) return record('sign-in', { result: 'the visible tab has no web page' });
    const button = await evaluate(tab.sessionId, SIGN_IN_FINDER);
    if (!button) return record('sign-in', { result: 'no Sign in button in the tab (signed in already?)' });
    const x = tab.x + button.x;
    const y = tab.y + button.y;
    record('action', { do: 'click Sign in', text: button.text, href: tidyUrl(button.href), target: button.target });
    signInClickedAt = Date.now();
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, mainSession);
    await cdp.send(
        'Input.dispatchMouseEvent',
        { type: 'mousePressed', x, y, button: 'left', clickCount: 1 },
        mainSession
    );
    await cdp.send(
        'Input.dispatchMouseEvent',
        { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 },
        mainSession
    );
}

async function reportTabState(mainSession) {
    const frames = await evaluate(
        mainSession,
        `[...document.querySelectorAll('iframe')].map((f) => ({ name: f.name, visible: f.offsetParent !== null }))`
    ).catch(() => []);
    for (const frame of frames) {
        const frameId = [...frameNames].find(([, name]) => name === frame.name)?.[0];
        const target = frameId ? targets.get(frameId) : undefined;
        const url = frameId ? (frameUrls.get(frameId) ?? target?.url) : undefined;
        frame.url = url;
        frame.error = url?.startsWith('chrome-error:') ? (frameErrors.get(frameId) ?? 'load failed') : undefined;
        let signedIn;
        if (target?.sessionId && !target.closedAt && url?.startsWith('https://gemini.google.com/')) {
            const button = await evaluate(target.sessionId, SIGN_IN_FINDER).catch(() => undefined);
            if (button !== undefined) signedIn = button === null;
        }
        record('tab', {
            tab: frameLabel(frameId) ?? frame.name,
            visible: frame.visible,
            url: frame.error ? `error page (${frame.error})` : url ? tidyUrl(url) : 'no web page (blank)',
            signedIn,
        });
    }
    reportTabState.frames = frames;
}

function summarize(stop) {
    const lines = [];
    const checks = [];
    const check = (passed, text) => checks.push(`${passed ? 'PASS' : 'FAIL'}  ${text}`);

    const framedSignIn = documentResponses.filter((r) => !r.topLevel && isGoogleAccounts(r.url) && r.status >= 400);
    check(
        framedSignIn.length === 0,
        framedSignIn.length === 0
            ? 'Google sign-in never loaded inside a tab or frame'
            : `Google answered ${framedSignIn.length} page(s) inside a frame with an error: ${framedSignIn
                  .map((r) => `${r.status} ${tidyUrl(r.url)}`)
                  .join(', ')}`
    );

    const frames = reportTabState.frames ?? [];
    const offGemini = frames.filter((f) => f.error || !f.url?.startsWith('https://gemini.google.com/'));
    check(
        frames.length > 0 && offGemini.length === 0,
        frames.length === 0
            ? 'No tabs found in the main window'
            : offGemini.length === 0
              ? `All ${frames.length} tab(s) end on Gemini`
              : `${offGemini.length} of ${frames.length} tab(s) end off Gemini: ${offGemini
                    .map((f) => (f.error ? `error page (${f.error})` : f.url ? tidyUrl(f.url) : 'blank'))
                    .join(', ')}`
    );

    if (signInClickedAt) {
        const opened = authWindows.filter((w) => w.openedAt >= signInClickedAt);
        check(opened.length > 0, opened.length > 0 ? 'A sign-in window opened' : 'No sign-in window opened');
        for (const window of opened) {
            const closedAfter = window.closedAt
                ? `closed by ${window.closedBy} after ${((window.closedAt - window.openedAt) / 1000).toFixed(1)}s`
                : 'still open';
            lines.push(`Sign-in window: ${closedAfter}`);
            if (window.closedAt) {
                const reloaded = mainLoads.some((t) => t >= window.closedAt);
                check(
                    reloaded,
                    reloaded
                        ? 'The main window reloaded after the sign-in window closed'
                        : 'The main window did not reload after the sign-in window closed'
                );
            }
        }
    }

    if (stop) {
        check(
            stop.quit && !stop.crashed,
            !stop.quit
                ? `The app was still running 10s after SIGTERM to ${stop.target}`
                : stop.crashed
                  ? `The app crashed while quitting after SIGTERM to ${stop.target} (${stop.how}; see app.log)`
                  : `The app quit ${stop.seconds}s after SIGTERM to ${stop.target} (${stop.how})`
        );
    }

    const summary = [...checks, ...lines].join('\n');
    fs.writeFileSync(path.join(outDir, 'summary.txt'), `${summary}\n`);
    console.log(`\n${summary}`);
    return checks.every((line) => line.startsWith('PASS'));
}
