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

## ESPHome Firmware and Configuration

> [!CAUTION]
>   * You're on your own here. I provide no support for any of the configuration files or firmware provided here. It's here as a convenience and for you to explore and customize some cosmetic aspects of HBR. Please don't open issues regarding anything on this page - I will close them without comment. You're welcome to come to the Discord and ask questions there and I'll address them as best I can.
>   * You should be familiar and comfortable with the command line and modifying configuration files.

> [!TIP]
> If you would like to tailor your experience a bit further, you can choose to use the [hombridge-ratgdo ESPHome YAML configuration file](https://github.com/hjdhjd/homebridge-ratgdo/blob/main/esphome/homebridge-ratgdo.yaml) and use it to create a more customized Ratgdo ESPHome firmware. Using this firmware allows you to do the following things for those using Ratgdo hardware revision 2.5 or beyond:
>
>   * The ability to customize the name (and friendly name) of the Ratgdo device. Though cosmetic, it can be helpful when you have multiple Ratgdo devices.
>   * Use SNTP to set the time on the Ratgdo device. Not strictly necessary, but good hygeine.
>   * Allows you to configure the timezone either yourself or automatically. The timezone will be autoconfigured using the World Time API geoIP by default.
>   * Set the interval to check for updates from the Ratgdo repository to every 6 hours instead of the Ratgdo default of every second.
>
> **Using this YAML is completely optional and largely for cosmetic purposes. There are no functional differences between using this custom YAML configuration and the default Ratgdo ESPHome one.**

> [!NOTE]
> If you're struggling with the current series of ESPHome firwmares (2024.5.0 onward), I would recommend installing and sticking with the last stable firmware, 2024.4.2. There are two ways to do this:
>
>  * Use the ESPHome firmware I've provided here as a convenience. It is v2024.4.2 compiled with the `homebridge-ratgdo.yaml`. To install it this way:
>    * If you can access the Ratgdo ESPHome webUI and can perform an OTA update, you can upload the [homebridge-ratgdo-2024.4.2.bin](https://raw.githubusercontent.com/hjdhjd/homebridge-ratgdo/main/esphome/homebridge-ratgdo-2024.4.2.bin).
>    * If the Ratgdo ESPHome webUI is unavailable, you'll need to use the ESPHome tools to install the firmware and physical access to the Ratgdo. To do this:
>      * Plug your Ratgdo to the machine you're working on using a USB cable.
>      * Install the ESPHome tools if needed (e.g. on macOS `brew install esphome`).
>      * Download both the [homebridge-ratgdo-2024.4.2.bin](https://raw.githubusercontent.com/hjdhjd/homebridge-ratgdo/main/esphome/homebridge-ratgdo-2024.4.2.bin) and the [homebridge-ratgdo.yml](https://github.com/hjdhjd/homebridge-ratgdo/blob/main/esphome/homebridge-ratgdo.yaml) files.
>      * Run the following command: `esphome upload --file homebridge-ratgdo-2024.4.2.bin homebridge-ratgdo.yaml`
>  * Use the ESPHome 2024.4.2 Docker image to create your own firmware and upload it to the Ratgdo. This presumes you are familiar with Docker and how to use it.
>    * Download the [Docker ESPHome 2024.4.2 image](https://hub.docker.com/layers/esphome/esphome/2024.4.2/images/sha256-02fa50ad0d1fe39a63204b9da53e47e5a1455861602328ad4bf8c097130f6706) and install it.
>    * Download [homebridge-ratgdo.yml](https://github.com/hjdhjd/homebridge-ratgdo/blob/main/esphome/homebridge-ratgdo.yaml) and customize it, if you would like.
>      * If you can access the Ratgdo ESPHome webUI and can perform an OTA update, you can use the following command: `docker run --rm -v "${PWD}":/config -it ghcr.io/esphome/esphome:2024.4.2 run --no-logs --device 1.2.3.4 homebridge-ratgdo.yaml` replacing 1.2.3.4 with your Ratgdo's IP address.
>      * If you cannot access your Ratgdo over your network:
>        * Plug your Ratgdo to the machine you're working on using a USB cable.
>        * Run the following command `docker run --rm -v "${PWD}":/config -it ghcr.io/esphome/esphome:2024.4.2 run --no-logs homebridge-ratgdo.yaml` and follow the prompts to install it to your Ratgdo.
>    * Refer to the [Docker command reference for ESPHome](https://esphome.io/guides/faq.html?highlight=reboot#docker-reference) as needed.
