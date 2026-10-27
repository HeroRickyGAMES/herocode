import { describe, expect, test } from "bun:test"
import { ProxyRotator } from "../../src/proxy/proxy-rotator.js"

describe("proxy rotator", () => {
  test("normalizes bare and explicit proxy entries", () => {
    expect(ProxyRotator.normalize("127.0.0.1:8080")).toBe("http://127.0.0.1:8080")
    expect(ProxyRotator.normalize("socks5://127.0.0.1:1080")).toBe("socks5://127.0.0.1:1080")
    expect(ProxyRotator.normalize("https://user:pass@example.com:443")).toBe("https://user:pass@example.com:443")
  })

  test("rejects unsupported or incomplete entries", () => {
    expect(ProxyRotator.normalize("socks4://127.0.0.1:1080")).toBe("socks4://127.0.0.1:1080")
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

  test("labels proxy list sources by host path so GitHub mirrors stay distinct", () => {
    expect(ProxyRotator.sourceLabel("https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt")).toBe(
      "raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt",
    )
    expect(
      ProxyRotator.sourceLabel(
        "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=socks5&proxy_format=ipport&format=text",
      ),
    ).toBe("api.proxyscrape.com/v4/free-proxy-list/get?socks5")
  })

  test("groups IPv4 proxies by /24 for shared free-tier quota", () => {
    expect(ProxyRotator.subnetOf("socks5://45.74.31.47:4504")).toBe("45.74.31.0/24")
    expect(ProxyRotator.subnetOf("http://45.74.31.40:8080")).toBe("45.74.31.0/24")
    expect(ProxyRotator.subnetOf("http://102.244.78.61:8082")).toBe("102.244.78.0/24")
    expect(ProxyRotator.subnetOf("socks5://example.com:1080")).toBeUndefined()
  })
})
