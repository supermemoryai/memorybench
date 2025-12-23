/**
 * Visualization Web Server
 * Serves the benchmark visualization dashboard using Bun.serve
 */

import { getAllAggregatedData } from './aggregator';
import { join } from 'path';
import { readdirSync, readFileSync, statSync, existsSync } from 'fs';

/**
 * Get all results JSON files
 */
function getAllResults() {
    const results = [];
    const resultsDir = join(process.cwd(), 'results');

    if (!existsSync(resultsDir)) {
        return results;
    }

    const runDirs = readdirSync(resultsDir).filter(dir => {
        const fullPath = join(resultsDir, dir);
        return statSync(fullPath).isDirectory();
    });

    for (const runDir of runDirs) {
        const summaryPath = join(resultsDir, runDir, 'evaluation-summary.json');
        if (!existsSync(summaryPath)) continue;

        try {
            const data = JSON.parse(readFileSync(summaryPath, 'utf-8'));
            results.push(data);
        } catch (err) {
            console.error(`Error reading ${summaryPath}:`, err);
        }
    }

    // Sort by evaluated time (most recent first)
    results.sort((a, b) => {
        const timeA = new Date(a.metadata.evaluatedAt || 0).getTime();
        const timeB = new Date(b.metadata.evaluatedAt || 0).getTime();
        return timeB - timeA;
    });

    return results;
}

const server = Bun.serve({
    port: 3001,
    async fetch(req) {
        const url = new URL(req.url);

        // Serve main HTML page
        if (url.pathname === '/') {
            const file = Bun.file('./viz/simple.html');
            return new Response(await file.text(), {
                headers: { 'Content-Type': 'text/html' },
            });
        }

        // Serve simple results API
        if (url.pathname === '/api/results') {
            const results = getAllResults();
            return new Response(JSON.stringify(results), {
                headers: { 'Content-Type': 'application/json' },
            });
        }

        // Serve favicon (optional, prevents 404)
        if (url.pathname === '/favicon.ico') {
            return new Response('', { status: 204 });
        }

        // 404 for everything else
        return new Response('Not Found', { status: 404 });
    },
    development: {
        hmr: true,
        console: true,
    },
});

console.log(`Benchmark Visualization Server running at http://localhost:${server.port}`);
console.log(`Open http://localhost:${server.port} in your browser to view the dashboard`);
