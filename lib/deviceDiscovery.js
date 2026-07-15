const config = require('./configService');
const constants = require('./constants');

function asPositiveInteger(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function createDeviceDiscovery(options = {}) {
    const ttlMs = asPositiveInteger(options.ttlMs, constants.MQTT_DEFAULT_DISCOVERY_TTL_MS);
    const maxEntries = asPositiveInteger(options.maxEntries, constants.MQTT_DEFAULT_DISCOVERY_MAX_ENTRIES);
    const clock = typeof options.clock === 'function' ? options.clock : Date.now;
    const devices = new Map();

    function prune(timestamp = clock()) {
        for (const [deviceId, entry] of devices) {
            if (timestamp - entry.lastSeen < ttlMs) break;
            devices.delete(deviceId);
        }
    }

    function observe(deviceId) {
        const normalizedId = String(deviceId || '').trim();
        if (!normalizedId) return;

        const timestamp = clock();
        prune(timestamp);
        const existing = devices.get(normalizedId);
        if (existing) devices.delete(normalizedId);
        devices.set(normalizedId, {
            deviceId: normalizedId,
            firstSeen: existing ? existing.firstSeen : timestamp,
            lastSeen: timestamp
        });

        while (devices.size > maxEntries) {
            devices.delete(devices.keys().next().value);
        }
    }

    function list() {
        prune();
        return Array.from(devices.values())
            .map((entry) => ({
                deviceId: entry.deviceId,
                firstSeen: new Date(entry.firstSeen).toISOString(),
                lastSeen: new Date(entry.lastSeen).toISOString()
            }))
            .sort((left, right) => left.deviceId.localeCompare(right.deviceId));
    }

    return { observe, list };
}

let sharedDiscovery;

function getSharedDiscovery() {
    if (!sharedDiscovery) {
        const mqttConfig = config.getConfig().mqtt || {};
        sharedDiscovery = createDeviceDiscovery({
            ttlMs: mqttConfig.discoveryTtlMs,
            maxEntries: mqttConfig.discoveryMaxEntries
        });
    }
    return sharedDiscovery;
}

module.exports = {
    createDeviceDiscovery,
    observe(deviceId) {
        getSharedDiscovery().observe(deviceId);
    },
    list() {
        return getSharedDiscovery().list();
    }
};
