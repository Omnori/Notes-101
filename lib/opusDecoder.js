const prism = require('prism-media');

// prism-media's Decoder treats a single corrupted Opus packet as a fatal stream error,
// destroying the whole pipeline (see node_modules/prism-media/src/opus/Opus.js Decoder._transform,
// which catches the decode exception but reports it via done(e), tearing the stream down). Discord's
// voice UDP occasionally delivers a corrupted/lost packet under normal network conditions — not
// something we can prevent — so losing the rest of the utterance's audio over one bad frame is a
// real accuracy problem, not just log noise. This drops just the bad frame and keeps decoding.
class ResilientOpusDecoder extends prism.opus.Decoder {
    _transform(chunk, encoding, callback) {
        super._transform(chunk, encoding, () => callback());
    }
}

module.exports = { ResilientOpusDecoder };
