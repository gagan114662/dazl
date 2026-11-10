Recorded 2026-11-03T10:00:19.495Z from the public Enhetsregisteret API (data.brreg.no, NLOD 2.0, no key); records.json was recorded the same way on 2026-11-10. Public-register data as published, including the register's sole-trader (ENK) names already present in the list fixtures.
Requests:
- enheter-restaurant-oslo.json: https://data.brreg.no/enhetsregisteret/api/enheter?naeringskode=56&kommunenummer=0301&fraRegistreringsdatoEnhetsregisteret=2026-09-04&size=20&sort=registreringsdatoEnhetsregisteret,desc
- enheter-dental-no.json: https://data.brreg.no/enhetsregisteret/api/enheter?naeringskode=86.23&fraRegistreringsdatoEnhetsregisteret=2026-09-04&size=20&sort=registreringsdatoEnhetsregisteret,desc
- underenheter-dental-no.json: https://data.brreg.no/enhetsregisteret/api/underenheter?naeringskode=86.23&fraRegistreringsdatoEnhetsregisteret=2026-09-04&size=20&sort=registreringsdatoEnhetsregisteret,desc
- underenheter-restaurant-oslo.json: https://data.brreg.no/enhetsregisteret/api/underenheter?naeringskode=56&kommunenummer=0301&fraRegistreringsdatoEnhetsregisteret=2026-09-04&size=20&sort=registreringsdatoEnhetsregisteret,desc
- parents-restaurant-oslo.json: https://data.brreg.no/enhetsregisteret/api/enheter/<overordnetEnhet> for those sub-units
- parents-dental.json: https://data.brreg.no/enhetsregisteret/api/enheter/<overordnetEnhet> for the dental sub-units whose parent is not itself newly registered
- records.json: the entity's own record, https://data.brreg.no/enhetsregisteret/api/{enheter|underenheter}/<orgnr> (Accept: application/json), for every candidate the adapter cites (recorded 2026-11-10; replaces the virksomhet.brreg.no page texts, which do not show the registration date)
Nothing is edited by hand; tests that need a synthetic case build it inline and say so.
