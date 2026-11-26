const INSTITUTION_FORMS = new Set([
  'school board', 'school district', 'public schools', 'public library', 'public health', 'health authority',
  'police department', 'fire department', 'public agency', 'housing authority', 'transit authority', 'public works',
]);

const NON_PUBLIC_HOSPITAL_WORDS = new Set([
  'animal', 'veterinary', 'vet', 'pet', 'laptop', 'phone', 'computer', 'doll', 'teddy', 'toy', 'private',
]);

export const HOSPITAL_OWNERSHIP_UNKNOWN = 'Hospital ownership could not be confirmed. Research only.';

function hospitalOwnership(company: string, sourceText: string | null | undefined): 'public' | 'private' | null {
  const text = ' ' + (sourceText ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
  const name = ' ' + company + ' ';
  const index = text.indexOf(name);
  if (index < 0) return null;
  const statement = text.slice(index + name.length);
  if (/^(?:is|operates as) (?:an? |the )?(?:private|privately owned|for profit) hospital\b/.test(statement)) return 'private';
  if (/^(?:is|operates as) (?:an? |the )?(?:public(?: sector)?|government owned) hospital\b/.test(statement) ||
      /^(?:is )?(?:owned|operated|run) by (?:the )?(?:government\b|(?:[a-z0-9]+ ){0,4}health authority\b)/.test(statement)) return 'public';
  return null;
}

export function isPublicSectorBody(input: {
  company: string;
  domain?: string | null;
  offer?: string | null;
  sourceText?: string | null;
}): { nonBuyer: boolean; reason: string; ownershipUnconfirmed?: true } {
  const company = input.company.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const domain = hostname(input.domain);
  const offerClauses = (input.offer ?? '').toLowerCase().split(/[.!?;\n]+/);

  const governmentOffer = /\bserves? government agencies\b|\b(?:serves?|for) (?:municipalities|(?:local|state|federal) governments?)\b|\bserves? public schools\b|\bpublic sector procurement\b|\bgovtech\b|\bsled\b|\bpublic sector\b/;
  const negation = /\b(?:not|never|don t|do not|no|isn t|aren t|doesn t|won t|exclud(?:e|es|ing))\b/;
  const offerTargetsGovernment = offerClauses.some(clause => {
    const words = clause.replace(/[^a-z0-9]+/g, ' ').trim();
    return governmentOffer.test(words) && !governmentOfferMatchesNegated(words, governmentOffer, negation);
  });
  if (offerTargetsGovernment) {
    return { nonBuyer: false, reason: 'The offer is explicitly aimed at government or public-sector buyers.' };
  }

  const govDomain = /(?:^|\.)(?:gov(?:\.[a-z]{2})?|gc\.ca|mil|ontario\.ca|canada\.ca)$/.test(domain);
  const civicName = company.match(/^(?:regional municipality|town|city|county|township|village|municipality|region|province|state|district|borough) of (.+)$/);
  const place = civicName?.[1] ?? '';
  // Ambiguous multiword names need civic wording, a geographic ending, or a matching site.
  const civicPlace = /^[a-z0-9]+$/.test(place) ||
    /^.+ (?:bay|creek|falls|harbour|harbor|heights|hills|island|lake|mountain|rapids|river|springs|valley)$/.test(place) ||
    (place.includes(' ') && domain.replace(/^www\./, '').split('.')[0].replace(/-/g, '') === place.replace(/ /g, ''));
  const words = company.split(' ');
  const first = words[0];
  const last = words.at(-1);
  const lastTwo = words.slice(-2).join(' ');
  const council = (first === 'city' || first === 'town') && words[1] === 'of' && words.length >= 4 && last === 'council';
  const localGovernment = first !== 'the' && words.length > 1 && (
    last === 'county' || last === 'township' || (words.length > 2 && (lastTwo === 'city council' || lastTwo === 'town council'))
  );
  const hospital = words.length > 1 && (last === 'hospital' || last === 'hospitals') &&
    !words.slice(0, -1).some(word => NON_PUBLIC_HOSPITAL_WORDS.has(word));
  const ownership = hospital ? hospitalOwnership(company, input.sourceText) : null;
  const namedBody = civicPlace || council || localGovernment || ownership === 'public' || INSTITUTION_FORMS.has(lastTwo);
  const requiresGovernmentDomain = first === 'ministry' || first === 'department' || first === 'government';

  if (govDomain || (namedBody && !requiresGovernmentDomain)) {
    return { nonBuyer: true, reason: govDomain ? 'The domain identifies a government or public-sector organization.' : 'The organization name identifies a government or public-sector body.' };
  }
  if (hospital && ownership === null) return { nonBuyer: false, ownershipUnconfirmed: true, reason: HOSPITAL_OWNERSHIP_UNKNOWN };
  return { nonBuyer: false, reason: 'No clear public-sector identity was found.' };
}

function hostname(domain: string | null | undefined): string {
  if (!domain?.trim()) return '';
  const value = domain.trim();
  try {
    return new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`).hostname.replace(/\.$/, '');
  } catch {
    return '';
  }
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
