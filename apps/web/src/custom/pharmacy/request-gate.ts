export type RequestGate = {
  start(): number
  abort(): void
  isCurrent(token: number): boolean
}

export function createRequestGate(): RequestGate {
  let generation = 0
  return {
    start: () => ++generation,
    abort: () => { generation += 1 },
    isCurrent: (token) => generation === token,
  }
}
