import { installClientErrorReporting } from './lib/client-error-report'

// React can report a hydration mismatch before the root layout's effects have run.
installClientErrorReporting()
