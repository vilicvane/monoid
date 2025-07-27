import type * as x from 'x-value';

export type TransformNominal<
  TFrom,
  T,
  TKeyTransform extends `${'+' | '-'}${string}` | false = false,
> = TFrom extends x.NominalPartial
  ? T &
      Record<x.__type, T> &
      Record<
        x.__nominal,
        TKeyTransform extends false
          ? TFrom[x.__nominal]
          : TransformNominalMap_<TFrom[x.__nominal], TKeyTransform>
      >
  : T;

type TransformNominalMap_<TNominalMap, TKeyTransform> = {
  [TKey in keyof TNominalMap as TKey extends string
    ? NominalKeyTransform_<TKey, TKeyTransform>
    : TKey]: TNominalMap[TKey];
};

type NominalKeyTransform_<
  TKey extends string,
  TKeyTransform,
> = TKeyTransform extends `${infer TTransformType extends
  | '+'
  | '-'}${infer TSuffix}`
  ? TTransformType extends '+'
    ? `${TKey}${TSuffix}`
    : TKey extends `${infer TTransformedKey}${TSuffix}`
      ? TTransformedKey
      : never
  : never;
