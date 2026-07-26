const { GoogleGenAI } = require('@google/genai');

let client = null;

function getClient() {
    if (!client) {
        if (!process.env.GEMINI_API_KEY) {
            throw new Error('GEMINI_API_KEY is not set.');
        }
        // Vertex AI Express Mode (API-key auth): project/location can't be set
        // explicitly alongside an apiKey — the SDK throws if you try. The region is
        // whatever the key's backing Vertex AI project uses, not something the
        // client can pin, so GEMINI_LOCATION isn't honored here.
        client = new GoogleGenAI({
            vertexai: true,
            apiKey: process.env.GEMINI_API_KEY,
        });
    }
    return client;
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
* [ ] **[Task]** - @[Owner] (Due: [Date/Time, or "Not specified"])`

async function summarizeTranscript(transcriptText) {
    const ai = getClient();
    const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash';

    const response = await ai.models.generateContent({
        model,
        contents: [
            { role: 'user', parts: [{ text: `${SYSTEM_PROMPT}\n\nTranscript:\n${transcriptText}` }] },
        ],
    });

    return response.text;
}

module.exports = { summarizeTranscript };
