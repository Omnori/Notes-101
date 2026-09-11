const { GoogleGenAI } = require('@google/genai');

function getClient(customApiKey = null) {
    const apiKey = customApiKey || process.env.GEMINI_API_KEY;
    if (!apiKey) {
        throw new Error('Gemini API key is not configured for this server.');
    }
    return new GoogleGenAI({
        vertexai: true,
        apiKey,
    });
}

const SYSTEM_PROMPT = `You are an expert executive assistant and meeting note-taker. You will be provided with an automated voice-chat transcript that includes speaker names and timestamps. 
Because this transcript is produced by an offline speech recognizer, expect occasional phonetic errors, missing punctuation, or garbled text.

Your task is to synthesize this transcript into clean, concise, and highly structured meeting minutes using Markdown.

Follow these strict rules:
1. Fix obvious speech-to-text errors silently based on context (e.g., "right code" -> "write code").
2. Do not hallucinate or invent any information. If a section is too garbled to understand, explicitly write: "[Audio unintelligible: skipped section]" instead of guessing.
3. Be concise and objective. Strip out small talk, filler words, and tangents.
4. Assign action items strictly to the person mentioned. If no owner is clear, label it "Unassigned".

Format your output exactly as follows:

## 📝 Meeting Summary
[A 2-3 sentence high-level overview of the meeting's primary purpose and final outcome.]

## 🗣️ Key Discussion Points
* [Speaker Name/s]: [Concise summary of the point made]
* [Speaker Name/s]: [Concise summary of the point made]

## 🤝 Decisions Made
* [Clear statement of the decision and who approved it, if applicable]

## 🎯 Action Items
* [ ] **[Task]** - @[Owner] (Due: [Date/Time, or "Not specified"])`;

function isRateLimitError(error) {
    if (!error) return false;
    if (error.status === 'RESOURCE_EXHAUSTED' || error.status === 429) return true;
    if (error.code === 429 || error.code === 'RESOURCE_EXHAUSTED') return true;
    if (error.error?.code === 429 || error.error?.status === 'RESOURCE_EXHAUSTED') return true;
    const msg = String(error.message || '');
    return msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('Quota exceeded');
}

async function generateContentWithRetry(generateFunc, maxRetries = 4, initialDelay = 2000) {
    let delay = initialDelay;

    for (let i = 0; i < maxRetries; i++) {
        try {
            return await generateFunc();
        } catch (error) {
            if (isRateLimitError(error)) {
                if (i === maxRetries - 1) {
                    throw new Error(`Failed after ${maxRetries} retries: ${error.message}`, { cause: error });
                }
                console.warn(`[Gemini API] 429 Rate Limit hit. Retrying in ${delay}ms... (Attempt ${i + 1}/${maxRetries})`);
                await new Promise((resolve) => setTimeout(resolve, delay));
                delay *= 2;
            } else {
                throw error;
            }
        }
    }
}

let taskQueue = Promise.resolve();

function enqueueTask(taskFn) {
    const result = taskQueue.then(async () => {
        const res = await taskFn();
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return res;
    });
    taskQueue = result.catch(() => new Promise((resolve) => setTimeout(resolve, 1000)));
    return result;
}

async function summarizeTranscript(transcriptText, customApiKey = null, customModel = null) {
    return enqueueTask(async () => {
        const ai = getClient(customApiKey);
        const model = customModel || process.env.GEMINI_MODEL || 'gemini-2.5-flash';

        const response = await generateContentWithRetry(() =>
            ai.models.generateContent({
                model,
                contents: [
                    { role: 'user', parts: [{ text: `${SYSTEM_PROMPT}\n\nTranscript:\n${transcriptText}` }] },
                ],
            }),
        );

        return response.text;
    });
}

module.exports = { summarizeTranscript, generateContentWithRetry, isRateLimitError };
