// Whole leadership titles. Each group is a general role, with common equivalents
// in French, German, Spanish, Portuguese, Russian, Arabic, Japanese and Chinese.
// Match the full title so an employer, qualification or trailing commentary cannot
// turn an otherwise unsupported title into a buyer.
const levels = [
  { rank: 4, titles: [
    'fondateur', 'fondatrice', 'cofondateur', 'cofondatrice', 'propriétaire', 'président', 'présidente',
    'directeur général', 'directrice générale', 'président directeur général', 'président et directeur général',
    'gründer', 'gründerin', 'geschäftsführer', 'geschäftsführerin', 'inhaber', 'inhaberin',
    'fundador', 'fundadora', 'cofundador', 'cofundadora', 'director general', 'directora general', 'diretor geral', 'diretora geral',
    'director ejecutivo', 'directora ejecutiva', 'diretor executivo', 'diretora executiva', 'presidente',
    'основатель', 'сооснователь', 'владелец', 'генеральный директор', 'управляющий директор',
    'مؤسس', 'المؤسس', 'الرئيس التنفيذي', 'المدير التنفيذي', 'المدير العام', 'الرئيس وكبير الإداريين التنفيذيين',
    '創業者', '共同創業者', '創業者 取締役', '代表取締役', '代表取締役社長', '最高経営責任者',
    '创始人', '聯合創辦人', '首席执行官', '總經理',
  ] },
  { rank: 3, titles: [
    'vice-président', 'vice-présidente', 'vizepräsident', 'vizepräsidentin', 'vicepresidente', 'vice-presidente',
    'вице-президент', 'نائب الرئيس', '副社長', '副总裁',
  ] },
  { rank: 2, titles: [
    'associé', 'associée', 'directeur', 'directrice', 'direktor', 'direktorin', 'director', 'directora',
    'diretor', 'diretora', 'socio', 'socia', 'sócio', 'sócia', 'директор', 'партнёр',
    'شريك', '取締役', '合伙人', '董事',
  ] },
]

const normalize = (title: string) => title.normalize('NFKD').toLowerCase().replace(/\p{M}/gu, '').trim().replace(/\s+/g, ' ')
const ranks = new Map(levels.flatMap(({ rank, titles }) => titles.map(title => [normalize(title), rank] as const)))

export function multilingualSeniority(title: string): number {
  return ranks.get(normalize(title)) ?? 0
}
