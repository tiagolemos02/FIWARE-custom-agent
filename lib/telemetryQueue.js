function asPositiveInteger(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function createTelemetryQueue(options = {}) {
    if (typeof options.worker !== 'function') {
        throw new TypeError('telemetry queue requires a worker function');
    }

    const concurrency = asPositiveInteger(options.concurrency, 10);
    const maxPending = asPositiveInteger(options.maxPending, 1000);
    const worker = options.worker;
    const onDrop = typeof options.onDrop === 'function' ? options.onDrop : () => {};
    const pending = new Map();
    const activeGroups = new Set();
    const closeCallbacks = [];
    const counters = {
        enqueued: 0,
        coalesced: 0,
        completed: 0,
        failed: 0,
        dropped: 0
    };

    let active = 0;
    let accepting = true;
    let draining = false;
    let closeTimer = null;
    let closeFinished = false;

    function snapshot() {
        return {
            ...counters,
            active,
            pending: pending.size,
            concurrency,
            maxPending,
            accepting
        };
    }

    function finishClose() {
        if (closeFinished) {
            return;
        }
        closeFinished = true;
        if (closeTimer) {
            clearTimeout(closeTimer);
            closeTimer = null;
        }
        while (closeCallbacks.length) {
            closeCallbacks.shift()();
        }
    }

    function checkIdle() {
        if (!accepting && active === 0 && pending.size === 0) {
            finishClose();
        }
    }

    function takeNextEligible() {
        for (const [key, entry] of pending) {
            if (!activeGroups.has(entry.groupKey)) {
                pending.delete(key);
                return entry;
            }
        }
        return null;
    }

    function scheduleDrain() {
        if (draining) {
            return;
        }
        draining = true;
        setImmediate(drain);
    }

    function processEntry(entry) {
        active += 1;
        activeGroups.add(entry.groupKey);
        let completed = false;

        const done = (error) => {
            if (completed) {
                return;
            }
            completed = true;
            active -= 1;
            activeGroups.delete(entry.groupKey);
            if (error) {
                counters.failed += 1;
            } else {
                counters.completed += 1;
            }
            checkIdle();
            scheduleDrain();
        };

        try {
            worker(entry.item, done);
        } catch (error) {
            done(error);
        }
    }

    function drain() {
        draining = false;

        while (active < concurrency) {
            const entry = takeNextEligible();
            if (!entry) {
                break;
            }
            processEntry(entry);
        }

        checkIdle();
    }

    function dropOldest(reason) {
        const oldestKey = pending.keys().next().value;
        if (oldestKey === undefined) {
            return;
        }
        const oldest = pending.get(oldestKey);
        pending.delete(oldestKey);
        counters.dropped += 1;
        onDrop(oldest.item, reason);
    }

    function enqueue({ key, groupKey, item }) {
        if (!accepting) {
            counters.dropped += 1;
            onDrop(item, 'queue-closed');
            return false;
        }

        counters.enqueued += 1;
        if (pending.has(key)) {
            pending.set(key, { key, groupKey, item });
            counters.coalesced += 1;
            return true;
        }

        if (pending.size >= maxPending) {
            dropOldest('queue-capacity');
        }

        pending.set(key, { key, groupKey, item });
        scheduleDrain();
        return true;
    }

    function close(timeoutMs, callback) {
        accepting = false;
        if (typeof callback === 'function') {
            closeCallbacks.push(callback);
        }

        const timeout = asPositiveInteger(timeoutMs, 5000);
        if (!closeTimer && !closeFinished) {
            closeTimer = setTimeout(() => {
                while (pending.size) {
                    dropOldest('shutdown-timeout');
                }
                finishClose();
            }, timeout);
            if (typeof closeTimer.unref === 'function') {
                closeTimer.unref();
            }
        }

        scheduleDrain();
        checkIdle();
    }

    return {
        enqueue,
        close,
        getStats: snapshot
    };
}

module.exports = {
    createTelemetryQueue
};
