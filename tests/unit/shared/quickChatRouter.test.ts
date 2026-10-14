/**
 * Unit tests for the Quick Chat router (H4).
 */

import { describe, it, expect } from 'vitest';

import {
    classifyPrompt,
    describeRoute,
    findFileNames,
    forceRoute,
    otherRoute,
    parseRoutePrefix,
    routePrompt,
    ROUTE_REASONS,
} from '../../../src/shared/utils/quickChatRouter';
import type { AgentTaskCategory, QuickChatRoute } from '../../../src/shared/types/agent';

const AUTO = { mode: 'auto' as const, agentAvailable: true };

type Case = [prompt: string, route: QuickChatRoute, category?: AgentTaskCategory];

describe('quickChatRouter', () => {
    describe('auto mode', () => {
        const cases: Case[] = [
            // Files: paths
            ['move ~/Downloads/*.pdf to ~/Documents/PDFs', 'agent', 'files'],
            ['rename the photos in /home/jared/Pictures/2024 by date', 'agent', 'files'],
            ['copy ./build/output.log to my desktop', 'agent', 'files'],
            ['delete C:\\Users\\me\\Downloads\\old', 'agent', 'files'],
            ['what is in ~/Projects', 'agent', 'files'],
            ['~/notes', 'agent', 'files'],
            // Files: folder names with verbs
            ['organise my Downloads folder by file type', 'agent', 'files'],
            ['organize my downloads', 'agent', 'files'],
            ['clean up my Desktop', 'agent', 'files'],
            ['sort my photos into folders by year', 'agent', 'files'],
            ['trash the screenshots folder', 'agent', 'files'],
            ['unzip everything in Downloads', 'agent', 'files'],
            ['compress my Documents folder', 'agent', 'files'],
            ['sync my Music folder to the USB drive', 'agent', 'files'],
            ['find the biggest files in my home folder', 'agent', 'files'],
            ['list my Videos', 'agent', 'files'],
            ['what is in the Downloads directory', 'agent', 'files'],
            // Files: file names
            ['rename IMG_0001.jpg to holiday.jpg', 'agent', 'files'],
            ['unzip archive.tar.gz', 'agent', 'files'],
            ['where is invoice.png', 'agent', 'files'],
            ['find every *.iso and delete them', 'agent', 'files'],
            // Documents
            ['summarise report.pdf', 'agent', 'documents'],
            ['summarize ~/Documents/thesis.docx in five bullet points', 'agent', 'documents'],
            ['summarize ~/Documents/report.pdf', 'agent', 'documents'],
            ['summarise "Q3 report.pdf"', 'agent', 'documents'],
            ['explain what contract.pdf says about termination', 'agent', 'documents'],
            ['translate notes.txt into German', 'agent', 'documents'],
            ['budget.xlsx', 'agent', 'documents'],
            ['proofread my Documents/letter.odt', 'agent', 'documents'],
            // Code
            ['explain src/main.ts', 'agent', 'code'],
            ['what does app.py do', 'agent', 'code'],
            ['git status of my project', 'agent', 'code'],
            ['run the tests in this repo', 'agent', 'code'],
            ['why does the build fail in my project', 'agent', 'code'],
            ['find the TODOs in this codebase', 'agent', 'code'],
            ['npm install fails in this repo', 'agent', 'code'],
            ['run the tests in my project', 'agent', 'code'],
            ['git diff', 'agent', 'code'],
            // System
            ['how much disk space do I have left', 'agent', 'system'],
            ['how much disk space is left on my laptop', 'agent', 'system'],
            ['why is my computer slow', 'agent', 'system'],
            ["what's using memory on this machine", 'agent', 'system'],
            ['what is using all my CPU', 'agent', 'system'],
            ['how much RAM is free', 'agent', 'system'],
            ['show running processes on this machine', 'agent', 'system'],
            ['are there any failed services', 'agent', 'system'],
            ['is ffmpeg installed', 'agent', 'system'],
            ['why is my wifi slow', 'agent', 'system'],
            ['how is my battery health', 'agent', 'system'],
            ['which kernel am I running', 'agent', 'system'],
            ['show the journalctl errors since boot', 'agent', 'system'],
            ['pacman on my laptop says the keyring is out of date', 'agent', 'system'],
            ['restart the systemd unit for docker', 'agent', 'system'],
            ['check the logs on this machine for errors', 'agent', 'system'],
            ['how old is my laptop', 'agent', 'system'],
            ['which packages are installed on here', 'agent', 'system'],
            // Ordinary questions that mention system or code words stay with Gemini
            ['How does human memory work?', 'web'],
            ["What's the best GPU under $500?", 'web'],
            ['How do I brew better coffee?', 'web'],
            ['Why does my phone battery drain so fast?', 'web'],
            ['Is bluetooth 5.3 backward compatible?', 'web'],
            ['Explain the Linux kernel scheduler', 'web'],
            ['What is RAM?', 'web'],
            ['Find me a good repo for learning Rust', 'web'],
            ['What is a makefile?', 'web'],
            ['What is the weather in Washington D.C. today?', 'web'],
            ['how do I set up Alpine.js', 'web'],
            ['Summarize theverge.com/review.html', 'web'],
            ['how do I fix apt lock errors', 'web'],
            ['what does e.g. mean', 'web'],
            ['is Vue.js better than React', 'web'],
            ['open www.example.com/index.html', 'web'],
            ['weather forecast for budget.xlsx fans', 'web'],
            // Web cues
            ['draw a cat wearing a hat', 'web'],
            ['generate an image of a lighthouse at dusk', 'web'],
            ['make a picture of my desktop setup', 'web'],
            ['create a short video of waves', 'web'],
            ['deep research on solid state batteries', 'web'],
            ['open this in canvas', 'web'],
            ['use my coding gem', 'web'],
            ['search the web for battery tips', 'web'],
            ['latest news about the kernel', 'web'],
            ["what's today's weather in Berlin", 'web'],
            ['start a voice chat', 'web'],
            // General
            ['what is the capital of France', 'web'],
            ['write a haiku about autumn', 'web'],
            ['how do I log in to my bank', 'web'],
            ['what is node.js', 'web'],
            ['find a good recipe for lasagne', 'web'],
            ['the process of photosynthesis', 'web'],
            ['compare cloud storage plans', 'web'],
            ['https://example.com/photo.png what is this', 'web'],
            ['', 'web'],
        ];

        it.each(cases)('%j → %s %s', (prompt, route, category) => {
            const decision = routePrompt(prompt, AUTO);
            expect(decision.route).toBe(route);
            expect(decision.category).toBe(category);
            expect(decision.forced).toBe(false);
            expect(decision.reason.length).toBeGreaterThan(0);
        });

        it('gives the general reason by default', () => {
            expect(routePrompt('tell me a joke', AUTO).reason).toBe(ROUTE_REASONS.general);
        });

        it('explains web cues', () => {
            expect(routePrompt('draw a dragon', AUTO).reason).toBe('asks for an image');
            expect(routePrompt('deep research on tides', AUTO).reason).toBe('asks for Deep Research');
        });

        it('trims the prompt', () => {
            expect(routePrompt('  hello  ', AUTO).prompt).toBe('hello');
        });
    });

    describe('prefixes', () => {
        const cases: [string, QuickChatRoute, string][] = [
            ['@web organise my Downloads folder', 'web', 'organise my Downloads folder'],
            ['@gemini how much disk space is left', 'web', 'how much disk space is left'],
            ['@agent what is the capital of France', 'agent', 'what is the capital of France'],
            ['@cli tell me a joke', 'agent', 'tell me a joke'],
            ['@local hi', 'agent', 'hi'],
            ['/web move ~/a to ~/b', 'web', 'move ~/a to ~/b'],
            ['/agent hello', 'agent', 'hello'],
            ['@AGENT Hello', 'agent', 'Hello'],
            ['  @Web   spaced  ', 'web', 'spaced'],
            ['@agent', 'agent', ''],
        ];

        it.each(cases)('%j → %s', (text, route, prompt) => {
            const decision = routePrompt(text, AUTO);
            expect(decision.route).toBe(route);
            expect(decision.forced).toBe(true);
            expect(decision.prompt).toBe(prompt);
            expect(decision.reason).toMatch(/^you typed /);
        });

        it('requires a space or the end after the prefix', () => {
            expect(parseRoutePrefix('@webby hello')).toBeNull();
            expect(parseRoutePrefix('/agents are cool')).toBeNull();
            expect(routePrompt('@webby hello', AUTO).forced).toBe(false);
        });

        it('only accepts prefixes at the start', () => {
            expect(parseRoutePrefix('hello @agent')).toBeNull();
        });

        it('keeps the agent category for a forced agent prompt', () => {
            expect(routePrompt('@agent organise my Downloads folder', AUTO).category).toBe('files');
            expect(routePrompt('@agent tell me a joke', AUTO).category).toBe('general');
        });

        it('wins over the routing mode', () => {
            expect(routePrompt('@agent hi', { mode: 'web', agentAvailable: true }).route).toBe('agent');
            expect(routePrompt('@web hi', { mode: 'agent', agentAvailable: true }).route).toBe('web');
        });

        it('keeps a forced agent route when no agent is installed', () => {
            const decision = routePrompt('@agent organise my Downloads folder', {
                mode: 'auto',
                agentAvailable: false,
            });
            expect(decision.route).toBe('agent');
            expect(decision.forced).toBe(true);
        });
    });

    describe('modes', () => {
        it('always web sends local prompts to web', () => {
            const decision = routePrompt('organise my Downloads folder', { mode: 'web', agentAvailable: true });
            expect(decision).toMatchObject({ route: 'web', reason: ROUTE_REASONS.modeWeb, forced: false });
            expect(decision.category).toBeUndefined();
        });

        it('always agent sends general prompts to the agent', () => {
            const decision = routePrompt('draw a cat', { mode: 'agent', agentAvailable: true });
            expect(decision).toMatchObject({
                route: 'agent',
                category: 'general',
                reason: ROUTE_REASONS.modeAgent,
            });
        });

        it('always agent keeps the category', () => {
            expect(routePrompt('how much disk space do I have', { mode: 'agent', agentAvailable: true }).category).toBe(
                'system'
            );
        });
    });

    describe('follow-ups', () => {
        const FOLLOW_UP = { mode: 'auto' as const, agentAvailable: true, followUp: true };

        it('sends an unprefixed follow-up to the agent', () => {
            expect(routePrompt('and what about the second one?', FOLLOW_UP)).toMatchObject({
                route: 'agent',
                category: 'general',
                reason: ROUTE_REASONS.followUp,
                forced: false,
            });
        });

        it('keeps the category the auto rules give', () => {
            expect(routePrompt('now move them to my Documents folder', FOLLOW_UP).category).toBe('files');
        });

        it('lets web cues and prefixes win', () => {
            expect(routePrompt('draw a chart of that', FOLLOW_UP).route).toBe('web');
            expect(routePrompt('@web tell me more', FOLLOW_UP).route).toBe('web');
        });

        it('only applies in auto mode and with an agent', () => {
            expect(routePrompt('and then?', { ...FOLLOW_UP, mode: 'web' }).route).toBe('web');
            expect(routePrompt('and then?', { ...FOLLOW_UP, agentAvailable: false }).route).toBe('web');
            expect(routePrompt('and then?', AUTO).route).toBe('web');
        });
    });

    describe('no agent installed', () => {
        it('falls back to web in auto mode', () => {
            const decision = routePrompt('organise my Downloads folder', { mode: 'auto', agentAvailable: false });
            expect(decision).toMatchObject({ route: 'web', reason: ROUTE_REASONS.agentUnavailable, forced: false });
            expect(decision.category).toBeUndefined();
        });

        it('falls back to web in agent mode', () => {
            const decision = routePrompt('hello', { mode: 'agent', agentAvailable: false });
            expect(decision.route).toBe('web');
            expect(decision.reason).toBe(ROUTE_REASONS.agentUnavailable);
        });

        it('leaves web prompts alone', () => {
            expect(routePrompt('tell me a joke', { mode: 'auto', agentAvailable: false }).reason).toBe(
                ROUTE_REASONS.general
            );
        });
    });

    describe('helpers', () => {
        it('describeRoute labels the chip', () => {
            expect(describeRoute({ route: 'web' })).toBe('Gemini');
            expect(describeRoute({ route: 'agent', category: 'files' })).toBe('Agent · Files');
            expect(describeRoute({ route: 'agent', category: 'system' })).toBe('Agent · System');
            expect(describeRoute({ route: 'agent', category: 'documents' })).toBe('Agent · Documents');
            expect(describeRoute({ route: 'agent', category: 'code' })).toBe('Agent · Code');
            expect(describeRoute({ route: 'agent', category: 'general' })).toBe('Agent');
            expect(describeRoute({ route: 'agent' })).toBe('Agent');
        });

        it('forceRoute picks a route and strips prefixes', () => {
            expect(forceRoute('@web organise my Downloads folder', 'agent')).toEqual({
                route: 'agent',
                category: 'files',
                reason: ROUTE_REASONS.pickedAgent,
                forced: true,
                prompt: 'organise my Downloads folder',
            });
            expect(forceRoute('organise my Downloads folder', 'web')).toEqual({
                route: 'web',
                reason: ROUTE_REASONS.pickedWeb,
                forced: true,
                prompt: 'organise my Downloads folder',
            });
        });

        it('otherRoute flips', () => {
            expect(otherRoute('web')).toBe('agent');
            expect(otherRoute('agent')).toBe('web');
        });

        it('findFileNames ignores URLs and library names', () => {
            expect(findFileNames('see https://x.com/a.png and node.js')).toEqual([]);
            expect(findFileNames('Washington D.C. and Alpine.js and x.md')).toEqual([]);
            expect(findFileNames('open "my report.pdf" and main.rs.')).toEqual([
                { name: 'my report.pdf', kind: 'documents', quoted: true },
                { name: 'main.rs', kind: 'code', quoted: false },
            ]);
            expect(findFileNames('copy src/Alpine.js')).toEqual([
                { name: 'src/Alpine.js', kind: 'code', quoted: false },
            ]);
        });

        it('classifyPrompt has a reason for every agent route', () => {
            for (const prompt of [
                'move ~/a ~/b',
                'my battery level',
                'run the tests in my project',
                'summarise ab.pdf',
            ]) {
                const result = classifyPrompt(prompt);
                expect(result.route).toBe('agent');
                expect(result.reason).not.toBe('');
            }
        });
    });
});
