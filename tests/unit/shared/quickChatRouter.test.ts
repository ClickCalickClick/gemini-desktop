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
            ['explain what contract.pdf says about termination', 'agent', 'documents'],
            ['translate notes.txt into German', 'agent', 'documents'],
            ['budget.xlsx', 'agent', 'documents'],
            ['proofread my Documents/letter.odt', 'agent', 'documents'],
            // Code
            ['explain src/main.ts', 'agent', 'code'],
            ['what does app.py do', 'agent', 'code'],
            ['git status of my project', 'agent', 'code'],
            ['run the tests in this repo', 'agent', 'code'],
            ['why does the build fail', 'agent', 'code'],
            ['find the TODOs in this codebase', 'agent', 'code'],
            ['npm install fails with EACCES', 'agent', 'code'],
            // System
            ['how much disk space do I have left', 'agent', 'system'],
            ['what is using all my CPU', 'agent', 'system'],
            ['how much RAM is free', 'agent', 'system'],
            ['show running processes', 'agent', 'system'],
            ['are there any failed services', 'agent', 'system'],
            ['is ffmpeg installed', 'agent', 'system'],
            ['why is my wifi slow', 'agent', 'system'],
            ['battery health', 'agent', 'system'],
            ['which kernel am I running', 'agent', 'system'],
            ['show the journalctl errors since boot', 'agent', 'system'],
            ['pacman says the keyring is out of date', 'agent', 'system'],
            ['how do I fix apt lock errors', 'agent', 'system'],
            ['brew upgrade broke python', 'agent', 'system'],
            ['restart the systemd unit for docker', 'agent', 'system'],
            ['check the system logs for errors', 'agent', 'system'],
            ['how old is my laptop', 'agent', 'system'],
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
            expect(routePrompt('how much disk space', { mode: 'agent', agentAvailable: true }).category).toBe('system');
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
            expect(findFileNames('open "my report.pdf" and main.rs.')).toEqual([
                { name: 'report.pdf', kind: 'documents' },
                { name: 'main.rs', kind: 'code' },
            ]);
        });

        it('classifyPrompt has a reason for every agent route', () => {
            for (const prompt of ['move ~/a ~/b', 'battery', 'run the tests', 'summarise a.pdf']) {
                const result = classifyPrompt(prompt);
                expect(result.route).toBe('agent');
                expect(result.reason).not.toBe('');
            }
        });
    });
});
