// Model-written briefs and drafts are markdown, shown in a plain-text block, so users saw literal "##" and "**"
// (issue #199). This turns them into readable text: headings and emphasis marks go, links keep their text, list
// bullets become "- ", line breaks stay. Not an HTML renderer: nothing here can inject markup.
export function markdownToPlain(md: string): string {
  return md
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]{0,300})\]\([^)]*\)/g, '$1')
    .replace(/(\*{1,3})([^*\n]+)\1/g, '$2')
    .replace(/(?<![A-Za-z0-9])(_{1,3})([^_\n]+)\1(?![A-Za-z0-9])/g, '$2')
    .replace(/^\s*[*+]\s+/gm, '- ')
    .replace(/`{1,3}/g, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
