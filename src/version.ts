import manifest from "../package.json" with { type: "json" }

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
  throw new Error("package.json contains an invalid service version")
}

/** The package manifest is the single release-version source of truth. */
export const SERVICE_VERSION = manifest.version
