<SPAN ALIGN="CENTER" STYLE="text-align:center">
<DIV ALIGN="CENTER" STYLE="text-align:center">

[![homebridge-ratgdo: Native HomeKit support for Ratgdo](https://raw.githubusercontent.com/hjdhjd/homebridge-ratgdo/main/images/homebridge-ratgdo.svg)](https://github.com/hjdhjd/homebridge-ratgdo)

# Homebridge Ratgdo

[![Downloads](https://img.shields.io/npm/dt/homebridge-ratgdo?color=%23000000&logo=icloud&logoColor=%23FFFFFF&style=for-the-badge)](https://www.npmjs.com/package/homebridge-ratgdo)
[![Version](https://img.shields.io/npm/v/homebridge-ratgdo?color=%23000000&label=Homebridge%20Ratgdo&logoColor=%23FFFFFF&style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyByb2xlPSJpbWciIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyIgdmlld0JveD0iMCAwIDI0IDI0Ij48cGF0aCBzdHlsZT0iZmlsbDojRkZGRkZGIiBkPSJNMjMuOTkzIDkuODE2TDEyIDIuNDczbC00LjEyIDIuNTI0VjIuNDczSDQuMTI0djQuODE5TC4wMDQgOS44MTZsMS45NjEgMy4yMDIgMi4xNi0xLjMxNXY5LjgyNmgxNS43NDl2LTkuODI2bDIuMTU5IDEuMzE1IDEuOTYtMy4yMDIiLz48L3N2Zz4K)](https://www.npmjs.com/package/homebridge-ratgdo)
[![Ratgdo@Homebridge Discord](https://img.shields.io/discord/432663330281226270?color=%23000000&label=Discord&logo=discord&logoColor=%23FFFFFF&style=for-the-badge)](https://discord.gg/QXqfHEW)
[![verified-by-homebridge](https://img.shields.io/badge/homebridge-verified-blueviolet?color=%2357277C&style=for-the-badge&logoColor=%23FFFFFF&logo=data:image/svg%2bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI5OTIuMDkiIGhlaWdodD0iMTAwMCIgdmlld0JveD0iMCAwIDk5Mi4wOSAxMDAwIj48ZGVmcz48c3R5bGU+LmF7ZmlsbDojZmZmO308L3N0eWxlPjwvZGVmcz48cGF0aCBjbGFzcz0iYSIgZD0iTTk1MC4xOSw1MDguMDZhNDEuOTEsNDEuOTEsMCwwLDEtNDItNDEuOWMwLS40OC4zLS45MS4zLTEuNDJMODI1Ljg2LDM4Mi4xYTc0LjI2LDc0LjI2LDAsMCwxLTIxLjUxLTUyVjEzOC4yMmExNi4xMywxNi4xMywwLDAsMC0xNi4wOS0xNkg3MzYuNGExNi4xLDE2LjEsMCwwLDAtMTYsMTZWMjc0Ljg4bC0yMjAuMDktMjEzYTE2LjA4LDE2LjA4LDAsMCwwLTIyLjY0LjE5TDYyLjM0LDQ3Ny4zNGExNiwxNiwwLDAsMCwwLDIyLjY1bDM5LjM5LDM5LjQ5YTE2LjE4LDE2LjE4LDAsMCwwLDIyLjY0LDBMNDQzLjUyLDIyNS4wOWE3My43Miw3My43MiwwLDAsMSwxMDMuNjIuNDVMODYwLDUzOC4zOGE3My42MSw3My42MSwwLDAsMSwwLDEwNGwtMzguNDYsMzguNDdhNzMuODcsNzMuODcsMCwwLDEtMTAzLjIyLjc1TDQ5OC43OSw0NjguMjhhMTYuMDUsMTYuMDUsMCwwLDAtMjIuNjUuMjJMMjY1LjMsNjgwLjI5YTE2LjEzLDE2LjEzLDAsMCwwLDAsMjIuNjZsMzguOTIsMzlhMTYuMDYsMTYuMDYsMCwwLDAsMjIuNjUsMGwxMTQtMTEyLjM5YTczLjc1LDczLjc1LDAsMCwxLDEwMy4yMiwwbDExMywxMTEsLjQyLjQyYTczLjU0LDczLjU0LDAsMCwxLDAsMTA0TDU0NS4wOCw5NTcuMzV2LjcxYTQxLjk1LDQxLjk1LDAsMSwxLTQyLTQxLjk0Yy41MywwLC45NS4zLDEuNDQuM0w2MTYuNDMsODA0LjIzYTE2LjA5LDE2LjA5LDAsMCwwLDQuNzEtMTEuMzMsMTUuODUsMTUuODUsMCwwLDAtNC43OS0xMS4zMmwtMTEzLTExMWExNi4xMywxNi4xMywwLDAsMC0yMi42NiwwTDM2Ny4xNiw3ODIuNzlhNzMuNjYsNzMuNjYsMCwwLDEtMTAzLjY3LS4yN2wtMzktMzlhNzMuNjYsNzMuNjYsMCwwLDEsMC0xMDMuODZMNDM1LjE3LDQyNy44OGE3My43OSw3My43OSwwLDAsMSwxMDMuMzctLjlMNzU4LjEsNjM5Ljc1YTE2LjEzLDE2LjEzLDAsMCwwLDIyLjY2LDBsMzguNDMtMzguNDNhMTYuMTMsMTYuMTMsMCwwLDAsMC0yMi42Nkw1MDYuNSwyNjUuOTNhMTYuMTEsMTYuMTEsMCwwLDAtMjIuNjYsMEwxNjQuNjksNTgwLjQ0QTczLjY5LDczLjY5LDAsMCwxLDYxLjEsNTgwTDIxLjU3LDU0MC42OWwtLjExLS4xMmE3My40Niw3My40NiwwLDAsMSwuMTEtMTAzLjg4TDQzNi44NSwyMS40MUE3My44OSw3My44OSwwLDAsMSw1NDAsMjAuNTZMNjYyLjYzLDEzOS4zMnYtMS4xYTczLjYxLDczLjYxLDAsMCwxLDczLjU0LTczLjVINzg4YTczLjYxLDczLjYxLDAsMCwxLDczLjUsNzMuNVYzMjkuODFhMTYsMTYsMCwwLDAsNC43MSwxMS4zMmw4My4wNyw4My4wNWguNzlhNDEuOTQsNDEuOTQsMCwwLDEsLjA4LDgzLjg4WiIvPjwvc3ZnPg==)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)

## Ratgdo-enabled garage door opener support for [Homebridge](https://homebridge.io).
</DIV>
</SPAN>

`homebridge-ratgdo` is a [Homebridge](https://homebridge.io) plugin that makes Chamberlain, Liftmaster, and other garage door openers that utilize the Ratgdo hardware control board available to [Apple's](https://www.apple.com) [HomeKit](https://www.apple.com/ios/home) smart home platform. You can determine if your garage door opener by checking the [Ratgdo website](https://paulwieland.github.io/ratgdo/).

### Feature Options

Feature options allow you to enable or disable certain features in this plugin. These feature options provide unique flexibility by also allowing you to set a scope for each option that allows you more granular control in how this plugin makes features and capabilities available in HomeKit.

The priority given to these options works in the following order, from highest to lowest priority where settings that are higher in priority will override the ones below:

  * Device options that are enabled or disabled.
  * Global options that are enabled or disabled.

All feature options can be set at any scope level, or at multiple scope levels. If an option isn't applicable to a particular category of device, it is ignored. If you want to override a global feature option you've set, you can override the global feature option for the individual device, if you choose.

> [!IMPORTANT]
> It's strongly recommended that you use the Homebridge webUI](https://github.com/homebridge/homebridge-config-ui-x) to configure this plugin - it's easier to use for most people, and will ensure you always have a valid configuration.**

### <A NAME="reference"></A>Feature Options Reference
Feature options provide a rich mechanism for tailoring your `homebridge-ratgdo` experience. The reference below is divided into functional category groups:

 * [Device](#device): Device feature options.
 * [Log](#log): Logging feature options.
 * [Opener](#opener): Opener feature options.
 * [Light](#light): Opener light feature options.
 * [Motion](#motion): Opener motion feature options.
 * [Disco](#disco): Ratgdo (ESP32) Disco device-specific feature options.
 * [Konnected](#konnected): Konnected device-specific feature options.

#### <A NAME="device"></A>Device feature options.

| Option                                           | Description
|--------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
| `Device`                                         | Make this device available in HomeKit. **(default: enabled)**.

#### <A NAME="log"></A>Logging feature options.

| Option                                           | Description
|--------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
| `Log.Opener`                                     | Log opener events in Homebridge. **(default: enabled)**.
| `Log.Light`                                      | Log light events in Homebridge. **(default: enabled)**.
| `Log.Motion`                                     | Log motion-related events in Homebridge. **(default: enabled)**.
| `Log.Obstruction`                                | Log obstruction events in Homebridge. **(default: enabled)**.
| `Log.VehiclePresence`                            | Log vehicle presence-related events in Homebridge. This is only valid on Ratgdo (ESP32) Disco openers. **(default: enabled)**.

#### <A NAME="opener"></A>Opener feature options.

| Option                                           | Description
|--------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
| `Opener.ReadOnly`                                | Make this opener read-only by ignoring open and close requests from HomeKit. **(default: disabled)**.
| `Opener.Dimmer`                                  | Add a dimmer accessory to control the opener. This can be useful in automation scenarios where you want to set the door to a specific percentage. **(default: disabled)**.
| `Opener.Switch`                                  | Add a switch accessory to control the opener. This can be useful in automation scenarios where you want to work around HomeKit's security restrictions for controlling garage door openers. **(default: disabled)**.
| `Opener.OccupancySensor`                         | Add an occupancy sensor accessory using the open state of the opener to determine occupancy. This can be useful in automation scenarios where you want to trigger an action based on the opener being open for an extended period of time. **(default: disabled)**.
| `Opener.OccupancySensor.Duration<I>.Value</I>`   | Duration, in seconds, to wait once the opener has reached the open state before indicating occupancy. **(default: 300)**.
| `Opener.Switch.RemoteLockout`                    | Add a switch accessory to control the wireless remote lockout feature (if present) on your opener. This can be useful in automation scenarios where you want to work around HomeKit's security restrictions for controlling the lock state of garage door openers. **(default: disabled)**.

#### <A NAME="light"></A>Opener light feature options.

| Option                                           | Description
|--------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
| `Light`                                          | Make the light on the opener available in HomeKit. **(default: enabled)**.

#### <A NAME="motion"></A>Opener motion feature options.

| Option                                           | Description
|--------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
| `Motion`                                         | Make the motion sensor on the opener available in HomeKit. **(default: enabled)**.
| `Motion.OccupancySensor`                         | Add an occupancy sensor accessory using motion sensor activity to determine occupancy. **(default: disabled)**.
| `Motion.OccupancySensor.Duration<I>.Value</I>`   | Duration, in seconds, to wait without receiving a motion event to determine when occupancy is no longer detected. **(default: 300)**.

#### <A NAME="disco"></A>Ratgdo (ESP32) Disco device-specific feature options.

| Option                                           | Description
|--------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
| `Disco.Battery`                                  | Show the state of the backup battery in HomeKit. This requires ensuring the Ratgdo (ESP32) Disco is connected directly to the backup battery. **(default: disabled)**.
| `Disco.OccupancySensor.Vehicle.Presence`         | Add an occupancy sensor accessory for vehicle presence detection. **(default: disabled)**.
| `Disco.ContactSensor.Vehicle.Arriving`           | Add a contact sensor accessory for vehicle arrival. **(default: disabled)**.
| `Disco.ContactSensor.Vehicle.Leaving`            | Add a contact sensor accessory for vehicle departure. **(default: disabled)**.
| `Disco.Switch.laser`                             | Add a switch accessory to control the park assistance laser feature. **(default: disabled)**.
| `Disco.Switch.led`                               | Add a switch accessory to control the LED setting. **(default: disabled)**.

#### <A NAME="konnected"></A>Konnected device-specific feature options.

| Option                                           | Description
|--------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
| `Konnected.Switch.PCW`                           | Add a switch accessory to control the pre-close warning feature on Konnected openers. This can be useful in automation scenarios. **(default: disabled)**.
| `Konnected.Switch.Strobe`                        | Add a switch accessory to control the strobe setting on Konnected openers. **(default: disabled)**.

