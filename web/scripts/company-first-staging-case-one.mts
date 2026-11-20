// Systemd one-shot only; never mounted in Next or a public worker route.
import { runTrustedStagingCaseOneEntry } from '../lib/company-first/scorecard-staging-case-one-entry.ts'
import { prepareStagingCaseOneBinding } from '../lib/company-first/scorecard-staging-case-one-bindings.ts'

const abort=new AbortController()
const stop=()=>abort.abort()
process.once('SIGTERM',stop)
process.once('SIGINT',stop)
try{
  const result=await runTrustedStagingCaseOneEntry(prepareStagingCaseOneBinding,
    AbortSignal.any([abort.signal,AbortSignal.timeout(9*60_000)]))
  // Sole output goes to the protected operator pipe, never the app journal;
  // it contains only settled proof's vetted sample labels, or a closed code.
  process.stdout.write(JSON.stringify(result)+'\n')
  if(result.state!=='measured')process.exitCode=1
}finally{
  process.off('SIGTERM',stop)
  process.off('SIGINT',stop)
}
