import { describe, expect, test } from "bun:test"
import { ProxyRotator } from "../../src/proxy/proxy-rotator.js"

describe("proxy rotator", () => {
  test("normalizes bare and explicit proxy entries", () => {
    expect(ProxyRotator.normalize("127.0.0.1:8080")).toBe("http://127.0.0.1:8080")
    expect(ProxyRotator.normalize("socks5://127.0.0.1:1080")).toBe("socks5://127.0.0.1:1080")
    // Free "https proxy" lists are CONNECT proxies — never TLS-to-the-proxy.
    expect(ProxyRotator.normalize("127.0.0.1:8080", "https")).toBe("http://127.0.0.1:8080")
    expect(ProxyRotator.normalize("https://user:pass@example.com:443")).toBe("http://user:pass@example.com:443")
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
    expect(
      ProxyRotator.sourceLabel(
        "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=http&proxy_format=ipport&format=text&anonymity=elite&timeout=5000",
      ),
    ).toBe("api.proxyscrape.com/v4/free-proxy-list/get?http&elite")
    expect(
      ProxyRotator.sourceLabel(
        "https://proxylist.geonode.com/api/proxy-list?limit=500&page=2&sort_by=lastChecked&sort_type=desc&protocols=socks5",
      ),
    ).toBe("proxylist.geonode.com/api/proxy-list?socks5&page=2")
  })

  test("groups IPv4 proxies by /24 for shared free-tier quota", () => {
    expect(ProxyRotator.subnetOf("socks5://45.74.31.47:4504")).toBe("45.74.31.0/24")
    expect(ProxyRotator.subnetOf("http://45.74.31.40:8080")).toBe("45.74.31.0/24")
    expect(ProxyRotator.subnetOf("http://102.244.78.61:8082")).toBe("102.244.78.0/24")
    expect(ProxyRotator.subnetOf("socks5://example.com:1080")).toBeUndefined()
  })

  test("status exposes active subnet bans after reset clears them", () => {
    ProxyRotator.reset()
    expect(ProxyRotator.status().subnets).toEqual({})
  })

  test("formats source:proxy traces for dead-list debugging", () => {
    expect(ProxyRotator.proxyTrace("http://1.2.3.4:8080", "raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt")).toBe(
      "raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt : proxy: 1.2.3.4:8080",
    )
    expect(ProxyRotator.proxyTrace(undefined)).toBe("direct")
  })

  test("ships known-dead lists already purged", () => {
    ProxyRotator.reset()
    expect(ProxyRotator.status().purged).toContain("raw.githubusercontent.com/ALIILAPRO/Proxy/main/http.txt")
    expect(ProxyRotator.status().purged).toContain("raw.githubusercontent.com/ErcinDedeoglu/proxies/main/proxies/http.txt")
    expect(ProxyRotator.status().purged).toContain("raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt")
    expect(ProxyRotator.status().purged).toContain(
      "raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/socks5/data.txt",
    )
    expect(ProxyRotator.status().purged).toContain("raw.githubusercontent.com/iplocate/free-proxy-list/main/protocols/socks5.txt")
    expect(ProxyRotator.status().purged).toContain("raw.githubusercontent.com/zloi-user/hideip.me/main/socks5.txt")
    expect(ProxyRotator.status().purged).toContain("raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt")
    expect(ProxyRotator.status().purged).toContain("api.proxyscrape.com/v4/free-proxy-list/get?socks5")
    expect(ProxyRotator.status().purged).toContain("raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt")
  })
})
