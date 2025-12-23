/**
 * Visualization Web Server
 * Serves the benchmark visualization dashboard using Bun.serve
 */

import { getAllAggregatedData, getLatestRunsByProvider, PROVIDER_COLORS, LONGMEMEVAL_LABELS, LOCOMO_LABELS, getLoCoMoDatasetStats, getNoLiMaDatasetStats, getLongMemEvalDatasetStats } from './aggregator';
import { join } from 'path';
import { readdirSync, readFileSync, statSync, existsSync } from 'fs';

const RESULTS_DIR = join(process.cwd(), 'results');

/**
 * Get all raw results JSON files
 */
function getAllResults() {
    const results = [];

    if (!existsSync(RESULTS_DIR)) {
        return results;
    }

    const runDirs = readdirSync(RESULTS_DIR).filter(dir => {
        const fullPath = join(RESULTS_DIR, dir);
        return statSync(fullPath).isDirectory();
    });

    for (const runDir of runDirs) {
        const summaryPath = join(RESULTS_DIR, runDir, 'evaluation-summary.json');
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

/**
 * Get run metrics (timing, API stats, etc.)
 */
function getRunMetrics(runId: string) {
    const runDir = join(RESULTS_DIR, runId);
    const metrics: any = {};
    
    // Check for various checkpoint files
    const checkpoints = ['ingest-checkpoint.json', 'search-checkpoint.json', 'evaluate-checkpoint.json'];
    
    for (const checkpoint of checkpoints) {
        const path = join(runDir, checkpoint);
        if (existsSync(path)) {
            try {
                const data = JSON.parse(readFileSync(path, 'utf-8'));
                const phase = checkpoint.replace('-checkpoint.json', '');
                metrics[phase] = {
                    startTime: data.startTime,
                    lastUpdate: data.lastUpdate,
                    progress: data.results?.length || data.evaluations?.length || 0,
                };
            } catch (err) {
                // Ignore
            }
        }
    }
    
    return metrics;
}

const server = Bun.serve({
    port: 3001,
    async fetch(req) {
        const url = new URL(req.url);
        const formalOnly = url.searchParams.get('formalOnly') !== 'false';

        // Serve main dashboard
        if (url.pathname === '/' || url.pathname === '/index.html') {
            const file = Bun.file('./viz/dashboard.html');
            if (await file.exists()) {
                return new Response(await file.text(), {
                    headers: { 'Content-Type': 'text/html' },
                });
            }
            // Fallback to simple.html
            const fallback = Bun.file('./viz/simple.html');
            return new Response(await fallback.text(), {
                headers: { 'Content-Type': 'text/html' },
            });
        }

        // API: Get aggregated data for charts
        if (url.pathname === '/api/aggregated') {
            const data = getLatestRunsByProvider({ formalOnly });
            return Response.json(data);
        }

        // API: Get all runs (including historical)
        if (url.pathname === '/api/all-runs') {
            const data = getAllAggregatedData({ formalOnly });
            return Response.json(data);
        }

        // API: Get raw results
        if (url.pathname === '/api/results') {
            const results = getAllResults();
            return Response.json(results);
        }

        // API: Get provider colors and config
        if (url.pathname === '/api/config') {
            return Response.json({
                providerColors: PROVIDER_COLORS,
                longMemEvalLabels: LONGMEMEVAL_LABELS,
                locomoLabels: LOCOMO_LABELS,
            });
        }

        // API: Get dataset statistics
        if (url.pathname === '/api/dataset-stats') {
            return Response.json({
                locomo: getLoCoMoDatasetStats(),
                nolima: getNoLiMaDatasetStats(),
                longmemeval: getLongMemEvalDatasetStats(),
            });
        }

        // API: Get specific run metrics
        if (url.pathname.startsWith('/api/run/')) {
            const runId = url.pathname.replace('/api/run/', '');
            const metrics = getRunMetrics(runId);
            return Response.json(metrics);
        }

        // Serve static files from viz directory
        if (url.pathname.endsWith('.js') || url.pathname.endsWith('.css')) {
            const file = Bun.file(`./viz${url.pathname}`);
            if (await file.exists()) {
                const contentType = url.pathname.endsWith('.js') ? 'application/javascript' : 'text/css';
                return new Response(await file.text(), {
                    headers: { 'Content-Type': contentType },
                });
            }
        }

        // Serve favicon
        if (url.pathname === '/favicon.ico') {
            return new Response('', { status: 204 });
        }

        return new Response('Not Found', { status: 404 });
    },
});

console.log(`
╔══════════════════════════════════════════════════════════════╗
║                                                              ║
║   📊 MemoryBench Visualization Dashboard                     ║
║                                                              ║
║   Server running at: http://localhost:${server.port}                   ║
║                                                              ║
║   Open this URL in your browser to view benchmark results    ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
`);
