/**
 * Test Zep provider
 */

import ZepProvider from '../providers/zep/Provider';

async function test() {
    console.log('=== Testing Zep Provider ===');
    console.log('');
    
    const provider = new ZepProvider();
    
    // Check if API key is set
    if (!process.env.ZEP_API_KEY) {
        console.log('❌ ZEP_API_KEY not set - skipping live test');
        console.log('');
        console.log('To use Zep, set these environment variables:');
        console.log('  ZEP_API_KEY=your_api_key');
        console.log('  ZEP_API_URL=https://api.getzep.com (or your self-hosted URL)');
        console.log('');
        console.log('✅ Provider class loads correctly');
        return;
    }
    
    console.log('✅ ZEP_API_KEY is set');
    console.log(`   API URL: ${process.env.ZEP_API_URL || 'https://api.getzep.com'}`);
    
    try {
        await provider.initialize();
        console.log('✅ Provider initialized');
        
        const containerTag = 'memorybench-test-' + Date.now();
        console.log(`   Container: ${containerTag}`);
        
        // Test ingest
        console.log('');
        console.log('Testing ingest...');
        const testContent = 'John visited Paris in 2023. He enjoyed the Eiffel Tower and ate croissants every morning. Mary went to Tokyo the same year and loved the cherry blossoms.';
        
        await provider.ingest(testContent, containerTag, { metadata: { test: true } });
        console.log('✅ Ingest completed');
        
        // Wait a bit for processing
        console.log('   Waiting for processing...');
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        // Test search
        console.log('');
        console.log('Testing search...');
        const results = await provider.search('Where did John go?', containerTag, { limit: 5 });
        console.log(`✅ Search returned ${results.length} results`);
        
        if (results.length > 0) {
            console.log('');
            console.log('Results:');
            for (const r of results.slice(0, 3)) {
                console.log(`  [${r.score?.toFixed(2)}] ${r.content?.substring(0, 80)}...`);
            }
        }
        
        // Cleanup
        console.log('');
        console.log('Cleaning up...');
        await provider.deleteContainer(containerTag);
        console.log('✅ Cleanup completed');
        
        console.log('');
        console.log('✅ Zep provider is working correctly!');
        console.log('');
        console.log('You can now use it with:');
        console.log('  bun run benchmark LoCoMo zep --limit=5');
        console.log('  bun run benchmark NoLiMa zep --limit=10');
        
    } catch (error: any) {
        console.log('❌ Error:', error.message);
        console.log('');
        console.log('Debug info:');
        console.log('  If you see 404/410 errors, your Zep instance may use a different API version.');
        console.log('  Check: https://docs.getzep.com/ for the latest API documentation.');
    }
}

test();
