export interface LibraryStats {
  site: string;
  libraries: { [libraryName: string]: number };
  mediaTypes: { [type: string]: number };
  authors: { [authorName: string]: number };
  calculatedAt: Date;
  lastUpdated: Date;
}
