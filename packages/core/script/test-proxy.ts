import { ProxyRotator } from "../src/proxy/proxy-rotator.js"
import * as SocksBridge from "../src/proxy/socks-bridge.js"

const proxy = process.env.OPENCODE_PROXY
if (!proxy) {
  console.error("Set OPENCODE_PROXY to a live proxy, for example OPENCODE_PROXY=socks5://host:1080")
  process.exit(2)
}

process.env.OPENCODE_PROXY_FORCE = "1"

const direct = await fetch("https://api.ipify.org").then((response) => response.text())
const bridged = await fetch("https://api.ipify.org", {
  proxy: await SocksBridge.httpProxy(proxy),
}).then((response) => response.text())
const rotated = await ProxyRotator.fetch("https://api.ipify.org").then((response) => response.text())

console.log({ proxy, direct, bridged, rotated })

if (!bridged || bridged === direct) {
  console.error("bridge did not route through the proxy")
  process.exit(1)
}
if (!rotated) {
  console.error("proxy rotator returned no body")
  process.exit(1)
}
if (rotated !== bridged) {
  console.warn("rotator used a different proxy than the direct bridge test")
}

SocksBridge.stop()
console.log("proxy rotator forced-proxy test passed")
