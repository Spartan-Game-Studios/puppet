/** A translation of an English area catalog: any subset of its keys (missing ones fall back to English). */
export type Tr<T> = Partial<Record<keyof T, string>>;
