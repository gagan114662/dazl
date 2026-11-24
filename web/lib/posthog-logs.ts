import { SeverityNumber } from '@opentelemetry/api-logs'
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs'

let loggerProvider: LoggerProvider | null | undefined
let warned = false
let shutdownHookInstalled = false

function getLoggerProvider(): LoggerProvider | null {
  if (loggerProvider !== undefined) return loggerProvider

  const token = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN
  const host = process.env.NEXT_PUBLIC_POSTHOG_HOST
  if (!token || !host) {
    loggerProvider = null
    if (!warned && process.env.NODE_ENV !== 'production') {
      warned = true
      const missing = token ? 'NEXT_PUBLIC_POSTHOG_HOST' : 'NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN'
      console.warn(`${missing} variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once ${missing} is configured`)
    }
    return loggerProvider
  }

  loggerProvider = new LoggerProvider({
    resource: resourceFromAttributes({ 'service.name': 'dazl' }),
    processors: [
      new BatchLogRecordProcessor({
        exporter: new OTLPLogExporter({
          url: `${host.replace(/\/$/, '')}/i/v1/logs`,
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        }),
      }),
    ],
  })
  return loggerProvider
}

export function emitPostHogLog(body: string, attributes: Record<string, string | number | boolean>): void {
  try {
    const provider = getLoggerProvider()
    provider?.getLogger('dazl-posthog').emit({
      body,
      severityNumber: SeverityNumber.INFO,
      attributes,
    })
  } catch {
    // Observability must never affect scan execution.
  }
}

export function registerPostHogLogShutdown(): void {
  const provider = getLoggerProvider()
  if (!provider || shutdownHookInstalled) return
  shutdownHookInstalled = true
  process.once('beforeExit', () => {
    void provider.forceFlush().catch(() => {})
  })
}
