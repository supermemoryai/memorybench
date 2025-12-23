/**
 * Frontend Application for Benchmark Visualizations
 */

let allData = null;
let charts = {};
let selectedProviders = {
    nolima: new Set(),
    longmemeval: new Set(),
    locomo: new Set()
};

// Chart.js default config
Chart.defaults.color = '#e0e0e0';
Chart.defaults.borderColor = '#333';
Chart.defaults.font.family = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, sans-serif';

const PROVIDER_COLORS = {
    'supermemory': '#2563eb',
    'mem0': '#7c3aed',
    'langchain': '#dc2626',
    'fullcontext': '#059669'
};

// Fetch data from API
async function fetchData() {
    try {
        const response = await fetch('/api/data');
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        allData = await response.json();

        document.getElementById('loading').style.display = 'none';

        initializeProviderCheckboxes();
        renderAll();
    } catch (error) {
        console.error('Error fetching data:', error);
        document.getElementById('loading').style.display = 'none';
        const errorEl = document.getElementById('error');
        errorEl.textContent = `Error loading data: ${error.message}`;
        errorEl.style.display = 'block';
    }
}

// Initialize provider checkboxes
function initializeProviderCheckboxes() {
    const providers = allData.providers;

    // Initially select all providers
    providers.forEach(p => {
        selectedProviders.nolima.add(p);
        selectedProviders.longmemeval.add(p);
        selectedProviders.locomo.add(p);
    });

    // NoLiMa providers
    const nolimaContainer = document.getElementById('nolima-providers');
    nolimaContainer.innerHTML = providers.map(provider => `
        <label class="checkbox-label">
            <input type="checkbox"
                   value="${provider}"
                   checked
                   onchange="toggleProvider('nolima', '${provider}', this.checked)">
            <span>${provider}</span>
        </label>
    `).join('');

    // LongMemEval providers
    const longmemevalContainer = document.getElementById('longmemeval-providers');
    longmemevalContainer.innerHTML = providers.map(provider => `
        <label class="checkbox-label">
            <input type="checkbox"
                   value="${provider}"
                   checked
                   onchange="toggleProvider('longmemeval', '${provider}', this.checked)">
            <span>${provider}</span>
        </label>
    `).join('');

    // LoCoMo providers
    const locomoContainer = document.getElementById('locomo-providers');
    locomoContainer.innerHTML = providers.map(provider => `
        <label class="checkbox-label">
            <input type="checkbox"
                   value="${provider}"
                   checked
                   onchange="toggleProvider('locomo', '${provider}', this.checked)">
            <span>${provider}</span>
        </label>
    `).join('');
}

// Toggle provider selection
window.toggleProvider = function(benchmark, provider, checked) {
    if (checked) {
        selectedProviders[benchmark].add(provider);
    } else {
        selectedProviders[benchmark].delete(provider);
    }

    if (benchmark === 'nolima') renderNoLiMa();
    if (benchmark === 'longmemeval') renderLongMemEval();
    if (benchmark === 'locomo') renderLoCoMo();
};

// Render all visualizations
function renderAll() {
    renderNoLiMa();
    renderLongMemEval();
    renderLoCoMo();
}

// Render NoLiMa visualizations
function renderNoLiMa() {
    const data = allData.noLiMa.filter(r => selectedProviders.nolima.has(r.provider));

    if (data.length === 0) {
        document.getElementById('nolima-stats').innerHTML = '<div class="no-data">No data available for selected providers</div>';
        return;
    }

    // Calculate stats
    const avgAccuracy = data.reduce((sum, r) => sum + r.accuracy, 0) / data.length;
    const avgRetrieval = data.reduce((sum, r) => sum + r.retrievalRate, 0) / data.length;
    const totalTests = data.reduce((sum, r) => sum + r.totalTests, 0);

    // Render stats cards
    document.getElementById('nolima-stats').innerHTML = `
        <div class="stat-card">
            <div class="stat-label">Average Accuracy</div>
            <div class="stat-value">${avgAccuracy.toFixed(1)}%</div>
        </div>
        <div class="stat-card">
            <div class="stat-label">Average Retrieval Rate</div>
            <div class="stat-value">${avgRetrieval.toFixed(1)}%</div>
        </div>
        <div class="stat-card">
            <div class="stat-label">Total Tests Run</div>
            <div class="stat-value">${totalTests}</div>
        </div>
        <div class="stat-card">
            <div class="stat-label">Providers Tested</div>
            <div class="stat-value">${selectedProviders.nolima.size}</div>
        </div>
    `;

    // Group by provider for charts
    const byProvider = {};
    data.forEach(r => {
        if (!byProvider[r.provider]) {
            byProvider[r.provider] = [];
        }
        byProvider[r.provider].push(r);
    });

    const providers = Object.keys(byProvider);
    const accuracies = providers.map(p => {
        const providerData = byProvider[p];
        return providerData.reduce((sum, r) => sum + r.accuracy, 0) / providerData.length;
    });
    const retrievalRates = providers.map(p => {
        const providerData = byProvider[p];
        return providerData.reduce((sum, r) => sum + r.retrievalRate, 0) / providerData.length;
    });

    // Collect category breakdown
    const categoryAccuracy = {};
    data.forEach(r => {
        if (r.categoryAccuracy) {
            Object.entries(r.categoryAccuracy).forEach(([cat, acc]) => {
                if (!categoryAccuracy[cat]) {
                    categoryAccuracy[cat] = [];
                }
                categoryAccuracy[cat].push(acc);
            });
        }
    });

    // Destroy existing charts
    if (charts.nolimaAccuracy) charts.nolimaAccuracy.destroy();
    if (charts.nolimaRetrieval) charts.nolimaRetrieval.destroy();
    if (charts.nolimaCategory) charts.nolimaCategory.destroy();

    // Accuracy chart
    const ctxAccuracy = document.getElementById('nolima-accuracy-chart').getContext('2d');
    charts.nolimaAccuracy = new Chart(ctxAccuracy, {
        type: 'bar',
        data: {
            labels: providers,
            datasets: [{
                label: 'Accuracy (%)',
                data: accuracies,
                backgroundColor: providers.map(p => PROVIDER_COLORS[p] || '#666'),
                borderWidth: 0,
                borderRadius: 6
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    max: 100,
                    ticks: { callback: value => value + '%' },
                    grid: { color: '#2a2a2a' }
                },
                x: { grid: { display: false } }
            }
        }
    });

    // Retrieval rate chart
    const ctxRetrieval = document.getElementById('nolima-retrieval-chart').getContext('2d');
    charts.nolimaRetrieval = new Chart(ctxRetrieval, {
        type: 'bar',
        data: {
            labels: providers,
            datasets: [{
                label: 'Retrieval Rate (%)',
                data: retrievalRates,
                backgroundColor: providers.map(p => PROVIDER_COLORS[p] || '#666'),
                borderWidth: 0,
                borderRadius: 6
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    max: 100,
                    ticks: { callback: value => value + '%' },
                    grid: { color: '#2a2a2a' }
                },
                x: { grid: { display: false } }
            }
        }
    });

    // Category accuracy chart
    if (Object.keys(categoryAccuracy).length > 0) {
        // Insert category breakdown chart if it doesn't exist
        if (!document.querySelector('[data-chart="nolima-category"]')) {
            const chartHtml = `
                <div data-chart="nolima-category" class="chart-container" style="margin-top: 30px;">
                    <h3>Accuracy by Category</h3>
                    <div class="chart-wrapper">
                        <canvas id="nolima-category-chart"></canvas>
                    </div>
                </div>
            `;
            document.getElementById('nolima-tab').insertAdjacentHTML('beforeend', chartHtml);
        }

        const categories = Object.keys(categoryAccuracy);
        const categoryAvgs = categories.map(c => {
            const vals = categoryAccuracy[c];
            return vals.reduce((sum, v) => sum + v, 0) / vals.length;
        });

        const ctxCategory = document.getElementById('nolima-category-chart').getContext('2d');
        charts.nolimaCategory = new Chart(ctxCategory, {
            type: 'bar',
            data: {
                labels: categories,
                datasets: [{
                    label: 'Accuracy (%)',
                    data: categoryAvgs,
                    backgroundColor: '#3b82f6',
                    borderWidth: 0,
                    borderRadius: 6
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        max: 100,
                        ticks: { callback: value => value + '%' },
                        grid: { color: '#2a2a2a' }
                    },
                    x: { grid: { display: false } }
                }
            }
        });
    }
}

// Render LongMemEval visualizations
function renderLongMemEval() {
    const data = allData.longMemEval.filter(r => selectedProviders.longmemeval.has(r.provider));

    if (data.length === 0) {
        document.getElementById('longmemeval-stats').innerHTML = '<div class="no-data">No data available for selected providers</div>';
        return;
    }

    // Calculate stats
    const totalRuns = data.length;
    const totalQuestions = data.reduce((sum, r) => sum + r.totalQuestions, 0);
    const avgAccuracy = (
        data.reduce((sum, r) => sum + r.accuracy, 0) / totalRuns
    );

    // Render stats cards
    document.getElementById('longmemeval-stats').innerHTML = `
        <div class="stat-card">
            <div class="stat-label">Total Runs</div>
            <div class="stat-value">${totalRuns}</div>
        </div>
        <div class="stat-card">
            <div class="stat-label">Overall Accuracy</div>
            <div class="stat-value">${avgAccuracy.toFixed(1)}%</div>
        </div>
        <div class="stat-card">
            <div class="stat-label">Total Questions</div>
            <div class="stat-value">${totalQuestions}</div>
        </div>
        <div class="stat-card">
            <div class="stat-label">Providers Tested</div>
            <div class="stat-value">${selectedProviders.longmemeval.size}</div>
        </div>
    `;

    // Group by provider for comparison
    const byProvider = {};
    data.forEach(r => {
        if (!byProvider[r.provider]) {
            byProvider[r.provider] = [];
        }
        byProvider[r.provider].push(r);
    });

    const providers = Object.keys(byProvider);
    const providerAccuracies = providers.map(p => {
        const providerData = byProvider[p];
        return providerData.reduce((sum, r) => sum + r.accuracy, 0) / providerData.length;
    });

    // Get all question types across all runs
    const allQuestionTypes = new Set();
    data.forEach(r => {
        if (r.questionTypes) {
            r.questionTypes.forEach(qt => allQuestionTypes.add(qt.questionType));
        }
    });

    // Calculate accuracy by question type
    const accuracyByType = {};
    allQuestionTypes.forEach(type => {
        const typeResults = data
            .filter(r => r.questionTypes)
            .flatMap(r => r.questionTypes.filter(qt => qt.questionType === type));
        
        if (typeResults.length > 0) {
            const avgAcc = typeResults.reduce((sum, qt) => {
                const acc = parseFloat(qt.accuracy);
                return sum + (isNaN(acc) ? 0 : acc);
            }, 0) / typeResults.length;
            accuracyByType[type] = avgAcc;
        }
    });

    // Destroy existing charts
    if (charts.longmemevalAccuracy) charts.longmemevalAccuracy.destroy();
    if (charts.longmemevalByType) charts.longmemevalByType.destroy();

    // Provider accuracy comparison
    const ctxAccuracy = document.getElementById('longmemeval-results-chart').getContext('2d');
    charts.longmemevalAccuracy = new Chart(ctxAccuracy, {
        type: 'bar',
        data: {
            labels: providers,
            datasets: [{
                label: 'Accuracy (%)',
                data: providerAccuracies,
                backgroundColor: providers.map(p => PROVIDER_COLORS[p] || '#666'),
                borderWidth: 0,
                borderRadius: 6
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    max: 100,
                    ticks: { callback: value => value + '%' },
                    grid: { color: '#2a2a2a' }
                },
                x: { grid: { display: false } }
            }
        }
    });

    // Only show type breakdown if we have data
    const typeChartContainer = document.querySelector('[data-chart="longmemeval-by-type"]') || 
                              document.createElement('div');
    
    if (Object.keys(accuracyByType).length > 0) {
        // Insert type breakdown chart if it doesn't exist
        if (!document.querySelector('[data-chart="longmemeval-by-type"]')) {
            const chartHtml = `
                <div data-chart="longmemeval-by-type" class="chart-container" style="margin-top: 30px;">
                    <h3>Accuracy by Question Type</h3>
                    <div class="chart-wrapper">
                        <canvas id="longmemeval-type-chart"></canvas>
                    </div>
                </div>
            `;
            document.getElementById('longmemeval-tab').insertAdjacentHTML('beforeend', chartHtml);
        }

        const types = Object.keys(accuracyByType);
        const typeAccuracies = types.map(t => accuracyByType[t]);

        if (charts.longmemevalByType) charts.longmemevalByType.destroy();
        
        const ctxType = document.getElementById('longmemeval-type-chart').getContext('2d');
        charts.longmemevalByType = new Chart(ctxType, {
            type: 'bar',
            data: {
                labels: types,
                datasets: [{
                    label: 'Accuracy (%)',
                    data: typeAccuracies,
                    backgroundColor: '#2563eb',
                    borderWidth: 0,
                    borderRadius: 6
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        max: 100,
                        ticks: { callback: value => value + '%' },
                        grid: { color: '#2a2a2a' }
                    },
                    x: { grid: { display: false } }
                }
            }
        });
    }
}

// Render LoCoMo visualizations
function renderLoCoMo() {
    const data = allData.loCoMo.filter(r => selectedProviders.locomo.has(r.provider));

    if (data.length === 0) {
        document.getElementById('locomo-stats').innerHTML = '<div class="no-data">No data available for selected providers</div>';
        return;
    }

    // Calculate stats
    const totalQuestions = data.reduce((sum, r) => sum + r.totalQuestions, 0);
    const totalCorrect = data.reduce((sum, r) => sum + r.correctAnswers, 0);
    const overallAccuracy = totalQuestions > 0 ? ((totalCorrect / totalQuestions) * 100).toFixed(1) : 0;
    const avgAccuracy = data.reduce((sum, r) => sum + r.accuracy, 0) / data.length;

    // Render stats cards
    document.getElementById('locomo-stats').innerHTML = `
        <div class="stat-card">
            <div class="stat-label">Overall Accuracy</div>
            <div class="stat-value">${overallAccuracy}%</div>
        </div>
        <div class="stat-card">
            <div class="stat-label">Total Questions</div>
            <div class="stat-value">${totalQuestions}</div>
        </div>
        <div class="stat-card">
            <div class="stat-label">Correct Answers</div>
            <div class="stat-value">${totalCorrect}</div>
        </div>
        <div class="stat-card">
            <div class="stat-label">Providers Tested</div>
            <div class="stat-value">${selectedProviders.locomo.size}</div>
        </div>
    `;

    // Group by provider
    const byProvider = {};
    data.forEach(r => {
        if (!byProvider[r.provider]) {
            byProvider[r.provider] = [];
        }
        byProvider[r.provider].push(r);
    });

    const providers = Object.keys(byProvider);
    const accuracies = providers.map(p => {
        const providerData = byProvider[p];
        return providerData.reduce((sum, r) => sum + r.accuracy, 0) / providerData.length;
    });
    const totalQuestionsByProvider = providers.map(p => {
        return byProvider[p].reduce((sum, r) => sum + r.totalQuestions, 0);
    });
    const correctAnswersByProvider = providers.map(p => {
        return byProvider[p].reduce((sum, r) => sum + r.correctAnswers, 0);
    });

    // Destroy existing charts
    if (charts.locomoAccuracy) charts.locomoAccuracy.destroy();
    if (charts.locomoQuestions) charts.locomoQuestions.destroy();

    // Accuracy chart
    const ctxAccuracy = document.getElementById('locomo-retrieval-chart').getContext('2d');
    charts.locomoAccuracy = new Chart(ctxAccuracy, {
        type: 'bar',
        data: {
            labels: providers,
            datasets: [{
                label: 'Accuracy (%)',
                data: accuracies,
                backgroundColor: providers.map(p => PROVIDER_COLORS[p] || '#666'),
                borderWidth: 0,
                borderRadius: 6
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    max: 100,
                    ticks: { callback: value => value + '%' },
                    grid: { color: '#2a2a2a' }
                },
                x: { grid: { display: false } }
            }
        }
    });

    // Questions and correct answers chart
    const ctxQuestions = document.getElementById('locomo-questions-chart').getContext('2d');
    charts.locomoQuestions = new Chart(ctxQuestions, {
        type: 'bar',
        data: {
            labels: providers,
            datasets: [
                {
                    label: 'Correct Answers',
                    data: correctAnswersByProvider,
                    backgroundColor: providers.map(p => PROVIDER_COLORS[p] || '#666'),
                    borderWidth: 0,
                    borderRadius: 6
                },
                {
                    label: 'Total Questions',
                    data: totalQuestionsByProvider,
                    backgroundColor: providers.map(p => {
                        const color = PROVIDER_COLORS[p] || '#666';
                        return color + '40'; // Add transparency
                    }),
                    borderColor: providers.map(p => PROVIDER_COLORS[p] || '#666'),
                    borderWidth: 2,
                    borderRadius: 6,
                    fill: false,
                    type: 'line'
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: true, labels: { usePointStyle: true } }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    grid: { color: '#2a2a2a' }
                },
                x: { grid: { display: false } }
            }
        }
    });
}

// Tab switching
document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
        // Remove active class from all tabs and content
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

        // Add active class to clicked tab
        tab.classList.add('active');

        // Show corresponding content
        const tabName = tab.getAttribute('data-tab');
        document.getElementById(`${tabName}-tab`).classList.add('active');
    });
});

// Initialize on load
fetchData();
