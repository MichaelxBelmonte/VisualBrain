export const SEARCH_FILTERS = {
  all: 'Tutto', folders: 'Cartelle', projects: 'Progetti', files: 'File', code: 'Codice',
  documents: 'Documenti', media: 'Immagini e media', objects: 'Oggetti e collegamenti',
} as const;
export type SearchFilter = keyof typeof SEARCH_FILTERS;
export function isSearchFilter(value: string): value is SearchFilter { return Object.hasOwn(SEARCH_FILTERS, value); }
/** SQL fragments are fixed here, never supplied by a request. Applied before candidate limits. */
export const SEARCH_SQL: Record<SearchFilter, string> = {
  all: '1=1', folders: "n.kind='dir'", projects: "n.kind='dir' AND n.cls='project'", files: "n.kind='file'",
  code: "n.kind='file' AND n.cls IN ('code','config','notebook')",
  documents: "n.kind='file' AND n.cls IN ('doc','sheet','data')",
  media: "n.kind='file' AND n.cls IN ('image','video','audio','media')",
  objects: "n.kind IN ('external','area','symlink')",
};
