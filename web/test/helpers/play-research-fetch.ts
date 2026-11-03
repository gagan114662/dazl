export {isFail} from '../../lib/scan/fetch-page.ts'
export let calls=0
export function resetCalls(){calls=0}
export async function fetchPageDetailed(){calls++;return {title:'Epoch careers',text:'Epoch is hiring a first sales representative in London.',retrievedAt:1793286117}}
