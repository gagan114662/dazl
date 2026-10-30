// #349: text quoted inside a sentence ("...says you sell <X>, but it started with <Y>. dazl will...") ends where the
// sentence goes on, so it drops its own closing punctuation: one or more . ! ? or an ellipsis (also "..."), with any
// trailing space, including when a closing quote or bracket follows it (the closer stays). Without this an offer saved as
// "...in New York City." renders "City.. dazl". Applied to the shown text only; the value chosen and stored is unchanged.
export function inSentence(text: string): string {
  return text.replace(/\s+$/, '').replace(/[.!?…]+(["'”’)\]]*)$/, '$1')
}
