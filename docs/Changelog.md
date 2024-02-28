# Changelog

All notable changes to this project will be documented in this file. This project uses [semantic versioning](https://semver.org/).

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
