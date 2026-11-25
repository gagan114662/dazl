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
  const businessLookalike = /\b(?:bakery|cafe|restaurant|boutique|salon|llc|inc|software|consulting|store|shop|dreams|carpentry|plumbing|glass|pizza)\b/.test(company);
  const cityPattern = /\bcity of (?!the\b)([a-z0-9]+(?: [a-z0-9]+){0,3})(?: council)?\b/;
  const cityMatch = company.match(cityPattern);
  const cityLooksLikeBusiness = !!cityMatch && /\b(?:dreams|bakery|carpentry|plumbing|glass|pizza|cafe|restaurant|shop|store)\b/.test(cityMatch[1]);
  const publicBody =
    /\btown of [a-z][a-z ]+\b/.test(company) ||
    (!!cityMatch && !cityLooksLikeBusiness) ||
    /\b[a-z][a-z ]+ county\b|\bcounty of [a-z][a-z ]+\b/.test(company) ||
    /\bmunicipality(?: of [a-z][a-z ]+)?\b|\bministry(?: of [a-z][a-z ]+)?\b|\bdepartment of [a-z][a-z ]+\b|\bgovernment of [a-z][a-z ]+\b/.test(company) ||
    /\b(?:borough|school board|school district|public schools|public library|public health|police department|fire department|state of|province of|village of|public agency|housing authority|transit authority|public works)\b/.test(company);

  if ((govDomain || publicBody) && !(publicBody && businessLookalike)) {
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
