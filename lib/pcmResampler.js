const { Transform } = require('node:stream');

const CHANNELS = 2;
const DECIMATION = 3; // 48000 / 16000
const BYTES_PER_SAMPLE = 2;
const GROUP_BYTES = DECIMATION * CHANNELS * BYTES_PER_SAMPLE;

// Downmixes 48kHz stereo PCM16LE (discord's receive format) to 16kHz mono
// PCM16LE (what Vosk expects), boxcar-averaging each group of 3 stereo
// frames into one mono sample instead of naively dropping samples.
class Pcm48kStereoTo16kMono extends Transform {
    constructor(options) {
        super(options);
        this._leftover = Buffer.alloc(0);
    }

    _transform(chunk, encoding, callback) {
        const data = this._leftover.length ? Buffer.concat([this._leftover, chunk]) : chunk;
        const groups = Math.floor(data.length / GROUP_BYTES);
        const usableBytes = groups * GROUP_BYTES;
        this._leftover = data.subarray(usableBytes);

        const out = Buffer.alloc(groups * BYTES_PER_SAMPLE);
        for (let i = 0; i < groups; i++) {
            const base = i * GROUP_BYTES;
            let sum = 0;
            for (let s = 0; s < DECIMATION; s++) {
                const off = base + s * CHANNELS * BYTES_PER_SAMPLE;
                const left = data.readInt16LE(off);
                const right = data.readInt16LE(off + BYTES_PER_SAMPLE);
                sum += (left + right) >> 1;
            }
            const avg = Math.max(-32768, Math.min(32767, Math.floor(sum / DECIMATION)));
            out.writeInt16LE(avg, i * BYTES_PER_SAMPLE);
        }

        if (out.length) this.push(out);
        callback();
    }
}

module.exports = { Pcm48kStereoTo16kMono };
