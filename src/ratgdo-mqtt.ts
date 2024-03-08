/* Copyright(C) 2017-2024, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ratgdo-mqtt.ts: MQTT connectivity class for Ratgdo.
 */
import mqtt, { MqttClient } from "mqtt";
import { RATGDO_MQTT_RECONNECT_INTERVAL } from "./settings.js";
import { RatgdoAccessory } from "./ratgdo-device.js";
import { RatgdoLogging } from "./ratgdo-types.js";
import { RatgdoOptions } from "./ratgdo-options.js";
import { RatgdoPlatform } from "./ratgdo-platform.js";

export class RatgdoMqtt {

  private config: RatgdoOptions;
  private isConnected: boolean;
  private log: RatgdoLogging;
  private mqtt: MqttClient | null;
  private platform: RatgdoPlatform;
  private subscriptions: { [index: string]: (cbBuffer: Buffer) => void };

  constructor(platform: RatgdoPlatform) {

    this.config = platform.config;
    this.isConnected = false;
    this.log = platform.log;
    this.mqtt = null;
    this.platform = platform;
    this.subscriptions = {};

    if(!this.config.mqttUrl) {

      return;
    }

    this.configure();
  }

  // Connect to the MQTT broker.
  private configure(): void {

    // Try to connect to the MQTT broker and make sure we catch any URL errors.
    try {

      this.mqtt = mqtt.connect(this.config.mqttUrl, { reconnectPeriod: RATGDO_MQTT_RECONNECT_INTERVAL * 1000, rejectUnauthorized: false});

    } catch(error) {

      if(error instanceof Error) {

        switch(error.message) {

          case "Missing protocol":

            this.log.error("MQTT Broker: Invalid URL provided: %s.", this.config.mqttUrl);
            break;

          default:

            this.log.error("MQTT Broker: Error: %s.", error.message);
            break;
        }

      }

    }

    // We've been unable to even attempt to connect. It's likely we have a configuration issue - we're done here.
    if(!this.mqtt) {

      return;
    }

    // Notify the user when we connect to the broker.
    this.mqtt.on("connect", () => {

      this.isConnected = true;

      // Magic incantation to redact passwords.
      const redact = /^(?<pre>.*:\/{0,2}.*:)(?<pass>.*)(?<post>@.*)/;

      this.log.info("Connected to MQTT broker: %s (topic: %s).", this.config.mqttUrl.replace(redact, "$<pre>REDACTED$<post>"), this.config.mqttTopic);
    });

    // Notify the user when we've disconnected.
    this.mqtt.on("close", () => {

      if(this.isConnected) {

        this.isConnected = false;

        // Magic incantation to redact passwords.
        const redact = /^(?<pre>.*:\/{0,2}.*:)(?<pass>.*)(?<post>@.*)/;

        this.log.info("Disconnected from MQTT broker: %s.", this.config.mqttUrl.replace(redact, "$<pre>REDACTED$<post>"));
      }
    });

    // Process inbound messages and pass it to the right message handler.
    this.mqtt.on("message", (topic: string, message: Buffer) => {

      if(this.subscriptions[topic]) {

        this.subscriptions[topic](message);
      }
    });

    // Notify the user when there's a connectivity error.
    this.mqtt.on("error", (error: Error) => {
      switch((error as NodeJS.ErrnoException).code) {

        case "ECONNREFUSED":

          this.log.error("MQTT Broker: Connection refused (url: %s). Will retry again in %s minute%s.", this.config.mqttUrl,
            RATGDO_MQTT_RECONNECT_INTERVAL / 60, RATGDO_MQTT_RECONNECT_INTERVAL / 60 > 1 ? "s": "");
          break;

        case "ECONNRESET":

          this.log.error("MQTT Broker: Connection reset (url: %s). Will retry again in %s minute%s.", this.config.mqttUrl,
            RATGDO_MQTT_RECONNECT_INTERVAL / 60, RATGDO_MQTT_RECONNECT_INTERVAL / 60 > 1 ? "s": "");
          break;

        case "ENOTFOUND":

          this.mqtt?.end(true);
          this.log.error("MQTT Broker: Hostname or IP address not found. (url: %s).", this.config.mqttUrl);
          break;

        default:

          this.log.error("MQTT Broker: %s (url: %s). Will retry again in %s minute%s.", error, this.config.mqttUrl,
            RATGDO_MQTT_RECONNECT_INTERVAL / 60, RATGDO_MQTT_RECONNECT_INTERVAL / 60 > 1 ? "s": "");
          break;
      }
    });
  }

  // Publish an MQTT event to a broker.
  public publish(accessory: RatgdoAccessory, topic: string, message: string): void {

    const expandedTopic = this.expandTopic(accessory.device.mac, topic);

    // No valid topic returned, we're done.
    if(!expandedTopic) {

      return;
    }

    accessory.log.debug("MQTT publish: %s Message: %s.", expandedTopic, message);

    // By default, we publish as: ratgdo/mac/event/name
    this.mqtt?.publish(expandedTopic, message);
  }

  // Subscribe to an MQTT topic.
  public subscribe(accessory: RatgdoAccessory, topic: string, callback: (cbBuffer: Buffer) => void): void {

    const expandedTopic = this.expandTopic(accessory.device.mac, topic);

    // No valid topic returned, we're done.
    if(!expandedTopic) {

      return;
    }

    accessory.log.debug("MQTT subscribe: %s.", expandedTopic);

    // Add to our callback list.
    this.subscriptions[expandedTopic] = callback;

    // Tell MQTT we're subscribing to this event. By default, we subscribe as: ratgdo/mac/event/name.
    this.mqtt?.subscribe(expandedTopic);
  }

  // Subscribe to a specific MQTT topic and publish a value on a get request.
  public subscribeGet(accessory: RatgdoAccessory, topic: string, type: string, getValue: () => string): void {

    // Return the current status of a given sensor.
    this.platform.mqtt?.subscribe(accessory, topic + "/get", (message: Buffer) => {

      const value = message.toString().toLowerCase();

      // Only publish if we receive a true value.
      if(value !== "true") {

        return;
      }

      // Publish our value and inform the user.
      this.platform.mqtt?.publish(accessory, topic, getValue());
      accessory.log.info("MQTT: %s status published.", type);
    });
  }

  // Subscribe to a specific MQTT topic and set a value on a set request.
  public subscribeSet(accessory: RatgdoAccessory, topic: string, type: string, setValue: (value: string) => void): void {

    // Return the current status of a given sensor.
    this.platform.mqtt?.subscribe(accessory, topic + "/set", (message: Buffer) => {

      const value = message.toString().toLowerCase();

      // Set our value and inform the user.
      setValue(value);
      accessory.log.info("MQTT: set message received for %s: %s.", type, value);
    });
  }

  // Unsubscribe to an MQTT topic.
  public unsubscribe(accessory: RatgdoAccessory, topic: string): void {

    const expandedTopic = this.expandTopic(accessory.device.mac, topic);

    // No valid topic returned, we're done.
    if(!expandedTopic) {

      return;
    }

    delete this.subscriptions[expandedTopic];
  }

  // Expand a topic to a unique, fully formed one.
  private expandTopic(mac: string, topic: string) : string | null {

    // No accessory, we're done.
    if(!mac) {

      return null;
    }

    return this.config.mqttTopic + "/" + mac + "/" + topic;
  }
}
