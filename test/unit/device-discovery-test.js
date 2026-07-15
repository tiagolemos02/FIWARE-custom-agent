const assert = require('assert');
const { createDeviceDiscovery } = require('../../lib/deviceDiscovery');

describe('MQTT device discovery', function () {
    it('tracks unique Device IDs and refreshes their last-seen time', function () {
        let now = Date.parse('2026-07-15T10:00:00.000Z');
        const discovery = createDeviceDiscovery({ ttlMs: 3600000, maxEntries: 10, clock: () => now });

        discovery.observe('machine-b');
        now += 1000;
        discovery.observe('machine-a');
        now += 1000;
        discovery.observe('machine-b');

        assert.deepStrictEqual(discovery.list(), [
            {
                deviceId: 'machine-a',
                firstSeen: '2026-07-15T10:00:01.000Z',
                lastSeen: '2026-07-15T10:00:01.000Z'
            },
            {
                deviceId: 'machine-b',
                firstSeen: '2026-07-15T10:00:00.000Z',
                lastSeen: '2026-07-15T10:00:02.000Z'
            }
        ]);
    });

    it('removes expired IDs and bounds the number of entries', function () {
        let now = 0;
        const discovery = createDeviceDiscovery({ ttlMs: 100, maxEntries: 2, clock: () => now });

        discovery.observe('machine-a');
        now = 10;
        discovery.observe('machine-b');
        now = 20;
        discovery.observe('machine-c');
        assert.deepStrictEqual(discovery.list().map((entry) => entry.deviceId), ['machine-b', 'machine-c']);

        now = 121;
        assert.deepStrictEqual(discovery.list(), []);
    });
});
