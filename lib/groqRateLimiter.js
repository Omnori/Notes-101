const { checkGroqDailyLimit, GROQ_LIMITS } = require('./database');

// In-memory sliding window bucket per API key or 'default'
const buckets = new Map();

function getBucket(key = 'default') {
    const bucketKey = key ? String(key).slice(-10) : 'default';
    if (!buckets.has(bucketKey)) {
        buckets.set(bucketKey, {
            requests: [], // timestamps: number[]
            tokens: [],   // { time: number, tokens: number }[]
        });
    }
    return buckets.get(bucketKey);
}

function parseRetryAfter(errorMessage) {
    try {
        const match = String(errorMessage || '').match(/try again in ([\d\.]+)s/i);
        if (match && match[1]) {
            const sec = parseFloat(match[1]);
            if (!isNaN(sec) && sec > 0) {
                return Math.min(65000, Math.ceil(sec * 1000) + 500);
            }
        }
    } catch {
        // ignore
    }
    return 5000;
}

async function throttleGroq(apiKey, estimatedTokens = 0, guildId = null) {
    // 1. Check daily limits (1,000 RPD, 200,000 TPD)
    const dailyCheck = checkGroqDailyLimit(guildId);
    if (!dailyCheck.allowed) {
        throw new Error(`[Groq Rate Limit] ${dailyCheck.reason}`);
    }

    // 2. Check 1-minute window (30 RPM, 8,000 TPM)
    const bucket = getBucket(apiKey);
    while (true) {
        const now = Date.now();
        const oneMinAgo = now - 60000;

        bucket.requests = bucket.requests.filter((t) => t > oneMinAgo);
        bucket.tokens = bucket.tokens.filter((r) => r.time > oneMinAgo);

        // Check 30 requests / minute
        if (bucket.requests.length >= GROQ_LIMITS.requestsPerMinute) {
            const oldest = bucket.requests[0];
            const waitMs = Math.max(200, 60000 - (now - oldest) + 150);
            console.warn(`[Groq RateLimiter] 30 RPM reached (${bucket.requests.length} requests in 1m). Throttling for ${waitMs}ms...`);
            await new Promise((resolve) => setTimeout(resolve, waitMs));
            continue;
        }

        // Check 8,000 tokens / minute
        const currentTokens = bucket.tokens.reduce((acc, r) => acc + r.tokens, 0);
        if (currentTokens + estimatedTokens > GROQ_LIMITS.tokensPerMinute && bucket.tokens.length > 0) {
            const oldestToken = bucket.tokens[0].time;
            const waitMs = Math.max(200, 60000 - (now - oldestToken) + 150);
            console.warn(`[Groq RateLimiter] 8K TPM reached (${currentTokens} tokens in 1m). Throttling for ${waitMs}ms...`);
            await new Promise((resolve) => setTimeout(resolve, waitMs));
            continue;
        }

        // Space available in current 1-minute window
        bucket.requests.push(Date.now());
        if (estimatedTokens > 0) {
            bucket.tokens.push({ time: Date.now(), tokens: estimatedTokens });
        }
        break;
    }
}

function recordActualTokens(apiKey, tokens) {
    if (!tokens || tokens <= 0) return;
    const bucket = getBucket(apiKey);
    bucket.tokens.push({ time: Date.now(), tokens });
}

async function executeGroqRequest(fn, { apiKey, estimatedTokens = 0, guildId = null, maxRetries = 2 }) {
    await throttleGroq(apiKey, estimatedTokens, guildId);

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            const isRateLimit = String(error?.message || '').includes('429');
            if (isRateLimit && attempt < maxRetries) {
                const waitMs = parseRetryAfter(error?.message);
                console.warn(`[Groq RateLimiter] 429 received from Groq. Retrying in ${waitMs}ms (attempt ${attempt + 1}/${maxRetries})...`);
                await new Promise((resolve) => setTimeout(resolve, waitMs));
                continue;
            }
            throw error;
        }
    }
}

module.exports = {
    GROQ_LIMITS,
    executeGroqRequest,
    recordActualTokens,
    throttleGroq,
};
