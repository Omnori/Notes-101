const { initWhisper } = require('@fugood/whisper.node');

let contextPromise = null;
// Serializes access to the shared context — concurrent transcribeData() calls on
// one WhisperContext aren't documented as safe, so utterances (including from
// different simultaneous speakers) are transcribed one at a time.
let queue = Promise.resolve();

function getContext() {
    if (!contextPromise) {
        const filePath = process.env.WHISPER_MODEL_PATH;
        if (!filePath) {
            throw new Error(
                'WHISPER_MODEL_PATH is not set. Point it at a GGML whisper.cpp model file ' +
                '(see models/whisper-hindi2hinglish-swift.bin).',
            );
        }
        contextPromise = initWhisper({ filePath });
    }
    return contextPromise;
}

// pcmBuffer must be 16kHz mono PCM16LE.
function transcribePcm16kMono(pcmBuffer) {
    const run = async () => {
        const ctx = await getContext();
        const arrayBuffer = pcmBuffer.buffer.slice(pcmBuffer.byteOffset, pcmBuffer.byteOffset + pcmBuffer.byteLength);
        const { promise } = ctx.transcribeData(arrayBuffer, {});
        const { result } = await promise;
        return (result || '').trim();
    };
    const resultPromise = queue.then(run, run);
    queue = resultPromise.then(
        () => undefined,
        () => undefined,
    );
    return resultPromise;
}

module.exports = { getContext, transcribePcm16kMono };
