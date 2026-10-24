export * as SocksBridge from "./socks-bridge.js"

import { Buffer } from "node:buffer"

// Bun's fetch accepts HTTP(S) proxies but rejects SOCKS URLs. A local loopback
// HTTP CONNECT proxy bridges each tunnel through the configured SOCKS5 server,
// so the rest of the runtime keeps using one proxy format.

interface State {
  readonly client: Bun.Socket<State>
  readonly hostname: string
  readonly port: number
  stage: "http" | "greeting" | "auth" | "connect" | "tunnel"
  clientBuffer: Buffer
  upstreamBuffer: Buffer
  upstream?: Bun.Socket<undefined>
}

const bridges = new Map<string, Promise<string>>()
const owners = new Map<string, Bun.TCPSocketListener<State>>()
const servers = new Set<Bun.TCPSocketListener<State>>()

const MAX_HEADER_BYTES = 16 * 1024
const MAX_SOCKS_REPLY_BYTES = 512

const debug = (...values: unknown[]) => {
  if (process.env.OPENCODE_PROXY_DEBUG) console.error("[socks-bridge]", ...values)
}

const parseSocks = (value: string) => {
  const url = new URL(value)
  if (url.protocol !== "socks5:" && url.protocol !== "socks5h:") return
  return {
    hostname: url.hostname.replace(/^\[|\]$/g, ""),
    port: Number(url.port || 1080),
  }
}

const writeBuffer = <Data>(socket: Bun.Socket<Data>, data: Buffer) =>
  socket.write(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))

const socksConnectRequest = (hostname: string, port: number) => {
  const name = Buffer.from(hostname.replace(/^\[|\]$/g, ""))
  if (name.length === 0 || name.length > 255) return
  return Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([(port >> 8) & 0xff, port & 0xff])])
}

const openTunnel = async (
  state: State,
  hostname: string,
  port: number,
  credentials: { username: string; password: string } | undefined,
) => {
  const greeting = credentials ? Buffer.from([5, 2, 0, 2]) : Buffer.from([5, 1, 0])
  const request = socksConnectRequest(hostname, port)
  if (!request) {
    state.client.end()
    return
  }

  debug("connect", hostname, port)
  const upstream = await Bun.connect({
    hostname: state.hostname,
    port: state.port,
    socket: {
      open(socket) {
        writeBuffer(socket, greeting)
      },
      data(socket, data) {
        if (state.stage === "tunnel") {
          state.client.write(data)
          return
        }

        state.upstreamBuffer = Buffer.concat([state.upstreamBuffer, Buffer.from(data)])
        if (state.upstreamBuffer.length > MAX_SOCKS_REPLY_BYTES) {
          state.client.end()
          return
        }

        if (state.stage === "greeting") {
          if (state.upstreamBuffer.length < 2) return
          const version = state.upstreamBuffer[0]
          const method = state.upstreamBuffer[1]
          state.upstreamBuffer = state.upstreamBuffer.subarray(2)
          if (version !== 5 || (method !== 0 && method !== 2)) {
            state.client.end()
            return
          }
          if (method === 2) {
            if (!credentials) {
              state.client.end()
              return
            }
            const username = Buffer.from(credentials.username)
            const password = Buffer.from(credentials.password)
            if (username.length > 255 || password.length > 255) {
              state.client.end()
              return
            }
            state.upstreamBuffer = Buffer.alloc(0)
            state.stage = "auth"
            writeBuffer(
              socket,
              Buffer.concat([Buffer.from([1, username.length]), username, Buffer.from([password.length]), password]),
            )
            return
          }
          state.stage = "connect"
          writeBuffer(socket, request)
        }

        if (state.stage === "auth") {
          if (state.upstreamBuffer.length < 2) return
          const status = state.upstreamBuffer[1]
          state.upstreamBuffer = state.upstreamBuffer.subarray(2)
          if (status !== 0) {
            state.client.end()
            return
          }
          state.stage = "connect"
          writeBuffer(socket, request)
        }

        if (state.stage === "connect") {
          if (state.upstreamBuffer.length < 5) return
          if (state.upstreamBuffer[0] !== 5 || state.upstreamBuffer[1] !== 0) {
            state.client.end()
            return
          }
          const addressType = state.upstreamBuffer[3]
          const length =
            addressType === 1 ? 10 : addressType === 3 ? 7 + state.upstreamBuffer[4] : addressType === 4 ? 22 : 0
          if (length === 0 || state.upstreamBuffer.length < length) return

          const leftover = state.upstreamBuffer.subarray(length)
          state.upstreamBuffer = Buffer.alloc(0)
          state.stage = "tunnel"
          debug("tunnel", hostname, port)
          state.client.write("HTTP/1.1 200 Connection Established\r\n\r\n")
          if (leftover.length) state.client.write(leftover)
          if (state.clientBuffer.length) {
            writeBuffer(socket, state.clientBuffer)
            state.clientBuffer = Buffer.alloc(0)
          }
        }
      },
      close() {
        debug("upstream closed")
        state.client.end()
      },
      error() {
        state.client.end()
      },
    },
  })
  state.upstream = upstream
}

const listen = (hostname: string, port: number, credentials: { username: string; password: string } | undefined) => {
  const server = Bun.listen<State>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        socket.data = {
          client: socket,
          hostname,
          port,
          stage: "http",
          clientBuffer: Buffer.alloc(0),
          upstreamBuffer: Buffer.alloc(0),
        }
      },
      data(socket, data) {
        const state = socket.data
        if (state.stage === "tunnel") {
          state.upstream?.write(data)
          return
        }

        state.clientBuffer = Buffer.concat([state.clientBuffer, Buffer.from(data)])
        if (state.clientBuffer.length > MAX_HEADER_BYTES) {
          socket.end()
          return
        }

        const headerEnd = state.clientBuffer.indexOf("\r\n\r\n")
        if (headerEnd < 0) return
        const header = state.clientBuffer.subarray(0, headerEnd).toString("latin1")
        const target = /^CONNECT\s+(\S+)\s+HTTP\/1\.[01]$/i.exec(header.split("\r\n")[0])?.[1]
        if (!target) {
          socket.end()
          return
        }
        const separator = target.lastIndexOf(":")
        const targetHost = target.slice(0, separator)
        const targetPort = Number(target.slice(separator + 1))
        if (separator < 0 || !Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
          socket.end()
          return
        }

        state.clientBuffer = state.clientBuffer.subarray(headerEnd + 4)
        debug("http", target)
        state.stage = "greeting"
        void openTunnel(state, targetHost, targetPort, credentials).catch(() => socket.end())
      },
      close(socket) {
        debug("client closed")
        socket.data.upstream?.end()
      },
      error(socket) {
        socket.data.upstream?.end()
      },
    },
  })
  server.unref()
  servers.add(server)
  return `http://127.0.0.1:${server.port}`
}

export const httpProxy = (proxy: string) => {
  const existing = bridges.get(proxy)
  if (existing) return existing

  const bridge = Promise.resolve().then(() => {
    const parsed = parseSocks(proxy)
    if (!parsed) throw new Error(`Unsupported SOCKS proxy: ${proxy}`)
    const url = new URL(proxy)
    const username = decodeURIComponent(url.username)
    const password = decodeURIComponent(url.password)
    return listen(parsed.hostname, parsed.port, username ? { username, password } : undefined)
  })
  bridges.set(proxy, bridge)
  void bridge.then((url) => {
    const owner = [...servers].find((server) => url.endsWith(`:${server.port}`))
    if (owner) owners.set(proxy, owner)
  })
  bridge.catch(() => bridges.delete(proxy))
  return bridge
}

export const release = (proxy: string) => {
  const owner = owners.get(proxy)
  if (!owner) return
  owners.delete(proxy)
  bridges.delete(proxy)
  servers.delete(owner)
  owner.stop(true)
}

export const stop = () => {
  servers.forEach((server) => server.stop(true))
  servers.clear()
  bridges.clear()
  owners.clear()
}
