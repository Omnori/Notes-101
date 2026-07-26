const vosk = require('vosk-koffi');

let modelsConfig = null;
const modelCache = new Map(); // languageCode -> vosk.Model

function getModelsConfig() {
    if (!modelsConfig) {
        const raw = process.env.VOSK_MODELS;
        if (!raw) {
            throw new Error(
                'VOSK_MODELS is not set. Set it to a JSON object mapping language codes to Vosk model ' +
                'folder paths, e.g. {"en":"/models/vosk-model-small-en-us-0.15","hi":"/models/vosk-model-hi-0.22"}. ' +
                'Download models from https://alphacephei.com/vosk/models',
            );
        }
        try {
            modelsConfig = JSON.parse(raw);
        } catch {
            throw new Error('VOSK_MODELS is not valid JSON.');
        }
    }
    return modelsConfig;
}

function getAvailableLanguages() {
    return Object.keys(getModelsConfig());
}

function getDefaultLanguage() {
    const languages = getAvailableLanguages();
    const envDefault = process.env.DEFAULT_STT_LANGUAGE;
    if (envDefault && languages.includes(envDefault)) return envDefault;
    return languages[0];
}

function getModel(languageCode) {
    if (!modelCache.has(languageCode)) {
        const modelPath = getModelsConfig()[languageCode];
        if (!modelPath) {
            throw new Error(`Unknown STT language "${languageCode}". Available: ${getAvailableLanguages().join(', ')}`);
        }
        vosk.setLogLevel(-1);
        modelCache.set(languageCode, new vosk.Model(modelPath));
    }
    return modelCache.get(languageCode);
}

// pcmBuffer must be 16kHz mono PCM16LE.
function transcribePcm16kMono(pcmBuffer, languageCode) {
    const recognizer = new vosk.Recognizer({ model: getModel(languageCode), sampleRate: 16000 });
    try {
        recognizer.acceptWaveform(pcmBuffer);
        // vosk-koffi's .d.ts claims finalResult() returns { alternatives: [...] }, but at
        // runtime (v1.1.1) it actually returns { text: "..." } directly — verified against
        // the raw result. Check both shapes so this survives either behavior.
        const result = recognizer.finalResult();
        const text = result.text ?? result.alternatives?.[0]?.text ?? '';
        return text.trim();
    } finally {
        recognizer.free();
    }
}

module.exports = { getModel, transcribePcm16kMono, getAvailableLanguages, getDefaultLanguage };
