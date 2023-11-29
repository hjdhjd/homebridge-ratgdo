# Changelog

All notable changes to this project will be documented in this file. This project uses [semantic versioning](https://semver.org/).

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
