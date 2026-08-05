import { describe, expect, it } from "vitest"
import { parseBrainResource, toBrainHttpsUrl } from "../src/uri.js"

const area = "a1234567890"
const note = "n1234567890"
const source = "s1234567890"
const skill = "k1234567890"

describe("version-1 Day of Week brain URI parser", () => {
  it.each([
    [`dayofweek://brain/${area}`, { areaId: area, resourceType: "area", resourceId: undefined }],
    [`dayofweek://brain/${area}/note/${note}`, { areaId: area, resourceType: "note", resourceId: note }],
    [`dayofweek://brain/${area}/source/${source}`, { areaId: area, resourceType: "source", resourceId: source }],
    [`dayofweek://brain/${area}/skill/${skill}`, { areaId: area, resourceType: "skill", resourceId: skill }],
    [`https://field.dayofweek.com/app/brain/${area}/note/${note}`, { areaId: area, resourceType: "note", resourceId: note }],
    [`https://field.dayofweek.com/app/brain/${area}/skill/${skill}`, { areaId: area, resourceType: "skill", resourceId: skill }],
  ])("parses %s", (value, expected) => {
    expect(parseBrainResource(value)).toEqual({ version: 1, ...expected })
  })

  it.each([
    `dayofweek://user:secret@brain/${area}`,
    `dayofweek://brain/${area}/note/${note}?token=secret`,
    `dayofweek://brain/${area}/note/${note}#fragment`,
    `dayofweek://brain/${area}/unknown/${note}`,
    `dayofweek://brain/${area}/note/${note}/extra`,
    `https://evil.example/app/brain/${area}`,
    `https://field.dayofweek.com/app/brain/${area}?x=1`,
    `dayofweek://brain/${"x".repeat(129)}`,
    `dayofweek://brain/a b/note/${note}`,
  ])("rejects unsafe or non-v1 input %s", (value) => {
    expect(() => parseBrainResource(value)).toThrow()
  })

  it("produces the canonical authenticated HTTPS deeplink", () => {
    const parsed = parseBrainResource(`dayofweek://brain/${area}/source/${source}`)
    expect(toBrainHttpsUrl(parsed)).toBe(
      `https://field.dayofweek.com/app/brain/${area}/source/${source}`,
    )
  })
})
