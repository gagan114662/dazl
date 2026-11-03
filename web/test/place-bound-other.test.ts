// A namesake that gives ITS OWN address in another state is that other place's business, however often its page also names the asked city as somewhere it serves. Pure; invented businesses.
import test from 'node:test'
import assert from 'node:assert/strict'
import { placeAgreement } from '../lib/scan/place-agreement.ts'

const v = (where: string, text: string, company = 'Smile Avenue Dental') => placeAgreement(text, [where], company)
test('SERVICE-AREA MENTION does not erase the company\'s own other-state address (Sunnyside, NY asked; Pico Rivera, CA is the company\'s own address)', () => {
  for (const t of [
    'Smile Avenue Dental Group, Pico Rivera, CA 90660. We proudly serve patients from Sunnyside and Queens.',
    'Smile Avenue Dental is located in Pico Rivera, CA. Patients travel to us from Sunnyside.',
    'Our office: Pico Rivera, CA 90660. We welcome families from Sunnyside, NY.',
    'Smile Avenue Dental, a Pico Rivera, CA practice, now accepts patients from Sunnyside.',
  ]) assert.equal(v('Sunnyside, NY', t), 'mismatch', t)
})
test('CONTROLS: the asked place bound to the company agrees, including with another office; an unbound mention of another state is not a conflict; no place stays unconfirmed', () => {
  assert.equal(v('Sunnyside, NY', 'Smile Avenue Dental, 45-12 Queens Boulevard, Sunnyside, NY 11104. Call us today.'), 'agrees')
  assert.equal(v('Sunnyside, NY', 'Smile Avenue Dental is located in Sunnyside, NY. Our Pico Rivera, CA office opened last year.'), 'agrees', 'both bound: a business with offices in both')
  assert.equal(v('Sunnyside, NY', 'Smile Avenue Dental is located in Sunnyside, NY. Our partner lab in Pico Rivera, CA ships crowns.'), 'agrees', 'an unbound other-state mention is not the company\'s address')
  assert.equal(v('Sunnyside, NY', 'Smile Avenue Dental welcomes families. Open Monday through Friday.'), 'unconfirmed')
  assert.equal(v('Austin, TX', 'Lone Star Dental, 100 Congress Avenue, Austin, TX 78701.', 'Lone Star Dental'), 'agrees')
  assert.equal(v('Austin, TX', 'Lone Star Dental Group, Tulsa, OK 74103. We also treat patients from Austin.', 'Lone Star Dental'), 'mismatch')
})
test('country-only and non-US asks are untouched', () => {
  assert.notEqual(v('India', 'Skyline Realty, Pune, MH. We serve clients across India.', 'Skyline Realty'), 'mismatch')
  assert.equal(v('Toronto, Canada', 'Maple Marketing opened an office in Toronto', 'Maple Marketing'), 'agrees')
})
