/**
 * Author: Meirion Hughes
 * @see https://stackoverflow.com/a/41980288/740183
 */
export type RecursivePartial<T> = {
  [P in keyof T]?: RecursivePartial<T[P]>;
};
