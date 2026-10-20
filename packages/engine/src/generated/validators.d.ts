export interface SchemaError { instancePath: string; message?: string }
export type Validator = ((data: unknown) => boolean) & { errors?: SchemaError[] | null };
export const threats: Validator;
export const effectors: Validator;
export const doctrine: Validator;
export const training: Validator;
export const guns: Validator;
