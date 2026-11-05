// #390: display text for first-party event rows. Import-free on purpose: the Leads page (a client bundle) reads it.
export const FP_TYPE_LABEL: Record<string, string> = { form_submission: 'Form submission', demo_request: 'Demo request', site_visit: 'Site visit', product_event: 'Product activity' }
// A stored first-party event value is '<type>:<event hash>'.
export const fpTypeLabel = (value: string): string => FP_TYPE_LABEL[value.split(':')[0]] ?? 'First-party event'
