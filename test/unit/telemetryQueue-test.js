'use strict';

const assert = require('assert');
const { createTelemetryQueue } = require('../../lib/telemetryQueue');

describe('telemetryQueue', function () {
    it('coalesces pending updates for the same machine and attribute', function (done) {
        const processed = [];
        const completions = [];
        const queue = createTelemetryQueue({
            concurrency: 1,
            maxPending: 10,
            worker(item, complete) {
                processed.push(item.value);
                completions.push(complete);
            }
        });

        queue.enqueue({ key: 'm1\u0000a', groupKey: 'm1', item: { value: 1 } });
        setImmediate(() => {
            queue.enqueue({ key: 'm1\u0000a', groupKey: 'm1', item: { value: 2 } });
            queue.enqueue({ key: 'm1\u0000a', groupKey: 'm1', item: { value: 3 } });
            completions.shift()();

            setImmediate(() => {
                assert.deepStrictEqual(processed, [1, 3]);
                assert.strictEqual(queue.getStats().coalesced, 1);
                completions.shift()();
                queue.close(100, done);
            });
        });
    });

    it('does not process two attributes from the same machine concurrently', function (done) {
        const activeByMachine = new Set();
        const violations = [];
        const queue = createTelemetryQueue({
            concurrency: 2,
            maxPending: 10,
            worker(item, complete) {
                if (activeByMachine.has(item.machine)) violations.push(item.machine);
                activeByMachine.add(item.machine);
                setImmediate(() => {
                    activeByMachine.delete(item.machine);
                    complete();
                });
            }
        });

        queue.enqueue({ key: 'm1\u0000a', groupKey: 'm1', item: { machine: 'm1' } });
        queue.enqueue({ key: 'm1\u0000b', groupKey: 'm1', item: { machine: 'm1' } });
        queue.enqueue({ key: 'm2\u0000a', groupKey: 'm2', item: { machine: 'm2' } });
        queue.close(500, () => {
            assert.deepStrictEqual(violations, []);
            done();
        });
    });

    it('drops the oldest pending item when capacity is reached', function (done) {
        const dropped = [];
        const completions = [];
        const queue = createTelemetryQueue({
            concurrency: 1,
            maxPending: 1,
            worker(item, complete) {
                completions.push(complete);
            },
            onDrop(item, reason) {
                dropped.push({ item, reason });
            }
        });

        queue.enqueue({ key: 'm1\u0000a', groupKey: 'm1', item: { value: 1 } });
        setImmediate(() => {
            queue.enqueue({ key: 'm2\u0000a', groupKey: 'm2', item: { value: 2 } });
            queue.enqueue({ key: 'm3\u0000a', groupKey: 'm3', item: { value: 3 } });
            assert.deepStrictEqual(dropped, [
                { item: { value: 2 }, reason: 'queue-capacity' }
            ]);
            completions.shift()();
            setImmediate(() => {
                completions.shift()();
                queue.close(100, done);
            });
        });
    });
});
