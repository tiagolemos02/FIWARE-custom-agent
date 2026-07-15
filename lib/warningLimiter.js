'use strict';

function asPositiveInteger(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function createWarningLimiter(options = {}) {
    const intervalMs = asPositiveInteger(options.intervalMs, 300000);
    const maxEntries = asPositiveInteger(options.maxEntries, 10000);
    const now = typeof options.now === 'function' ? options.now : Date.now;
    const lastLoggedByKey = new Map();

    function shouldLog(key) {
        const current = now();
        const previous = lastLoggedByKey.get(key);
        if (previous !== undefined && current - previous < intervalMs) {
            return false;
        }

        if (lastLoggedByKey.has(key)) {
            lastLoggedByKey.delete(key);
        } else if (lastLoggedByKey.size >= maxEntries) {
            const oldestKey = lastLoggedByKey.keys().next().value;
            if (oldestKey !== undefined) lastLoggedByKey.delete(oldestKey);
        }

        lastLoggedByKey.set(key, current);
        return true;
    }

    function reset() {
        lastLoggedByKey.clear();
    }

    return {
        shouldLog,
        reset
    };
}

module.exports = {
    createWarningLimiter
};
