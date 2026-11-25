export function isPublicSectorBody(input: {
  company: string;
  domain?: string | null;
  offer?: string | null;
}): { nonBuyer: boolean; reason: string } {
  const company = input.company.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const domain = (input.domain ?? '').toLowerCase().trim().replace(/^https?:\/\//, '').split(/[/:?#]/, 1)[0];
  const offer = (input.offer ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  const governmentTargeted = /\bserves? government agencies\b|\bserves? municipalities\b|\bserves? public schools\b|\bpublic sector procurement\b|\bgovtech\b|\bsled\b|\bpublic sector\b/.test(offer);
  if (governmentTargeted) {
    return { nonBuyer: false, reason: 'The offer is explicitly aimed at government or public-sector buyers.' };
  }

  const govDomain = /(?:^|\.)gov$/.test(domain) || /(?:^|\.)gc\.ca$/.test(domain) || /(?:^|\.)mil$/.test(domain);
  const businessLookalike = /\b(?:bakery|cafe|restaurant|boutique|salon|llc|inc|software|consulting|store|shop)\b/.test(company);
  const publicBody = /\b(?:city of|town of|county of|municipality|borough|school board|school district|public schools|department of|ministry of|public works|public library|public health|police department|fire department|state of|province of|village of|public agency|housing authority|transit authority)\b/.test(company);

  if ((govDomain || publicBody) && !(publicBody && businessLookalike)) {
    return { nonBuyer: true, reason: govDomain ? 'The domain identifies a government or public-sector organization.' : 'The organization name identifies a government or public-sector body.' };
  }
  return { nonBuyer: false, reason: 'No clear public-sector identity was found.' };
}
