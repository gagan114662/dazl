-- #1926: the leads event_date_proof CHECK (0025) learns 'page_structured' - a day the proof page's own typed
-- markup states (an Article's datePublished, a JobPosting's datePosted), the third proof kind the readers
-- already judge alongside page_bound and ats_structured. Until now such a day could only be stored as
-- page_bound, and a row carrying the checker's own token was refused by this CHECK. Only the CHECK widens;
-- rows are untouched. Slot 0079 per the ruling on #2136: lands after 0078 (#2135).
ALTER TABLE leads DROP CONSTRAINT leads_event_date_proof_check;
ALTER TABLE leads ADD CONSTRAINT leads_event_date_proof_check CHECK (event_date_proof IS NULL OR event_date_proof IN ('page_bound','ats_structured','page_structured'));
