export function isPublicSectorBody(input: {
  company: string;
  domain?: string | null;
  offer?: string | null;
}): { nonBuyer: boolean; reason: string } {
  const company = input.company.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const domain = (input.domain ?? '').toLowerCase().trim().replace(/^https?:\/\//, '').split(/[/:?#]/, 1)[0];
  const offer = (input.offer ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  const governmentOffer = /\bserves? government agencies\b|\bserves? municipalities\b|\bserves? public schools\b|\bpublic sector procurement\b|\bgovtech\b|\bsled\b|\bpublic sector\b/;
  const negation = /\b(?:not|never|don t|do not|no longer|isn t|aren t|doesn t|won t)\b/;
  const offerTargetsGovernment = governmentOffer.test(offer) && !governmentOfferMatchesNegated(offer, governmentOffer, negation);
  if (offerTargetsGovernment) {
    return { nonBuyer: false, reason: 'The offer is explicitly aimed at government or public-sector buyers.' };
  }

  const govDomain = /(?:^|\.)gov$/.test(domain) || /(?:^|\.)gc\.ca$/.test(domain) || /(?:^|\.)mil$/.test(domain);
  const publicBody = /^(?:(?:city|town|county) of [a-z0-9]+|(?:ministry|department) of [a-z0-9]+|[a-z0-9]+(?: [a-z0-9]+)* (?:school district|school board|district school board|police department|fire department))$/.test(company);

  if (govDomain || publicBody) {
    return { nonBuyer: true, reason: govDomain ? 'The domain identifies a government or public-sector organization.' : 'The organization name identifies a government or public-sector body.' };
  }
  return { nonBuyer: false, reason: 'No clear public-sector identity was found.' };
}

function governmentOfferMatchesNegated(
  offer: string,
  targetPattern: RegExp,
  negationPattern: RegExp,
): boolean {
  for (const match of offer.matchAll(new RegExp(targetPattern.source, 'g'))) {
    const preceding = offer.slice(Math.max(0, match.index! - 48), match.index!);
    const words = preceding.split(/\s+/).slice(-6).join(' ');
    if (negationPattern.test(words)) return true;
  }
  return false;
}
