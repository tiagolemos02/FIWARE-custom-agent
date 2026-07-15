const assert = require('assert');
const proxyquire = require('proxyquire').noCallThru();

describe('MTEXNS MQTT runtime regression', function () {
    it('uses environment-neutral MQTT defaults and disables unused AMQP', function () {
        const runtimeConfig = require('../../config');

        assert.strictEqual(runtimeConfig.mqtt.protocol, 'mqtt');
        assert.strictEqual(runtimeConfig.mqtt.host, 'localhost');
        assert.strictEqual(runtimeConfig.mqtt.port, 1883);
        ['ca', 'cert', 'key', 'username', 'password'].forEach((property) => {
            assert.strictEqual(Object.prototype.hasOwnProperty.call(runtimeConfig.mqtt, property), false);
        });
        assert.strictEqual(runtimeConfig.amqp.disabled, true);
    });

    it('resolves a provisioned device globally when the MQTT topic has no API key', function (done) {
        const expectedDevice = {
            id: 'machine-1',
            name: 'urn:ngsi-ld:Machine:machine-1',
            service: 'factory',
            subservice: '/line1'
        };
        let configurationLookupCalled = false;
        const iotAgentLib = {
            getDevicesByAttribute(attribute, value, service, subservice, callback) {
                assert.strictEqual(attribute, 'id');
                assert.strictEqual(value, 'machine-1');
                assert.strictEqual(service, null);
                assert.strictEqual(subservice, null);
                callback(null, [expectedDevice]);
            },
            getConfigurationSilently(resource, apiKey, callback) {
                configurationLookupCalled = true;
                callback(new Error(`Unexpected configuration lookup for ${resource}:${apiKey}`));
            }
        };
        const logger = {
            debug() {},
            error() {}
        };
        const iotaUtils = proxyquire('../../lib/iotaUtils', {
            'iotagent-node-lib': iotAgentLib,
            './configService': {
                getConfig() {
                    return {
                        defaultKey: '1234',
                        iota: { defaultResource: '' }
                    };
                },
                getLogger() {
                    return logger;
                }
            }
        });

        iotaUtils.retrieveDevice('machine-1', '', function (error, device) {
            assert.ifError(error);
            assert.strictEqual(configurationLookupCalled, false);
            assert.strictEqual(device, expectedDevice);
            done();
        });
    });
});
