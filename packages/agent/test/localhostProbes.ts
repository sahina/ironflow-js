import { connect } from 'node:net'

// Exercise fixture isolation from localhost port scanners.
export async function sendLocalhostProbes(url: string): Promise<void> {
  const response = await fetch(url)
  await response.arrayBuffer()
  const target = new URL(url)
  await new Promise<void>((resolve, reject) => {
    const socket = connect(Number(target.port), target.hostname)
    socket.on('error', reject)
    socket.on('connect', () => { socket.end() })
    socket.on('close', () => { resolve() })
  })
}
