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
const _ = require('underscore');
const commandHandler = require('./commandHandler');
const transportSelector = require('./transportSelector');
const async = require('async');
const iotaUtils = require('./iotaUtils');
const constants = require('./constants');
let context = {
    op: 'IoTAgentJSON.commonBinding'
};
const config = require('./configService');

/**
 * Parse a message received from a Topic.
 *
 * @param {Buffer} message          Message to be parsed
 * @return {Object}                 Parsed message or null if an error has occurred.
 */
function parseMessage(message) {
    let parsedMessage;
    let messageArray;
    context = fillService(context, { service: 'n/a', subservice: 'n/a' });
    const stringMessage = message.toString();
    try {
        parsedMessage = JSON.parse(stringMessage);
    } catch (e) {
        parsedMessage = message.toString('hex');
    }
    config.getLogger().debug(context, 'stringMessage: %s parsedMessage: %s', stringMessage, parsedMessage);
    messageArray = [];
    if (Array.isArray(parsedMessage)) {
        if (parsedMessage.length === 1) {
            // Allow single array measures of 1 element not handled like single measures
            messageArray.push(parsedMessage);
        } else {
            messageArray = parsedMessage;
        }
    } else {
        messageArray.push(parsedMessage);
    }

    config.getLogger().debug(context, 'parserMessage array: %s', messageArray);
    return messageArray;
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

    const ctxt = fillService(context, device);
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
function manageConfigurationRequest(apiKey, deviceId, device, objMessage) {
    const ctxt = fillService(context, device);
    for (let i = 0; i < objMessage.length; i++) {
        iotaUtils.manageConfiguration(
            apiKey,
            deviceId,
            device,
            objMessage[i],
            async.apply(sendConfigurationToDevice, device),
            function (error) {
                if (error) {
                    iotAgentLib.alarms.raise(constants.MQTTB_ALARM, error);
                } else {
                    iotAgentLib.alarms.release(constants.MQTTB_ALARM);
                    config
                        .getLogger()
                        .debug(ctxt, 'Configuration request finished for APIKey %s and Device %s', apiKey, deviceId);
                }
                finishSouthBoundTransaction(null);
            }
        );
    }
}

/**
 * Adds a single measure to the context broker. The message for single measures contains the direct value to
 * be inserted in the attribute, given by its name.
 *
 * @param {String} apiKey           API Key corresponding to the Devices configuration.
 * @param {String} deviceId         Id of the device to be updated.
 * @param {String} attribute        Name of the attribute to update.
 * @param {Object} device           Device object containing all the information about a device.
 * @param {Object} parsedMessage    ParsedMessage (JSON or string) message coming from the client.
 */
function singleMeasure(apiKey, deviceId, attribute, device, parsedMessage) {
    context = fillService(context, device);
    config.getLogger().debug(context, 'Processing single measure for device %s', deviceId);

    const values = [
        {
            name: attribute,
            type: guessType(attribute, device, null),
            // If the parsed message is an array with 1 element, use that element, else entire array.
            value: parsedMessage.length === 1 ? parsedMessage[0] : parsedMessage
        }
    ];
    config.getLogger().debug(context, 'values updates %s', JSON.stringify(values));

    iotAgentLib.update(device.name, device.type, '', values, device, function (error) {
        if (error) {
            config.getLogger().error(
                context,
                "MEASURES-002: Couldn't send the updated values to the Context Broker: %j",
                error
            );
        } else {
            config
                .getLogger()
                .debug(context, 'Single measure for device %s successfully updated', deviceId);
        }
        finishSouthBoundTransaction(null);
    });
}

/**
 * Adds multiple measures to the Context Broker. Multiple measures come in the form of single-level JSON objects,
 * whose keys are the attribute names and whose values are the attribute values.
 *
 * @param {String} apiKey           API Key corresponding to the Devices configuration.
 * @param {String} deviceId         Id of the device to be updated.
 * @param {Object} device           Device object containing all the information about a device.
 * @param {Object} messageObj       Array of JSON object sent using.
 */
function multipleMeasures(apiKey, deviceId, device, messageObj) {
    const ctxt = fillService(context, device);
    config.getLogger().debug(context, 'Processing multiple measures for device %s', deviceId);

    let attributesArray = [];
    for (let j = 0; j < messageObj.length; j++) {
        const measure = messageObj[j];
        const values = extractAttributes(device, measure, device.payloadType);
        if (values && values[0] && values[0][0]) {
            // Possibly multi-entity
            attributesArray = attributesArray.concat(values);
        } else {
            attributesArray.push(values);
        }
    }
    config
        .getLogger()
        .debug(
            ctxt,
            'Processing multiple measures for device %s values %j',
            deviceId,
            attributesArray
        );

    iotAgentLib.update(device.name, device.type, '', attributesArray, device, function (error) {
        if (error) {
            config.getLogger().error(
                ctxt,
                "MEASURES-002: Couldn't send the updated values to the Context Broker: %j",
                error
            );
        } else {
            config
                .getLogger()
                .info(ctxt, 'Multiple measures for device %s successfully updated', deviceId);
        }
        finishSouthBoundTransaction(null);
    });
}

/**
 * Handles an incoming message, extracting the API Key, device Id and attribute to update (in the case of single
 * measures) from the topic.
 *
 * @param {String} topic        Topic of the form: '/<APIKey>/deviceId/attrs[/<attributeName>]'.
 * @param {Object} message      message body (Object or Buffer, depending on the value).
 */
function messageHandler(topic, message) {
    // In the new scheme, we do NOT force a leading slash or remove a 'json' sub-path.
    // Instead, we parse the topic as [deviceId, 'state', attribute].
    const topicParts = topic.split('/'); // e.g. ['00:00:0A:B3:47:FA', 'state', 'ambient_humidity']

    const deviceId = topicParts[0] || '';
    const stateLiteral = topicParts[1] || '';
    const attribute = topicParts[2] || ''; // could be 'ambient_humidity', 'config', 'cmd', or others

    // If your device retrieval still needs an apiKey, you can set a default
    const apiKey = ''; // or null, or some fallback

    // Parse the message into an array of items
    const parsedMessage = parseMessage(message);

    /**
     * Called when we have the device object from the DB (or an error).
     */
    function processDeviceMeasure(error, device) {
        if (error || !device) {
            context = fillService(context, { service: 'n/a', subservice: 'n/a' });
            config.getLogger().warn(context, 'MEASURES-004: Device not found for topic %s', topic);
            finishSouthBoundTransaction(null);
        } else {
            const localContext = _.clone(context);
            localContext.service = device.service;
            localContext.subservice = device.subservice;

            // This function routes the message to single measure, multiple measure, etc.
            intoTrans(localContext, function processMessageForDevice(dev) {
                // If the second chunk is 'state', we handle it
                if (stateLiteral === 'state') {
                    // Suppose 'config' => configuration requests
                    if (attribute === 'config' && parsedMessage) {
                        manageConfigurationRequest(apiKey, deviceId, dev, parsedMessage);

                    // Suppose 'cmd' => device is sending commands or requests
                    } else if (attribute === 'cmd') {
                        for (let i = 0; i < parsedMessage.length; i++) {
                            commandHandler.updateCommand(apiKey, deviceId, dev, parsedMessage[i]);
                        }
                        finishSouthBoundTransaction(null);

                    // Or some other special attributes
                    } else if (attribute === constants.CONFIGURATION_COMMAND_UPDATE) {
                        for (let i = 0; i < parsedMessage.length; i++) {
                            commandHandler.updateCommand(apiKey, deviceId, dev, parsedMessage[i]);
                        }
                        finishSouthBoundTransaction(null);

                    // For normal telemetry, we check single vs multiple measures
                    } else if (
                        parsedMessage &&
                        Array.isArray(parsedMessage) &&
                        parsedMessage.every((x) => typeof x === 'object')
                    ) {
                        multipleMeasures(apiKey, deviceId, dev, parsedMessage);
                    } else {
                        singleMeasure(apiKey, deviceId, attribute, dev, parsedMessage);
                    }

                } else {
                    // If the 2nd chunk is not 'state', you can decide how to handle or log
                    config.getLogger().warn(localContext, 'Unknown topic format: %s', topic);
                    finishSouthBoundTransaction(null);
                }
            })(device);
        }
    }

    // Release any prior MQTT alarm
    iotAgentLib.alarms.release(constants.MQTTB_ALARM);

    // Retrieve the device from the DB (using deviceId = MAC).
    // If your code requires an apiKey to retrieve, pass the blank or fallback here
    iotaUtils.retrieveDevice(deviceId, apiKey, processDeviceMeasure);
}

/**
 * Handles an incoming AMQP message, extracting the API Key, device Id and attribute to update (in the case of single
 * measures) from the AMQP topic.
 *
 * @param {String} topic        Topic of the form: '/<APIKey>/deviceId/attributes[/<attributeName>]'.
 * @param {Object} message      AMQP message body (Object or Buffer, depending on the value).
 */
function amqpMessageHandler(topic, message) {
    regenerateTransid(topic);
    messageHandler(topic, message);
}

/**
 * Handles an incoming MQTT message, extracting the API Key, device Id and attribute to update (in the case of single
 * measures) from the MQTT topic.
 *
 * @param {String} topic        Topic of the form: '/<APIKey>/deviceId/attributes[/<attributeName>]'.
 * @param {Object} message      MQTT message body (Object or Buffer, depending on the value).
 */
function mqttMessageHandler(topic, message) {
    regenerateTransid(topic);
    config.getLogger().debug(context, 'message topic: %s', topic);
    messageHandler(topic, message);
}


exports.amqpMessageHandler = amqpMessageHandler;
exports.mqttMessageHandler = mqttMessageHandler;
exports.messageHandler = messageHandler;
exports.extractAttributes = extractAttributes;
exports.guessType = guessType;
