<SPAN ALIGN="CENTER" STYLE="text-align:center">
<DIV ALIGN="CENTER" STYLE="text-align:center">

[![homebridge-ratgdp: Native HomeKit support for Ratgdo](https://raw.githubusercontent.com/hjdhjd/homebridge-ratgdo/main/images/homebridge-ratgdo.svg)](https://github.com/hjdhjd/homebridge-ratgdo)

# Homebridge Ratgdo

[![Downloads](https://img.shields.io/npm/dt/homebridge-ratgdo?color=%23000000&logo=icloud&logoColor=%23FFFFFF&style=for-the-badge)](https://www.npmjs.com/package/homebridge-ratgdo)
[![Version](https://img.shields.io/npm/v/homebridge-ratgdo?color=%23000000&label=Homebridge%20Ratgdo&logoColor=%23FFFFFF&style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyByb2xlPSJpbWciIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyIgdmlld0JveD0iMCAwIDI0IDI0Ij48cGF0aCBzdHlsZT0iZmlsbDojRkZGRkZGIiBkPSJNMjMuOTkzIDkuODE2TDEyIDIuNDczbC00LjEyIDIuNTI0VjIuNDczSDQuMTI0djQuODE5TC4wMDQgOS44MTZsMS45NjEgMy4yMDIgMi4xNi0xLjMxNXY5LjgyNmgxNS43NDl2LTkuODI2bDIuMTU5IDEuMzE1IDEuOTYtMy4yMDIiLz48L3N2Zz4K)](https://www.npmjs.com/package/homebridge-ratgdo)
[![Ratgdo@Homebridge Discord](https://img.shields.io/discord/432663330281226270?color=%23000000&label=Discord&logo=discord&logoColor=%23FFFFFF&style=for-the-badge)](https://discord.gg/QXqfHEW)
[![verified-by-homebridge](https://img.shields.io/badge/homebridge-verified-blueviolet?color=%2357277C&style=for-the-badge&logoColor=%23FFFFFF&logo=data:image/svg%2bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI5OTIuMDkiIGhlaWdodD0iMTAwMCIgdmlld0JveD0iMCAwIDk5Mi4wOSAxMDAwIj48ZGVmcz48c3R5bGU+LmF7ZmlsbDojZmZmO308L3N0eWxlPjwvZGVmcz48cGF0aCBjbGFzcz0iYSIgZD0iTTk1MC4xOSw1MDguMDZhNDEuOTEsNDEuOTEsMCwwLDEtNDItNDEuOWMwLS40OC4zLS45MS4zLTEuNDJMODI1Ljg2LDM4Mi4xYTc0LjI2LDc0LjI2LDAsMCwxLTIxLjUxLTUyVjEzOC4yMmExNi4xMywxNi4xMywwLDAsMC0xNi4wOS0xNkg3MzYuNGExNi4xLDE2LjEsMCwwLDAtMTYsMTZWMjc0Ljg4bC0yMjAuMDktMjEzYTE2LjA4LDE2LjA4LDAsMCwwLTIyLjY0LjE5TDYyLjM0LDQ3Ny4zNGExNiwxNiwwLDAsMCwwLDIyLjY1bDM5LjM5LDM5LjQ5YTE2LjE4LDE2LjE4LDAsMCwwLDIyLjY0LDBMNDQzLjUyLDIyNS4wOWE3My43Miw3My43MiwwLDAsMSwxMDMuNjIuNDVMODYwLDUzOC4zOGE3My42MSw3My42MSwwLDAsMSwwLDEwNGwtMzguNDYsMzguNDdhNzMuODcsNzMuODcsMCwwLDEtMTAzLjIyLjc1TDQ5OC43OSw0NjguMjhhMTYuMDUsMTYuMDUsMCwwLDAtMjIuNjUuMjJMMjY1LjMsNjgwLjI5YTE2LjEzLDE2LjEzLDAsMCwwLDAsMjIuNjZsMzguOTIsMzlhMTYuMDYsMTYuMDYsMCwwLDAsMjIuNjUsMGwxMTQtMTEyLjM5YTczLjc1LDczLjc1LDAsMCwxLDEwMy4yMiwwbDExMywxMTEsLjQyLjQyYTczLjU0LDczLjU0LDAsMCwxLDAsMTA0TDU0NS4wOCw5NTcuMzV2LjcxYTQxLjk1LDQxLjk1LDAsMSwxLTQyLTQxLjk0Yy41MywwLC45NS4zLDEuNDQuM0w2MTYuNDMsODA0LjIzYTE2LjA5LDE2LjA5LDAsMCwwLDQuNzEtMTEuMzMsMTUuODUsMTUuODUsMCwwLDAtNC43OS0xMS4zMmwtMTEzLTExMWExNi4xMywxNi4xMywwLDAsMC0yMi42NiwwTDM2Ny4xNiw3ODIuNzlhNzMuNjYsNzMuNjYsMCwwLDEtMTAzLjY3LS4yN2wtMzktMzlhNzMuNjYsNzMuNjYsMCwwLDEsMC0xMDMuODZMNDM1LjE3LDQyNy44OGE3My43OSw3My43OSwwLDAsMSwxMDMuMzctLjlMNzU4LjEsNjM5Ljc1YTE2LjEzLDE2LjEzLDAsMCwwLDIyLjY2LDBsMzguNDMtMzguNDNhMTYuMTMsMTYuMTMsMCwwLDAsMC0yMi42Nkw1MDYuNSwyNjUuOTNhMTYuMTEsMTYuMTEsMCwwLDAtMjIuNjYsMEwxNjQuNjksNTgwLjQ0QTczLjY5LDczLjY5LDAsMCwxLDYxLjEsNTgwTDIxLjU3LDU0MC42OWwtLjExLS4xMmE3My40Niw3My40NiwwLDAsMSwuMTEtMTAzLjg4TDQzNi44NSwyMS40MUE3My44OSw3My44OSwwLDAsMSw1NDAsMjAuNTZMNjYyLjYzLDEzOS4zMnYtMS4xYTczLjYxLDczLjYxLDAsMCwxLDczLjU0LTczLjVINzg4YTczLjYxLDczLjYxLDAsMCwxLDczLjUsNzMuNVYzMjkuODFhMTYsMTYsMCwwLDAsNC43MSwxMS4zMmw4My4wNyw4My4wNWguNzlhNDEuOTQsNDEuOTQsMCwwLDEsLjA4LDgzLjg4WiIvPjwvc3ZnPg==)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)

## Ratgdo-enabled garage door opener support for [Homebridge](https://homebridge.io).
</DIV>
</SPAN>

`homebridge-ratgdo` is a [Homebridge](https://homebridge.io) plugin that makes Chamberlain, Liftmaster, and other garage door openers that utilize the Ratgdo hardware control board available to [Apple's](https://www.apple.com) [HomeKit](https://www.apple.com/ios/home) smart home platform. You can determine if your garage door opener by checking the [Ratgdo website](https://paulwieland.github.io/ratgdo/).

### MQTT Support
[MQTT](https://mqtt.org) is a popular Internet of Things (IoT) messaging protocol that can be used to weave together different smart devices and orchestrate or instrument them in an infinite number of ways. In short - it lets things that might not normally be able to talk to each other communicate across ecosystems, provided they can support MQTT.

`homebridge-ratgdo` will publish MQTT events if you've configured a broker in the plugin settings. Supported MQTT capabilities include:

  * Garage open and close events.
  * Garage light switch events.
  * Garage motion sensor events.
  * Garage obstruction events.

### Configuration

This documentation assumes you know what MQTT is, what an MQTT broker does, and how to configure it. Setting up an MQTT broker will not be covered here. There are plenty of guides available on how to do so just a search away.

You can configure MQTT settings in the plugin webUI. The settings are:

| Configuration Setting | Description
|-----------------------|----------------------------------
| **mqttUrl**           | The URL of your MQTT broker. **This must be in URL form**, e.g.: `mqtt://user:password@1.2.3.4`.
| **mqttTopic**         | The base topic to publish to. The default is: `ratgdo`.

> [!IMPORTANT]
> **mqttUrl** must be a valid URL. Just entering a hostname will result in an error. The URL can use any of these protocols: `mqtt`, `mqtts`, `tcp`, `tls`, `ws`, `wss`.

When events are published, by default, the topics look like:

> ```sh
> ratgdo/1234567890AB/garagedoor
> ```

In the above example, `1234567890AB` is the MAC address of your garage door opener. We use MAC address as an easy way to guarantee unique identifiers that won't change. `homebridge-ratgdo` provides you information about your Ratgdo devices and their respective MAC addresses in the Homebridge log on startup.

### <A NAME="publish"></A>Topics Published
The topics and messages that `homebridge-ratgdo` publishes are:

| Topic                 | Message Published
|-----------------------|----------------------------------
| `dooropenoccupancy`   | `true` when the garage door open indicator occupancy is detected. `false` when the garage door open indicator occupancy event is reset.
| `garagedoor`          | `closed`, `closing`, `open`, `opening`, when garage door state changes are detected.
| `light`               | `true` when the light has been activated. `false` when the light has been turned off.
| `lock`                | `true` when the garage door opener remote lock has been activated. `false` when the garage door opener remote lock has been turned off.
| `motion`              | `true` when motion is detected. `false` when the motion event is reset.
| `obstruction`         | `true` when an obstruction in the garage door opener is detected. `false` when the obstruction event is reset.
| `occupancy`           | `true` when occupancy is detected. `false` when the occupancy event is reset.

Messages are published to MQTT when an action occurs on a device that triggers the respective event, or when an MQTT message is received for one of the topics `homebridge-ratgdo` subscribes to.

### <A NAME="subscribe"></A>Topics Subscribed
The topics that `homebridge-ratgdo` subscribes to are:

| Topic                   | Message Expected
|-------------------------|----------------------------------
| `dooropenoccupancy/get` | `true` will trigger a publish event of the current garage door opener door open indicator occupancy status.
| `garagedoor/get`        | `true` will trigger a publish event of the current garage door opener state.
| `garagedoor/set`        | One of `close` or `open`. This will send the respective command to the garage door opener. When using the ESPHome firmware, `open` takes an optional parameter between 0 and 100 to set the door position appropriately: `open 50` will set the garage door to the 50% open position.
| `light/get`             | `true` will trigger a publish event of the current garage door opener light.
| `motion/get`            | `true` will trigger a publish event of the current garage door opener motion sensor.
| `obstruction/get`       | `true` will trigger a publish event of the current garage door opener obstruction sensor.
| `occupancy/get`         | `true` will trigger a publish event of the current garage door opener occupancy status.

> [!NOTE]
>   * MQTT support is disabled by default. It's enabled when an MQTT broker is specified in the configuration.
>   * If connectivity to the broker is lost, it will perpetually retry to connect in one-minute intervals.
>   * If a bad URL is provided, MQTT support will not be enabled.
