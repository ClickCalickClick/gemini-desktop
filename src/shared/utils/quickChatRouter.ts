/**
 * Quick Chat Router
 *
 * Decides per prompt whether Quick Chat sends it to a Gemini web tab or to the
 * local agent CLI. The rules are deterministic and every decision carries a short
 * reason the UI shows as a tooltip, so the user can see why and override it.
 *
 * Pure TypeScript: no Electron, DOM or Node imports, so main, preload and renderer
 * can all use it.
 *
 * Order of the rules in auto mode:
 * 1. A path or a file name (strong local cue) → agent (files, documents or code).
 * 2. Web cues (images, video, Deep Research, Canvas, Gems, web search, news, weather) → web.
 * 3. A well-known folder (Downloads, Documents, ...) → agent (files or documents).
 * 4. Code in a local repository (repo, git status, run the tests, ...) → agent/code.
 * 5. System questions (disk space, CPU, packages, services, logs, ...) → agent/system.
 * 6. Anything else → web, "general question".
 *
 * @module quickChatRouter
 */

import type { AgentTaskCategory, QuickChatRoute, QuickChatRoutingMode, RouteDecision } from '../types/agent';

// ============================================================================
// Types
// ============================================================================

export interface RouteOptions {
    /** Routing preference from Options. */
    mode: QuickChatRoutingMode;
    /** Whether an agent CLI is installed and usable. */
    agentAvailable: boolean;
    /**
     * True while Quick Chat shows an agent conversation that can be continued. In auto
     * mode, prompts without a prefix or a web cue then go to the agent as a follow-up.
     */
    followUp?: boolean;
}

/** Result of classifying a prompt without looking at the mode or the agent's availability. */
export interface PromptClassification {
    route: QuickChatRoute;
    /** Set when route is 'agent'. */
    category?: AgentTaskCategory;
    reason: string;
}

/** A routing prefix found at the start of a prompt. */
export interface RoutePrefix {
    route: QuickChatRoute;
    /** The prefix as typed, e.g. "@agent". */
    prefix: string;
    /** The prompt without the prefix. */
    rest: string;
}

// ============================================================================
// Labels and reasons
// ============================================================================

/** Short labels for the route chip, e.g. "Agent · Files". */
export const AGENT_CATEGORY_LABELS: Record<AgentTaskCategory, string> = {
    files: 'Files',
    system: 'System',
    documents: 'Documents',
    code: 'Code',
    general: 'General',
};

export const WEB_ROUTE_LABEL = 'Gemini';
export const AGENT_ROUTE_LABEL = 'Agent';

export const ROUTE_REASONS = {
    general: 'general question',
    agentUnavailable: 'no agent CLI installed',
    modeWeb: 'Options: always the Gemini tab',
    modeAgent: 'Options: always the agent',
    pickedWeb: 'you picked Gemini',
    pickedAgent: 'you picked the agent',
    followUp: 'follow-up to the agent',
} as const;

/** Chip label for a decision: "Gemini", "Agent" or "Agent · Files". */
export function describeRoute(decision: Pick<RouteDecision, 'route' | 'category'>): string {
    if (decision.route === 'web') {
        return WEB_ROUTE_LABEL;
    }
    if (!decision.category || decision.category === 'general') {
        return AGENT_ROUTE_LABEL;
    }
    return `${AGENT_ROUTE_LABEL} · ${AGENT_CATEGORY_LABELS[decision.category]}`;
}

// ============================================================================
// Prefixes
// ============================================================================

const PREFIX_ROUTES: Record<string, QuickChatRoute> = {
    '@web': 'web',
    '@gemini': 'web',
    '@agent': 'agent',
    '@cli': 'agent',
    '@local': 'agent',
    '/web': 'web',
    '/agent': 'agent',
};

const PREFIX_PATTERN = /^\s*(@web|@gemini|@agent|@cli|@local|\/web|\/agent)(?=\s|$)/i;

/** Find a routing prefix (`@web`, `@gemini`, `@agent`, `@cli`, `@local`, `/web`, `/agent`). */
export function parseRoutePrefix(text: string): RoutePrefix | null {
    const match = PREFIX_PATTERN.exec(text);
    if (!match) {
        return null;
    }
    const prefix = match[1] ?? '';
    const route = PREFIX_ROUTES[prefix.toLowerCase()];
    if (!route) {
        return null;
    }
    return {
        route,
        prefix,
        rest: text.slice(match[0].length).trim(),
    };
}

// ============================================================================
// Heuristics (exported so the UI and tests can reuse them)
// ============================================================================

/** File name extensions by kind, used to recognise file names such as `report.pdf`. */
export const FILE_EXTENSIONS = {
    documents: [
        'pdf',
        'doc',
        'docx',
        'odt',
        'rtf',
        'txt',
        'md',
        'markdown',
        'epub',
        'ppt',
        'pptx',
        'odp',
        'xls',
        'xlsx',
        'ods',
        'csv',
        'tsv',
        'log',
    ],
    code: [
        'ts',
        'tsx',
        'js',
        'jsx',
        'mjs',
        'cjs',
        'py',
        'rs',
        'go',
        'c',
        'h',
        'cpp',
        'hpp',
        'java',
        'kt',
        'rb',
        'php',
        'sh',
        'css',
        'html',
        'json',
        'yaml',
        'yml',
        'toml',
        'xml',
        'ini',
        'conf',
        'cfg',
    ],
    media: [
        'png',
        'jpg',
        'jpeg',
        'gif',
        'webp',
        'heic',
        'bmp',
        'tiff',
        'svg',
        'mp3',
        'wav',
        'flac',
        'ogg',
        'm4a',
        'mp4',
        'mkv',
        'mov',
        'avi',
        'webm',
    ],
    archives: [
        'zip',
        'tar',
        'gz',
        'tgz',
        'bz2',
        'xz',
        '7z',
        'rar',
        'iso',
        'deb',
        'rpm',
        'appimage',
        'dmg',
        'exe',
        'msi',
    ],
} as const;

const ALL_EXTENSIONS = Object.values(FILE_EXTENSIONS).flat();

/** Library names that look like file names but are not ("node.js", "Alpine.js"). */
const NOT_FILE_NAMES =
    /^(?:node|vue|next|nuxt|react|three|d3|chart|express|ember|backbone|socket|p5|deno|bun|alpine|svelte|solid|angular|moment|lodash|jquery|anime|htmx|preact|ext|pixi|babylon|phaser|leaflet|paper|fabric|tone|ml5|brain|tensorflow)\.js$/i;

/** URLs and host names ("https://...", "www.x.y", "theverge.com/review.html") are not local files. */
const URL_LIKE =
    /^(?:[a-z][a-z0-9+.-]*:\/\/|www\.)|^[\w-]+(?:\.[\w-]+)*\.(?:com|org|net|io|dev|ai|app|co|edu|gov|me|info|tv|uk|de|fr|eu|us|ca|au|ly|gg|so|xyz|site|blog|news)(?:[/:?#]|$)/i;

/** Paths: `~/`, `/home/`, `/Users/`, `./`, `../`, a few system folders, and Windows drive paths. */
export const PATH_PATTERN =
    /(?:^|[\s"'(`])(?:~[/\\]|~(?=$|[\s"'),.;:!?])|\.{1,2}\/|\/(?:home|Users|root|tmp|etc|var|usr|opt|mnt|media|srv)\/|[A-Za-z]:[\\/])/;

const FILE_NAME_PATTERN = new RegExp(
    `(?:^|[\\s"'(\`])([\\w\\-.*/~:]*\\.(${ALL_EXTENSIONS.join('|')}))(?=$|[\\s"'),;:!?]|\\.(?:\\s|$))`,
    'gi'
);

/** A file name in quotes or backticks ("my report.pdf"), which always counts. */
const QUOTED_FILE_NAME_PATTERN = new RegExp(`["'\`]([^"'\`\\n]{2,}\\.(${ALL_EXTENSIONS.join('|')}))["'\`]`, 'gi');

/** Well-known folders: "my Downloads", "Documents folder", "the home folder", "in Downloads". */
export const FOLDER_PATTERN = new RegExp(
    [
        String.raw`\b(?:downloads|documents|desktop|pictures|photos|music|videos|screenshots|home)\s+(?:folder|directory|dir)\b`,
        String.raw`\bhome\s+(?:folder|directory|dir)\b`,
        String.raw`\bmy\s+(?:downloads|documents|desktop|pictures|photos|music|videos|screenshots|files|folders)\b`,
        String.raw`\b(?:in|from|to|into|on|under)\s+(?:the\s+)?(?:downloads|documents|desktop)\b`,
    ].join('|'),
    'i'
);

/** Verbs that change files: always end in a plan the user confirms. */
export const FILE_CHANGE_VERBS =
    /\b(?:move|moving|copy|copying|rename|renaming|organi[sz]e|organi[sz]ing|sort|sorting|clean\s*up|cleanup|tidy(?:\s+up)?|delete|deleting|remove|removing|trash|unzip|untar|extract\s+(?:the\s+|this\s+|all\s+)?(?:zip|archive|tar)|compress|zip\s+up|archive|sync|back\s*up|dedupe|deduplicate|make\s+a\s+folder|create\s+a\s+folder|mkdir)\b/i;

/** Verbs that only look for or list files. */
export const FILE_FIND_VERBS =
    /\b(?:find|list|search|locate|show|which|count|how\s+many|largest|biggest|oldest|newest|recent|what'?s\s+in|what\s+is\s+in)\b/i;

/** Verbs that ask to read or explain a document. */
export const DOCUMENT_READ_VERBS =
    /\b(?:summari[sz]e|summary|tl;?dr|read|explain|translate|proofread|review|outline|key\s+points|compare|what\s+does\s+.+\s+say|what\s+is\s+(?:this|it)\s+about)\b/i;

/**
 * Words that tie a question to this machine. System topics only count with one of
 * these, so "What is RAM?" stays with Gemini and "what's using memory on this machine" does not.
 */
export const LOCAL_ANCHOR_PATTERN = new RegExp(
    [
        String.raw`\b(?:my|this|our)\s+(?:computer|laptop|pc|machine|system|mac|macbook|workstation|box|disks?|drives?|ssd|hard\s+drive|partition|install|installation|setup|distro|os)\b`,
        String.raw`\bmy\s+(?:wi-?fi|battery|cpu|gpu|ram|memory|kernel|network|internet|bluetooth|fans?|processes|services|packages|logs|storage|space)\b`,
        String.raw`\bdo\s+i\s+have\b`,
        String.raw`\b(?:is|are)\s+(?:left|free|running)\b`,
        String.raw`\b(?:is|are)\s+[\w.+-]+\s+installed\b`,
        String.raw`\binstalled\s+(?:here|on\s+(?:my|this))\b`,
        String.raw`\bon\s+here\b`,
        String.raw`\b(?:am\s+i|i'?m)\s+(?:running|using|on)\b`,
    ].join('|'),
    'i'
);

/** The device itself, which is local on its own ("why is my computer slow"). */
const DEVICE_PATTERN = /\b(?:my|this)\s+(?:computer|laptop|pc|machine|macbook|workstation)\b/i;

/** System topics; they need {@link LOCAL_ANCHOR_PATTERN} to count. */
export const SYSTEM_TOPIC_PATTERN = new RegExp(
    [
        String.raw`\bdisk\s+(?:space|usage|use)\b`,
        String.raw`\bfree\s+space\b`,
        String.raw`\bstorage\b`,
        String.raw`\bspace\b`,
        String.raw`\bcpu\b`,
        String.raw`\bgpu\b`,
        String.raw`\bram\b`,
        String.raw`\bmemory\b`,
        String.raw`\bprocess(?:es)?\b`,
        String.raw`\bservices?\b`,
        String.raw`\bpackages?\b`,
        String.raw`\binstalled\b`,
        String.raw`\bwi-?fi\b`,
        String.raw`\bnetwork\b`,
        String.raw`\binternet\b`,
        String.raw`\bbluetooth\b`,
        String.raw`\bbattery\b`,
        String.raw`\bkernel\b`,
        String.raw`\blogs?\b`,
        String.raw`\bpacman\b`,
        String.raw`\bparu\b`,
        String.raw`\byay\b`,
        String.raw`\bapt(?:-get)?\b`,
        String.raw`\bdnf\b`,
        String.raw`\bflatpak\b`,
        String.raw`\buptime\b`,
        String.raw`\bip\s+address\b`,
        String.raw`\bfans?\b`,
        String.raw`\btemperature\b`,
    ].join('|'),
    'i'
);

/** Commands and phrases that only make sense on this machine, with or without an anchor. */
export const SYSTEM_STRONG_PATTERN =
    /\bjournalctl\b|\bsystemctl\b|\bsystemd\s+(?:unit|service)s?\b|\bfailed\s+services\b/i;

/** Code in a local repository: needs "my project", "this repo", a version-control command and the like. */
export const CODE_PATTERN = new RegExp(
    [
        String.raw`\b(?:my|this|our)\s+(?:project|repo|repository|codebase|code|branch|tests?|build)\b`,
        String.raw`\b(?:in|of)\s+this\s+(?:folder|directory)\b`,
        String.raw`\bgit\s+(?:status|log|diff|branch|stash|blame)\b`,
    ].join('|'),
    'i'
);

/** Things only the Gemini web app does well. These override folder, system and code cues. */
export const WEB_CUES: { pattern: RegExp; reason: string }[] = [
    {
        pattern:
            /\b(?:generate|create|make|design|render)\s+(?:me\s+)?(?:an?\s+|some\s+|the\s+)?(?:new\s+)?(?:image|picture|photo|illustration|logo|drawing|painting|wallpaper|icon|sticker)s?\b/i,
        reason: 'asks for an image',
    },
    { pattern: /\b(?:draw|sketch|paint|illustrate)\b/i, reason: 'asks for an image' },
    {
        pattern:
            /\b(?:generate|create|make|render)\s+(?:me\s+)?(?:an?\s+|some\s+|the\s+)?(?:short\s+)?(?:video|animation|clip)s?\b|\bveo\b/i,
        reason: 'asks for a video',
    },
    { pattern: /\bdeep\s+research\b/i, reason: 'asks for Deep Research' },
    { pattern: /\bcanvas\b/i, reason: 'asks for Canvas' },
    { pattern: /\bgems?\b/i, reason: 'mentions a Gem' },
    { pattern: /\bgemini\s+live\b|\bvoice\s+chat\b/i, reason: 'asks for Gemini Live' },
    {
        pattern:
            /\bsearch\s+(?:the\s+)?(?:web|internet|online)\b|\bgoogle\s+(?:it|this|that|for)\b|\bon\s+the\s+web\b/i,
        reason: 'asks to search the web',
    },
    {
        pattern:
            /\bnews\b|\bheadlines\b|\bcurrent\s+events\b|\bweather\b|\bforecast\b|\bstock\s+price\b|\bscores?\s+(?:today|tonight|last\s+night)\b/i,
        reason: 'asks about current events',
    },
    { pattern: /\byoutube\b/i, reason: 'mentions YouTube' },
];

// ============================================================================
// Classification
// ============================================================================

type FileKind = keyof typeof FILE_EXTENSIONS;

/** Kind of file for an extension. */
function fileKindOf(extension: string): FileKind | undefined {
    return (Object.keys(FILE_EXTENSIONS) as FileKind[]).find((key) =>
        (FILE_EXTENSIONS[key] as readonly string[]).includes(extension.toLowerCase())
    );
}

/** True when a bare token looks like a local file name rather than a URL, host, abbreviation or library. */
function looksLikeFileName(name: string): boolean {
    if (URL_LIKE.test(name) || name.includes(':')) {
        return false;
    }
    const base = name.split('/').pop() ?? name;
    const stem = base.slice(0, base.lastIndexOf('.'));
    // At least two characters before the dot ("*.iso" is a pattern and counts), and no abbreviations like "D.C".
    if (!stem.includes('*') && stem.replace(/\./g, '').length < 2) {
        return false;
    }
    if (/^(?:[A-Za-z]\.)+[A-Za-z]$/.test(base)) {
        return false;
    }
    if (!name.includes('/') && (NOT_FILE_NAMES.test(base) || /^[A-Z][a-z0-9]*\.js$/.test(base))) {
        return false;
    }
    return true;
}

/**
 * File names in the prompt, e.g. `report.pdf` or `src/main.ts`, with the kind of their extension.
 * Quoted names always count; bare names skip URLs, hosts, abbreviations ("D.C.") and libraries ("Alpine.js").
 */
export function findFileNames(text: string): { name: string; kind: FileKind; quoted: boolean }[] {
    const found: { name: string; kind: FileKind; quoted: boolean }[] = [];
    for (const match of text.matchAll(QUOTED_FILE_NAME_PATTERN)) {
        const name = match[1] ?? '';
        const kind = fileKindOf(match[2] ?? '');
        if (kind && !URL_LIKE.test(name)) {
            found.push({ name, kind, quoted: true });
        }
    }
    for (const match of text.matchAll(FILE_NAME_PATTERN)) {
        const name = match[1] ?? '';
        const kind = fileKindOf(match[2] ?? '');
        if (!kind || !name || !looksLikeFileName(name) || found.some((file) => file.name.endsWith(name))) {
            continue;
        }
        found.push({ name, kind, quoted: false });
    }
    return found;
}

/** The web cue in the prompt, if any. */
export function findWebCue(text: string): string | null {
    const cue = WEB_CUES.find(({ pattern }) => pattern.test(text));
    return cue ? cue.reason : null;
}

/** Category for a prompt that clearly points at local files or folders. */
function classifyLocal(text: string, fileKinds: FileKind[], place: 'path' | 'file' | 'folder'): PromptClassification {
    if (FILE_CHANGE_VERBS.test(text)) {
        return { route: 'agent', category: 'files', reason: 'asks to change files' };
    }
    if (DOCUMENT_READ_VERBS.test(text)) {
        if (fileKinds.includes('code') && !fileKinds.includes('documents')) {
            return { route: 'agent', category: 'code', reason: 'asks about a code file' };
        }
        return { route: 'agent', category: 'documents', reason: 'asks about a document' };
    }
    if (FILE_FIND_VERBS.test(text)) {
        return { route: 'agent', category: 'files', reason: 'looks for files' };
    }
    if (fileKinds.includes('documents')) {
        return { route: 'agent', category: 'documents', reason: 'mentions a document' };
    }
    if (fileKinds.includes('code')) {
        return { route: 'agent', category: 'code', reason: 'mentions a code file' };
    }
    const reasons = { path: 'mentions a path', file: 'mentions a file', folder: 'mentions a folder' };
    return { route: 'agent', category: 'files', reason: reasons[place] };
}

/**
 * Classify a prompt (without a prefix) by the auto-mode rules.
 * Does not look at the routing mode or whether an agent is installed.
 */
export function classifyPrompt(text: string): PromptClassification {
    const fileNames = findFileNames(text);
    const fileKinds = fileNames.map((file) => file.kind);
    const hasPath = PATH_PATTERN.test(text);

    // 1. Strong local cues: a path or a quoted file name.
    if (hasPath || fileNames.some((file) => file.quoted)) {
        return classifyLocal(text, fileKinds, hasPath ? 'path' : 'file');
    }

    // 2. Web cues beat the weaker local cues below.
    const webCue = findWebCue(text);
    if (webCue) {
        return { route: 'web', reason: webCue };
    }

    // 3. Bare file names and well-known folders.
    if (fileNames.length > 0) {
        return classifyLocal(text, fileKinds, 'file');
    }
    if (FOLDER_PATTERN.test(text)) {
        return classifyLocal(text, fileKinds, 'folder');
    }

    // 4. Code in a local repository.
    if (CODE_PATTERN.test(text)) {
        return { route: 'agent', category: 'code', reason: 'asks about local code' };
    }

    // 5. Questions about this machine: a system topic with a local anchor, or the device itself.
    if (
        SYSTEM_STRONG_PATTERN.test(text) ||
        DEVICE_PATTERN.test(text) ||
        (SYSTEM_TOPIC_PATTERN.test(text) && LOCAL_ANCHOR_PATTERN.test(text))
    ) {
        return { route: 'agent', category: 'system', reason: 'asks about this computer' };
    }

    return { route: 'web', reason: ROUTE_REASONS.general };
}

/** The agent category a prompt would get, or 'general' when no agent rule matched. */
export function agentCategoryFor(text: string): AgentTaskCategory {
    return classifyPrompt(text).category ?? 'general';
}

// ============================================================================
// Routing
// ============================================================================

/**
 * Decide where a Quick Chat prompt goes.
 *
 * - A prefix (`@web`, `@gemini`, `@agent`, `@cli`, `@local`, `/web`, `/agent`) wins and is stripped.
 * - Mode 'web' or 'agent' forces that route; 'auto' uses {@link classifyPrompt}.
 * - An agent route without an installed agent falls back to web, unless a prefix forced it.
 */
export function routePrompt(text: string, options: RouteOptions): RouteDecision {
    const prefix = parseRoutePrefix(text);
    const prompt = prefix ? prefix.rest : text.trim();

    if (prefix) {
        return {
            route: prefix.route,
            category: prefix.route === 'agent' ? agentCategoryFor(prompt) : undefined,
            reason: `you typed ${prefix.prefix.toLowerCase()}`,
            forced: true,
            prompt,
        };
    }

    let decision: PromptClassification;
    if (options.mode === 'web') {
        decision = { route: 'web', reason: ROUTE_REASONS.modeWeb };
    } else if (options.mode === 'agent') {
        decision = { route: 'agent', category: agentCategoryFor(prompt), reason: ROUTE_REASONS.modeAgent };
    } else {
        decision = classifyPrompt(prompt);
        if (options.followUp && !findWebCue(prompt)) {
            decision = {
                route: 'agent',
                category: decision.category ?? 'general',
                reason: ROUTE_REASONS.followUp,
            };
        }
    }

    if (decision.route === 'agent' && !options.agentAvailable) {
        return { route: 'web', reason: ROUTE_REASONS.agentUnavailable, forced: false, prompt };
    }

    return { ...decision, forced: false, prompt };
}

/**
 * Force a route for a prompt (the chip toggle or Ctrl+Enter). Any prefix is stripped.
 * The agent category still comes from the auto-mode rules.
 */
export function forceRoute(text: string, route: QuickChatRoute): RouteDecision {
    const prefix = parseRoutePrefix(text);
    const prompt = prefix ? prefix.rest : text.trim();
    if (route === 'web') {
        return { route: 'web', reason: ROUTE_REASONS.pickedWeb, forced: true, prompt };
    }
    return {
        route: 'agent',
        category: agentCategoryFor(prompt),
        reason: ROUTE_REASONS.pickedAgent,
        forced: true,
        prompt,
    };
}

/** The other route. */
export function otherRoute(route: QuickChatRoute): QuickChatRoute {
    return route === 'web' ? 'agent' : 'web';
}
