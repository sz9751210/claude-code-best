import type { APIProvider } from 'src/utils/model/providers.js'

export function assertGeminiWebModeSupported({
  apiProvider,
  isNonInteractiveSession,
}: {
  apiProvider: APIProvider
  isNonInteractiveSession: boolean
}): void {
  void isNonInteractiveSession

  if (apiProvider !== 'geminiWeb') return
}
