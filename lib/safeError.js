/**
 * Central safe error sanitizer.
 * Prevents third-party SDK errors, HTTP responses, or exceptions from leaking
 * sensitive tokens, authorization headers, or server file paths into Discord or logs.
 */
function sanitizeErrorMessage(err) {
    if (!err) return 'Unknown error occurred.';

    let msg = typeof err === 'string' ? err : (err.message || String(err));

    // 1. Redact API tokens and Authorization headers
    const secretRegex = /(ntn_[A-Za-z0-9]+|secret_[A-Za-z0-9]+|gsk_[A-Za-z0-9]+|AIza[A-Za-z0-9_-]+|Bearer\s+[A-Za-z0-9._-]+)/gi;
    msg = msg.replace(secretRegex, '[REDACTED_SECRET]');

    // 2. Redact internal server filesystem paths
    msg = msg.replace(/(?:\/[a-zA-Z0-9_.-]+){3,}/g, '[INTERNAL_PATH]');

    // 3. Clean up common raw JSON error responses from APIs to human-friendly strings
    if (msg.includes('{"error":') || msg.includes('{"message":')) {
        try {
            const jsonStart = msg.indexOf('{');
            const jsonEnd = msg.lastIndexOf('}');
            if (jsonStart !== -1 && jsonEnd !== -1) {
                const parsed = JSON.parse(msg.slice(jsonStart, jsonEnd + 1));
                if (parsed.error?.message) {
                    msg = parsed.error.message;
                } else if (parsed.message) {
                    msg = parsed.message;
                }
            }
        } catch {
            // Keep cleaned string
        }
    }

    // 4. Truncate long error payloads to prevent Discord embed/message overflow
    if (msg.length > 300) {
        msg = msg.slice(0, 297) + '...';
    }

    return msg.trim() || 'Internal operation failure';
}

function sanitizeAuditPreview(text, maxLength = 50) {
    if (!text || typeof text !== 'string') return '';
    const cleaned = text.replace(/[\r\n\t]+/g, ' ').replace(/(ntn_[A-Za-z0-9]+|secret_[A-Za-z0-9]+|gsk_[A-Za-z0-9]+|AIza[A-Za-z0-9_-]+)/gi, '[SECRET]').trim();
    return cleaned.length > maxLength ? cleaned.slice(0, maxLength - 3) + '...' : cleaned;
}

module.exports = {
    sanitizeErrorMessage,
    sanitizeAuditPreview,
};
