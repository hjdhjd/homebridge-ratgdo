/* Copyright(C) 2017-2025, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ratgdo-api.ts: ESPHome native API client for Ratgdo.
 */
import type { HomebridgePluginLogging, Nullable } from "homebridge-plugin-utils";
import { type Socket, createConnection } from "node:net";
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";

// Define the minimum frame header size for message validation.
const MIN_FRAME_SIZE = 3;

// Define the fixed32 field size in bytes.
const FIXED32_SIZE = 4;

/**
 * A subset of the ESPHome API message types that we need for Ratgdo.
 */
enum MessageType {

  HELLO_REQUEST                          = 1,
  HELLO_RESPONSE                         = 2,
  CONNECT_REQUEST                        = 3,
  CONNECT_RESPONSE                       = 4,
  DISCONNECT_REQUEST                     = 5,
  DISCONNECT_RESPONSE                    = 6,
  PING_REQUEST                           = 7,
  PING_RESPONSE                          = 8,
  DEVICE_INFO_REQUEST                    = 9,
  DEVICE_INFO_RESPONSE                   = 10,
  LIST_ENTITIES_REQUEST                  = 11,
  LIST_ENTITIES_BINARY_SENSOR_RESPONSE   = 12,
  LIST_ENTITIES_COVER_RESPONSE           = 13,
  LIST_ENTITIES_LIGHT_RESPONSE           = 15,
  LIST_ENTITIES_SENSOR_RESPONSE          = 16,
  LIST_ENTITIES_SWITCH_RESPONSE          = 17,
  LIST_ENTITIES_TEXT_SENSOR_RESPONSE     = 18,
  LIST_ENTITIES_DONE_RESPONSE            = 19,
  SUBSCRIBE_STATES_REQUEST               = 20,
  BINARY_SENSOR_STATE                    = 21,
  COVER_STATE                            = 22,
  LIGHT_STATE                            = 24,
  SENSOR_STATE                           = 25,
  SWITCH_STATE                           = 26,
  TEXT_SENSOR_STATE                      = 27,
  COVER_COMMAND_REQUEST                  = 30,
  FAN_COMMAND_REQUEST                    = 31,
  LIGHT_COMMAND_REQUEST                  = 32,
  SWITCH_COMMAND_REQUEST                 = 33,
  GET_TIME_REQUEST                       = 36,
  GET_TIME_RESPONSE                      = 37,
  LIST_ENTITIES_SERVICES_RESPONSE        = 41,
  LIST_ENTITIES_NUMBER_RESPONSE          = 49,
  NUMBER_STATE                           = 50,
  LIST_ENTITIES_LOCK_RESPONSE            = 58,
  LOCK_STATE                             = 59,
  LOCK_COMMAND_REQUEST                   = 60,
  LIST_ENTITIES_BUTTON_RESPONSE          = 61,
  BUTTON_COMMAND_REQUEST                 = 62
}

/**
 * Define the valid types that a decoded ESPHome field value can have.
 */
type FieldValue = Buffer | number;

/**
 * Wire types used in protobuf encoding.
 */
enum WireType {

  VARINT = 0,
  FIXED64 = 1,
  LENGTH_DELIMITED = 2,
  FIXED32 = 5
}

/**
 * Represents one entity from the ESPHome device.
 *
 * @property key - The numeric key identifier for the entity.
 * @property name - The human-readable name of the entity.
 * @property type - The type of entity (e.g., "switch", "light", "cover").
 */
interface Entity {

  key: number;
  name: string;
  type: string;
}

/**
 * Represents a protobuf field with tag and wire type.
 *
 * @property fieldNumber - The field number in the protobuf message.
 * @property wireType - The wire type for encoding the field.
 * @property value - The field value (number or Buffer).
 */
interface ProtoField {

  fieldNumber: number;
  wireType: WireType;
  value: number | Buffer;
}

/**
 * Device information to send when requested by the ESPHome device.
 *
 * @property bluetoothProxyFeatureFlags - Bluetooth proxy feature flags.
 * @property compilationTime - When the client was compiled/started.
 * @property esphomeVersion - Version of ESPHome protocol being used.
 * @property hasDeepSleep - Whether the client supports deep sleep.
 * @property legacyBluetoothProxyVersion - Legacy Bluetooth proxy version.
 * @property macAddress - MAC address of the client (format: "AA:BB:CC:DD:EE:FF").
 * @property model - Model or type of the client.
 * @property name - Friendly name of the client.
 * @property projectName - Name of the project/plugin.
 * @property projectVersion - Version of the project/plugin.
 * @property usesPassword - Whether the client uses password authentication.
 * @property webserverPort - Port number of any web server.
 */
export interface DeviceInfo {

  bluetoothProxyFeatureFlags?: number;
  compilationTime?: string;
  esphomeVersion?: string;
  hasDeepSleep?: boolean;
  legacyBluetoothProxyVersion?: number;
  macAddress?: string;
  model?: string;
  name?: string;
  projectName?: string;
  projectVersion?: string;
  usesPassword?: boolean;
  webserverPort?: number;
}

/**
 * ESPHome API client for communicating with ESPHome devices.
 * Implements the ESPHome native API protocol over TCP.
 *
 * @extends EventEmitter
 * @emits connect - Connected to device.
 * @emits disconnect - Disconnected from device.
 * @emits message - Raw message received with type and payload.
 * @emits entities - List of discovered entities after enumeration.
 * @emits telemetry - Generic telemetry update for any entity.
 * @emits heartbeat - Heartbeat response received.
 * @emits {entityType} - Type-specific telemetry events (e.g., "cover", "light", "switch").
 *
 * @example
 * ```typescript
 * const client = new EspHomeClient(ratgdo, "192.168.1.100");
 * client.connect();
 *
 * // Listen for discovered entities
 * client.on("entities", (entities) => {
 *
 *   // Log all available entity IDs
 *   client.logAllEntityIds();
 * });
 *
 * // Send commands using entity IDs
 * await client.sendSwitchCommand("switch-garagedoor", true);
 * await client.sendLightCommand("light-light", { state: true, brightness: 0.8 });
 * await client.sendCoverCommand("cover-door", "open");
 * ```
 */
export class EspHomeClient extends EventEmitter {

  // The TCP socket connection to the ESPHome device.
  private clientSocket: Nullable<Socket>;

  // The data event listener function reference for cleanup.
  private dataListener: Nullable<(chunk: Buffer) => void>;

  // The hostname or IP address of the ESPHome device.
  private host: string;

  // Logging.
  private log: HomebridgePluginLogging;

  // The port number for the ESPHome API connection.
  private port: number;

  // Buffer for accumulating incoming data until complete messages are received.
  private recvBuffer;

  // Device information received from the ESPHome device.
  private remoteDeviceInfo: Nullable<DeviceInfo>;

  // Array storing all discovered entities from the device.
  private discoveredEntities: Entity[];

  // Map from entity identifier strings to their numeric keys.
  private entityKeys;

  // Map from entity keys to their human-readable names.
  private entityNames;

  // Map from entity keys to their type labels.
  private entityTypes;

  /**
   * Creates a new ESPHome client instance.
   *
   * @param log - Logging interface.
   * @param host - The hostname or IP address of the ESPHome device.
   * @param port - The port number for the ESPHome API (default: 6053).
   */
  constructor(log: HomebridgePluginLogging, host: string, port = 6053) {

    super();

    this.clientSocket = null;
    this.dataListener = null;
    this.discoveredEntities = [];
    this.entityKeys = new Map<string, number>();
    this.entityNames = new Map<number, string>();
    this.entityTypes = new Map<number, string>();
    this.host = host;
    this.log = log;
    this.port = port;
    this.recvBuffer = Buffer.alloc(0);
    this.remoteDeviceInfo = null;
  }

  /**
   * Connect to the ESPHome device and start communication.
   */
  public connect(): void {

    // Clean up any existing data listener before establishing a new connection.
    this.cleanupDataListener();

    // Create a new TCP connection to the ESPHome device.
    this.clientSocket = createConnection({ host: this.host, port: this.port });

    // Handle successful connection by initiating the handshake process.
    this.clientSocket.on("connect", () => this.handleConnect());

    // Set up the data handler for incoming messages.
    this.dataListener = (chunk: Buffer): void => this.handleData(chunk);
    this.clientSocket.on("data", this.dataListener);

    // Handle socket errors by attempting to reconnect.
    this.clientSocket.once("error", (err: Error) => this.handleSocketError(err));

    // Handle socket closure by attempting to reconnect.
    this.clientSocket.once("close", () => this.handleSocketClose());
  }

  /**
   * Disconnect from the ESPHome device and cleanup resources.
   */
  public disconnect(): void {

    // Clean up the data listener.
    this.cleanupDataListener();

    // Destroy the socket connection.
    if(this.clientSocket) {

      this.clientSocket.destroy();
      this.clientSocket = null;
    }

    this.emit("disconnect");
  }

  /**
   * Handle a newly connected socket.
   */
  private handleConnect(): void {

    this.log.debug("Connected to " + this.host + ":" + this.port + ".");

    // Send the initial hello request to start the handshake.
    // Prepare the client information string for the hello message.
    const clientInfo = Buffer.from("homebridge-ratgdo", "utf8");

    // Build the hello payload fields.
    const fields: ProtoField[] = [

      { fieldNumber: 1, value: clientInfo, wireType: WireType.LENGTH_DELIMITED },
      { fieldNumber: 2, value: 1, wireType: WireType.VARINT },
      { fieldNumber: 3, value: 10, wireType: WireType.VARINT }
    ];

    // Encode and send the hello request.
    const payload = this.encodeProtoFields(fields);

    this.frameAndSend(MessageType.HELLO_REQUEST, payload);
  }

  /**
   * Handle socket errors.
   */
  private handleSocketError(err: Error): void {

    switch((err as NodeJS.ErrnoException).code) {

      case "ECONNRESET":

        this.log.error("Connection reset.");

        break;

      case "EHOSTDOWN":
      case "EHOSTUNREACH":

        this.log.error("Ratgdo unreachable.");

        break;

      case "ETIMEDOUT":

        this.log.error("Connection timed out.");

        break;

      default:

        this.log.error("Socket error: %s | %s", (err as NodeJS.ErrnoException).code, err);

        break;
    }

    this.disconnect();
  }

  /**
   * Handle socket closure.
   */
  private handleSocketClose(): void {

    this.log.debug("Socket closed");
  }

  /**
   * Clean up the data listener if it exists.
   */
  private cleanupDataListener(): void {

    if(this.dataListener && this.clientSocket) {

      this.clientSocket.off("data", this.dataListener);
      this.dataListener = null;
    }
  }

  /**
   * Handle incoming raw data, frame messages, and dispatch.
   */
  private handleData(chunk: Buffer): void {

    // Append the new data chunk to our receive buffer.
    this.recvBuffer = Buffer.concat([this.recvBuffer, chunk]);

    // Process complete messages from the buffer.
    while(this.recvBuffer.length >= MIN_FRAME_SIZE) {

      // Verify the frame starts with the expected sentinel byte.
      if(this.recvBuffer[0] !== 0) {

        this.log.error("Framing error: missing 0x00.");

        // Find the next sentinel position.
        const idx = this.recvBuffer.indexOf(0);

        // If no sentinel is found, drop all data and exit loop.
        if(idx === -1) {

          this.recvBuffer = Buffer.alloc(0);

          break;
        }

        // Discard data up to the sentinel.
        this.recvBuffer = this.recvBuffer.subarray(idx);

        // Retry parsing with the new buffer.
        continue;
      }

      // Attempt to read the message length varint.
      const [length, lenBytes] = this.readVarint(this.recvBuffer, 1);

      // Incomplete varint; wait for more data.
      if((length === -1) && (lenBytes === -1)) {

        break;
      }

      // Attempt to read the message type varint.
      const [type, typeBytes] = this.readVarint(this.recvBuffer, 1 + lenBytes);

      // Incomplete varint; wait for more data.
      if((type === -1) && (typeBytes === -1)) {

        break;
      }

      // Calculate the total header size.
      const headerSize = 1 + lenBytes + typeBytes;

      // If full message is not yet received, wait for more data.
      if(this.recvBuffer.length < (headerSize + length)){

        break;
      }

      // Extract the message payload.
      const payload = this.recvBuffer.subarray(headerSize, (headerSize + length));

      // Dispatch the message to the handler.
      this.handleMessage(type, payload);

      // Remove the processed message from the buffer.
      this.recvBuffer = this.recvBuffer.subarray(headerSize + length);
    }
  }

  /**
   * Dispatch based on message type.
   */
  private handleMessage(type: number, payload: Buffer): void {

    let epoch, nowBuf;

    // Emit a generic message event for all message types.
    this.emit("message", { payload, type });

    // Handle specific message types.
    switch(type) {

      case MessageType.HELLO_RESPONSE:

        // Send the connect request to complete the handshake.
        this.frameAndSend(MessageType.CONNECT_REQUEST, Buffer.alloc(0));

        break;

      case MessageType.CONNECT_RESPONSE:

        // Query device information once we're connected.
        this.frameAndSend(MessageType.DEVICE_INFO_REQUEST, Buffer.alloc(0));

        // Start entity enumeration after successful connection.
        this.frameAndSend(MessageType.LIST_ENTITIES_REQUEST, Buffer.alloc(0));

        break;

      case MessageType.DISCONNECT_REQUEST:

        // Start entity enumeration after successful connection.
        this.frameAndSend(MessageType.DISCONNECT_RESPONSE, Buffer.alloc(0));

        this.disconnect();

        break;

      case MessageType.DISCONNECT_RESPONSE:

        this.disconnect();

        break;


      case MessageType.DEVICE_INFO_RESPONSE:

        this.handleDeviceInfoResponse(payload);

        this.emit("connect", this.remoteDeviceInfo);

        break;

      case MessageType.LIST_ENTITIES_DONE_RESPONSE:

        // Emit the complete list of discovered entities.
        this.emit("entities", this.discoveredEntities);

        // Now that we know all the entities we have available, subscribe to state updates.
        this.frameAndSend(MessageType.SUBSCRIBE_STATES_REQUEST, Buffer.alloc(0));

        break;

      case MessageType.PING_REQUEST:

        this.log.debug("Received PingRequest, replying");

        // Respond to ping requests to keep the connection alive.
        this.frameAndSend(MessageType.PING_RESPONSE, Buffer.alloc(0));

        // Emit heartbeat event for connection monitoring.
        this.emit("heartbeat");

        break;

      case MessageType.PING_RESPONSE:

        // Emit heartbeat event for connection monitoring.
        this.emit("heartbeat");

        break;

      case MessageType.GET_TIME_REQUEST:

        // We got a time‐sync request from the device; reply with our current epoch.
        this.log.debug("Received GetTimeRequest, replying with current epoch time");

        // Prepare a four-byte little‐endian buffer.
        nowBuf = Buffer.alloc(FIXED32_SIZE);

        // Calculate our time in seconds and encode it in our buffer.
        nowBuf.writeUInt32LE(Math.floor(Date.now() / 1000), 0);

        // Build the protobuf field: field 1, fixed32 wire type, then encode and send the message.
        this.frameAndSend(MessageType.GET_TIME_RESPONSE, this.encodeProtoFields([ { fieldNumber: 1, value: nowBuf, wireType: WireType.FIXED32 } ]));

        break;

      case MessageType.GET_TIME_RESPONSE:

        // Decode the fields in the GetTimeResponse payload and extract the epoch_seconds fixed32 field (field 1).
        epoch = this.extractFixed32Field(this.decodeProtobuf(payload), 1);

        if(epoch !== undefined) {

          // Emit a `time` event carrying the returned epoch seconds.
          this.emit("time", epoch);

          this.log.debug("Received GetTimeResponse: epoch seconds", epoch);
        }

        break;

      default:

        // Check if this is a list entities response.
        if(this.isListEntitiesResponse(type)) {

          this.handleListEntity(type, payload);

          return;
        }

        // Check if this is a state update.
        if(this.isStateUpdate(type)) {

          this.handleTelemetry(type, payload);

          return;
        }

        // Unhandled message type.
        this.log.warn("Unhandled message type: " + type + " | payload: " + payload.toString("hex"));

        break;
    }
  }

  /**
   * Handle device info response from the ESPHome device.
   */
  private handleDeviceInfoResponse(payload: Buffer): void {

    this.log.debug("Received DeviceInfoResponse");

    // Decode the protobuf fields from the payload.
    const fields = this.decodeProtobuf(payload);

    // Build the device info object from the response.
    const info: DeviceInfo = {};

    // Extract uses_password (field 1).
    info.usesPassword = this.extractNumberField(fields, 1) === 1;

    // Extract name (field 2).
    info.name = this.extractStringField(fields, 2);

    // Extract MAC address (field 3).
    info.macAddress = this.extractStringField(fields, 3);

    // Extract ESPHome version (field 4).
    info.esphomeVersion = this.extractStringField(fields, 4);

    // Extract compilation time (field 5).
    info.compilationTime = this.extractStringField(fields, 5);

    // Extract model (field 6).
    info.model = this.extractStringField(fields, 6);

    // Extract has_deep_sleep (field 7).
    info.hasDeepSleep = this.extractNumberField(fields, 7) === 1;

    // Extract project_name (field 8).
    info.projectName = this.extractStringField(fields, 8);

    // Extract project_version (field 9).
    info.projectVersion = this.extractStringField(fields, 9);

    // Extract webserver_port (field 10).
    info.webserverPort = this.extractNumberField(fields, 10);

    // Extract legacy_bluetooth_proxy_version (field 11).
    info.legacyBluetoothProxyVersion = this.extractNumberField(fields, 11);

    // Extract bluetooth_proxy_feature_flags (field 12).
    info.bluetoothProxyFeatureFlags = this.extractNumberField(fields, 12);

    // Store the remote device info.
    this.remoteDeviceInfo = info;
  }

  /**
   * Return the device information of the connected ESPHome device if available.
   *
   * @returns The device information if available, or `null`.
   */
  public deviceInfo(): Nullable<DeviceInfo> {

    // Ensure the device information can't be mutated by our caller.
    return this.remoteDeviceInfo ? { ...this.remoteDeviceInfo } : null;
  }

  /**
   * Check if a message type is a list entities response.
   */
  private isListEntitiesResponse(type: number): boolean {

    return (type >= MessageType.LIST_ENTITIES_BINARY_SENSOR_RESPONSE && type <= MessageType.LIST_ENTITIES_TEXT_SENSOR_RESPONSE) ||
    [ MessageType.LIST_ENTITIES_SERVICES_RESPONSE, MessageType.LIST_ENTITIES_NUMBER_RESPONSE, MessageType.LIST_ENTITIES_LOCK_RESPONSE,
      MessageType.LIST_ENTITIES_BUTTON_RESPONSE ].includes(type);
  }

  /**
   * Check if a message type is a state update.
   */
  private isStateUpdate(type: number): boolean {

    return [ MessageType.BINARY_SENSOR_STATE, MessageType.COVER_STATE, MessageType.LIGHT_STATE, MessageType.SENSOR_STATE, MessageType.SWITCH_STATE,
      MessageType.TEXT_SENSOR_STATE, MessageType.NUMBER_STATE, MessageType.LOCK_STATE, MessageType.BUTTON_COMMAND_REQUEST ].includes(type);
  }

  /**
   * Extract entity type label from message type.
   */
  private getEntityTypeLabel(type: MessageType): string {

    return MessageType[type].replace(/^LIST_ENTITIES_/, "").replace(/_RESPONSE$/, "").replace(/_STATE$/, "").toLowerCase();
  }

  /**
   * Parses a single ListEntities*Response, logs it, and stores it.
   */
  private handleListEntity(type: number, payload: Buffer): void {

    // Decode the protobuf fields from the payload.
    const fields = this.decodeProtobuf(payload);

    // Extract and validate the entity key.
    const key = this.extractFixed32Field(fields, 2);

    if(key === undefined) {

      return;
    }

    // Extract and validate the entity name.
    const name = this.extractStringField(fields, 3);

    if(name === undefined) {

      return;
    }

    // Determine the entity type label from the message type enum.
    const label = this.getEntityTypeLabel(type);

    // Store the entity information in our lookup maps.
    const entityId = (label + "-" + name).replace(/ /g, "_").toLowerCase();

    this.entityKeys.set(entityId, key);
    this.entityNames.set(key, name);
    this.entityTypes.set(key, label);

    // Create an entity object and add it to our discovered entities list.
    const ent: Entity = { key, name, type: label };

    this.discoveredEntities.push(ent);

    // Log the entity registration for debugging.
    this.log.debug("Registered entity: [" + key + "] " + name + " (" + label + ") | " + type);
  }

  /**
   * Decodes a state update, looks up entity info, and emits events.
   */
  private handleTelemetry(type: number, payload: Buffer): void {

    // Decode the protobuf fields from the payload.
    const fields = this.decodeProtobuf(payload);

    // Extract the entity key from field 1.
    const key = this.extractEntityKey(fields, 1);

    if(key === undefined) {

      return;
    }

    // Look up the entity information using the key.
    const name = this.entityNames.get(key) || ("unknown(" + key + ")");
    const typeLabel = this.entityTypes.get(key) || this.getEntityTypeLabel(type);
    const eventType = typeLabel.toLowerCase();

    // Handle cover state messages specially as they have additional fields.
    if(type === MessageType.COVER_STATE) {

      this.handleCoverState(fields, eventType, name);

      return;
    }

    // Handle all other entity types with simpler value extraction.
    const value = this.extractTelemetryValue(fields, 2);

    // Build the telemetry data object.
    const data = { entity: name, type: eventType, value };

    // Emit both the generic telemetry event and the type-specific event.
    this.emit("telemetry", data);
    this.emit(eventType, data);

    this.log.debug("TYPE: " + eventType + " | data: " + JSON.stringify(data));
  }

  /**
   * Handle cover state telemetry.
   */
  private handleCoverState(fields: Record<number, FieldValue[]>, eventType: string, name: string): void {

    // Extract all cover-specific fields.
    const legacyState = this.extractNumberField(fields, 2);
    const position = this.extractTelemetryValue(fields, 3);
    const tilt = this.extractTelemetryValue(fields, 4);
    const currentOperation = this.extractNumberField(fields, 5);
    const deviceId = this.extractNumberField(fields, 6);

    // Build a comprehensive cover state data object.
    const data = {

      currentOperation,
      deviceId,
      entity: name,
      legacyState,
      position,
      tilt,
      type: eventType
    };

    // Emit both the generic telemetry event and the type-specific event.
    this.emit("telemetry", data);
    this.emit(eventType, data);

    this.log.debug("TYPE: " + eventType + " | data: " + JSON.stringify(data));
  }

  /**
   * Extract entity key from protobuf fields.
   */
  private extractEntityKey(fields: Record<number, FieldValue[]>, fieldNum: number): number | undefined {

    const rawKey = fields[fieldNum]?.[0];

    if(!rawKey) {

      return undefined;
    }

    // Handle both Buffer and number types.
    if(Buffer.isBuffer(rawKey)) {

      return rawKey.readUInt32LE(0);
    }

    if(typeof rawKey === "number") {

      return rawKey;
    }

    return undefined;
  }

  /**
   * Extract fixed32 field from protobuf fields.
   */
  private extractFixed32Field(fields: Record<number, FieldValue[]>, fieldNum: number): number | undefined {

    const rawBuf = fields[fieldNum]?.[0];

    if(!Buffer.isBuffer(rawBuf) || rawBuf.length !== FIXED32_SIZE) {

      return undefined;
    }

    return rawBuf.readUInt32LE(0);
  }

  /**
   * Extract string field from protobuf fields.
   */
  private extractStringField(fields: Record<number, FieldValue[]>, fieldNum: number): string | undefined {

    const rawBuf = fields[fieldNum]?.[0];

    if(!Buffer.isBuffer(rawBuf)) {

      return undefined;
    }

    return rawBuf.toString("utf8");
  }

  /**
   * Extract number field from protobuf fields.
   */
  private extractNumberField(fields: Record<number, FieldValue[]>, fieldNum: number): number | undefined {

    const raw = fields[fieldNum]?.[0];

    return typeof raw === "number" ? raw : undefined;
  }

  /**
   * Extract telemetry value from protobuf fields.
   */
  private extractTelemetryValue(fields: Record<number, FieldValue[]>, fieldNum: number): number | string | undefined {

    const valRaw = fields[fieldNum]?.[0];

    if(Buffer.isBuffer(valRaw)) {

      // Interpret 4-byte buffers as float32, others as UTF-8 strings.
      return valRaw.length === FIXED32_SIZE ? valRaw.readFloatLE(0) : valRaw.toString("utf8");
    }

    return valRaw as number;
  }

  /**
   * Frames a raw protobuf payload with the 0x00 sentinel, length, and message type.
   */
  private frameAndSend(type: MessageType, payload: Buffer): void {

    // Construct the message header with sentinel, length, and type.
    const header = Buffer.concat([ Buffer.from([0x00]), this.encodeVarint(payload.length), this.encodeVarint(type) ]);

    // Write the complete framed message to the socket.
    if(this.clientSocket) {

      this.clientSocket.write(Buffer.concat([header, payload]));
    }
  }

  /**
   * Encode protobuf fields into a buffer.
   */
  private encodeProtoFields(fields: ProtoField[]): Buffer {

    const parts: Buffer[] = [];
    let buf: Buffer;

    for(const field of fields) {

      // Encode the field tag.
      parts.push(this.encodeVarint((field.fieldNumber << 3) | field.wireType));

      // Encode the field value based on wire type.
      switch(field.wireType) {

        case WireType.VARINT:

          parts.push(this.encodeVarint(field.value as number));

          break;

        case WireType.LENGTH_DELIMITED:

          buf = field.value as Buffer;

          parts.push(this.encodeVarint(buf.length));
          parts.push(buf);

          break;

        case WireType.FIXED32:

          buf = Buffer.alloc(FIXED32_SIZE);

          if(typeof field.value === "number") {

            buf.writeUInt32LE(field.value, 0);
          } else {

            (field.value as Buffer).copy(buf);
          }

          parts.push(buf);

          break;
      }
    }

    return Buffer.concat(parts);
  }

  /**
   * Build key field as fixed32 for command requests.
   */
  private buildKeyField(key: number): ProtoField {

    return { fieldNumber: 1, value: key, wireType: WireType.FIXED32 };
  }

  /**
   * Get entity key by ID.
   *
   * @param id - The entity ID to look up.
   *
   * @returns The entity key or `null` if not found.
   */
  public getEntityKey(id: string): Nullable<number> {

    return this.entityKeys.get(id) ?? null;
  }

  /**
   * Log all registered entity IDs for debugging.
   * Logs entities grouped by type with their names and keys.
   */
  public logAllEntityIds(): void {

    this.log.warn("Registered Entity IDs:");

    for(const [type, ids] of Object.entries(this.getAvailableEntityIds())) {

      this.log.warn("  " + type + ":");

      for(const id of ids) {

        const entity = this.getEntityById(id);

        if(entity) {

          this.log.warn("    " + id + " => " + entity.name + " (key: " + entity.key + ")");
        }
      }
    }
  }

  /**
   * Get entity information by ID.
   *
   * @param id - The entity ID to look up.
   *
   * @returns The entity information or `null` if not found.
   */
  public getEntityById(id: string): Nullable<Entity> {

    const key = this.entityKeys.get(id);

    if(!key) {

      return null;
    }

    const name = this.entityNames.get(key);
    const type = this.entityTypes.get(key);

    if(!name || !type) {

      return null;
    }

    return { key, name, type };
  }

  /**
   * Check if an entity ID exists.
   *
   * @param id - The entity ID to check.
   *
   * @returns `true` if the entity exists, `false` otherwise.
   */
  public hasEntity(id: string): boolean {

    return this.entityKeys.has(id);
  }

  /**
   * Get all available entity IDs grouped by type.
   *
   * @returns Object with entity types as keys and arrays of IDs as values.
   */
  public getAvailableEntityIds(): Record<string, string[]> {

    const result: Record<string, string[]> = {};

    for(const id of this.entityKeys.keys()) {

      const type = id.split("-")[0];

      result[type] ??= [];
      result[type].push(id);
    }

    return result;
  }

  /**
   * Get all entities with their IDs.
   *
   * @returns Array of entities with their corresponding IDs.
   */
  public getEntitiesWithIds(): Array<Entity & { id: string }> {

    return this.discoveredEntities.map(entity => {

      const id = (entity.type + "-" + entity.name).replace(/ /g, "_").toLowerCase();

      return { ...entity, id };
    });
  }

  /**
   * Send a ping request to the device to heartbeat the connection.
   */
  public sendPing(): void {

    this.frameAndSend(MessageType.PING_REQUEST, Buffer.alloc(0));
  }

  /**
   * Sends a SwitchCommandRequest for the given entity ID and on/off state.
   *
   * @param id - The entity ID (format: "switch-entityname").
   * @param state - `true` for on, `false` for off.
   */
  public sendSwitchCommand(id: string, state: boolean): void {

    // Look up the entity key using the provided ID.
    const key = this.entityKeys.get(id);

    // Log debugging information.
    this.log.debug("sendSwitchCommand - ID: " + id + " | KEY: " + key + " | state: " + state);

    // Return early if the entity key is not found.
    if(!key) {

      this.log.warn("Entity key not found for ID: " + id);

      return;
    }

    // Build the protobuf fields.
    const fields: ProtoField[] = [ this.buildKeyField(key), { fieldNumber: 2, value: state ? 1 : 0, wireType: WireType.VARINT } ];

    // Encode and send the switch command request.
    const payload = this.encodeProtoFields(fields);

    this.frameAndSend(MessageType.SWITCH_COMMAND_REQUEST, payload);
  }

  /**
   * Sends a ButtonCommandRequest to press a button entity.
   *
   * @param id - The entity ID (format: "button-entityname").
   */
  public sendButtonCommand(id: string): void {

    // Look up the entity key using the provided ID.
    const key = this.entityKeys.get(id);

    // Log debugging information.
    this.log.debug("sendButtonCommand - ID: " + id + " | KEY: " + key);

    // Return early if the entity key is not found.
    if(!key) {

      this.log.warn("Entity key not found for ID: " + id);

      return;
    }

    // Build the protobuf fields.
    const fields: ProtoField[] = [ this.buildKeyField(key) ];

    // Encode and send the button command request.
    const payload = this.encodeProtoFields(fields);

    this.frameAndSend(MessageType.BUTTON_COMMAND_REQUEST, payload);
  }

  /**
   * Sends a CoverCommandRequest for the given entity ID.
   *
   * @param id - The entity ID (format: "cover-entityname").
   * @param options - Command options (at least one option must be provided).
   * @param options.command - The command: "open", "close", or "stop" (optional).
   * @param options.position - Target position 0.0-1.0 where 0 is closed, 1 is open (optional).
   * @param options.tilt - Target tilt 0.0-1.0 where 0 is closed, 1 is open (optional).
   *
   * @example
   * ```typescript
   * // Send a simple command
   * await client.sendCoverCommand("cover-garagedoor", { command: "open" });
   *
   * // Set to specific position
   * await client.sendCoverCommand("cover-garagedoor", { position: 0.5 }); // 50% open
   *
   * // Set position and tilt
   * await client.sendCoverCommand("cover-blinds", { position: 1.0, tilt: 0.25 });
   * ```
   */
  public sendCoverCommand(id: string, options: { command?: "open" | "close" | "stop"; position?: number; tilt?: number }): void {

    // Validate that at least one option is provided.
    if(!options.command && typeof options.position !== "number" && typeof options.tilt !== "number") {

      this.log.warn("sendCoverCommand requires at least one option: command, position, or tilt");

      return;
    }

    // Look up the entity key using the provided ID.
    const key = this.entityKeys.get(id);

    // Log debugging information.
    this.log.debug("sendCoverCommand - ID: " + id + " | KEY: " + key + " | options: " + JSON.stringify(options));

    // Return early if the entity key is not found.
    if(!key) {

      this.log.warn("Entity key not found for ID: " + id);

      return;
    }

    // Build the protobuf fields.
    const fields: ProtoField[] = [ this.buildKeyField(key) ];

    // Add legacy command fields if a command is specified.
    if(options.command) {

      // Map user-friendly commands to legacy enum values.
      const cmdMap = { close: 1, open: 0, stop: 2 };

      fields.push(

        { fieldNumber: 2, value: 1, wireType: WireType.VARINT },  // has_legacy_command
        { fieldNumber: 3, value: cmdMap[options.command], wireType: WireType.VARINT }  // legacy_command
      );
    }

    // Add position field if specified.
    if(typeof options.position === "number") {

      fields.push(

        { fieldNumber: 4, value: 1, wireType: WireType.VARINT }  // has_position
      );

      // Create position buffer as float32.
      const positionBuf = Buffer.alloc(FIXED32_SIZE);

      positionBuf.writeFloatLE(options.position, 0);
      fields.push(

        { fieldNumber: 5, value: positionBuf, wireType: WireType.FIXED32 }  // position
      );
    }

    // Add tilt field if specified.
    if(typeof options.tilt === "number") {

      fields.push(

        { fieldNumber: 6, value: 1, wireType: WireType.VARINT }  // has_tilt
      );

      // Create tilt buffer as float32.
      const tiltBuf = Buffer.alloc(FIXED32_SIZE);

      tiltBuf.writeFloatLE(options.tilt, 0);
      fields.push(

        { fieldNumber: 7, value: tiltBuf, wireType: WireType.FIXED32 }  // tilt
      );
    }

    // Encode and send the cover command request.
    const payload = this.encodeProtoFields(fields);

    this.frameAndSend(MessageType.COVER_COMMAND_REQUEST, payload);
  }

  /**
   * Sends a LightCommandRequest to turn on/off and optionally set brightness.
   *
   * @param id - The entity ID (format: "light-entityname").
   * @param options - Command options.
   * @param options.state - `true` for on, `false` for off (optional).
   * @param options.brightness - Brightness level 0.0-1.0 (optional).
   */
  public sendLightCommand(id: string, options: { state?: boolean; brightness?: number }): void {

    // Look up the entity key using the provided ID.
    const key = this.entityKeys.get(id);

    // Log debugging information.
    this.log.debug("sendLightCommand - ID: " + id + " | KEY: " + key + " | options: " + JSON.stringify(options));

    // Return early if the entity key is not found.
    if(!key) {

      this.log.warn("Entity key not found for ID: " + id);

      return;
    }

    // Start building the protobuf fields.
    const fields: ProtoField[] = [ this.buildKeyField(key) ];

    // Add state fields if a state is specified.
    if(options.state !== undefined) {

      fields.push(

        { fieldNumber: 2, value: 1, wireType: WireType.VARINT },  // has_state
        { fieldNumber: 3, value: options.state ? 1 : 0, wireType: WireType.VARINT }  // state
      );
    }

    // Add brightness fields if brightness is specified.
    if(typeof options.brightness === "number") {

      fields.push(

        { fieldNumber: 4, value: 1, wireType: WireType.VARINT }  // has_brightness
      );

      // Create brightness buffer.
      const brightnessBuf = Buffer.alloc(FIXED32_SIZE);

      brightnessBuf.writeFloatLE(options.brightness, 0);
      fields.push(

        { fieldNumber: 5, value: brightnessBuf, wireType: WireType.FIXED32 }  // brightness
      );
    }

    // Encode and send the light command request.
    const payload = this.encodeProtoFields(fields);

    this.frameAndSend(MessageType.LIGHT_COMMAND_REQUEST, payload);
  }

  /**
   * Sends a LockCommandRequest to lock or unlock the given entity ID.
   *
   * @param id - The entity ID (format: "lock-entityname").
   * @param command - The command to send: "lock" or "unlock".
   * @param code - Optional unlock code.
   */
  public sendLockCommand(id: string, command: "lock" | "unlock", code?: string): void {

    // Look up the entity key using the provided ID.
    const key = this.entityKeys.get(id);

    // Log debugging information.
    this.log.debug("sendLockCommand - ID: " + id + " | KEY: " + key + " | command: " + command);

    // Return early if the entity key is not found.
    if(!key) {

      this.log.warn("Entity key not found for ID: " + id);

      return;
    }

    // Map user-friendly commands to enum values.
    const cmdMap = { lock: 1, unlock: 0 };

    // Build the protobuf fields.
    const fields: ProtoField[] = [

      this.buildKeyField(key),
      { fieldNumber: 2, value: cmdMap[command], wireType: WireType.VARINT }  // command
    ];

    // Add the optional code field if provided.
    if(code !== undefined) {

      const codeBuf = Buffer.from(code, "utf8");

      fields.push(

        { fieldNumber: 3, value: codeBuf, wireType: WireType.LENGTH_DELIMITED }  // code
      );
    }

    // Encode and send the lock command request.
    const payload = this.encodeProtoFields(fields);

    this.frameAndSend(MessageType.LOCK_COMMAND_REQUEST, payload);
  }

  /**
   * Encode an integer as a VarInt (protobuf-style).
   */
  private encodeVarint(value: number): Buffer {

    // Initialize an array to accumulate the encoded bytes.
    const bytes: number[] = [];

    // Loop through the value, seven bits at a time, until all bits are consumed.
    for(let v = value; ; v >>>= 7) {

      // Extract the lowest 7 bits of the current value chunk.
      const bytePart = v & 0x7F;

      // Determine if there are more bits left beyond this chunk.
      const hasMore = (v >>> 7) !== 0;

      // If there are more chunks, set the MSB (continuation) bit; otherwise leave it clear.
      const byte = hasMore ? (bytePart | 0x80) : bytePart;

      // Append this byte into our buffer array.
      bytes.push(byte);

      // If this was the final chunk (no more bits), exit the loop.
      if(!hasMore) {

        break;
      }
    }

    // Convert the array of byte values into a Buffer and return it.
    return Buffer.from(bytes);
  }

  /**
   * Read a VarInt from buffer at offset; returns [value, bytesRead].
   */
  private readVarint(buffer: Buffer, offset: number): [number, number] {

    // Accumulator for the decoded integer result.
    let result = 0;

    // Counter for how many bytes we've consumed.
    let bytesRead = 0;

    // Read byte-by-byte, adding 7 bits at each step, until the continuation bit is clear.
    for(let shift = 0; ; shift += 7) {

      // If we're trying to read past the end, let's quit.
      if(offset + bytesRead >= buffer.length){

        this.log.error("Incomplete response received from the API.");

        return [-1, -1];
      }

      // Fetch the next raw byte from the buffer.
      const byte = buffer[offset + bytesRead];

      // Mask off the continuation bit and merge into the result at the correct position.
      result |= (byte & 0x7F) << shift;

      // Advance our byte counter.
      bytesRead++;

      // If the continuation bit (0x80) is not set, we're done.
      if((byte & 0x80) === 0) {

        break;
      }
    }

    // Return the decoded integer and the number of bytes we consumed.
    return [result, bytesRead];
  }

  /**
   * Decode a simple protobuf message into a map of field numbers to values.
   */
  private decodeProtobuf(buffer: Buffer): Record<number, FieldValue[]> {

    // Initialize the map from field numbers to arrays of decoded values.
    const fields: Record<number, FieldValue[]> = {};

    // Iterate through the buffer by manually advancing the offset.
    for(let offset = 0; offset < buffer.length; /* offset updated in cases */) {

      let len: number;
      let lenLen: number;
      let v: number;
      let value: FieldValue;
      let vLen: number;

      // Read the next varint as the tag (combines field number and wire type).
      const [tag, tagLen] = this.readVarint(buffer, offset);

      // Advance past the tag bytes.
      offset += tagLen;

      // Extract the field number (upper bits of tag).
      const fieldNum = tag >>> 3;

      // Extract the wire type (lower 3 bits of tag).
      const wireType = tag & 0x07;

      // Decode the payload based on its wire type.
      switch(wireType) {

        case WireType.VARINT:

          // Read a varint payload.
          [v, vLen] = this.readVarint(buffer, offset);

          // Assign the numeric result.
          value = v;

          // Advance past the varint bytes.
          offset += vLen;

          break;

        case WireType.FIXED64:

          // Read a 64-bit little-endian double.
          value = buffer.readDoubleLE(offset);

          // Advance by eight bytes.
          offset += 8;

          break;

        case WireType.LENGTH_DELIMITED:

          // Read the length prefix as a varint.
          [len, lenLen] = this.readVarint(buffer, offset);

          // Advance past the length prefix.
          offset += lenLen;

          // Slice out the next len bytes as a Buffer.
          value = buffer.subarray(offset, offset + len);

          // Advance past the length-delimited payload.
          offset += len;

          break;

        case WireType.FIXED32:

          // For 32-bit fields, return the raw bytes for caller interpretation.
          value = buffer.subarray(offset, offset + 4);

          // Advance by four bytes.
          offset += 4;

          break;

        default:

          // Warn about unsupported wire types and return what's decoded so far.
          this.log.warn("Unsupported wire type " + wireType + ".");

          return fields;
      }

      // Ensure there is an array to hold this field's values.
      if(!fields[fieldNum]) {

        fields[fieldNum] = [];
      }

      // Append the decoded value for this field.
      fields[fieldNum].push(value);
    }

    // Return the completed map of field numbers to value arrays.
    return fields;
  }
}
