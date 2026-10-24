import { describe, expect, test } from "bun:test"
import { ProxyRotator } from "../../src/proxy/proxy-rotator.js"

describe("proxy rotator", () => {
  test("normalizes bare and explicit proxy entries", () => {
    expect(ProxyRotator.normalize("127.0.0.1:8080")).toBe("http://127.0.0.1:8080")
    expect(ProxyRotator.normalize("socks5://127.0.0.1:1080")).toBe("socks5://127.0.0.1:1080")
    expect(ProxyRotator.normalize("https://user:pass@example.com:443")).toBe("https://user:pass@example.com:443")
  })

  test("rejects unsupported or incomplete entries", () => {
    expect(ProxyRotator.normalize("socks4://127.0.0.1:1080")).toBeUndefined()
    expect(ProxyRotator.normalize("127.0.0.1")).toBeUndefined()
    expect(ProxyRotator.normalize("# comment")).toBeUndefined()
    expect(ProxyRotator.normalize("127.0.0.1:70000")).toBeUndefined()
  })

  test("parses list formats and skips noise", () => {
    const text = ["# comment", "127.0.0.1:8080", "  socks5://127.0.0.1:1080  ", "not a proxy"].join("\n")
    expect(ProxyRotator.parseProxyLines(text)).toEqual(["http://127.0.0.1:8080", "socks5://127.0.0.1:1080"])
  })

  test("rotates on rate-limit, quota, and proxy failure statuses", () => {
    expect(ProxyRotator.shouldRotate(429)).toBe(true)
    expect(ProxyRotator.shouldRotate(402)).toBe(true)
    expect(ProxyRotator.shouldRotate(529)).toBe(true)
    expect(ProxyRotator.shouldRotate(407)).toBe(true)
    expect(ProxyRotator.shouldRotate(500)).toBe(false)
    expect(ProxyRotator.shouldRotate(401)).toBe(false)
  })
})
