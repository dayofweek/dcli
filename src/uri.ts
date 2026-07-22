const HTTPS_ORIGIN = "https://field.dayofweek.com"
const HTTPS_PREFIX = "/app/brain/"
const ID_PATTERN = /^[A-Za-z0-9_-]{2,128}$/

export type BrainResource = {
  version: 1
  areaId: string
  resourceType: "area" | "note" | "source"
  resourceId?: string
}

function assertId(value: string | undefined, label: string): string {
  if (!value || !ID_PATTERN.test(value)) {
    throw new Error(`Invalid ${label}`)
  }
  return value
}

function parseSegments(pathname: string): Omit<BrainResource, "version"> {
  if (pathname.includes("%")) throw new Error("Encoded brain URI paths are not supported")
  const segments = pathname.split("/").filter(Boolean)
  if (segments.length === 1) {
    return {
      areaId: assertId(segments[0], "area ID"),
      resourceType: "area",
    }
  }
  if (segments.length !== 3) throw new Error("Unsupported brain URI form")
  const areaId = assertId(segments[0], "area ID")
  const resourceType = segments[1]
  if (resourceType !== "note" && resourceType !== "source") {
    throw new Error("Unsupported brain resource type")
  }
  return {
    areaId,
    resourceType,
    resourceId: assertId(segments[2], `${resourceType} ID`),
  }
}

export function parseBrainResource(input: string): BrainResource {
  if (input.length > 512) throw new Error("Brain URI is too long")
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new Error("Invalid brain URI")
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Brain URIs cannot contain credentials, queries, or fragments")
  }

  let pathname: string
  if (url.protocol === "dayofweek:") {
    if (url.hostname !== "brain" || url.port) throw new Error("Invalid brain URI authority")
    pathname = url.pathname
  } else if (url.protocol === "https:") {
    if (url.origin !== HTTPS_ORIGIN || !url.pathname.startsWith(HTTPS_PREFIX)) {
      throw new Error("Unsupported Day of Week deeplink")
    }
    pathname = url.pathname.slice(HTTPS_PREFIX.length - 1)
  } else {
    throw new Error("Unsupported brain URI protocol")
  }

  return { version: 1, ...parseSegments(pathname) }
}

export function toBrainUri(resource: BrainResource): string {
  const areaId = assertId(resource.areaId, "area ID")
  if (resource.resourceType === "area") return `dayofweek://brain/${areaId}`
  const resourceId = assertId(resource.resourceId, `${resource.resourceType} ID`)
  return `dayofweek://brain/${areaId}/${resource.resourceType}/${resourceId}`
}

export function toBrainHttpsUrl(resource: BrainResource): string {
  return `${HTTPS_ORIGIN}/app/brain/${toBrainUri(resource).slice("dayofweek://brain/".length)}`
}
