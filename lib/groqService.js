function createWavBuffer(pcmBuffer, sampleRate = 16000, numChannels = 1) {
    const header = Buffer.alloc(44);
    const dataSize = pcmBuffer.length;

    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataSize, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16); // Subchunk1Size (16 for PCM)
    header.writeUInt16LE(1, 20); // AudioFormat (1 for PCM)
    header.writeUInt16LE(numChannels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * numChannels * 2, 28); // ByteRate
    header.writeUInt16LE(numChannels * 2, 32); // BlockAlign
    header.writeUInt16LE(16, 34); // BitsPerSample
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);

    return Buffer.concat([header, pcmBuffer]);
}

// pcmBuffer must be 16kHz mono PCM16LE.
async function transcribePcm16kMono(pcmBuffer) {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
        throw new Error('GROQ_API_KEY is not set in environment variables.');
    }

    const wavBuffer = createWavBuffer(pcmBuffer);
    const blob = new Blob([wavBuffer], { type: 'audio/wav' });
    const formData = new FormData();
    formData.append('file', blob, 'audio.wav');
    formData.append('model', process.env.GROQ_MODEL || 'whisper-large-v3-turbo');
    formData.append('temperature', '0');
    formData.append('response_format', 'verbose_json');

    // Prompt guiding Whisper to format Hinglish code-switching in Roman/Latin script
    const prompt = process.env.GROQ_WHISPER_PROMPT ||
        'This is a Hinglish speech conversation written in Roman script (Latin alphabet), e.g. Haan bhai main code push kar raha hoon.';
    formData.append('prompt', prompt);

    const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
        },
        body: formData,
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Groq API error (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    return (data.text || '').trim();
}

module.exports = { transcribePcm16kMono };
