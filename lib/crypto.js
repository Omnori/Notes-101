const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ENV_PATH = path.join(__dirname, '../.env');

const ALGORITHM = 'aes-256-gcm';
const CURRENT_VERSION = 'v1';
const CURRENT_PREFIX = `enc:${CURRENT_VERSION}:`;
const VERSION_REGEX = /^enc:(v\d+):([0-9a-fA-F]+):([0-9a-fA-F]+):([0-9a-fA-F]+)$/;

function isEncrypted(val) {
    return typeof val === 'string' && VERSION_REGEX.test(val);
}

const GUILD_CONFIGS_PATH = path.join(__dirname, '../guild_configs.json');

function hasExistingEncryptedConfig() {
    if (fs.existsSync(GUILD_CONFIGS_PATH)) {
        try {
            const content = fs.readFileSync(GUILD_CONFIGS_PATH, 'utf-8');
            if (content.includes('enc:v1:')) return true;
        } catch {
            // Non-fatal
        }
    }
    return false;
}

function getOrInitEncryptionKey() {
    let rawKey = process.env.CONFIG_ENCRYPTION_KEY;
    if (!rawKey) {
        // Check if .env has it
        if (fs.existsSync(ENV_PATH)) {
            try {
                const envContent = fs.readFileSync(ENV_PATH, 'utf-8');
                const match = envContent.match(/^CONFIG_ENCRYPTION_KEY=(.*)$/m);
                if (match && match[1].trim()) {
                    rawKey = match[1].trim();
                    process.env.CONFIG_ENCRYPTION_KEY = rawKey;
                }
            } catch (readErr) {
                console.warn('[crypto] Could not read .env for encryption key:', readErr.message);
            }
        }
    }

    if (!rawKey) {
        if (hasExistingEncryptedConfig()) {
            throw new Error(
                'FATAL: CONFIG_ENCRYPTION_KEY is missing, but encrypted configurations already exist on disk! ' +
                'Refusing to generate a new key as it would permanently corrupt existing credentials. ' +
                'Restore the original CONFIG_ENCRYPTION_KEY to the environment or .env file.'
            );
        }

        if (process.env.NODE_ENV === 'production') {
            console.error('[crypto:FATAL] CONFIG_ENCRYPTION_KEY is missing in production environment! Generating an ephemeral key will lead to permanent data loss on container restart.');
        }

        // Generate a new 256-bit (32 bytes) hex key and append to .env
        const generatedKey = crypto.randomBytes(32).toString('hex');
        try {
            const envContent = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf-8') : '';
            const newEnv = envContent.trimEnd() + `\n\n# Key for AES-256-GCM encryption of sensitive guild tokens (DO NOT LOSE)\nCONFIG_ENCRYPTION_KEY=${generatedKey}\n`;
            
            // Atomic write to .env with strict 0600 owner-only permissions
            const tempEnv = `${ENV_PATH}.tmp.${process.pid}.${Date.now()}`;
            fs.writeFileSync(tempEnv, newEnv, { encoding: 'utf-8', mode: 0o600 });
            fs.renameSync(tempEnv, ENV_PATH);
            console.log('[crypto] Generated and securely saved new CONFIG_ENCRYPTION_KEY to .env');
            rawKey = generatedKey;
            process.env.CONFIG_ENCRYPTION_KEY = rawKey;
        } catch (err) {
            console.error('[crypto:ERROR] Could not persist CONFIG_ENCRYPTION_KEY to .env:', err.message);
            throw new Error('Failed to persist CONFIG_ENCRYPTION_KEY to disk. Set CONFIG_ENCRYPTION_KEY explicitly in environment.', { cause: err });
        }
    }

    if (/^[0-9a-fA-F]{64}$/.test(rawKey)) {
        return Buffer.from(rawKey, 'hex');
    }
    return crypto.createHash('sha256').update(String(rawKey)).digest();
}

function encrypt(text) {
    if (text === null || text === undefined || text === '') {
        return text;
    }
    if (isEncrypted(text)) {
        return text;
    }

    const key = getOrInitEncryptionKey();
    const iv = crypto.randomBytes(12); // 96-bit nonce for GCM
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    const ciphertext = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return `${CURRENT_PREFIX}${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`;
}

function decrypt(cipherString) {
    if (cipherString === null || cipherString === undefined || cipherString === '') {
        return cipherString;
    }
    if (!isEncrypted(cipherString)) {
        // Plaintext value (e.g. before migration)
        return cipherString;
    }

    const match = cipherString.match(VERSION_REGEX);
    if (!match) {
        throw new Error('Invalid encrypted payload format');
    }

    const [, version, ivHex, tagHex, dataHex] = match;

    if (version !== 'v1') {
        throw new Error(`Unsupported encryption version: ${version}`);
    }

    const key = getOrInitEncryptionKey();
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(tagHex, 'hex');
    const ciphertext = Buffer.from(dataHex, 'hex');

    try {
        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
        decipher.setAuthTag(authTag);

        const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        return decrypted.toString('utf8');
    } catch (err) {
        // Fail closed: never return partial data or expose ciphertext details
        throw new Error('Decryption failed: authentication tag mismatch or corrupted ciphertext', { cause: err });
    }
}

module.exports = {
    encrypt,
    decrypt,
    isEncrypted,
    getOrInitEncryptionKey,
};
