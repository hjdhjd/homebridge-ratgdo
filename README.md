<SPAN ALIGN="CENTER" STYLE="text-align:center">
<DIV ALIGN="CENTER" STYLE="text-align:center">

# Homebridge Ratgdo

[![Downloads](https://img.shields.io/npm/dt/homebridge-ratgdo?color=%235EB5E5&logo=icloud&logoColor=%23FFFFFF&style=for-the-badge)](https://www.npmjs.com/package/homebridge-ratgdo)
[![Version](https://img.shields.io/npm/v/homebridge-ratgdo?color=%235EB5E5&label=Homebridge%20Ratgdo&logoColor=%23FFFFFF&style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyByb2xlPSJpbWciIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyIgdmlld0JveD0iMCAwIDI0IDI0Ij48cGF0aCBzdHlsZT0iZmlsbDojRkZGRkZGIiBkPSJNMjMuOTkzIDkuODE2TDEyIDIuNDczbC00LjEyIDIuNTI0VjIuNDczSDQuMTI0djQuODE5TC4wMDQgOS44MTZsMS45NjEgMy4yMDIgMi4xNi0xLjMxNXY5LjgyNmgxNS43NDl2LTkuODI2bDIuMTU5IDEuMzE1IDEuOTYtMy4yMDIiLz48L3N2Zz4K)](https://www.npmjs.com/package/homebridge-ratgdo)
[![Ratgdo@Homebridge Discord](https://img.shields.io/discord/432663330281226270?color=%235EB5E5&label=Discord&logo=discord&logoColor=%23FFFFFF&style=for-the-badge)](https://discord.gg/QXqfHEW)
[![verified-by-homebridge](https://img.shields.io/badge/homebridge-verified-blueviolet?color=%2357277C&style=for-the-badge&logoColor=%23FFFFFF&logo=data:image/svg%2bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI5OTIuMDkiIGhlaWdodD0iMTAwMCIgdmlld0JveD0iMCAwIDk5Mi4wOSAxMDAwIj48ZGVmcz48c3R5bGU+LmF7ZmlsbDojZmZmO308L3N0eWxlPjwvZGVmcz48cGF0aCBjbGFzcz0iYSIgZD0iTTk1MC4xOSw1MDguMDZhNDEuOTEsNDEuOTEsMCwwLDEtNDItNDEuOWMwLS40OC4zLS45MS4zLTEuNDJMODI1Ljg2LDM4Mi4xYTc0LjI2LDc0LjI2LDAsMCwxLTIxLjUxLTUyVjEzOC4yMmExNi4xMywxNi4xMywwLDAsMC0xNi4wOS0xNkg3MzYuNGExNi4xLDE2LjEsMCwwLDAtMTYsMTZWMjc0Ljg4bC0yMjAuMDktMjEzYTE2LjA4LDE2LjA4LDAsMCwwLTIyLjY0LjE5TDYyLjM0LDQ3Ny4zNGExNiwxNiwwLDAsMCwwLDIyLjY1bDM5LjM5LDM5LjQ5YTE2LjE4LDE2LjE4LDAsMCwwLDIyLjY0LDBMNDQzLjUyLDIyNS4wOWE3My43Miw3My43MiwwLDAsMSwxMDMuNjIuNDVMODYwLDUzOC4zOGE3My42MSw3My42MSwwLDAsMSwwLDEwNGwtMzguNDYsMzguNDdhNzMuODcsNzMuODcsMCwwLDEtMTAzLjIyLjc1TDQ5OC43OSw0NjguMjhhMTYuMDUsMTYuMDUsMCwwLDAtMjIuNjUuMjJMMjY1LjMsNjgwLjI5YTE2LjEzLDE2LjEzLDAsMCwwLDAsMjIuNjZsMzguOTIsMzlhMTYuMDYsMTYuMDYsMCwwLDAsMjIuNjUsMGwxMTQtMTEyLjM5YTczLjc1LDczLjc1LDAsMCwxLDEwMy4yMiwwbDExMywxMTEsLjQyLjQyYTczLjU0LDczLjU0LDAsMCwxLDAsMTA0TDU0NS4wOCw5NTcuMzV2LjcxYTQxLjk1LDQxLjk1LDAsMSwxLTQyLTQxLjk0Yy41MywwLC45NS4zLDEuNDQuM0w2MTYuNDMsODA0LjIzYTE2LjA5LDE2LjA5LDAsMCwwLDQuNzEtMTEuMzMsMTUuODUsMTUuODUsMCwwLDAtNC43OS0xMS4zMmwtMTEzLTExMWExNi4xMywxNi4xMywwLDAsMC0yMi42NiwwTDM2Ny4xNiw3ODIuNzlhNzMuNjYsNzMuNjYsMCwwLDEtMTAzLjY3LS4yN2wtMzktMzlhNzMuNjYsNzMuNjYsMCwwLDEsMC0xMDMuODZMNDM1LjE3LDQyNy44OGE3My43OSw3My43OSwwLDAsMSwxMDMuMzctLjlMNzU4LjEsNjM5Ljc1YTE2LjEzLDE2LjEzLDAsMCwwLDIyLjY2LDBsMzguNDMtMzguNDNhMTYuMTMsMTYuMTMsMCwwLDAsMC0yMi42Nkw1MDYuNSwyNjUuOTNhMTYuMTEsMTYuMTEsMCwwLDAtMjIuNjYsMEwxNjQuNjksNTgwLjQ0QTczLjY5LDczLjY5LDAsMCwxLDYxLjEsNTgwTDIxLjU3LDU0MC42OWwtLjExLS4xMmE3My40Niw3My40NiwwLDAsMSwuMTEtMTAzLjg4TDQzNi44NSwyMS40MUE3My44OSw3My44OSwwLDAsMSw1NDAsMjAuNTZMNjYyLjYzLDEzOS4zMnYtMS4xYTczLjYxLDczLjYxLDAsMCwxLDczLjU0LTczLjVINzg4YTczLjYxLDczLjYxLDAsMCwxLDczLjUsNzMuNVYzMjkuODFhMTYsMTYsMCwwLDAsNC43MSwxMS4zMmw4My4wNyw4My4wNWguNzlhNDEuOTQsNDEuOTQsMCwwLDEsLjA4LDgzLjg4WiIvPjwvc3ZnPg==)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)

## Ratgdo-enabled garage door opener support for [Homebridge](https://homebridge.io).
</DIV>
</SPAN>

`homebridge-ratgdo` is a [Homebridge](https://homebridge.io) plugin that makes Chamberlain, Liftmaster, and other garage door openers that utilize the Ratgdo hardware control board available to [Apple's](https://www.apple.com) [HomeKit](https://www.apple.com/ios/home) smart home platform. You can determine if your garage door opener by checking the [Ratgdo website](https://paulwieland.github.io/ratgdo/).

## Why use this plugin for Ratgdo support in HomeKit?
In a nutshell, the aim of this plugin for things to *just work* with minimal required configuration by users. The goal is to provide as close to a streamlined experience as you would expect from a first-party or native HomeKit solution. For the adventurous, those additional granular options are, of course, available to support more esoteric use cases or other unique needs.

What does *just work* mean in practice? It means that this plugin will discover all your Ratgdo devices without the need for additional configuration beyond telling the Ratgdo device about `homebridge-ratgdo`.

**I rely on this plugin every day and actively maintain and support it. That said, at the moment, this plugin should be considered beta and is still evolving its core feature set. I am currently not accepting any issues or feedback through GitHub for the time being, though support on the Homebridge Discord is available on the ratgdo channel.**

In the interest of the community seeking a solution outside of myQ, I'm releasing an initial implementation that enables the following features:

  * Control of the garage door opener. This includes, for those that have always wanted the feature, the ability to close the garage door without the requisite safety warning and delay that Chamberlain and Liftmaster garage door openers emit when being controlled remotely.
  * A motion sensor when it's available.
  * Control of the light attached to the garage door opener, when available.
  * Obstruction detection.

## Known Caveats
Ratgdo is a terrific solution that solves a problem for many stranded former myQ users and others. There are some quirks and caveats to note, however. As of Ratgdo firmware v2.51:

  * Misconfiguring your MQTT server IP or port number in any way **will** lock up / brick the Ratgdo. The only fix for this I've discovered is to reflash the Ratgdo and don't misconfigure it the next time around.
  * Ratgdo currently has no useful way to query it's state over MQTT. That means that on startup, the state of the garage door opener in Homebridge / HomeKit will be unknowable. Given that challenge, `homebridge-ratgdo` will assume the garage door opener is closed on startup. Once an action is taken, the state of the garage door opener will be accurately reflected in Homebridge / HomeKit. There is technically a *query* command available through the MQTT interface to Ratgdo, but all that currently does is to set the Ratgdo state information to an unknown state, awaiting the next state update from the garage door opener, rather than actually publish the current state, which is really what we need.
  * In some wiring configurations, Ratgdo reads information from the garage door opener either incorrectly or inconsistently. I would advise closely checking and confirming the wiring you're using to ensure it's correct and the physical wiring used is good. If it is, I'd suggest filing a support request on the [Ratgdo support page](https://github.com/PaulWieland/ratgdo/issues).

I hope these issues can be addressed in future Ratgdo releases.

## Plugin Development Dashboard
This is mostly of interest to the true developer nerds amongst us.

[![License](https://img.shields.io/npm/l/homebridge-ratgdo?color=%230559C9&logo=open%20source%20initiative&logoColor=%23FFFFFF&style=for-the-badge)](https://github.com/hjdhjd/homebridge-ratgdo/blob/main/LICENSE.md)
[![Build Status](https://img.shields.io/github/actions/workflow/status/hjdhjd/homebridge-ratgdo/ci.yml?branch=main&color=%230559C9&logo=github-actions&logoColor=%23FFFFFF&style=for-the-badge)](https://github.com/hjdhjd/homebridge-ratgdo/actions?query=workflow%3A%22Continuous+Integration%22)
[![Dependencies](https://img.shields.io/librariesio/release/npm/homebridge-ratgdo?color=%230559C9&logo=dependabot&style=for-the-badge)](https://libraries.io/npm/homebridge-ratgdo)
[![GitHub commits since latest release (by SemVer)](https://img.shields.io/github/commits-since/hjdhjd/homebridge-ratgdo/latest?color=%230559C9&logo=github&sort=semver&style=for-the-badge)](https://github.com/hjdhjd/homebridge-ratgdo/commits/main)
