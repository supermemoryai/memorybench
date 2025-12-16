import { config as dotenvConfig } from 'dotenv';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env from memorybench root
dotenvConfig({ path: join(__dirname, '../../../../.env') });

export interface Config {
    apiKey: string;
    baseUrl: string;
    openaiApiKey: string;
    googleApiKey: string;
    anthropicApiKey: string;
    judgeModel: string;
    generatorModel: string;
}

export const config: Config = {
    apiKey: process.env.SUPERMEMORY_API_KEY || "",
    baseUrl: process.env.SUPERMEMORY_API_URL || "https://api.supermemory.ai",
    openaiApiKey: process.env.OPENAI_API_KEY || "",
    googleApiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY || "",
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
    judgeModel: process.env.JUDGE_MODEL || "gpt-4o",
    generatorModel: process.env.GENERATOR_MODEL || "gemini-2.0-flash",
};

export function validateConfig(required: (keyof Config)[]) {
    const missing = required.filter(key => !config[key]);
    if (missing.length > 0) {
        console.error(`Missing required environment variables:`);
        missing.forEach(key => {
            const envVar = key === 'apiKey' ? 'SUPERMEMORY_API_KEY' 
                : key === 'baseUrl' ? 'SUPERMEMORY_API_URL'
                : key === 'openaiApiKey' ? 'OPENAI_API_KEY'
                : key === 'googleApiKey' ? 'GOOGLE_GENERATIVE_AI_API_KEY'
                : key === 'anthropicApiKey' ? 'ANTHROPIC_API_KEY'
                : key.toUpperCase();
            console.error(`  - ${envVar}`);
        });
        process.exit(1);
    }
}

