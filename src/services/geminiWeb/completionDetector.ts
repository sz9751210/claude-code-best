export function isResponseStable(params: {
  generationActive: boolean
  lastTextChangeAt: number
  now: number
  stableMs: number
}): boolean {
  if (params.generationActive) {
    return false
  }
  return params.now - params.lastTextChangeAt >= params.stableMs
}
