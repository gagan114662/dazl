const INSTITUTION_FORMS = new Set([
  'school board', 'school district', 'public schools', 'public library', 'public health', 'health authority',
  'police department', 'fire department', 'public agency', 'housing authority', 'transit authority', 'public works',
]);

const PUBLIC_HEALTH_FORMS = new Set(['health sciences', 'health network', 'health services', 'health region']);
const PUBLIC_HOSPITAL_MODIFIERS = new Set(['general', 'regional', 'memorial', 'district', 'university', 'public']);
const COMMERCIAL_HOSPITAL_WORDS = new Set(['animal', 'veterinary', 'vet', 'pet', 'laptop', 'phone', 'computer', 'doll', 'teddy', 'toy', 'private']);

export function isPublicSectorBody(input: {
  company: string;
  domain?: string | null;
  offer?: string | null;
}): { nonBuyer: boolean; reason: string } {
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
  const hospital = (last === 'hospital' || last === 'hospitals') && !words.some(word => COMMERCIAL_HOSPITAL_WORDS.has(word));
  const hospitalModifier = words.at(-2) ?? '';
  const publicHospital = hospital && (PUBLIC_HOSPITAL_MODIFIERS.has(hospitalModifier) || words.slice(-3, -1).join(' ') === 'children s');
  const provincialHealthDomain = hospital && /(?:^|\.)on\.ca$/.test(domain);
  const namedBody = civicPlace || council || localGovernment || INSTITUTION_FORMS.has(lastTwo) ||
    PUBLIC_HEALTH_FORMS.has(lastTwo) || last === 'lhin' || publicHospital;
  const requiresGovernmentDomain = first === 'ministry' || first === 'department' || first === 'government';

  if (govDomain || provincialHealthDomain || (namedBody && !requiresGovernmentDomain)) {
    return { nonBuyer: true, reason: govDomain || provincialHealthDomain ? 'The domain identifies a government or public-sector organization.' : 'The organization name identifies a government or public-sector body.' };
  }
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
