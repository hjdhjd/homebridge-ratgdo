# Changelog

All notable changes to this project will be documented in this file. This project uses [semantic versioning](https://semver.org/).

## 2.6.2 (2024-12-07)
  * Fix: address a regression in device discovery on startup.
  * Housekeeping.

## 2.6.1 (2024-12-06)
  * Fix: address a regression in device discovery on startup.
  * Housekeeping.

## 2.6.0 (2024-11-24)
  * Improvement: enhanced support for the new Ratgdo (ESP32) Disco version. Backup battery status, when the Ratgdo is wired to it. Vehicle presence, arrival, and departure detection are supported through occupancy and contact sensors. The parking assistance laser can be controlled as a switch, as can the on-device LED. Configure them using the HBR webUI.
  * Improvement: enhanced support for Konnected garage door openers with support for the strobe switch in addition to the pre-close warning alarm. Configure them using the HBR webUI.
  * Improvement: minor refinements to state availability in HomeKit.
  * Housekeeping.

## 2.5.0 (2024-11-17)
  * Improvement: enhanced Konnected Ratgdo support. HBR will now recognize all Konnected Ratgdo variants, and if you enable any of the garage door opener feature options (door automation switch or dimmer) it will also enable a switch for Konnected's pre-close warning alarm that you can trigger within HBR.
  * Housekeeping.

## 2.4.0 (2024-09-30)
  * Behavior change: HBR will now ensure HomeKit accessory names are compliant with [HomeKit's naming guidelines](https://developer.apple.com/design/human-interface-guidelines/homekit#Help-people-choose-useful-names). Invalid characters will be replaced with a space, and multiple spaces will be squashed.
  * Housekeeping.

## 2.3.3 (2024-09-24)
  * Improvement: better name resolution.
  * Housekeeping.

## 2.3.2 (2024-09-15)
  * Housekeeping.

## 2.3.1 (2024-07-20)
  * Housekeeping.

## 2.3.0 (2024-07-18)
  * New feature: you can selectively enable and disable the logging of various event types (light, motion, obstruction, and opener currently). Use the HBR webUI to configure to your taste.
  * New feature: initial support for the Konnected Ratgdo variant. This is a commercially packaged version of a Ratgdo device produced by Konnected. Feedback welcome, and thanks to @KyleBoyer for the initial PR needed to provide support.
  * Housekeeping.

## 2.2.2 (2024-06-06)
  * Housekeeping.

## 2.2.1 (2024-06-01)
  * Improvement: minor webUI updates.
  * Housekeeping.

## 2.2.0 (2024-05-18)
  * Minor bugfix when HBR encounters an error communicating with the Ratgdo device - thanks @ryderbike1 for the report.
  * Address webUI bug when running the plugin for the first time - thanks @jarz for the report.
  * Housekeeping.

## 2.1.3 (2024-05-05)
## 2.1.2 (2024-05-05)
  * Documentation updates and an optional [homebridge-ratgdo ESPHome YAML](https://github.com/hjdhjd/homebridge-ratgdo/blob/main/homebridge-ratgdo.yaml) for those that want some minor enhanced cosmetic / quality of life enhancements.
  * Housekeeping.

## 2.1.1 (2024-04-28)
  * Minor bugfixes and enhancements.
  * Housekeeping.

## 2.1.0 (2024-04-27)
  * New feature: you can enable a switch to control the state of the wireless remote lockout capabilities of your garage door opener, if they exist.

## 2.0.1 (2024-04-27)
  * Fix: Address a Node 18-specific regression with respect to event connectivity.

## 2.0.0 (2024-04-27)
  * Breaking change: Ratgdo MQTT firmware support has been removed. If you need support for it, please stick to 1.2.3. All development moving forward is going to focus on the Ratgdo ESPHome firmware.
  * Fix: address edge cases to ensure connectivity robustness when network interruptions occur.

## 1.2.3 (2024-04-20)
  * Change: Support for Ratgdo MQTT firmware is now deprecated and will be removed in the next point release.
  * Housekeeping.

## 1.2.2 (2024-04-15)
  * Improvement: increase the robustness of ESPHome Ratgdo autodiscovery.
  * Housekeeping.

## 1.2.1 (2024-04-14)
  * Fix: address a minor regression related to occupancy sensor logging.

## 1.2.0 (2024-04-14)
  * New feature: ESPHome firmware support. homebridge-ratgdo now supports both the MQTT and ESPHome firmwares. **A future release of homebridge-ratgdo will remove support for using the Ratgdo MQTT firmware. I encourage everyone to upgrade to the ESPHome firmware sooner than later.** The ESPHome firmware appears to be far better maintained and issue-free than the MQTT firmware. It's been significantly more stable and reliable in my extensive testing. In addition, it enables some new functionality, particularly for certain automation scenarios. ESPHome firmware support "just works": homebridge-ratgdo will autodetect it's presence and configure it accordingly. There is nothing you need to do beyond installing the Ratgdo ESPHome firmware - the devices will be autodiscovered and autoconfigured by homebridge-ratgdo. You also do not need to remove your prior accessories. homebridge-ratgdo will gracefully handle things.
  * New feature: automation dimmer support. You can now set automations to open and close yoru garage door opener to specific percentage levels, if you choose to do so. This feature is only available when using the ESPHome Ratgdo firmware.
  * Improvement: enhanced MQTT support for opening and closing, allowing you to specify where you want the door to be opened to, if using the ESPHome Ratgdo firmware.
  * Housekeeping.

## 1.1.0 (2024-02-29)
  * Improvement: when tapping on the garage door opener while an open or close event is inflight and has not yet completed, the garage door opener will now stop.
  * Fix: accessory names were being overwritten when the user has not requested them to be.
  * Housekeeping.

## 1.0.0 (2024-02-28)
  * New feature: a rich webUI is now available for `homebridge-ratgdo`.
  * New feature: read-only support to prevent someone from being able to open or close your garage door opener. Disabled by default.
  * New feature: door open state occupancy sensor support. This is a useful feature to those who want to create automations based on the opener being **open** for an extended duration of time. By default the duration is 5 minutes and is configurable within the Ratgdo webUI. See the feature option tab for all the goodies. Disabled by default.
  * New feature: occupancy sensor support, using the garage door opener's motion sensor. If you enable the occupancy sensor feature option, an occupancy sensor accessory will be added to the opener. The occupancy sensor works like this: when any motion is detected by that opener's motion sensor, occupancy is triggered. When no motion has been detected for a certain amount of time (5 minutes by default), occupancy will no longer be triggered. This is useful in various automation scenarios that folks might want (e.g. occupancy triggering a light turning on/off). Disabled by default.
  * New feature: you can now synchronize names of your Ratgdo devices with HomeKit. Synchronization is one-way and it will always view the Ratgdo name as the definitive source. Synchronization is only done at plugin startup - you'll need to restart `homebridge-ratgdo` to trigger a name synchronization event. The option is disabled by default.
  * New feature: MQTT support.
  * Housekeeping.

## 0.2.0 (2023-11-29)
  * Improvement: make open/close state transitions more robust to gracefully handle scenarios where Ratgdo doesn't seem to always share notifications when state transitions complete.
  * Housekeeping.
  * **Note: this release should be considered beta and should not be relied upon for daily use.**

## 0.1.0 (2023-11-26)
  * Initial release - in the interest of the community seeking a solution outside of myQ, I'm releasing an initial implementation that enables the following features:
    * Control of the garage door opener. This includes, for those that have always wanted the feature, the ability to close the garage door without the requisite safety warning and delay that Chamberlain and Liftmaster garage door openers emit when being controlled remotely.
    * A motion sensor when it's available.
    * Control of the light attached to the garage door opener, when available.
    * Obstruction detection.
  * **Note: this release should be considered beta and should not be relied upon for daily use.**
