/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * mdns.ts: Pure parsing of a bonjour-service mDNS TXT payload into HBR's typed MdnsTxt shape.
 */
import type { MdnsTxt } from "../types.ts";

/* Parse a bonjour-service mDNS TXT payload into our typed MdnsTxt shape. We do not trust the upstream type: bonjour-service surfaces TXT as a loose record because mDNS
 * records arrive over the wire as untyped key-value blobs. This validator narrows each field individually so downstream code can rely on the structural contract
 * declared by MdnsTxt without sprinkling per-field type checks across the discovery path. Pure and I/O-free so it can be unit-tested against arbitrary untrusted input.
 */
export function parseMdnsTxt(raw: unknown): MdnsTxt | undefined {

  if((typeof raw !== "object") || (raw === null)) {

    return undefined;
  }

  const fields = raw as Record<string, unknown>;
  const stringField = (key: string): string | undefined => {

    const value = fields[key];

    return (typeof value === "string") ? value : undefined;
  };

  // The MdnsTxt field names mirror the wire-format keys exactly so the discovery boundary reads them without any name translation. Snake_case is the ESPHome convention
  // upstream of us; preserving it here is what makes the parsed object structurally identical to what arrived over the wire.
  /* eslint-disable camelcase */
  return {

    esphome_version: stringField("esphome_version"),
    friendly_name: stringField("friendly_name"),
    mac: stringField("mac"),
    project_name: stringField("project_name"),
    project_version: stringField("project_version"),
    version: stringField("version")
  };
  /* eslint-enable camelcase */
}
