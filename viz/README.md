# MemoryBench Visualization Dashboard

A comprehensive web-based visualization dashboard for comparing memory provider performance across different benchmarks.

## Features

- **Multi-Benchmark Support**: Visualize results from NoLiMa, LongMemEval, and LoCoMo benchmarks
- **Interactive Provider Selection**: Filter results by provider using checkboxes
- **Comparative Charts**: Bar charts showing accuracy, retrieval rates, and other metrics
- **Tab-Based Navigation**: Easy switching between different benchmarks
- **Real-Time Stats**: Summary statistics cards for quick insights
- **Responsive Design**: Dark-themed UI optimized for data visualization

## Getting Started

### Prerequisites

- Bun runtime installed
- Benchmark results in the `results/` directory

### Running the Server

Start the visualization server:

```bash
bun run viz
```

The dashboard will be available at [http://localhost:3001](http://localhost:3001)

### Viewing Visualizations

1. Open your browser and navigate to `http://localhost:3001`
2. Use the tabs at the top to switch between benchmarks:
   - **NoLiMa**: Needle-in-a-haystack benchmark results
   - **LongMemEval**: Long-term memory evaluation metrics
   - **LoCoMo**: Conversational context retrieval performance
3. Use the provider checkboxes to filter which providers are displayed
4. Charts will update automatically based on your selection

## Benchmark Visualizations

### NoLiMa Dashboard

- **Accuracy Comparison**: Bar chart showing answer accuracy by provider
- **Retrieval Rate**: Needle retrieval success rates
- **Stats Cards**: Average accuracy, retrieval rate, total tests, and provider count

### LongMemEval Dashboard

- **Search Results**: Average search results returned by each provider
- **Stats Cards**: Total runs, average questions processed, and provider count

### LoCoMo Dashboard

- **Context Retrieval Rate**: Percentage of questions with retrieved context
- **Questions Processed**: Total questions handled by each provider
- **Stats Cards**: Average retrieval rate, total questions, and averages per sample

## Architecture

### Components

- **[viz/aggregator.ts](viz/aggregator.ts)**: Data aggregation logic that reads benchmark results
- **[viz/server.ts](viz/server.ts)**: Bun web server with API endpoints
- **[viz/index.html](viz/index.html)**: Main dashboard HTML
- **[viz/app.js](viz/app.js)**: Frontend JavaScript with Chart.js visualizations

### API Endpoints

- `GET /`: Main dashboard HTML page
- `GET /api/data`: JSON endpoint returning aggregated benchmark data

### Data Flow

1. Server reads results from `results/` directory
2. Aggregator processes JSON files and groups by benchmark type
3. API endpoint serves aggregated data
4. Frontend fetches data and renders charts using Chart.js

## Customization

### Adding New Benchmarks

To add a new benchmark visualization:

1. Add aggregation logic in `viz/aggregator.ts`
2. Create a new tab in `viz/index.html`
3. Add rendering function in `viz/app.js`
4. Update the tab switching logic

### Changing Chart Types

Charts can be customized in `viz/app.js` by modifying the Chart.js configuration:

```javascript
new Chart(ctx, {
    type: 'bar', // Change to 'line', 'radar', 'pie', etc.
    data: { ... },
    options: { ... }
});
```

### Styling

The dashboard uses CSS custom properties and can be themed by modifying the styles in `viz/index.html`.

## Troubleshooting

### No Data Displayed

- Ensure you have run benchmarks and results exist in `results/` directory
- Check browser console for errors
- Verify the API endpoint returns data: `http://localhost:3001/api/data`

### Server Won't Start

- Check if port 3001 is already in use
- Modify the port in `viz/server.ts` if needed
- Ensure Bun is properly installed: `bun --version`

### Charts Not Rendering

- Verify Chart.js is loading from CDN
- Check browser console for JavaScript errors
- Ensure the data structure matches expected format

## Performance

The dashboard is optimized for:
- Fast data aggregation using synchronous file reads
- Efficient chart rendering with Chart.js
- Minimal dependencies (only Chart.js from CDN)
- Client-side filtering for instant provider selection

## License

Part of the MemoryBench project.
