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

## Why use this plugin for Ratgdo support in HomeKit?
In a nutshell, the aim of this plugin for things to *just work* with minimal required configuration by users. The goal is to provide as close to a streamlined experience as you would expect from a first-party or native HomeKit solution. For the adventurous, those additional granular options are, of course, available to support more esoteric use cases or other unique needs.

What does *just work* mean in practice? It means that this plugin will discover all your Ratgdo devices that are running the Ratgdo ESPHome firmware without the need for additional configuration.

**I rely on this plugin every day and actively maintain and support it.**

In the interest of the community seeking a solution outside of myQ, I've developed a full-featured Homebridge plugin that enables the following features:

  * Control of the garage door opener. This includes, for those that have always wanted the feature, the ability to close the garage door without the requisite safety warning and delay that Chamberlain and Liftmaster garage door openers emit when being controlled remotely.
  * A motion sensor when it's available.
  * Control of the light attached to the garage door opener, when available.
  * Obstruction detection.
  * Occupancy sensor support.
  * Ability to lock and unlock the garage door opener through the ability to lockout wireless remotes.
  * Read-only garage door opener support.
  * Automation switch and dimmer support, allowing you to set the garage door to any position.
  * A rich webUI for configuration.

## Installation
To get started with `homebridge-ratgdo`:

  * Install `homebridge-ratgdo` using the Homebridge webUI. Make sure you make `homebridge-ratgdo` a child bridge for the best experience.
  * Install the [ESPHome Ratgdo firmware](https://ratgdo.github.io/esphome-ratgdo/). You'll need to use Chrome for this as Safari doesn't support installing firmware through a USB serial port.
  * Fully open and close the garage door one time. ESPHome Ratgdo will use this to determine how long it takes to open and close your garage door to enable precise control of the position of the garage door opener.
  * That's it. Ensure `homebridge-ratgdo` is running and it will autodiscover your Ratgdo devices and make them available in HomeKit.

<A NAME="notes"></A>
> [!WARNING]
> The current ESPHome firmware versions (2024.5.0 onward) appear to have some regressions that the ESPHome developers are working through. [I recommend installing the 2024.4.2 version of ESPHome.](https://github.com/hjdhjd/homebridge-ratgdo/blob/main/esphome/README.md)

> [!TIP]
> If you would like to tailor your experience a bit further, you can choose to use the [hombridge-ratgdo ESPHome YAML configuration file](https://github.com/hjdhjd/homebridge-ratgdo/blob/main/esphome/homebridge-ratgdo.yaml) and use it to create a more customized Ratgdo ESPHome firmware. Using this firmware allows you to do the following things for those using Ratgdo hardware revision 2.5 or beyond:
>
>   * The ability to customize the name (and friendly name) of the Ratgdo device. Though cosmetic, it can be helpful when you have multiple Ratgdo devices.
>   * Use SNTP to set the time on the Ratgdo device. Not strictly necessary, but good hygeine.
>   * Allows you to configure the timezone either yourself or automatically. The timezone will be autoconfigured using the World Time API geoIP by default.
>   * Set the interval to check for updates from the Ratgdo repository to every 6 hours instead of the Ratgdo default of every second.
>
> **Using this YAML is completely optional and largely for cosmetic purposes. There are no functional differences between using this custom YAML configuration and the default Ratgdo ESPHome one.**

## Documentation
* Getting Started
  * [Installation](#installation): installing this plugin, including system requirements.
  * [Changelog](https://github.com/hjdhjd/homebridge-ratgdo/blob/main/docs/Changelog.md): changes and release history of this plugin.

* Additional Topics
  * [Feature Options](https://github.com/hjdhjd/homebridge-ratgdo/blob/main/docs/FeatureOptions.md): options to allow you further tailor to your needs, particularly for those who want to have enhanced automation support.
  * [MQTT](https://github.com/hjdhjd/homebridge-ratgdo/blob/main/docs/MQTT.md): how to configure MQTT support.

## Plugin Development Dashboard
This is mostly of interest to the true developer nerds amongst us.

[![License](https://img.shields.io/npm/l/homebridge-ratgdo?color=%23000000&logo=open%20source%20initiative&logoColor=%23FFFFFF&style=for-the-badge)](https://github.com/hjdhjd/homebridge-ratgdo/blob/main/LICENSE.md)
[![Build Status](https://img.shields.io/github/actions/workflow/status/hjdhjd/homebridge-ratgdo/ci.yml?branch=main&color=%23000000&logo=github-actions&logoColor=%23FFFFFF&style=for-the-badge)](https://github.com/hjdhjd/homebridge-ratgdo/actions?query=workflow%3A%22Continuous+Integration%22)
[![Dependencies](https://img.shields.io/librariesio/release/npm/homebridge-ratgdo?color=%23000000&logo=dependabot&style=for-the-badge)](https://libraries.io/npm/homebridge-ratgdo)
[![GitHub commits since latest release (by SemVer)](https://img.shields.io/github/commits-since/hjdhjd/homebridge-ratgdo/latest?color=%23000000&logo=github&sort=semver&style=for-the-badge)](https://github.com/hjdhjd/homebridge-ratgdo/commits/main)

