/*
 * Copyright 2016 Telefonica Investigación y Desarrollo, S.A.U
 *
 * This file is part of iotagent-ul
 *
 * iotagent-ul is free software: you can redistribute it and/or
 * modify it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the License,
 * or (at your option) any later version.
 *
 * iotagent-ul is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 * See the GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public
 * License along with iotagent-ul.
 * If not, seehttp://www.gnu.org/licenses/.
 *
 * For those usages not covered by the GNU Affero General Public License
 * please contact with::[iot_support@tid.es]
 *
 * Modified by: Daniel Calvo - ATOS Research & Innovation
 */

/* eslint-disable no-prototype-builtins */

const iotAgentLib = require('iotagent-node-lib');
const regenerateTransid = iotAgentLib.regenerateTransid;
const intoTrans = iotAgentLib.intoTrans;
const finishSouthBoundTransaction = iotAgentLib.finishSouthBoundTransaction;
const fillService = iotAgentLib.fillService;
const commandHandler = require('./commandHandler');
const transportSelector = require('./transportSelector');
const async = require('async');
const iotaUtils = require('./iotaUtils');
const constants = require('./constants');
const { createTelemetryNormalizer } = require('./telemetryNormalizer');
const { createWarningLimiter } = require('./warningLimiter');
const context = {
    op: 'IoTAgentJSON.commonBinding'
};
const config = require('./configService');
let telemetryNormalizer;
let warningLimiter;

function mqttSetting(name, fallback) {
    const mqttConfig = config.getConfig().mqtt || {};
    const value = Number.parseInt(mqttConfig[name], 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

function getTelemetryNormalizer() {
    if (!telemetryNormalizer) {
        telemetryNormalizer = createTelemetryNormalizer({
            maxEntries: mqttSetting(
                'limitCacheMaxEntries',
                constants.MQTT_DEFAULT_LIMIT_CACHE_MAX_ENTRIES
            )
        });
    }
    return telemetryNormalizer;
}

function getWarningLimiter() {
    if (!warningLimiter) {
        warningLimiter = createWarningLimiter({
            intervalMs: mqttSetting('warningIntervalMs', constants.MQTT_DEFAULT_WARNING_INTERVAL_MS),
            maxEntries: mqttSetting(
                'limitCacheMaxEntries',
                constants.MQTT_DEFAULT_LIMIT_CACHE_MAX_ENTRIES
            )
        });
    }
    return warningLimiter;
}

function warnLimited(key, logContext, message, ...args) {
    if (getWarningLimiter().shouldLog(key)) {
        config.getLogger().warn(logContext, message, ...args);
    }
}

function messageByteLength(message) {
    if (Buffer.isBuffer(message)) return message.length;
    return Buffer.byteLength(String(message ?? ''), 'utf8');
}

function asMessageList(value) {
    return Array.isArray(value) ? value : [value];
}

/**
 * Parse a message received from a Topic.
 *
 * @param {Buffer} message          Message to be parsed
 * @return {Object}                 Parsed message or null if an error has occurred.
 */
function parseMessage(message) {
    let parsedMessage;
    const stringMessage = message.toString();
    try {
        parsedMessage = JSON.parse(stringMessage);
    } catch (e) {
        parsedMessage = stringMessage;
    }
    config
        .getLogger()
        .debug(context, 'Parsed telemetry payload with %d bytes and value type %s', messageByteLength(message), typeof parsedMessage);
    return parsedMessage;
}

/**
 * Find the attribute given by its name between all the active attributes of the given device, returning its type, or
 * null otherwise.
 *
 * @param {String}      attribute   Name of the attribute to find.
 * @param {Object}      device      Device object containing all the information about a device.
 * @param {string}      measureType Type of measure attribute according with measure when available (ngsiv2 and ngsild measures)
 * @return {String}                 String identifier of the attribute type.
 */
function guessType(attribute, device, measureType) {
    if (device.active) {
        for (let i = 0; i < device.active.length; i++) {
            if (device.active[i].name === attribute) {
                return device.active[i].type;
            }
        }
    }

    if (attribute === constants.TIMESTAMP_ATTRIBUTE) {
        return constants.TIMESTAMP_TYPE_NGSI2;
    }
    if (measureType) {
        return measureType;
    } else {
        return constants.DEFAULT_ATTRIBUTE_TYPE;
    }
}

function extractAttributes(device, current, payloadType) {
    let values = [];

    const ctxt = fillService({ ...context }, device);
    config.getLogger().debug(ctxt, 'extractAttributes current %j payloadType %j', current, payloadType);

    if (payloadType && [constants.PAYLOAD_NGSIv2, constants.PAYLOAD_NGSILD].includes(payloadType.toLowerCase())) {
        let arrayEntities = [];
        if (current.hasOwnProperty('actionType') && current.hasOwnProperty('entities')) {
            arrayEntities = current.entities;
        } else {
            arrayEntities = [current];
        }
        for (const entity of arrayEntities) {
            const valuesEntity = [];
            for (const k in entity) {
                if (entity.hasOwnProperty(k)) {
                    if (['id', 'type'].includes(k)) {
                        // Include ngsi id and type as measures by inserting here as is
                        // and later in iota-node-lib sendUpdateValueNgsi2 rename as measure_X
                        valuesEntity.push({
                            name: k,
                            type: guessType(k, device, null),
                            value: entity[k]
                        });
                    } else {
                        if (payloadType.toLowerCase() === constants.PAYLOAD_NGSIv2) {
                            valuesEntity.push({
                                name: k,
                                type: guessType(k, device, entity[k].type),
                                value: entity[k].value,
                                metadata: entity[k].metadata ? entity[k].metadata : undefined
                            });
                        } else if (payloadType.toLowerCase() === constants.PAYLOAD_NGSILD) {
                            const ent = {
                                name: k
                            };
                            if (k.toLowerCase() === '@context') {
                                ent.type = '@context';
                                ent.value = entity[k];
                            } else {
                                if (entity[k].type) {
                                    ent.type = guessType(k, device, entity[k].type);
                                    if (['property', 'geoproperty'].includes(entity[k].type.toLowerCase())) {
                                        ent.value = entity[k].value;
                                    } else if (entity[k].type.toLowerCase() === 'relationship') {
                                        ent.value = entity[k].object;
                                    }
                                }
                                // Add other stuff as metadata
                                for (const key in entity[k]) {
                                    if (!['type', 'value', 'object'].includes(key.toLowerCase())) {
                                        if (!ent.metadata) {
                                            ent.metadata = {};
                                        }
                                        ent.metadata[key] = { value: entity[k][key] };
                                    }
                                }
                            }
                            valuesEntity.push(ent);
                        }
                    }
                }
            }
            if (arrayEntities.length > 1) {
                values.push(valuesEntity); // like a multimeasure
            } else {
                values = valuesEntity;
            }
        }
    } else {
        for (const k in current) {
            if (current.hasOwnProperty(k)) {
                values.push({
                    name: k,
                    type: guessType(k, device, null),
                    value: current[k]
                });
            }
        }
    }
    return values;
}

function sendConfigurationToDevice(device, apiKey, group, deviceId, results, callback) {
    iotAgentLib.getConfigurationSilently(config.getConfig().iota.defaultResource || '', apiKey, function (
        error,
        foundGroup
    ) {
        if (!error) {
            group = foundGroup;
        }
        transportSelector.applyFunctionFromBinding(
            [apiKey, group, deviceId, results],
            'sendConfigurationToDevice',
            device.transport || group.transport || config.getConfig().defaultTransport,
            callback
        );
    });
}

/**
 * Deals with configuration requests coming from the device. Whenever a new configuration requests arrives with a list
 * of attributes to retrieve, this handler asks the Context Broker for the values of those attributes, and publish a
 * new message in the "/1234/MQTT_2/configuration/values" topic
 *
 * @param {String} apiKey           API Key corresponding to the Devices configuration.
 * @param {String} deviceId         Id of the device to be updated.
 * @param {Object} device           Device object containing all the information about a device.
 * @param {Object} objMessage          Array of JSON object received.
 */
function manageConfigurationRequest(apiKey, deviceId, device, objMessage, callback) {
    const ctxt = fillService({ ...context }, device);
    async.eachSeries(
        asMessageList(objMessage),
        function manageItem(item, next) {
            iotaUtils.manageConfiguration(
                apiKey,
                deviceId,
                device,
                item,
                async.apply(sendConfigurationToDevice, device),
                function (error) {
                    if (error) {
                        iotAgentLib.alarms.raise(constants.MQTTB_ALARM, error);
                    } else {
                        iotAgentLib.alarms.release(constants.MQTTB_ALARM);
                        config
                            .getLogger()
                            .debug(
                                ctxt,
                                'Configuration request finished for APIKey %s and Device %s',
                                apiKey,
                                deviceId
                            );
                    }
                    next(error);
                }
            );
        },
        callback
    );
}

/**
 * Sends one normalized MQTT update to the Context Broker.
 *
 * @param {String} deviceId         Id of the device to be updated.
 * @param {Object} device           Device object containing all the information about a device.
 * @param {Array} values             Normalized NGSI values.
 * @param {Function} callback        Completion callback.
 */
function sendMeasures(deviceId, device, values, callback) {
    const ctxt = fillService({ ...context }, device);
    config.getLogger().debug(ctxt, 'Processing %d normalized measure(s) for device %s', values.length, deviceId);
    iotAgentLib.update(device.name, device.type, '', values, device, function (error) {
        if (error) {
            config.getLogger().error(
                ctxt,
                "MEASURES-002: Couldn't send the updated values to the Context Broker: %j",
                error
            );
        } else {
            config
                .getLogger()
                .debug(ctxt, 'Normalized measures for device %s successfully updated', deviceId);
        }
        callback(error);
    });
}

/**
 * Handles an incoming message, extracting the API Key, device Id and attribute to update (in the case of single
 * measures) from the topic.
 *
 * @param {String} topic        Topic of the form: '/<APIKey>/deviceId/attrs[/<attributeName>]'.
 * @param {Object} message      message body (Object or Buffer, depending on the value).
 */
function messageHandler(topic, message, callback) {
    const done = typeof callback === 'function' ? callback : () => {};
    const topicParts = String(topic).split('/');
    const deviceId = topicParts[0] || '';
    const stateLiteral = topicParts[1] || '';
    const attribute = topicParts[2] || '';
    const apiKey = '';
    const baseContext = fillService({ ...context }, { service: 'n/a', subservice: 'n/a' });

    if (topicParts.length !== 3 || !deviceId || stateLiteral !== 'state' || !attribute) {
        warnLimited(`topic:${topic}`, baseContext, 'MEASURES-005: Unsupported MQTT topic format: %s', topic);
        done();
        return;
    }

    if (messageByteLength(message) > mqttSetting('maxPayloadBytes', constants.MQTT_DEFAULT_MAX_PAYLOAD_BYTES)) {
        warnLimited(
            `payload:${deviceId}:${attribute}`,
            baseContext,
            'MEASURES-006: MQTT payload for device %s attribute %s exceeds the configured size limit',
            deviceId,
            attribute
        );
        done();
        return;
    }

    const parsedMessage = parseMessage(message);
    iotAgentLib.alarms.release(constants.MQTTB_ALARM);
    iotaUtils.retrieveDevice(deviceId, apiKey, function processDeviceMeasure(error, device) {
        if (error && error.name === 'DEVICE_NOT_FOUND') {
            warnLimited(
                `device:${deviceId}`,
                baseContext,
                'MEASURES-004: MQTT DeviceId %s was discovered but is not provisioned; telemetry is ignored until ' +
                    'an operator assigns a service group',
                deviceId
            );
            done();
            return;
        }

        if (error || !device) {
            warnLimited(
                `device:${deviceId}`,
                baseContext,
                'MEASURES-004: Device %s was not found for an incoming MQTT message',
                deviceId
            );
            done(error || new Error(`Device ${deviceId} was not found`));
            return;
        }

        const localContext = fillService({ ...context }, device);
        intoTrans(localContext, function processMessageForDevice(dev) {
            let completed = false;
            function complete(processingError) {
                if (completed) return;
                completed = true;
                finishSouthBoundTransaction(null);
                done(processingError);
            }

            try {
                if (attribute === 'config') {
                    manageConfigurationRequest(apiKey, deviceId, dev, parsedMessage, complete);
                    return;
                }

                if (attribute === 'cmd' || attribute === constants.CONFIGURATION_COMMAND_UPDATE) {
                    async.eachSeries(
                        asMessageList(parsedMessage),
                        (item, next) => commandHandler.updateCommand(apiKey, deviceId, dev, item, next),
                        complete
                    );
                    return;
                }

                const normalized = getTelemetryNormalizer().normalize({
                    deviceId,
                    attribute,
                    value: parsedMessage,
                    provisionedType: guessType(attribute, dev, null)
                });

                normalized.warnings.forEach((warning) => {
                    warnLimited(
                        `normalize:${deviceId}:${attribute}:${warning.code}`,
                        localContext,
                        'MEASURES-007: Telemetry warning for device %s attribute %s (%s): %s',
                        deviceId,
                        attribute,
                        warning.code,
                        warning.detail
                    );
                });

                if (!normalized.values.length) {
                    complete();
                    return;
                }

                sendMeasures(deviceId, dev, normalized.values, complete);
            } catch (processingError) {
                complete(processingError);
            }
        })(device);
    });
}

/**
 * Handles an incoming AMQP message, extracting the API Key, device Id and attribute to update (in the case of single
 * measures) from the AMQP topic.
 *
 * @param {String} topic        Topic of the form: '/<APIKey>/deviceId/attributes[/<attributeName>]'.
 * @param {Object} message      AMQP message body (Object or Buffer, depending on the value).
 */
function amqpMessageHandler(topic, message, callback) {
    regenerateTransid(topic);
    messageHandler(topic, message, callback);
}

/**
 * Handles an incoming MQTT message, extracting the API Key, device Id and attribute to update (in the case of single
 * measures) from the MQTT topic.
 *
 * @param {String} topic        Topic of the form: '/<APIKey>/deviceId/attributes[/<attributeName>]'.
 * @param {Object} message      MQTT message body (Object or Buffer, depending on the value).
 */
function mqttMessageHandler(topic, message, callback) {
    regenerateTransid(topic);
    config.getLogger().debug(context, 'message topic: %s', topic);
    messageHandler(topic, message, callback);
}


exports.amqpMessageHandler = amqpMessageHandler;
exports.mqttMessageHandler = mqttMessageHandler;
exports.messageHandler = messageHandler;
exports.extractAttributes = extractAttributes;
exports.guessType = guessType;
exports.parseMessage = parseMessage;
